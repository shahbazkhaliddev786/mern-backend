import crypto from 'crypto';
import { User, OTP } from '../models/index.js';
import type { IUser } from '../models/auth.model.js';
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken
} from '../utils/auth.utils.js';
import { sendOTPEmail, type OtpEmailPurpose } from '../utils/email.js';
import bufferGenerator from '../utils/buffer.generator.js'
import cloudinary from '../utils/cloudinary.js';

const OTP_TTL_MS = 5 * 60 * 1000; // the OTP email promises 5 minutes
const MAX_OTP_ATTEMPTS = 5;

// A credential failure the user can act on (wrong code, wrong password,
// address taken); carries the HTTP status to answer with.
export class CredentialError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CredentialError';
    this.status = status;
  }
}

const generateOtp = (): string => crypto.randomInt(100000, 1000000).toString();
const hashOtp = (otp: string): string => crypto.createHash('sha256').update(otp).digest('hex');

// Checks a code against the email's OTP record. Every wrong guess counts toward
// the lockout, and the record is deleted once it is used or locked.
const consumeOtp = async (email: string, otp: string) => {
  const record = await OTP.findOne({ email });
  if (!record || record.expiresAt < new Date()) throw new CredentialError('Invalid or expired OTP');

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await OTP.deleteOne({ _id: record._id });
    throw new CredentialError('Too many attempts. Please request a new code.');
  }

  if (record.otp !== otp) {
    record.attempts += 1;
    await record.save();
    throw new CredentialError('Invalid or expired OTP');
  }

  await OTP.deleteOne({ _id: record._id });
};

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

export const sendOTP = async (email: string, purpose: OtpEmailPurpose = 'verify') => {
  const user = await User.findOne({ email });
  if (!user) throw new Error('User not found');

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await OTP.findOneAndUpdate(
    { email },
    { otp, expiresAt, attempts: 0 },
    { upsert: true }
  );

  await sendOTPEmail(email, otp, purpose);
};

export const verifyOTP = async (email: string, otp: string) => {
  await consumeOtp(email, otp);

  const user = await User.findOne({ email });
  if (!user) throw new Error('User not found');

  user.isVerified = true;
  await user.save();

  const accessToken = generateAccessToken(user._id.toString());
  const refreshToken = generateRefreshToken();
  const hashedRefresh = hashRefreshToken(refreshToken);

  user.refreshTokens.push(hashedRefresh);
  await user.save();

  return { accessToken, refreshToken, user };
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

// profile
export const getUserById = async (userId: string) => {
  return await User.findById(userId);
};

// logout
export const logout = async (refreshToken: string) => {
  const hashed = hashRefreshToken(refreshToken);
  await User.updateOne({ refreshTokens: hashed }, { $pull: { refreshTokens: hashed } });
};

// Update user profile
export const updateUserProfile = async (
  userId: string,
  name?: string,
  profilePictureFile?: Express.Multer.File
) => {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  if (name && name.trim()) {
    user.name = name.trim();
  }

  if (profilePictureFile) {
    try {
      const dataUri = bufferGenerator(profilePictureFile);
      if (!dataUri?.content) throw new Error('Failed to process image');

      const result = await cloudinary.uploader.upload(dataUri.content, {
        folder: 'profiles',
        public_id: user._id.toString(), // overwrite old image
        overwrite: true,
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      });

      user.profile = result.secure_url;
    } catch (error: any) {
      throw new Error('Failed to upload profile picture');
    }
  }

  await user.save();

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    profile: user.profile,
  };
};

export const forgotPassword = async (email: string) => {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    return { message: 'If email exists, OTP sent for password reset.' };
  }

  await sendOTP(email, 'reset');

  return { message: 'If email exists, OTP sent for password reset.' };
};

export const resetPasswordWithOtp = async (
  email: string,
  otp: string,
  newPassword: string
) => {
  await consumeOtp(email, otp);

  const user = await User.findOne({ email });
  if (!user) throw new Error('User not found');

  user.password = newPassword;
  user.refreshTokens = []; // a reset signs out every device
  await user.save();

  return { message: 'Password reset successfully' };
};

// Re-authenticates with the current password, then signs out every other
// device by replacing all refresh tokens with one new session for this device.
export const changeUserPassword = async (userId: string, currentPassword: string, newPassword: string) => {
  const user = await User.findById(userId);
  if (!user) throw new CredentialError('User not found', 404);
  if (!(await user.comparePassword(currentPassword))) throw new CredentialError('Current password is incorrect');

  const accessToken = generateAccessToken(user._id.toString());
  const refreshToken = generateRefreshToken();

  user.password = newPassword;
  user.refreshTokens = [hashRefreshToken(refreshToken)];
  await user.save();

  return { accessToken, refreshToken };
};

const clearPendingEmail = (user: IUser) => {
  user.pendingEmail = undefined;
  user.pendingEmailOtpHash = undefined;
  user.pendingEmailExpiresAt = undefined;
  user.pendingEmailAttempts = undefined;
};

// Step 1 of an email change: re-authenticate, then send a code to the new
// address. The address only changes once that code comes back (step 2).
export const requestUserEmailChange = async (userId: string, newEmail: string, currentPassword: string) => {
  const user = await User.findById(userId).select('+pendingEmailOtpHash');
  if (!user) throw new CredentialError('User not found', 404);
  if (!(await user.comparePassword(currentPassword))) throw new CredentialError('Current password is incorrect');
  if (newEmail === user.email) throw new CredentialError('That is already your email address');
  if (await User.exists({ email: newEmail })) throw new CredentialError('That email address is already in use');

  const otp = generateOtp();
  user.pendingEmail = newEmail;
  user.pendingEmailOtpHash = hashOtp(otp);
  user.pendingEmailExpiresAt = new Date(Date.now() + OTP_TTL_MS);
  user.pendingEmailAttempts = 0;
  await user.save();

  await sendOTPEmail(newEmail, otp, 'email_change');
};

// Step 2: check the code sent to the new address, then switch to it.
export const confirmUserEmailChange = async (userId: string, otp: string) => {
  const user = await User.findById(userId).select('+pendingEmailOtpHash');
  if (!user) throw new CredentialError('User not found', 404);

  const { pendingEmail, pendingEmailOtpHash, pendingEmailExpiresAt } = user;
  if (!pendingEmail || !pendingEmailOtpHash || !pendingEmailExpiresAt || pendingEmailExpiresAt < new Date()) {
    throw new CredentialError('No email change is pending, or the code has expired');
  }

  if ((user.pendingEmailAttempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    clearPendingEmail(user);
    await user.save();
    throw new CredentialError('Too many attempts. Please request a new code.');
  }

  if (hashOtp(otp) !== pendingEmailOtpHash) {
    user.pendingEmailAttempts = (user.pendingEmailAttempts ?? 0) + 1;
    await user.save();
    throw new CredentialError('Invalid code');
  }

  if (await User.exists({ email: pendingEmail, _id: { $ne: user._id } })) {
    clearPendingEmail(user);
    await user.save();
    throw new CredentialError('That email address is already in use');
  }

  user.email = pendingEmail;
  clearPendingEmail(user);
  await user.save();

  return { email: user.email };
};

// Delete account (permanent)
export const deleteUserAccount = async (
  userId: string,
  password: string
) => {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const isMatch = await user.comparePassword(password);
  if (!isMatch) throw new Error('Password confirmation failed');

  if (user.profile) {
    const publicId = `profiles/${user._id}`;
    await cloudinary.uploader.destroy(publicId).catch(() => {
    });
  }

  await User.deleteOne({ _id: userId });

  return { message: 'Account deleted permanently' };
};