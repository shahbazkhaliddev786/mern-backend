import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { runChatTurn, type ChatDeps } from '../agent/chat.service.js';
import { AgentConfigError, getAgentConfig, type AgentConfig } from '../agent/config.js';
import { formatSse } from '../agent/stream.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';

// A new message, or the answer to a pending confirmation (spec 008).
export const chatRequestSchema = z.union([
  z.object({
    message: z.string().trim().min(1).max(2000),
    threadId: z.uuid().optional(),
  }),
  z.object({
    threadId: z.uuid(),
    resume: z.object({ interruptId: z.string().min(1).max(200), approved: z.boolean() }),
  }),
]);

const UNAVAILABLE = 'The shopping assistant is not available right now.';

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

// POST /api/v1/agent/chat — streams one turn as server-sent events (spec 006).
export const createChatHandler =
  (deps?: ChatDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof chatRequestSchema>;
    const userId = String((req as Request & { user: { _id: unknown } }).user._id);

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
      ...('resume' in body ? { resume: body.resume } : { message: body.message }),
      signal: abort.signal,
    };
    for await (const event of runChatTurn(turn, deps)) {
      if (abort.signal.aborted) break;
      res.write(formatSse(event));
    }
    res.end();
  };
