// Support request schemas (zod).
//
// Mirrors mern-frontend/src/features/aljo-store/schemas/contact-schema.tsx —
// keep the two in sync. supportMessageSchema is also the input the agent's
// submit_support_request tool will reuse: a signed-in sender's name and email
// always come from the session, never from the request (security.md §7).

import { z } from 'zod';

export const supportMessageSchema = z.object({
  subject: z.string().min(3, 'Subject must be at least 3 characters.').max(100, 'Subject must be at most 100 characters.'),
  message: z.string().min(10, 'Message must be at least 10 characters.').max(500, 'Message must be at most 500 characters.'),
});

// Guests have no session identity, so they supply their own name and email.
export const guestSupportRequestSchema = supportMessageSchema.extend({
  name: z.string().min(2, 'Name must be at least 2 characters.').max(50, 'Name must be at most 50 characters.'),
  email: z.string().email('Please enter a valid email address.'),
});
