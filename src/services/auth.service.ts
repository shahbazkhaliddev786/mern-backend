import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb, isUniqueViolation } from '../db/client.js';
import { otps, users } from '../db/schema/index.js';
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken
} from '../utils/auth.utils.js';
import { sendOTPEmail, type OtpEmailPurpose } from '../utils/email.js';
import bufferGenerator from '../utils/buffer.generator.js'
import cloudinary from '../utils/cloudinary.js';
import { isId } from '../utils/ids.js';
import { apiUser, compact } from './shapes.js';

const OTP_TTL_MS = 5 * 60 * 1000; // the OTP email promises 5 minutes
const MAX_OTP_ATTEMPTS = 5;
const PASSWORD_HASH_ROUNDS = 12;

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

// Right password, but the email was never verified. A fresh code has been
// sent, so the client can take the user straight to the verification step.
export class UnverifiedAccountError extends CredentialError {
  constructor() {
    super('Please verify your email first. We sent a new code to your email address.', 403);
    this.name = 'UnverifiedAccountError';
  }
}

type UserRow = typeof users.$inferSelect;

const generateOtp = (): string => crypto.randomInt(100000, 1000000).toString();
const hashOtp = (otp: string): string => crypto.createHash('sha256').update(otp).digest('hex');
const hashPassword = (password: string) => bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
const comparePassword = (user: UserRow, candidatePassword: string) => bcrypt.compare(candidatePassword, user.password);

// Emails are stored trimmed and lowercase, and looked up the same way, as the Mongoose schema did.
const normalizeEmail = (email: string) => email.trim().toLowerCase();

const findUserByEmail = async (email: string): Promise<UserRow | undefined> =>
  (await getDb().select().from(users).where(eq(users.email, normalizeEmail(email))))[0];
const findUser = async (userId: string): Promise<UserRow | undefined> =>
  isId(userId) ? (await getDb().select().from(users).where(eq(users.id, userId)))[0] : undefined;

/** Adds one more signed-in device's refresh token. */
const withRefreshToken = (hashed: string) => sql`array_append(${users.refreshTokens}, ${hashed})`;
/** The users holding this refresh token (at most one). */
const holdsRefreshToken = (hashed: string) => sql`${users.refreshTokens} @> array[${hashed}]::text[]`;

const NO_PENDING_EMAIL = { pendingEmail: null, pendingEmailOtpHash: null, pendingEmailExpiresAt: null, pendingEmailAttempts: null };

// Checks a code against the email's OTP record. Every wrong guess counts toward
// the lockout, and the record is deleted once it is used or locked.
const consumeOtp = async (email: string, otp: string) => {
  const db = getDb();
  const [record] = await db.select().from(otps).where(eq(otps.email, normalizeEmail(email)));
  if (!record || record.expiresAt < new Date()) throw new CredentialError('Invalid or expired OTP');

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await db.delete(otps).where(eq(otps.id, record.id));
    throw new CredentialError('Too many attempts. Please request a new code.');
  }

  if (record.otp !== otp) {
    await db
      .update(otps)
      .set({ attempts: sql`${otps.attempts} + 1` })
      .where(eq(otps.id, record.id));
    throw new CredentialError('Invalid or expired OTP');
  }

  // Only one use of a code wins, even when the same code arrives twice at once.
  const used = await db.delete(otps).where(eq(otps.id, record.id)).returning({ id: otps.id });
  if (used.length === 0) throw new CredentialError('Invalid or expired OTP');
};

export const registerUser = async (
  name: string,
  email: string,
  password: string,
  profile?: string
) => {
  const existingUser = await findUserByEmail(email);
  if (existingUser) throw new Error('Email already registered');

  const [user] = await getDb()
    .insert(users)
    .values({
      name: name.trim(),
      email: normalizeEmail(email),
      password: await hashPassword(password),
      profile: profile ?? null,
    })
    .returning()
    .catch((error: unknown) => {
      // Another sign-up for the same address got there first.
      if (isUniqueViolation(error)) throw new Error('Email already registered');
      throw error;
    });

  await sendOTP(user!.email);

  return { message: 'Registration successful. OTP sent to email.' };
};

