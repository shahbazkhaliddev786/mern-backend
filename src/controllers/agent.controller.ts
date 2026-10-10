import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { runChatTurn, type ChatDeps } from '../agent/chat.service.js';
import { AgentConfigError, getAgentConfig, type AgentConfig } from '../agent/config.js';
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

    // An attachment must exist and belong to this customer. The model learns of it only through
    // this server-written note: name, size and an opaque id, never the image (security.md §9).
    let message = 'message' in body ? body.message : undefined;
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
