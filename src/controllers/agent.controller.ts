import { trace } from '@opentelemetry/api';
import type { BaseMessage } from '@langchain/core/messages';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { checkpointThreadId, runChatTurn, type ChatDeps } from '../agent/chat.service.js';
import { createCheckpointer } from '../agent/checkpointer.js';
import { AgentConfigError, getAgentConfig, type AgentConfig } from '../agent/config.js';
import { consumeBudgets, LimitStoreError, waitPhrase, type AgentBudget } from '../agent/limits.js';
import { cleanFileName, findSensitive } from '../agent/guard.js';
import { FEEDBACK_REASONS, saveFeedback, snapshotTurn } from '../agent/online-evals.js';
import { formatSse } from '../agent/stream.js';
import { createAvatarUpload, findOwnedUpload, formatSize } from '../services/upload.service.js';
import { flushTraces } from '../tracing.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';

// A new message, or the answer to a pending confirmation (spec 008).
export const chatRequestSchema = z.union([
  z.object({
    message: z.string().trim().min(1).max(2000),
    threadId: z.uuid().optional(),
    // An image attached in the chat (spec 012), from POST /agent/uploads/avatar.
    uploadId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  }),
  z.object({
    threadId: z.uuid(),
    resume: z.object({ interruptId: z.string().min(1).max(200), approved: z.boolean() }),
  }),
]);

// Thumbs up/down on one reply (spec 021). The reason and comment are optional: one tap counts.
export const feedbackRequestSchema = z.object({
  threadId: z.uuid(),
  replyId: z.string().min(1).max(200),
  rating: z.enum(['up', 'down']),
  reason: z.enum(FEEDBACK_REASONS).optional(),
  comment: z.string().trim().max(300).optional(),
});

const UNAVAILABLE = 'The shopping assistant is not available right now.';
export const SENSITIVE_MESSAGE =
  "For your security, don't share card numbers or passwords here. Payment happens only on Stripe's checkout page.";

// Runs before auth: when the agent is off or misconfigured, nothing else matters.
// Missing variable names go to the log, never to the client.
export const agentAvailable: RequestHandler = (_req, res, next) => {
  let config: AgentConfig;
  try {
    config = getAgentConfig();
  } catch (error) {
    if (error instanceof AgentConfigError) logger.error('AGENT_MISCONFIGURED', { missing: error.missing });
    return apiResponse(res, 503, 'error', UNAVAILABLE);
  }
  if (!config.enabled) return apiResponse(res, 503, 'error', UNAVAILABLE);
  res.locals.agentConfig = config;
  next();
};

// Per-user limits before anything costly runs (spec 014). Runs after auth: keyed on the user id.
const limitRequests =
  (budgets: AgentBudget[], tooMany: (wait: string) => string): RequestHandler =>
  async (req, res, next) => {
    const userId = String((req as Request & { user: { _id: unknown } }).user._id);
    try {
      const result = await consumeBudgets(userId, budgets);
      if (result.ok) return next();
      trace.getActiveSpan()?.addEvent('agent.rate_limited', { budget: result.budget });
      res.setHeader('Retry-After', String(Math.ceil(result.msBeforeNext / 1000)));
      return apiResponse(res, 429, 'error', tooMany(waitPhrase(result.msBeforeNext)));
    } catch (error) {
      // Without the limit store the request isn't let through (the chat needs MongoDB anyway).
      logger.error('AGENT_LIMIT_ERROR', { userId, error: error instanceof LimitStoreError ? error.message : String(error) });
      return apiResponse(res, 503, 'error', UNAVAILABLE);
    }
  };

export const agentTurnLimit = limitRequests(
  ['turnsBurst', 'turnsDaily'],
  (wait) => `You've sent a lot of messages in a short time. Please wait ${wait} and try again.`,
);

export const agentFeedbackLimit = limitRequests(
  ['feedback'],
  (wait) => `You've sent a lot of feedback in a short time. Please wait ${wait} and try again.`,
);

export const agentUploadLimit = limitRequests(
  ['writes'],
  (wait) => `You've made a lot of changes in a short time. Please wait ${wait} and try again.`,
);

