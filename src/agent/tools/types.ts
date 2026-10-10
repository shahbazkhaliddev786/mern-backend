// Every tool is built per request around the verified user's id (security.md §3).
export interface ToolContext {
  /** From the verified session (req.user._id). Never from the model. */
  userId: string;
}

// Read by the M4 confirmation gate.
export const READ_TOOL_METADATA = { kind: 'read', confirmRequired: false } as const;
