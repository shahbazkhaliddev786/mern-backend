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
  getUserById,
  logout,
  updateUserProfile,
  forgotPassword,
  resetPasswordWithOtp,
  deleteUserAccount
} from '../services/auth.service.js';
import cloudinary from '../utils/cloudinary.js';
import bufferGenerator from '../utils/buffer.generator.js';
import type {
  RegisterBody,
  ResendOtpBody,
  VerifyOtpBody,
  LoginBody,
  RefreshTokenBody,
  LogoutBody,
  UpdateProfileBody,
  ForgotPasswordBody,
  ResetPasswordWithOtpBody,
  DeleteAccountBody
} from '../types/index.js'
import { mergeGuestCartOnLogin } from '../services/cart.service.js';

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

  const { user, ...tokens } = await verifyOTP(email.toLowerCase().trim(), otp);

  (req as any).user = user;

  // Merge guest cart items into the newly-verified user's cart
  try {
    await mergeGuestCartOnLogin(req);
    logger.info('Guest cart merged successfully after OTP verification', { userId: user._id });
  } catch (mergeError: any) {
    logger.warn('Failed to merge guest cart after OTP verification', {
      userId: user._id,
      error: mergeError.message,
    });
    // We don't want to fail verification because of cart merge — just log it
  }

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

  (req as any).user = user;

  if (!user) {
    return apiResponse(res, 403, 'error', 'User not found');
  }

  //Merge guest cart items into user's cart
  try {
    await mergeGuestCartOnLogin(req);
    logger.info('Guest cart merged successfully after login', { userId: user._id });
  } catch (mergeError: any) {
    logger.warn('Failed to merge guest cart after login', {
      userId: user._id,
      error: mergeError.message,
    });
    // We don't want to fail login because of cart merge — just log it
  }

  logger.info('User logged in with password', { userId: user._id });

  return apiResponse(res, 200, 'success', 'Login successful', {
    accessToken,
    refreshToken,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      profile: user.profile,
      role: user.role,
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

// Get user profile
export const getProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;

  const user = await getUserById(userId);

  if (!user) {
    return apiResponse(res, 404, 'error', 'User not found');
  }

  logger.info('User profile retrieved', { userId });

  return apiResponse(res, 200, 'success', 'User profile retrieved successfully', {
    id: user._id,
    name: user.name,
    email: user.email,
    profile: user.profile,
    role: user.role,
  });
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


// Update profile
export const updateProfile = asyncHandler(async (req: Request<{}, {}, UpdateProfileBody>, res: Response) => {
  const userId = (req as any).user._id;
  const { name } = req.body;

  const updatedUser = await updateUserProfile(userId, name, req.file);

  logger.info('User profile updated', { userId });

  return apiResponse(res, 200, 'success', 'Profile updated successfully', updatedUser);
});

// Forgot Password - Send OTP
export const forgetPassword = asyncHandler(async (req: Request<{}, {}, ForgotPasswordBody>, res: Response) => {
  const { email } = req.body;

  await forgotPassword(email);

  logger.info('Password reset OTP requested', { email });

  return apiResponse(res, 200, 'success', 'If email exists, OTP sent to reset password');
});

// Reset Password
export const resetPassword = asyncHandler(async (req: Request<{}, {}, ResetPasswordWithOtpBody>, res: Response) => {
  const { email, otp, newPassword, confirmPassword } = req.body;

  if (newPassword !== confirmPassword) {
    return apiResponse(res, 400, 'error', 'Passwords do not match');
  }

  await resetPasswordWithOtp(email, otp, newPassword);

  logger.info('Password reset with OTP successful', { email });

  return apiResponse(res, 200, 'success', 'Password reset successfully. You can now login.');
});

// Delete account
export const deleteAccount = asyncHandler(async (req: Request<{}, {}, DeleteAccountBody>, res: Response) => {
  const userId = (req as any).user._id;
  const { password } = req.body;

  await deleteUserAccount(userId, password);

  logger.info('User account deleted', { userId });

  return apiResponse(res, 200, 'success', 'Account deleted successfully');
});