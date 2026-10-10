// Account and external writes (spec 011), both confirm-required (security.md §6).
// update_profile changes the display name only: email and password changes stay in the UI,
// which re-authenticates the customer (security.md §7). A support request always carries
// the session's name and email, never values from the model.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getUserById, updateUserProfile } from '../../services/auth.service.js';
import { submitSupportRequest, SupportDeliveryError } from '../../services/support.service.js';
import { applyAvatarUpload, findOwnedUpload, formatSize, UploadNotFoundError } from '../../services/upload.service.js';
import { supportMessageSchema } from '../../validations/support.schema.js';
import { OBJECT_ID_PATTERN, safely, toolError, toolResult } from './helpers.js';
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

// upload_avatar (spec 012): applies an image the customer attached in the chat. The model only
// has the opaque upload_id from the server's attachment note; the bytes never reach it.
const avatarSchema = z.object({
  upload_id: z.string().regex(OBJECT_ID_PATTERN, 'Not an upload id').describe("The upload_id from the attachment note in the customer's message"),
});

export const uploadAvatarTool = (ctx: ToolContext) =>
  tool(
    safely('upload_avatar', ctx.userId, async ({ upload_id }: z.infer<typeof avatarSchema>) => {
      try {
        await applyAvatarUpload(ctx.userId, upload_id);
      } catch (error) {
        if (error instanceof UploadNotFoundError) return toolError(error.message);
        if (error instanceof Error && /failed to (upload|process)/i.test(error.message)) {
          // The upload is kept, so asking again can work.
          return toolError("The picture couldn't be saved just now. Ask me to try again in a moment.");
        }
        throw error;
      }
      return toolResult({ profilePictureUpdated: true });
    }),
    {
      name: 'upload_avatar',
      description:
        'Set an image the customer attached in this chat as their profile picture. Use the upload_id from the attachment note; never make one up. The app asks the customer to confirm first.',
      schema: avatarSchema,
      metadata: CONFIRMED_WRITE_TOOL_METADATA,
    },
  );

/** What the customer confirms for upload_avatar. Read-only. */
export async function summarizeUploadAvatar(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const upload = await findOwnedUpload(ctx.userId, String(args.upload_id ?? ''));
  if (!upload) return 'That picture has expired. Cancel and attach it again.';
  return `Set "${upload.name}" (${formatSize(upload.size)}) as your profile picture?`;
}
