// Urgent agent alerts (spec 016, observability.md "page immediately"). Ids only, never the data
// that triggered them. Always a log line a log-based alert can watch; also a POST to
// ALERT_WEBHOOK_URL when it's set (a Slack incoming webhook or a Make.com scenario).

import config from '../config/config.js';
import logger from '../utils/logger.js';

export type AlertKind = 'sensitive_in_tool_args' | 'sensitive_in_tool_result' | 'sensitive_in_model_output' | 'unconfirmed_write';

export interface AlertContext {
  userId: string;
  thread: string;
  tool?: string;
  toolCallId?: string;
}

const WEBHOOK_TIMEOUT_MS = 3000;

/** Never throws: an alert that can't be delivered is logged and the turn carries on. */
export async function raiseAlert(kind: AlertKind, context: AlertContext): Promise<void> {
  logger.error('AGENT_ALERT', { kind, ...context });
  const url = config.ALERT_WEBHOOK_URL;
  if (!url) return;
  const where = [`user ${context.userId}`, `thread ${context.thread}`, ...(context.tool ? [`tool ${context.tool}`] : [])].join(', ');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Aljo agent alert: ${kind} (${where})` }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    logger.warn('AGENT_ALERT_NOT_DELIVERED', { kind, error: error instanceof Error ? error.message : String(error) });
  }
}
