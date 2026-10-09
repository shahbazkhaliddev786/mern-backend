import config from '../config/config.js';
import logger from '../utils/logger.js';

export type SupportRequestSource = 'contact_form' | 'agent';

export interface SupportRequest {
  name: string;
  email: string;
  subject: string;
  message: string;
  userId: string | null;
  source: SupportRequestSource;
}

// Carries the HTTP status the caller should respond with.
export class SupportDeliveryError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SupportDeliveryError';
    this.status = status;
  }
}

const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_FAILED = 'Failed to send your message. Please try again later.';

// Forwards a support request to the human support inbox (a Make.com webhook).
// The /contact form and the agent's submit_support_request tool both go
// through here, so there is one path to support. Callers must pass the
// sender's name/email from the verified session whenever the user is signed in.
export const submitSupportRequest = async (request: SupportRequest): Promise<void> => {
  if (!config.SUPPORT_WEBHOOK_URL) {
    logger.error('SUPPORT_WEBHOOK_URL_NOT_CONFIGURED');
    throw new SupportDeliveryError('Support requests are temporarily unavailable. Please try again later.', 503);
  }

  const response = await fetch(config.SUPPORT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  }).catch((error: Error) => {
    logger.error('SUPPORT_REQUEST_DELIVERY_FAILED', { source: request.source, error: error.message });
    throw new SupportDeliveryError(DELIVERY_FAILED, 502);
  });

  if (!response.ok) {
    logger.error('SUPPORT_REQUEST_DELIVERY_FAILED', { source: request.source, status: response.status });
    throw new SupportDeliveryError(DELIVERY_FAILED, 502);
  }

  // Ids only — no name, email or message in the logs (follow-ups.md §11).
  logger.info('SUPPORT_REQUEST_SUBMITTED', { source: request.source, userId: request.userId ?? 'guest' });
};
