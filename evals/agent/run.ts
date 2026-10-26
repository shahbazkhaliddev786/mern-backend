// Runs one golden through the harness and records what happened (spec 020): every tool call with
// its arguments and whether it ran, the confirmations, whether the turn got stuck or escalated,
// the replies, the wall time and the tokens.

import type { BaseMessage } from '@langchain/core/messages';
import logger from '../../src/utils/logger.js';
import { AGENT_MODELS } from '../../src/agent/config.js';
import type { Attack, Harness } from '../safety/harness';
import { CONFIRM_REQUIRED_TOOLS, type CaseRun, type Usage } from './score';
import type { Golden } from './goldens';
import { failing } from './mocks';

// The graph logs tokens per model call and every stuck turn; the suite reads them back here.
type Logged = { message: string; meta: Record<string, unknown> };
const logged: Logged[] = [];
let hooked = false;
function hookLogger() {
  if (hooked) return;
  hooked = true;
  for (const level of ['info', 'warn'] as const) {
    const original = logger[level].bind(logger) as (message: string, meta?: Record<string, unknown>) => unknown;
    (logger as unknown as Record<string, unknown>)[level] = (message: string, meta?: Record<string, unknown>) => {
      if (message === 'AGENT_MODEL_USAGE' || message === 'AGENT_ESCALATION') logged.push({ message, meta: meta ?? {} });
      return original(message, meta);
    };
  }
}

const typeOf = (m: BaseMessage) => m.getType();
const NOT_RUN = /^\{"error":"Not run:/;

export async function runCase(h: Harness, golden: Golden, user: string): Promise<CaseRun> {
  hookLogger();
  await h.reset();
  h.resetLimits();
  failing.orders = golden.failing === 'orders';
  failing.search = golden.failing === 'search';
  const firstLog = logged.length;
  const started = Date.now();
  const run: CaseRun = { id: golden.id, calls: [], confirmations: [], stuck: false, escalated: false, replies: [], ms: 0, usage: {} };
  let threadId: string | undefined;
  try {
    for (const [turn, step] of golden.turns.entries()) {
      const posts: Attack[] = [];
      let response = await h.say(user, step.user, threadId);
      posts.push(response);
      threadId ??= response.threadId;
      // Answer each confirmation as the golden says; anything it didn't expect is declined.
      for (let asked = 0; response.confirm && asked < 5; asked++) {
        const tool = response.confirm.tool;
        const approved = step.confirm === 'approve' && (step.expect ?? []).some((e) => e.name === tool && CONFIRM_REQUIRED_TOOLS.includes(tool));
        run.confirmations.push({ turn, tool, approved });
        response = await h.answer(user, response, approved);
        posts.push(response);
      }
      const failed = posts.find((p) => p.status !== 200 || p.events.some((e) => e.event === 'error'));
      if (failed) throw new Error(`turn ${turn + 1}: ${failed.status} ${JSON.stringify(failed.events.find((e) => e.event === 'error')?.data ?? {})}`);
      run.replies.push(posts.map((p) => p.text).join(''));
    }
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    failing.orders = false;
    failing.search = false;
  }
  run.ms = Date.now() - started;

  // Tool calls and results come from the checkpointed conversation.
  if (threadId) {
    let turn = -1;
    const results = new Map<string, string>();
    const messages = await h.transcript(user, threadId);
    for (const m of messages) if (typeOf(m) === 'tool') results.set(String((m as unknown as { tool_call_id: string }).tool_call_id), String(m.content));
    for (const m of messages) {
      if (typeOf(m) === 'human') turn += 1;
      if (typeOf(m) !== 'ai') continue;
      for (const call of (m as unknown as { tool_calls?: { id?: string; name: string; args: Record<string, unknown> }[] }).tool_calls ?? []) {
        const result = results.get(call.id ?? '');
        run.calls.push({ turn, name: call.name, args: call.args, ran: result !== undefined && !NOT_RUN.test(result) });
      }
    }
  }

  for (const { message, meta } of logged.slice(firstLog)) {
    if (message === 'AGENT_ESCALATION') {
      run.stuck = true;
      if (meta.outcome === 'escalated') run.escalated = true;
      continue;
    }
    // Logged under the production model name of the role that made the call.
    const role = meta.model === AGENT_MODELS.escalation ? 'escalation' : 'agent';
    const total: Usage = run.usage[role] ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const key of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) total[key] += Number(meta[key] ?? 0);
    run.usage[role] = total;
  }
  return run;
}
