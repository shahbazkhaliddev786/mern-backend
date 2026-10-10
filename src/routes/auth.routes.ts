import {Router} from 'express';

import {
  register,
  resendOTP,
  verifyOtp,
  getProfile,
  login,
  refreshToken,
  logoutUser,
  updateProfile,
  forgetPassword,
  resetPassword,
  deleteAccount,
  changePassword,
  requestEmailChange,
  confirmEmailChange
} from '../controllers/index.js';
import { uploadSingleFile } from '../middlewares/multer.middleware.js';
import {
  registerValidation,
  loginValidation,
  resendOtpValidation,
  verifyOtpValidation,
  refreshTokenValidation,
  forgotPasswordValidation,
  resetPasswordWithOtpValidation,
  changePasswordValidation,
  requestEmailChangeValidation,
  confirmEmailChangeValidation
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';
import rateLimiterMiddleware from '../middlewares/rate.lim.js'
import { authMiddleware } from '../middlewares/auth.middleware.js';

export const authRouter = Router();

authRouter.post('/register', uploadSingleFile, registerValidation, validate, register);
authRouter.post('/resend-otp', resendOtpValidation, validate, rateLimiterMiddleware, resendOTP);
authRouter.post('/verify-otp', verifyOtpValidation, validate, rateLimiterMiddleware, verifyOtp);
authRouter.get('/profile', authMiddleware, getProfile);
authRouter.post('/login', loginValidation, validate, rateLimiterMiddleware, login);
authRouter.post('/refresh-token', refreshTokenValidation, validate, rateLimiterMiddleware, refreshToken);
authRouter.post('/logout', logoutUser);
authRouter.patch('/profile', authMiddleware, uploadSingleFile, updateProfile);
authRouter.patch('/password', authMiddleware, changePasswordValidation, validate, rateLimiterMiddleware, changePassword);
authRouter.post('/email-change', authMiddleware, requestEmailChangeValidation, validate, rateLimiterMiddleware, requestEmailChange);
authRouter.post('/email-change/verify', authMiddleware, confirmEmailChangeValidation, validate, rateLimiterMiddleware, confirmEmailChange);
authRouter.post('/forgot-password', forgotPasswordValidation, validate, rateLimiterMiddleware, forgetPassword);
authRouter.post('/reset-password', resetPasswordWithOtpValidation, validate, rateLimiterMiddleware, resetPassword);
authRouter.delete('/delete-account', authMiddleware, deleteAccount);
