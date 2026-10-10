import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { runChatTurn, type ChatDeps } from '../agent/chat.service.js';
import { AgentConfigError, getAgentConfig, type AgentConfig } from '../agent/config.js';
import { consumeBudgets, LimitStoreError, waitPhrase, type AgentBudget } from '../agent/limits.js';
import { findSensitive } from '../agent/guard.js';
import { formatSse } from '../agent/stream.js';
import { createAvatarUpload, findOwnedUpload, formatSize } from '../services/upload.service.js';
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
      return apiResponse(res, 400, 'error', SENSITIVE_MESSAGE);
    }
    if ('uploadId' in body && body.uploadId) {
      const upload = await findOwnedUpload(userId, body.uploadId);
      if (!upload) return apiResponse(res, 400, 'error', 'That attachment has expired. Please attach it again.');
      message = `${message}\n\n[The customer attached an image: "${upload.name.replace(/["[\]]/g, '')}", ${formatSize(upload.size)}. upload_id: ${upload.uploadId}]`;
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
    res.end();
  };

// POST /api/v1/agent/uploads/avatar (spec 012): holds an image from the chat for its owner,
// for an hour. Nothing reaches Cloudinary or the profile until the customer confirms.
export const uploadAvatarHandler = async (req: Request, res: Response): Promise<void> => {
  const userId = String((req as Request & { user: { _id: unknown } }).user._id);
  if (!req.file) return apiResponse(res, 400, 'error', 'Attach one image in the "profile" field');
  const upload = await createAvatarUpload(userId, req.file);
  apiResponse(res, 201, 'success', 'Image received', upload);
};