// POST /api/v1/agent/chat — streams one turn as server-sent events (spec 006).
export const createChatHandler =
  (deps?: ChatDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof chatRequestSchema>;
    const userId = String((req as Request & { user: { _id: unknown } }).user._id);

    // An attachment must exist and belong to this customer. The model learns of it only through
    // this server-written note: name, size and an opaque id, never the image (security.md §9).
    let message = 'message' in body ? body.message : undefined;
    // Spec 016: a card number or credential never reaches the model, the conversation or a log.
    const sensitive = message ? findSensitive(message) : [];
    if (sensitive.length > 0) {
      logger.warn('AGENT_SENSITIVE_INPUT', { userId, kinds: sensitive });
      trace.getActiveSpan()?.addEvent('agent.sensitive_input', { kinds: sensitive });
      return apiResponse(res, 400, 'error', SENSITIVE_MESSAGE);
    }
    if ('uploadId' in body && body.uploadId) {
      const upload = await findOwnedUpload(userId, body.uploadId);
      if (!upload) return apiResponse(res, 400, 'error', 'That attachment has expired. Please attach it again.');
      message = `${message}\n\n[The customer attached an image: "${cleanFileName(upload.name)}", ${formatSize(upload.size)}. upload_id: ${upload.uploadId}]`;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    // The response closing before we end it means the customer left: stop the turn.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const turn = {
      config: res.locals.agentConfig as AgentConfig,
      userId,
      threadId: body.threadId,
      ...('resume' in body ? { resume: body.resume } : { message }),
      signal: abort.signal,
    };
    for await (const event of runChatTurn(turn, deps)) {
      if (abort.signal.aborted) break;
      res.write(formatSse(event));
    }
    // Spec 017: send the turn's spans before ending, since a Vercel function can be frozen after.
    await flushTraces();
    res.end();
  };

// POST /api/v1/agent/feedback (spec 021): a customer's thumbs up or down on one of their own
// replies. A thumbs-down keeps a redacted snapshot of the turn for review.
export const createFeedbackHandler =
  (deps?: Pick<ChatDeps, 'createCheckpointer'>) =>
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof feedbackRequestSchema>;
    const userId = String((req as Request & { user: { _id: unknown } }).user._id);
    // Spec 016: the comment is stored, so it gets the same check as a chat message.
    const sensitive = body.comment ? findSensitive(body.comment) : [];
    if (sensitive.length > 0) {
      logger.warn('AGENT_SENSITIVE_INPUT', { userId, kinds: sensitive, source: 'feedback' });
      return apiResponse(res, 400, 'error', SENSITIVE_MESSAGE);
    }
    // Only a reply in the customer's own conversation can be rated: the checkpoint key includes
    // their id, so someone else's thread reads as empty.
    const checkpointer = deps ? deps.createCheckpointer() : createCheckpointer();
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: checkpointThreadId(userId, body.threadId) } });
    const messages = ((tuple?.checkpoint.channel_values as { messages?: BaseMessage[] } | undefined)?.messages ?? []) as BaseMessage[];
    const index = messages.findIndex((m) => m.id === body.replyId && m.getType() === 'ai');
    if (index < 0) return apiResponse(res, 404, 'error', 'That reply could not be found.');

    const snapshot = body.rating === 'down' ? snapshotTurn(messages, index) : null;
    await saveFeedback({
      userId,
      threadId: body.threadId,
      replyId: body.replyId,
      rating: body.rating,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.comment ? { comment: body.comment } : {}),
      ...(snapshot ? { snapshot } : {}),
    });
    // Ids and the rating only; the comment stays in the database.
    logger.info('AGENT_FEEDBACK', { userId, threadId: body.threadId, replyId: body.replyId, rating: body.rating, reason: body.reason ?? null });
    trace.getActiveSpan()?.setAttributes({ 'agent.reply_id': body.replyId, 'agent.feedback': body.rating });
    await flushTraces();
    apiResponse(res, 200, 'success', 'Thanks for the feedback');
  };

// POST /api/v1/agent/uploads/avatar (spec 012): holds an image from the chat for its owner,
// for an hour. Nothing reaches Cloudinary or the profile until the customer confirms.
export const uploadAvatarHandler = async (req: Request, res: Response): Promise<void> => {
  const userId = String((req as Request & { user: { _id: unknown } }).user._id);
  if (!req.file) return apiResponse(res, 400, 'error', 'Attach one image in the "profile" field');
  // Spec 022: the name reaches the model in the attachment note, so it gets the same check as a
  // message (spec 016) and is stored as one clean line.
  const sensitive = findSensitive(req.file.originalname);
  if (sensitive.length > 0) {
    logger.warn('AGENT_SENSITIVE_INPUT', { userId, kinds: sensitive, source: 'upload_name' });
    return apiResponse(res, 400, 'error', SENSITIVE_MESSAGE);
  }
  const upload = await createAvatarUpload(userId, { ...req.file, originalname: cleanFileName(req.file.originalname) });
  await flushTraces();
  apiResponse(res, 201, 'success', 'Image received', upload);
};

// Names the request's HTTP span after its route (spec 017): the Express instrumentation doesn't
// patch Express 5 under ESM, so the span would otherwise just say "POST".
export const nameTraceSpan: RequestHandler = (req, _res, next) => {
  const route = `${req.baseUrl}${req.route?.path ?? ''}`;
  trace.getActiveSpan()?.updateName(`${req.method} ${route}`).setAttribute('http.route', route);
  next();
};
