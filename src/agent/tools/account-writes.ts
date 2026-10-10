// Account and external writes (spec 011), both confirm-required (security.md §6).
// update_profile changes the display name only: email and password changes stay in the UI,
// which re-authenticates the customer (security.md §7). A support request always carries
// the session's name and email, never values from the model.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getUserById, updateUserProfile } from '../../services/auth.service.js';
import { submitSupportRequest, SupportDeliveryError } from '../../services/support.service.js';
import { supportMessageSchema } from '../../validations/support.schema.js';
import { safely, toolError, toolResult } from './helpers.js';
import { CONFIRMED_WRITE_TOOL_METADATA, type ToolContext } from './types.js';

// Same bounds as sign-up (registerValidation): 2-50 characters after trimming.
const profileSchema = z.object({
  name: z.string().trim().min(2).max(50).describe('The new display name'),
});

export const updateProfileTool = (ctx: ToolContext) =>
  tool(
    safely('update_profile', ctx.userId, async ({ name }: z.infer<typeof profileSchema>) => {
      const updated = await updateUserProfile(ctx.userId, name);
      return toolResult({ name: updated.name });
    }),
    {
      name: 'update_profile',
      description:
        "Change the customer's display name. The app asks them to confirm first. Email and password can't be changed here; those are on Edit Profile (/profile/edit).",
      schema: profileSchema,
      metadata: CONFIRMED_WRITE_TOOL_METADATA,
    },
  );

export const submitSupportRequestTool = (ctx: ToolContext) =>
  tool(
    safely('submit_support_request', ctx.userId, async ({ subject, message }: z.infer<typeof supportMessageSchema>) => {
      const user = await getUserById(ctx.userId);
      if (!user) return toolError('Your account could not be found.');
      try {
        await submitSupportRequest({ name: user.name, email: user.email, subject, message, userId: ctx.userId, source: 'agent' });
      } catch (error) {
        if (error instanceof SupportDeliveryError) return toolError(error.message);
        throw error;
      }
      return toolResult({ sent: true });
    }),
    {
      name: 'submit_support_request',
      description:
        "Send a message to Aljo Store's human support team on the customer's behalf; it goes from their account's name and email. The app asks them to confirm first.",
      schema: supportMessageSchema,
      metadata: CONFIRMED_WRITE_TOOL_METADATA,
    },
  );

const SUMMARY_MESSAGE_LIMIT = 120;
const quoteShort = (text: string) => `"${text.length > SUMMARY_MESSAGE_LIMIT ? `${text.slice(0, SUMMARY_MESSAGE_LIMIT).trimEnd()}…` : text}"`;

/** What the customer confirms for update_profile. Read-only. */
export async function summarizeUpdateProfile(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const name = String(args.name ?? '').trim();
  const user = await getUserById(ctx.userId);
  if (user?.name === name) return `Your name is already "${name}". Save it anyway?`;
  return user?.name ? `Change your name from "${user.name}" to "${name}"?` : `Change your name to "${name}"?`;
}

/** What the customer confirms for submit_support_request: who it's from and what it says. Read-only. */
export async function summarizeSupportRequest(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const user = await getUserById(ctx.userId);
  const from = user ? ` as ${user.name} (${user.email})` : '';
  return `Send this to Aljo Store support${from}? Subject: "${String(args.subject ?? '')}" — ${quoteShort(String(args.message ?? ''))}`;
}
