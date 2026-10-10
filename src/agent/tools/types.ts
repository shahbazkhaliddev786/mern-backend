// Every tool is built per request around the verified user's id (security.md §3).
export interface ToolContext {
  /** From the verified session (req.user._id). Never from the model. */
  userId: string;
}

// Read by the confirmation gate (spec 008): confirm-required tools pause for the customer's "yes".
export interface ToolMetadata {
  kind: 'read' | 'write';
  confirmRequired: boolean;
}

export const READ_TOOL_METADATA = { kind: 'read', confirmRequired: false } as const satisfies ToolMetadata;
export const WRITE_TOOL_METADATA = { kind: 'write', confirmRequired: false } as const satisfies ToolMetadata;
export const CONFIRMED_WRITE_TOOL_METADATA = { kind: 'write', confirmRequired: true } as const satisfies ToolMetadata;
