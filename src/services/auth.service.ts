import { User, OTP } from '../models/index.js';
import { 
  generateAccessToken, 
  generateRefreshToken, 
  hashRefreshToken 
} from '../utils/auth.utils.js';
import { sendOTPEmail } from '../utils/email.js';

export const registerUser = async (
  name: string,
  email: string,
  password: string,
  profile?: string
) => {
  const existingUser = await User.findOne({ email });
  if (existingUser) throw new Error('Email already registered');

  const user = new User({
    name,
    email,
    password,
    profile,
  });

  await user.save();

  await sendOTP(user.email);

  return { message: 'Registration successful. OTP sent to email.' };
};

export const sendOTP = async (email: string) => {
  const user = await User.findOne({ email });
  if (!user) throw new Error('User not found');

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  await OTP.findOneAndUpdate(
    { email },
    { otp, expiresAt, attempts: 0 },
    { upsert: true }
  );

  await sendOTPEmail(email, otp);
};

export const verifyOTP = async (email: string, otp: string) => {
  const otpRecord = await OTP.findOne({ email, otp });
  if (!otpRecord) throw new Error('Invalid or expired OTP');
  if (otpRecord.attempts >= 5) throw new Error('Too many attempts');

  const user = await User.findOne({ email });
  if (!user) throw new Error('User not found');

  user.isVerified = true;
  await user.save();

  await OTP.deleteOne({ email });

  const accessToken = generateAccessToken(user._id.toString());
  const refreshToken = generateRefreshToken();
  const hashedRefresh = hashRefreshToken(refreshToken);

  user.refreshTokens.push(hashedRefresh);
  await user.save();

  return { accessToken, refreshToken };
};

export const loginWithPassword = async (email: string, password: string) => {
  const user = await User.findOne({ email });
  if (!user || !(await user.comparePassword(password))) {
    throw new Error('Invalid credentials');
  }

  if (!user.isVerified) throw new Error('Please verify your email first');

  const accessToken = generateAccessToken(user._id.toString());
  const refreshToken = generateRefreshToken();
  const hashedRefresh = hashRefreshToken(refreshToken);

  user.refreshTokens.push(hashedRefresh);
  await user.save();

  return { accessToken, refreshToken, user };
};

export const refreshAccessToken = async (refreshToken: string) => {
  if (!refreshToken) throw new Error('Refresh token is required');

  const hashed = hashRefreshToken(refreshToken);

  const user = await User.findOne({ refreshTokens: hashed });
  if (!user) throw new Error('Invalid refresh token');

  // Rotate: remove old token
  user.refreshTokens = user.refreshTokens.filter(t => t !== hashed);

  // Generate new tokens
  const newAccessToken = generateAccessToken(user._id.toString());
  const newRefreshToken = generateRefreshToken();
  const newHashed = hashRefreshToken(newRefreshToken);

  user.refreshTokens.push(newHashed);
  await user.save();

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  };
};

export const logout = async (refreshToken: string) => {
  const hashed = hashRefreshToken(refreshToken);
  await User.updateOne({ refreshTokens: hashed }, { $pull: { refreshTokens: hashed } });
};