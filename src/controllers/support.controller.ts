import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import { submitSupportRequest, SupportDeliveryError } from '../services/support.service.js';

// POST /api/v1/support
export const createSupportRequest = asyncHandler(async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { subject, message } = req.body;

  try {
    await submitSupportRequest({
      // A signed-in sender is identified by the session, never by the body.
      name: user ? user.name : req.body.name,
      email: user ? user.email : req.body.email,
      subject,
      message,
      userId: user ? user._id.toString() : null,
      source: 'contact_form',
    });
  } catch (error) {
    if (error instanceof SupportDeliveryError) {
      return apiResponse(res, error.status, 'error', error.message);
    }
    throw error;
  }

  return apiResponse(res, 200, 'success', 'Message sent successfully');
});
