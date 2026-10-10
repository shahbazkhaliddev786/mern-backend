import { Router, type RequestHandler } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/zod-validate.middleware.js';
import type { ChatDeps } from '../agent/chat.service.js';
// Imported directly rather than through controllers/index.js, like support.routes.ts, so the
// router can be tested without loading every controller.
import {
  agentAvailable,
  agentTurnLimit,
  agentUploadLimit,
  chatRequestSchema,
  createChatHandler,
  nameTraceSpan,
  uploadAvatarHandler,
} from '../controllers/agent.controller.js';
import { uploadSingleFile } from '../middlewares/multer.middleware.js';
import { streamProbe } from '../controllers/stream-probe.controller.js';
import config from '../config/config.js';

// The AI shopping agent (docs/shopping-agent). Signed-in customers only (reconciliation.md Gap 16).
// `auth` and `deps` are replaceable for tests.
export const createAgentRouter = ({
  deps,
  auth = authMiddleware,
  streamProbeEnabled = config.STREAM_PROBE_ENABLED === 'true',
}: { deps?: ChatDeps; auth?: RequestHandler; streamProbeEnabled?: boolean } = {}) => {
  const router = Router();
  // Per-user limits (spec 014): after auth, and before anything costly runs.
  router.post('/chat', nameTraceSpan, agentAvailable, auth, validateBody(chatRequestSchema), agentTurnLimit, createChatHandler(deps));
  // Same limits and messages as the Edit Profile upload: one JPEG/PNG/GIF/WEBP, up to 2 MB (spec 012).
  router.post('/uploads/avatar', nameTraceSpan, agentAvailable, auth, agentUploadLimit, uploadSingleFile, uploadAvatarHandler);
  // TEMPORARY (spec 004): only exists when switched on; removed when the spec closes.
  if (streamProbeEnabled) router.post('/_stream-probe', streamProbe);
  return router;
};

export const agentRouter = createAgentRouter();
