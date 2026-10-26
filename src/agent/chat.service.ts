// Runs one chat turn and yields SSE events (spec 006).

import crypto from 'node:crypto';
import { context, trace, type Context } from '@opentelemetry/api';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { claimConfirmation, createCheckpointer, releaseConfirmation } from './checkpointer.js';
import { PROMPT_VERSION, type AgentConfig } from './config.js';
import { GIVE_UP_REPLY, REFUSAL_REPLY } from './prompt.js';
import { buildAgentGraph, createChatModel, createEscalationModel, RECURSION_LIMIT } from './graph.js';
import { consumeBudgets } from './limits.js';
import { StreamRedactor } from './guard.js';
import { saveTurnSample, snapshotTurn, type TurnSample } from './online-evals.js';
import { toAgentEvents, toolStartEvent, visibleText, type AgentEvent } from './stream.js';
import { buildToolsForRequest, summarizeConfirmation } from './tools/index.js';

export interface ChatDeps {
  createModel: (config: AgentConfig) => BaseChatModel;
  /** Opus for stuck turns (spec 015). Without it, a stuck turn ends with the support offer. */
  createEscalationModel?: (config: AgentConfig) => BaseChatModel;
  createCheckpointer: () => BaseCheckpointSaver;
  /** Returns false when the confirmation was already claimed by another request. */
  claimConfirmation: (interruptId: string, thread: string) => Promise<boolean>;
  /** Spec 022: gives a claim back when the resumed run failed before the gate step was saved. */
  releaseConfirmation?: (interruptId: string) => Promise<void>;
  /** Spec 021: the share of finished turns saved for the online judge (0 or missing: none). */
  sampleRate?: number;
  saveSample?: (sample: Omit<TurnSample, 'createdAt' | 'expiresAt'>) => Promise<void>;
}

const defaultDeps: ChatDeps = {
  createModel: (config) => createChatModel(config),
  createEscalationModel: (config) => createEscalationModel(config),
  createCheckpointer: () => createCheckpointer(),
  claimConfirmation: (interruptId, thread) => claimConfirmation(interruptId, thread),
  releaseConfirmation: (interruptId) => releaseConfirmation(interruptId),
  sampleRate: Number(config.AGENT_EVAL_SAMPLE_RATE) || 0,
  saveSample: (sample) => saveTurnSample(sample),
};

// Turns the customer can rate, and the online judge samples (spec 021): ones that ended in a reply.
const SAMPLED_OUTCOMES = new Set(['answered', 'gave_up', 'refused']);

const INTERRUPTED = 'Not run: the previous turn was interrupted.';

/**
 * Tool calls in the last assistant message that never got a result (spec 022): what a turn
 * leaves behind when it stops mid-tool, and what the API refuses on the next request.
 */
function unansweredToolCalls(messages: BaseMessage[] | undefined): { id?: string; name: string }[] {
  if (!messages?.length) return [];
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.getType() === 'tool') index -= 1;
  const asking = messages[index];
  if (!asking || asking.getType() !== 'ai') return [];
  const answered = new Set(messages.slice(index + 1).map((m) => (m as ToolMessage).tool_call_id));
  return ((asking as { tool_calls?: { id?: string; name: string }[] }).tool_calls ?? []).filter((call) => !answered.has(call.id ?? ''));
}