export const sendOTP = async (email: string, purpose: OtpEmailPurpose = 'verify') => {
  const user = await findUserByEmail(email);
  if (!user) throw new Error('User not found');

  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  // A new code replaces the address's previous one.
  await getDb()
    .insert(otps)
    .values({ email: normalizeEmail(email), otp, expiresAt, attempts: 0 })
    .onConflictDoUpdate({ target: otps.email, set: { otp, expiresAt, attempts: 0 } });

  await sendOTPEmail(email, otp, purpose);
};

export const verifyOTP = async (email: string, otp: string) => {
  await consumeOtp(email, otp);

  const refreshToken = generateRefreshToken();
  const hashedRefresh = hashRefreshToken(refreshToken);

  const [user] = await getDb()
    .update(users)
    .set({ isVerified: true, refreshTokens: withRefreshToken(hashedRefresh) })
    .where(eq(users.email, normalizeEmail(email)))
    .returning();
  if (!user) throw new Error('User not found');

  const accessToken = generateAccessToken(user.id);

  return { accessToken, refreshToken, user: apiUser(user) };
};

export const loginWithPassword = async (email: string, password: string) => {
  const user = await findUserByEmail(email);
  if (!user || !(await comparePassword(user, password))) {
    throw new Error('Invalid credentials');
  }

  // Without this, a user who left sign-up before entering the code could
  // never get back: sign-in refused them and sign-up said the email was taken.
  if (!user.isVerified) {
    await sendOTP(user.email);
    throw new UnverifiedAccountError();
  }

  const accessToken = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken();
  const hashedRefresh = hashRefreshToken(refreshToken);

  const [signedIn] = await getDb()
    .update(users)
    .set({ refreshTokens: withRefreshToken(hashedRefresh) })
    .where(eq(users.id, user.id))
    .returning();

  return { accessToken, refreshToken, user: apiUser(signedIn ?? user) };
};

export const refreshAccessToken = async (refreshToken: string) => {
  if (!refreshToken) throw new Error('Refresh token is required');

  const hashed = hashRefreshToken(refreshToken);
  const newRefreshToken = generateRefreshToken();
  const newHashed = hashRefreshToken(newRefreshToken);

  // Rotate in one statement: the old token is swapped for the new one, so a token can only be
  // used once even when two refreshes race.
  const [user] = await getDb()
    .update(users)
    .set({ refreshTokens: sql`array_append(array_remove(${users.refreshTokens}, ${hashed}), ${newHashed})` })
    .where(holdsRefreshToken(hashed))
    .returning({ id: users.id });
  if (!user) throw new Error('Invalid refresh token');

  return {
    accessToken: generateAccessToken(user.id),
    refreshToken: newRefreshToken,
  };
};

// profile: the user without the password, tokens or pending-email secrets, or null.
export const getUserById = async (userId: string) => {
  const user = await findUser(userId);
  return user ? apiUser(user) : null;
};

// logout
export const logout = async (refreshToken: string) => {
  const hashed = hashRefreshToken(refreshToken);
  await getDb()
    .update(users)
    .set({ refreshTokens: sql`array_remove(${users.refreshTokens}, ${hashed})` })
    .where(holdsRefreshToken(hashed));
};

// Update user profile
export const updateUserProfile = async (
  userId: string,
  name?: string,
  profilePictureFile?: Express.Multer.File
) => {
  const user = await findUser(userId);
  if (!user) throw new Error('User not found');

  const changes: Partial<Pick<UserRow, 'name' | 'profile'>> = {};

  if (name && name.trim()) {
    changes.name = name.trim();
  }

  if (profilePictureFile) {
    try {
      const dataUri = bufferGenerator(profilePictureFile);
      if (!dataUri?.content) throw new Error('Failed to process image');

      const result = await cloudinary.uploader.upload(dataUri.content, {
        folder: 'profiles',
        public_id: user.id, // overwrite old image
        overwrite: true,
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      });

      changes.profile = result.secure_url;
    } catch {
      throw new Error('Failed to upload profile picture');
    }
  }

  const [updated] = Object.keys(changes).length
    ? await getDb().update(users).set(changes).where(eq(users.id, user.id)).returning()
    : [user];

  return compact({
    id: updated!.id,
    name: updated!.name,
    email: updated!.email,
    profile: updated!.profile,
  });
};

