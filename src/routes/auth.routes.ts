import {Router} from 'express';

import {
  register,
  resendOTP,
  verifyOtp,
  login,
  refreshToken,
  logoutUser,
} from '../controllers/auth.controller.js';
import { uploadSingleFile } from '../middlewares/multer.middleware.js';
import {
  registerValidation,
  loginValidation,
  resendOtpValidation,
  verifyOtpValidation,
  refreshTokenValidation
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';

export const authRouter = Router();

authRouter.post('/register', registerValidation, validate, uploadSingleFile, register);
authRouter.post('/resend-otp', resendOtpValidation, validate, resendOTP);
authRouter.post('/verify-otp', verifyOtpValidation, validate, verifyOtp);
authRouter.post('/login', loginValidation, validate, login);
authRouter.post('/refresh-token', refreshTokenValidation, validate, refreshToken);
authRouter.post('/logout', logoutUser);