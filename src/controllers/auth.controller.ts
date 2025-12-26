import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import {
  registerUser,
  sendOTP,
  verifyOTP,
  loginWithPassword,
  refreshAccessToken,
  logout,
} from '../services/auth.service.js';
import cloudinary from '../utils/cloudinary.js';
import bufferGenerator from '../utils/buffer.generator.js';
import type {
  RegisterBody,
  ResendOtpBody,
  VerifyOtpBody,
  LoginBody,
  RefreshTokenBody,
  LogoutBody
} from '../types/index.js'

// Todos:
  // Logout from all devices
  // Explain token rotation security
  // Update user profile
  // Change password
  // Delete account
  // Continue with google
  // Remaining auth flow, securing and optimizing it

// register
export const register = asyncHandler(async (req: Request<{},{},RegisterBody>, res: Response) => {
  const { name, email, password } = req.body;

  if (!name?.trim() || !email?.trim() || !password) {
    return apiResponse(res, 400, 'error', 'Name, email, and password are required');
  }

  let profile: string | undefined = undefined;

  if (req.file) {
    try {
      const dataUri = bufferGenerator(req.file);
      if (!dataUri?.content) {
        throw new Error('Failed to generate data URI');
      }

      const result = await cloudinary.uploader.upload(dataUri.content, {
        folder: 'profiles',
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      });

      profile = result.secure_url;
    } catch (error: any) {
      logger.error('Profile picture upload failed', { error: error.message });
      return apiResponse(res, 500, 'error', 'Failed to upload profile picture');
    }
  }

  await registerUser(
    name.trim(),
    email.toLowerCase().trim(),
    password,
    profile
  );

  logger.info('User registration initiated', {
    email: email.toLowerCase().trim(),
    hasProfilePicture: !!profile,
  });

  return apiResponse(
    res,
    201,
    'success',
    'Registration successful. Please check your email for the verification OTP.'
  );
});

// Resend OTP
export const resendOTP = asyncHandler(async (req: Request<{},{},ResendOtpBody>, res: Response) => {
  const { email } = req.body;

  await sendOTP(email.toLowerCase().trim());

  logger.info('OTP resent', { email });

  return apiResponse(res, 200, 'success', 'New OTP sent to your email.');
});

// Verify OTP and complete registration/login
export const verifyOtp = asyncHandler(async (req: Request<{},{},VerifyOtpBody>, res: Response) => {
  const { email, otp } = req.body;

  const tokens = await verifyOTP(email.toLowerCase().trim(), otp);

  logger.info('OTP verified successfully', { email });

  return apiResponse(res, 200, 'success', 'Email verified successfully', tokens);
});

// Login with password
export const login = asyncHandler(async (req: Request<{},{},LoginBody>, res: Response) => {
  const { email, password } = req.body;

  const { accessToken, refreshToken, user } = await loginWithPassword(
    email.toLowerCase().trim(),
    password
  );

  logger.info('User logged in with password', { userId: user._id });

  return apiResponse(res, 200, 'success', 'Login successful', {
    accessToken,
    refreshToken,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      profile: user.profile,
    },
  });
});

// Refresh access token
export const refreshToken = asyncHandler(async (req: Request<{},{},RefreshTokenBody>, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return apiResponse(res, 400, 'error', 'Refresh token is required');
  }

  const tokens = await refreshAccessToken(refreshToken);

  logger.info('Access token refreshed');

  return apiResponse(res, 200, 'success', 'Token refreshed successfully', tokens);
});

// Logout (invalidate refresh token)
export const logoutUser = asyncHandler(async (req: Request<{},{},LogoutBody>, res: Response) => {
  const { refreshToken } = req.body;

  if (refreshToken) {
    await logout(refreshToken);
  }

  const userId = (req as any).user?._id || 'unknown';

  logger.info('User logged out', { userId });

  return apiResponse(res, 200, 'success', 'Logged out successfully');
});
