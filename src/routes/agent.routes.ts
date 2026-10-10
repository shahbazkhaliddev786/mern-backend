import { Router, type RequestHandler } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { validateBody } from '../middlewares/zod-validate.middleware.js';
import type { ChatDeps } from '../agent/chat.service.js';
// Imported directly rather than through controllers/index.js, like support.routes.ts, so the
// router can be tested without loading every controller.
import { agentAvailable, chatRequestSchema, createChatHandler } from '../controllers/agent.controller.js';

// The AI shopping agent (docs/shopping-agent). Signed-in customers only (reconciliation.md Gap 16).
// `auth` and `deps` are replaceable for tests.
export const createAgentRouter = ({ deps, auth = authMiddleware }: { deps?: ChatDeps; auth?: RequestHandler } = {}) => {
  const router = Router();
  router.post('/chat', agentAvailable, auth, validateBody(chatRequestSchema), createChatHandler(deps));
  return router;
};

export const agentRouter = createAgentRouter();
