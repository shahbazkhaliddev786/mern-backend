// Shared plumbing for the agent's tools (spec 005).

import logger from '../../utils/logger.js';

/** Tool results are compact JSON strings. */
export const toolResult = (value: unknown): string => JSON.stringify(value);

/** A failure the model can relay to the customer. Tools never throw to the model. */
export const toolError = (message: string): string => JSON.stringify({ error: message });

/**
 * Wraps a tool body so unexpected errors are logged and turned into a generic message.
 * Arguments aren't logged: they can hold personal data.
 */
export function safely<A>(tool: string, userId: string, body: (args: A) => Promise<string>): (args: A) => Promise<string> {
  return async (args: A) => {
    try {
      return await body(args);
    } catch (error) {
      logger.error('AGENT_TOOL_ERROR', { tool, userId, error: error instanceof Error ? error.message : String(error) });
      return toolError('Something went wrong looking that up. Please try again in a moment.');
    }
  };
}

/**
 * Text written by others (product descriptions today, reviews later) goes to the model
 * as data, never instructions (security.md §5). Any tag inside the text that could
 * open or close the wrapper is defused.
 */
export function untrusted(source: string, text: string): string {
  const defused = text.replace(/<(\/?)untrusted_content/gi, '&lt;$1untrusted_content');
  return `<untrusted_content source="${source}">\n${defused}\n</untrusted_content>`;
}

export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const productUrl = (id: unknown): string => `/products/${String(id)}`;

/** 24-hex Mongo id, as the tools accept it. */
export const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

export const refName = (ref: unknown): string | null =>
  ref && typeof ref === 'object' && 'name' in ref ? String((ref as { name: unknown }).name) : null;