/** The turn's reply: the last message, when it's the assistant's and calls no tool. */
function replyOf(messages: BaseMessage[] | undefined): BaseMessage | undefined {
  const last = messages?.at(-1);
  if (!last || last.getType() !== 'ai' || ((last as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0) return undefined;
  return last;
}

export interface ChatTurn {
  config: AgentConfig;
  /** The verified session user (req.user._id). */
  userId: string;
  /** A new customer message; or `resume` to answer a pending confirmation (spec 008). */
  message?: string | undefined;
  resume?: { interruptId: string; approved: boolean } | undefined;
  /** Omit to start a new conversation; required with `resume`. */
  threadId?: string | undefined;
  signal?: AbortSignal;
}

/**
 * Threads are owned: the checkpointer key includes the user id, so a threadId sent by
 * someone else opens their own empty conversation, never another customer's history.
 * The prompt version starts conversations fresh when the prompt or tools change (spec 008).
 */
export const checkpointThreadId = (userId: string, threadId: string) => `${userId}:${threadId}:v${PROMPT_VERSION}`;

const NOTHING_PENDING = "There's nothing waiting for confirmation.";
const ALREADY_CONFIRMED = 'That was already confirmed.';
const CONFIRM_FIRST = 'Please confirm or cancel the pending action first.';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

// Anthropic overload, rate limit and server errors are worth retrying; the rest aren't.
const isRetryable = (error: unknown) => {
  const status = (error as { status?: number }).status;
  return status === 429 || status === 529 || (status !== undefined && status >= 500);
};

// The per-user escalation budget (spec 015). A failed limit store means no escalation.
async function allowEscalation(userId: string): Promise<boolean> {
  try {
    return (await consumeBudgets(userId, ['escalations'])).ok;
  } catch (error) {
    logger.error('AGENT_LIMIT_ERROR', { userId, budget: 'escalations', error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

const tracer = trace.getTracer('aljo-agent');

type AgentGraph = ReturnType<typeof buildAgentGraph>;
/** What the inner turn hands back for the turn's span. */
interface TurnRecord {
  graph?: AgentGraph;
  thread?: string;
  threadId?: string;
}

/**
 * One chat turn as SSE events, inside an `agent.turn` span (spec 017). The span carries ids and
 * counts from observability.md's minimum trace schema, never message text.
 */
export async function* runChatTurn(turn: ChatTurn, deps: ChatDeps = defaultDeps): AsyncGenerator<AgentEvent> {
  const span = tracer.startSpan('agent.turn', {
    attributes: { 'agent.user': hash(turn.userId), 'agent.prompt_version': PROMPT_VERSION, 'agent.kind': turn.resume ? 'resume' : 'message' },
  });
  const turnContext = trace.setSpan(context.active(), span);
  const record: TurnRecord = {};
  let outcome = 'answered';
  let toolsRun = 0;
  try {
    for await (const event of runTurn(turn, deps, turnContext, record)) {
      if (event.event === 'confirm_required') outcome = 'confirm_required';
      else if (event.event === 'error') outcome = 'error';
      else if (event.event === 'tool_end') toolsRun += 1;
      yield event;
    }
    if (turn.signal?.aborted) outcome = 'aborted';
  } finally {
    // Spec 022: a failed read here mustn't hide the turn's own error or leave the span open.
    let state: Record<string, unknown> | undefined;
    try {
      state = record.graph && record.thread ? (await record.graph.getState({ configurable: { thread_id: record.thread } })).values : undefined;
    } catch (error) {
      logger.error('AGENT_STATE_READ_FAILED', { userId: turn.userId, error: error instanceof Error ? error.message : String(error) });
    }
    const messages = state?.messages as BaseMessage[] | undefined;
    const lastText = visibleText(messages?.at(-1)?.content ?? '');
    if (outcome === 'answered' && lastText === GIVE_UP_REPLY) outcome = 'gave_up';
    if (outcome === 'answered' && lastText === REFUSAL_REPLY) outcome = 'refused';
    const reply = SAMPLED_OUTCOMES.has(outcome) ? replyOf(messages) : undefined;
    span.setAttributes({
      'agent.thread': record.threadId ?? '',
      'agent.outcome': outcome,
      'agent.tool_calls': toolsRun,
      'agent.escalated': state?.escalated === true,
      ...(state?.escalationReason ? { 'agent.escalation_reason': String(state.escalationReason) } : {}),
      // Spec 021: feedback on this reply can be found by its id in the trace.
      ...(reply?.id ? { 'agent.reply_id': reply.id } : {}),
    });
    span.end();
    // Spec 021: a share of finished turns, saved for the online judge. One insert, no model call;
    // a failure here never affects the customer's turn.
    if (reply?.id && messages && record.threadId && deps.saveSample && Math.random() < (deps.sampleRate ?? 0)) {
      const snapshot = snapshotTurn(messages);
      if (snapshot) {
        try {
          await deps.saveSample({
            user: hash(turn.userId),
            threadId: record.threadId,
            replyId: reply.id,
            promptVersion: PROMPT_VERSION,
            outcome,
            escalated: state?.escalated === true,
            snapshot,
          });
        } catch (error) {
          logger.error('AGENT_SAMPLE_FAILED', { userId: turn.userId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
}

async function* runTurn(turn: ChatTurn, deps: ChatDeps, turnContext: Context, record: TurnRecord): AsyncGenerator<AgentEvent> {
  const threadId = turn.threadId ?? crypto.randomUUID();
  const thread = checkpointThreadId(turn.userId, threadId);
  Object.assign(record, { thread, threadId });
  const redactor = new StreamRedactor();
  let failed = false;
  let claimed = false;
  // Spec 022: when a resumed run stops (error or abort) before the gate step is saved, the same
  // confirmation is still pending; give the claim back so the customer can answer it again.
  const releaseIfStillPending = async () => {
    const interruptId = turn.resume?.interruptId;
    if (!claimed || !interruptId || !record.graph || !deps.releaseConfirmation) return;
    try {
      const pending = (await record.graph.getState({ configurable: { thread_id: thread } })).tasks.flatMap((task) => task.interrupts ?? []);
      if (pending.some((i) => i.id === interruptId)) await deps.releaseConfirmation(interruptId);
    } catch (error) {
      logger.error('AGENT_CLAIM_RELEASE_FAILED', { userId: turn.userId, threadId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  function* flushText(): Generator<AgentEvent> {
    const text = redactor.flush();
    if (text) yield { event: 'token', data: { text } };
  }
  try {
    const ctx = { userId: turn.userId };
    const tools = buildToolsForRequest(ctx);
    const confirmRequired = new Set(
      tools.filter((t) => (t as { metadata?: { confirmRequired?: boolean } }).metadata?.confirmRequired === true).map((t) => t.name),
    );
    const graph = buildAgentGraph({
      model: deps.createModel(turn.config),
      tools,
      checkpointer: deps.createCheckpointer(),
      userId: turn.userId,
      summarize: (call) => summarizeConfirmation(ctx, call),
      ...(deps.createEscalationModel
        ? { escalation: { model: deps.createEscalationModel(turn.config), allow: () => allowEscalation(turn.userId) } }
        : {}),
    });
    record.graph = graph;

    const snapshot = await graph.getState({ configurable: { thread_id: thread } });
    const pending = snapshot.tasks.flatMap((task) => task.interrupts ?? []);

    let input: Parameters<typeof graph.stream>[0];
    if (turn.resume) {
      // Only a confirmation that is actually pending on this customer's thread can be answered,
      // and only once: the first request to claim it wins (spec 002).
      const waiting = pending.find((i) => i.id === turn.resume?.interruptId);
      if (!waiting) {
        yield { event: 'error', data: { message: NOTHING_PENDING, retryable: false } };
        yield { event: 'done', data: { threadId } };
        return;
      }
      if (!(await deps.claimConfirmation(turn.resume.interruptId, thread))) {
        yield { event: 'error', data: { message: ALREADY_CONFIRMED, retryable: false } };
        yield { event: 'done', data: { threadId } };
        return;
      }
      claimed = true;
      input = new Command({ resume: { approved: turn.resume.approved } }) as typeof input;
      // The confirmed tool runs now, so this is when its status chip should appear.
      const tool = (waiting.value as { tool?: string } | undefined)?.tool;
      if (turn.resume.approved && tool) yield toolStartEvent(tool);
    } else {
      // A message while a confirmation waits would follow a tool call that has no result yet,
      // which the API rejects; the customer answers the confirmation first (spec 009).
      if (pending.length > 0) {
        yield { event: 'error', data: { message: CONFIRM_FIRST, retryable: false } };
        yield { event: 'done', data: { threadId } };
        return;
      }
      // A new message starts a new turn: the step counter, call record and escalation start again.
      // Spec 022: a turn that stopped mid-tool (the customer left) leaves calls with no result,
      // which the API rejects from then on. Answer them first, appending only, as the tools step.
      const unanswered = unansweredToolCalls(snapshot.values.messages as BaseMessage[] | undefined);
      if (unanswered.length > 0) {
        await graph.updateState(
          { configurable: { thread_id: thread } },
          { messages: unanswered.map((call) => new ToolMessage({ tool_call_id: call.id ?? '', name: call.name, content: JSON.stringify({ error: INTERRUPTED }) })) },
          'tools',
        );
        logger.warn('AGENT_TURN_REPAIRED', { userId: turn.userId, threadId, unanswered: unanswered.length });
      }
      input = { messages: [new HumanMessage(turn.message ?? '')], toolCalls: 0, escalated: false, turnCalls: [], confirmedCalls: [] };
    }

    // The trace id goes into LangSmith's run metadata, linking its view of the turn to the trace.
    const traceId = trace.getSpan(turnContext)?.spanContext().traceId;
    // Run inside the turn's span, so model, tool and database spans nest under it. The context is
    // set for each step, since a generator's caller doesn't carry it across yields.
    const stream = await context.with(turnContext, () =>
      graph.stream(input, {
        configurable: { thread_id: thread },
        streamMode: ['updates', 'messages'],
        recursionLimit: RECURSION_LIMIT,
        ...(turn.signal ? { signal: turn.signal } : {}),
        metadata: { user: hash(turn.userId), threadId, ...(traceId && trace.getSpan(turnContext)?.isRecording() ? { otel_trace_id: traceId } : {}) },
      }),
    );
    const chunks = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await context.with(turnContext, () => chunks.next());
      if (next.done) break;
      const chunk = next.value;
      for (const event of toAgentEvents(chunk as [string, unknown], { confirmRequired })) {
        // Spec 016: text is redacted on its way out. The held-back tail is released before any
        // other event, so the order of text and status chips is unchanged.
        if (event.event === 'token') {
          const text = redactor.push(event.data.text);
          if (text) yield { event: 'token', data: { text } };
          continue;
        }
        yield* flushText();
        yield event;
      }
    }
    yield* flushText();
  } catch (error) {
    failed = true;
    await releaseIfStillPending();
    if (turn.signal?.aborted) return; // The customer left; nobody is listening.
    yield* flushText();
    logger.error('AGENT_TURN_FAILED', { userId: turn.userId, threadId, error: error instanceof Error ? error.message : String(error) });
    const retryable = isRetryable(error);
    yield {
      event: 'error',
      data: {
        message: retryable ? 'The assistant is busy right now. Please try again in a moment.' : 'Something went wrong. Please try again.',
        retryable,
      },
    };
  }
  // Spec 021: name the reply, so the customer can rate it. None after a failure or a pause.
  // A failed read only costs the reply id: `done` is always sent, so the response always ends (spec 022).
  let replyId: string | undefined;
  if (!failed && record.graph) {
    try {
      replyId = replyOf((await record.graph.getState({ configurable: { thread_id: thread } })).values.messages as BaseMessage[])?.id;
    } catch (error) {
      logger.error('AGENT_STATE_READ_FAILED', { userId: turn.userId, threadId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  yield { event: 'done', data: { threadId, ...(replyId ? { replyId } : {}) } };
}