export const forgotPassword = async (email: string) => {
  const user = await findUserByEmail(email);
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

  const [user] = await getDb()
    .update(users)
    .set({
      password: await hashPassword(newPassword),
      refreshTokens: [], // a reset signs out every device
      isVerified: true, // the emailed code proves the address, same as sign-up verification
    })
    .where(eq(users.email, normalizeEmail(email)))
    .returning({ id: users.id });
  if (!user) throw new Error('User not found');

  return { message: 'Password reset successfully' };
};

// Re-authenticates with the current password, then signs out every other
// device by replacing all refresh tokens with one new session for this device.
export const changeUserPassword = async (userId: string, currentPassword: string, newPassword: string) => {
  const user = await findUser(userId);
  if (!user) throw new CredentialError('User not found', 404);
  if (!(await comparePassword(user, currentPassword))) throw new CredentialError('Current password is incorrect');

  const accessToken = generateAccessToken(user.id);
  const refreshToken = generateRefreshToken();

  await getDb()
    .update(users)
    .set({ password: await hashPassword(newPassword), refreshTokens: [hashRefreshToken(refreshToken)] })
    .where(eq(users.id, user.id));

  return { accessToken, refreshToken };
};

// Step 1 of an email change: re-authenticate, then send a code to the new
// address. The address only changes once that code comes back (step 2).
export const requestUserEmailChange = async (userId: string, newEmail: string, currentPassword: string) => {
  const user = await findUser(userId);
  if (!user) throw new CredentialError('User not found', 404);
  if (!(await comparePassword(user, currentPassword))) throw new CredentialError('Current password is incorrect');
  const pendingEmail = normalizeEmail(newEmail);
  if (pendingEmail === user.email) throw new CredentialError('That is already your email address');
  if (await findUserByEmail(pendingEmail)) throw new CredentialError('That email address is already in use');

  const otp = generateOtp();
  await getDb()
    .update(users)
    .set({
      pendingEmail,
      pendingEmailOtpHash: hashOtp(otp),
      pendingEmailExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      pendingEmailAttempts: 0,
    })
    .where(eq(users.id, user.id));

  await sendOTPEmail(newEmail, otp, 'email_change');
};

// Step 2: check the code sent to the new address, then switch to it.
export const confirmUserEmailChange = async (userId: string, otp: string) => {
  const db = getDb();
  const user = await findUser(userId);
  if (!user) throw new CredentialError('User not found', 404);

  const { pendingEmail, pendingEmailOtpHash, pendingEmailExpiresAt } = user;
  if (!pendingEmail || !pendingEmailOtpHash || !pendingEmailExpiresAt || pendingEmailExpiresAt < new Date()) {
    throw new CredentialError('No email change is pending, or the code has expired');
  }

  const clearPendingEmail = () => db.update(users).set(NO_PENDING_EMAIL).where(eq(users.id, user.id));

  if ((user.pendingEmailAttempts ?? 0) >= MAX_OTP_ATTEMPTS) {
    await clearPendingEmail();
    throw new CredentialError('Too many attempts. Please request a new code.');
  }

  if (hashOtp(otp) !== pendingEmailOtpHash) {
    await db
      .update(users)
      .set({ pendingEmailAttempts: sql`coalesce(${users.pendingEmailAttempts}, 0) + 1` })
      .where(eq(users.id, user.id));
    throw new CredentialError('Invalid code');
  }

  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, pendingEmail), ne(users.id, user.id)));
  const switched = taken
    ? false
    : await db
        .update(users)
        .set({ email: pendingEmail, ...NO_PENDING_EMAIL })
        .where(eq(users.id, user.id))
        .then(() => true)
        .catch((error: unknown) => {
          // Another account took the address in the meantime.
          if (isUniqueViolation(error)) return false;
          throw error;
        });
  if (!switched) {
    await clearPendingEmail();
    throw new CredentialError('That email address is already in use');
  }

  return { email: pendingEmail };
};

// Delete account (permanent)
export const deleteUserAccount = async (
  userId: string,
  password: string
) => {
  const user = await findUser(userId);
  if (!user) throw new Error('User not found');

  const isMatch = await comparePassword(user, password);
  if (!isMatch) throw new Error('Password confirmation failed');

  if (user.profile) {
    const publicId = `profiles/${user.id}`;
    await cloudinary.uploader.destroy(publicId).catch(() => {
    });
  }

  // Their cart, pending checkouts and uploads go with them; their orders stay, without a user.
  await getDb().delete(users).where(eq(users.id, user.id));

  return { message: 'Account deleted permanently' };
};
