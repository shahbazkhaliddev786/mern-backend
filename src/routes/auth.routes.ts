import {Router} from 'express';

import {
  register,
  resendOTP,
  verifyOtp,
  login,
  refreshToken,
  logoutUser,
  updateProfile,
  forgetPassword,
  resetPassword,
  deleteAccount
} from '../controllers/index.js';
import { uploadSingleFile } from '../middlewares/multer.middleware.js';
import {
  registerValidation,
  loginValidation,
  resendOtpValidation,
  verifyOtpValidation,
  refreshTokenValidation,
  forgotPasswordValidation,
  resetPasswordWithOtpValidation
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';
import rateLimiterMiddleware from '../middlewares/rate.lim.js'
import { authMiddleware } from '../middlewares/auth.middleware.js';

export const authRouter = Router();

authRouter.post('/register', registerValidation, validate, uploadSingleFile, register);
authRouter.post('/resend-otp', resendOtpValidation, validate, rateLimiterMiddleware, resendOTP);
authRouter.post('/verify-otp', verifyOtpValidation, validate, verifyOtp);
authRouter.post('/login', loginValidation, validate, rateLimiterMiddleware, login);
authRouter.post('/refresh-token', refreshTokenValidation, validate, rateLimiterMiddleware, refreshToken);
authRouter.post('/logout', logoutUser);
authRouter.patch('/profile', authMiddleware, uploadSingleFile, updateProfile);
authRouter.post('/forgot-password', forgotPasswordValidation, validate, forgetPassword);
authRouter.post('/reset-password', resetPasswordWithOtpValidation, validate, resetPassword);
authRouter.delete('/delete-account', authMiddleware, deleteAccount);