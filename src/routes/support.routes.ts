import { Router } from 'express';
import type { RequestHandler } from 'express';
import { optionalAuthMiddleware } from '../middlewares/auth.middleware.js';
import rateLimiterMiddleware from '../middlewares/rate.lim.js';
import { validateBody } from '../middlewares/zod-validate.middleware.js';
import { guestSupportRequestSchema, supportMessageSchema } from '../validations/support.schema.js';
// Imported directly rather than through controllers/index.js so this router can be
// tested without loading every controller (the Cloudinary config throws without env vars).
import { createSupportRequest } from '../controllers/support.controller.js';

export const supportRouter = Router();

// Signed-in senders send only subject + message (any name/email they include is
// stripped); guests have no session identity, so they must provide both.
const validateSignedIn = validateBody(supportMessageSchema);
const validateGuest = validateBody(guestSupportRequestSchema);
const validateSupportRequest: RequestHandler = (req, res, next) =>
  (req.user ? validateSignedIn : validateGuest)(req, res, next);

// Optional auth keeps /contact open to guests; a valid token makes the session identity authoritative.
supportRouter.post('/', optionalAuthMiddleware, rateLimiterMiddleware, validateSupportRequest, createSupportRequest);
