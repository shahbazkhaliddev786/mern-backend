import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getUserById } from '../../services/auth.service.js';
import { safely, toolError, toolResult } from './helpers.js';
import { READ_TOOL_METADATA, type ToolContext } from './types.js';

export const viewProfileTool = (ctx: ToolContext) =>
  tool(
    safely('view_profile', ctx.userId, async () => {
      const user = await getUserById(ctx.userId);
      if (!user) return toolError('Your profile could not be found.');
      // Only what a customer would ask about; no role, tokens or pending-email fields.
      return toolResult({
        name: user.name,
        email: user.email,
        emailVerified: user.isVerified,
        hasProfilePicture: Boolean(user.profile),
        memberSince: user.createdAt,
      });
    }),
    {
      name: 'view_profile',
      description: 'Show the customer\'s profile: name, email, whether the email is verified, and when they joined.',
      schema: z.object({}),
      metadata: READ_TOOL_METADATA,
    },
  );
