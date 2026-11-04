// Sign-up codes, sign-in, refresh tokens, password and email changes against Postgres (spec 023).
// The mailer and Cloudinary are stand-ins; the codes are read from what the mailer was asked to send.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import config from '../config/config';
import { getDb } from '../db/client';
import { otps, users } from '../db/schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';
import { hashRefreshToken } from '../utils/auth.utils';
import {
  changeUserPassword,
  confirmUserEmailChange,
  CredentialError,
  loginWithPassword,
  logout,
  refreshAccessToken,
  registerUser,
  requestUserEmailChange,
  resetPasswordWithOtp,
  sendOTP,
  UnverifiedAccountError,
  verifyOTP,
} from './auth.service';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

const mail = vi.hoisted(() => ({ sendOTPEmail: vi.fn(async (_to: string, _otp: string, _purpose?: string) => {}) }));
vi.mock('../utils/email.js', () => ({ sendOTPEmail: mail.sendOTPEmail }));
vi.mock('../utils/cloudinary.js', () => ({ default: {} }));

const EMAIL = 'jane@example.com';
const NEW_EMAIL = 'jane.new@example.com';

// The code in the most recent email the mailer stand-in was asked to send.
const lastCode = () => mail.sendOTPEmail.mock.calls.at(-1)![1];
const wrongCodeFor = (code: string) => (code === '111111' ? '222222' : '111111');

describe.skipIf(!TEST_DATABASE_URL)('auth on Postgres', () => {
  let testDb: TestDatabase;
  let USER_ID = '';

  const addUser = async (overrides: Partial<typeof users.$inferInsert> = {}) => {
    const [user] = await getDb()
      .insert(users)
      .values({ name: 'Jane', email: EMAIL, password: await bcrypt.hash('Old-pass1!', 4), refreshTokens: ['existing-session'], ...overrides })
      .returning();
    return user!.id;
  };
  const userRow = async (id = USER_ID) => (await getDb().select().from(users).where(eq(users.id, id)))[0]!;

  beforeAll(async () => {
    testDb = await createTestDatabase('auth');
  }, 60_000);

  beforeEach(async () => {
    await getDb().delete(users);
    await getDb().delete(otps);
    mail.sendOTPEmail.mockClear();
    config.JWT_SECRET = 'test-secret';
    USER_ID = await addUser();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  describe('one-time codes (sign-up and password reset)', () => {
    it('emails a 6-digit code for the requested purpose', async () => {
      await sendOTP(EMAIL, 'reset');

      expect(mail.sendOTPEmail).toHaveBeenCalledWith(EMAIL, expect.stringMatching(/^\d{6}$/), 'reset');
      const [record] = await getDb().select().from(otps).where(eq(otps.email, EMAIL));
      expect(record?.otp).toBe(lastCode());
    });

    it('a new code replaces the previous one', async () => {
      await sendOTP(EMAIL);
      const first = lastCode();
      await sendOTP(EMAIL);

      expect(await getDb().select().from(otps)).toHaveLength(1);
      if (first !== lastCode()) await expect(verifyOTP(EMAIL, first)).rejects.toThrow('Invalid or expired OTP');
    });

    it('locks the code after 5 wrong guesses, even if the next one is right', async () => {
      await sendOTP(EMAIL);
      const code = lastCode();

      for (let i = 0; i < 5; i++) {
        await expect(verifyOTP(EMAIL, wrongCodeFor(code))).rejects.toThrow('Invalid or expired OTP');
      }
      await expect(verifyOTP(EMAIL, code)).rejects.toThrow('Too many attempts');
    });

    it('rejects an expired code', async () => {
      await sendOTP(EMAIL);
      await getDb()
        .update(otps)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(otps.email, EMAIL));

      await expect(verifyOTP(EMAIL, lastCode())).rejects.toBeInstanceOf(CredentialError);
    });

    it('verifies the account with the right code, which then cannot be reused', async () => {
      await sendOTP(EMAIL);
      const code = lastCode();

      const result = await verifyOTP(EMAIL, code);

      expect((await userRow()).isVerified).toBe(true);
      expect(result.accessToken).toBeTruthy();
      expect(result.user).toMatchObject({ _id: USER_ID, email: EMAIL });
      expect(result.user).not.toHaveProperty('password');
      await expect(verifyOTP(EMAIL, code)).rejects.toThrow('Invalid or expired OTP');
    });

    it('resets the password and signs out every device', async () => {
      await sendOTP(EMAIL, 'reset');

      await resetPasswordWithOtp(EMAIL, lastCode(), 'New-pass1!');

      const user = await userRow();
      expect(await bcrypt.compare('New-pass1!', user.password)).toBe(true);
      expect(user.refreshTokens).toEqual([]);
    });

    it('marks an unverified account verified after a password reset', async () => {
      await sendOTP(EMAIL, 'reset');

      await resetPasswordWithOtp(EMAIL, lastCode(), 'New-pass1!');

      expect((await userRow()).isVerified).toBe(true);
    });
  });

  describe('registerUser', () => {
    it('stores a hashed password and a lowercase email, then sends the code', async () => {
      await registerUser('  Sam  ', 'Sam@Example.com', 'Sam-pass1!');

      const [sam] = await getDb().select().from(users).where(eq(users.email, 'sam@example.com'));
      expect(sam).toMatchObject({ name: 'Sam', isVerified: false, role: 'user' });
      expect(await bcrypt.compare('Sam-pass1!', sam!.password)).toBe(true);
      expect(mail.sendOTPEmail).toHaveBeenCalledWith('sam@example.com', expect.stringMatching(/^\d{6}$/), 'verify');
    });

    it('refuses an address that is taken, even when two sign-ups race', async () => {
      await expect(registerUser('Jane', EMAIL, 'Other-pass1!')).rejects.toThrow('Email already registered');

      const both = await Promise.allSettled([registerUser('A', 'race@example.com', 'Race-pass1!'), registerUser('B', 'race@example.com', 'Race-pass1!')]);
      expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(String((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toContain('Email already registered');
    });
  });

  describe('loginWithPassword', () => {
    it('signs in a verified account, whatever the case of the email', async () => {
      await getDb().update(users).set({ isVerified: true }).where(eq(users.id, USER_ID));

      const result = await loginWithPassword('Jane@Example.com', 'Old-pass1!');

      expect(result.user).toMatchObject({ _id: USER_ID, name: 'Jane' });
      expect((await userRow()).refreshTokens).toEqual(['existing-session', hashRefreshToken(result.refreshToken)]);
    });

    it('sends a fresh code and asks for verification when the password is right', async () => {
      await expect(loginWithPassword(EMAIL, 'Old-pass1!')).rejects.toBeInstanceOf(UnverifiedAccountError);
      expect(mail.sendOTPEmail).toHaveBeenCalledWith(EMAIL, expect.stringMatching(/^\d{6}$/), 'verify');

      // The new code completes verification and signs the user in.
      await expect(verifyOTP(EMAIL, lastCode())).resolves.toHaveProperty('accessToken');
    });

    it('sends nothing when the password is wrong', async () => {
      await expect(loginWithPassword(EMAIL, 'wrong')).rejects.toThrow('Invalid credentials');
      expect(mail.sendOTPEmail).not.toHaveBeenCalled();
    });
  });

  describe('refresh tokens', () => {
    it('rotates: the old token stops working and the new one works', async () => {
      await getDb().update(users).set({ refreshTokens: [hashRefreshToken('device-token')] }).where(eq(users.id, USER_ID));

      const next = await refreshAccessToken('device-token');

      expect(next.accessToken).toBeTruthy();
      await expect(refreshAccessToken('device-token')).rejects.toThrow('Invalid refresh token');
      await expect(refreshAccessToken(next.refreshToken)).resolves.toHaveProperty('accessToken');
    });

    it('a token works once, even when two refreshes race', async () => {
      await getDb().update(users).set({ refreshTokens: [hashRefreshToken('device-token')] }).where(eq(users.id, USER_ID));

      const both = await Promise.allSettled([refreshAccessToken('device-token'), refreshAccessToken('device-token')]);

      expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((await userRow()).refreshTokens).toHaveLength(1);
    });

    it('logout removes only that device', async () => {
      await getDb()
        .update(users)
        .set({ refreshTokens: [hashRefreshToken('phone'), hashRefreshToken('laptop')] })
        .where(eq(users.id, USER_ID));

      await logout('phone');

      expect((await userRow()).refreshTokens).toEqual([hashRefreshToken('laptop')]);
    });
  });

  describe('changeUserPassword', () => {
    it('requires the current password', async () => {
      await expect(changeUserPassword(USER_ID, 'wrong', 'New-pass1!')).rejects.toThrow('Current password is incorrect');
    });

    it('sets the new password and signs out other devices, but keeps this one signed in', async () => {
      const tokens = await changeUserPassword(USER_ID, 'Old-pass1!', 'New-pass1!');

      const user = await userRow();
      expect(await bcrypt.compare('New-pass1!', user.password)).toBe(true);
      expect(tokens.accessToken).toBeTruthy();
      // Only the new session's (hashed) refresh token survives.
      expect(user.refreshTokens).toEqual([hashRefreshToken(tokens.refreshToken)]);
    });
  });

  describe('email change', () => {
    it('refuses a wrong password, the current address and a taken address', async () => {
      await addUser({ email: 'taken@example.com' });

      await expect(requestUserEmailChange(USER_ID, NEW_EMAIL, 'wrong')).rejects.toThrow('Current password is incorrect');
      await expect(requestUserEmailChange(USER_ID, EMAIL, 'Old-pass1!')).rejects.toThrow('already your email');
      await expect(requestUserEmailChange(USER_ID, 'taken@example.com', 'Old-pass1!')).rejects.toThrow('already in use');
      expect(mail.sendOTPEmail).not.toHaveBeenCalled();
    });

    it('emails a code to the new address and switches once that code comes back', async () => {
      await requestUserEmailChange(USER_ID, NEW_EMAIL, 'Old-pass1!');

      expect(mail.sendOTPEmail).toHaveBeenCalledWith(NEW_EMAIL, expect.stringMatching(/^\d{6}$/), 'email_change');
      const pending = await userRow();
      expect(pending.email).toBe(EMAIL); // unchanged until confirmed
      expect(pending.pendingEmailOtpHash).not.toBe(lastCode()); // stored hashed

      await expect(confirmUserEmailChange(USER_ID, lastCode())).resolves.toEqual({ email: NEW_EMAIL });
      const user = await userRow();
      expect(user.email).toBe(NEW_EMAIL);
      expect(user.pendingEmail).toBeNull();
    });

    it('cancels the change after 5 wrong codes', async () => {
      await requestUserEmailChange(USER_ID, NEW_EMAIL, 'Old-pass1!');
      const code = lastCode();

      for (let i = 0; i < 5; i++) {
        await expect(confirmUserEmailChange(USER_ID, wrongCodeFor(code))).rejects.toThrow('Invalid code');
      }
      await expect(confirmUserEmailChange(USER_ID, code)).rejects.toThrow('Too many attempts');
      const user = await userRow();
      expect(user.pendingEmail).toBeNull();
      expect(user.email).toBe(EMAIL);
    });

    it('rejects an expired code', async () => {
      await requestUserEmailChange(USER_ID, NEW_EMAIL, 'Old-pass1!');
      await getDb()
        .update(users)
        .set({ pendingEmailExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(users.id, USER_ID));

      await expect(confirmUserEmailChange(USER_ID, lastCode())).rejects.toThrow('expired');
    });

    it('refuses the switch when another account took the address meanwhile', async () => {
      await requestUserEmailChange(USER_ID, NEW_EMAIL, 'Old-pass1!');
      await addUser({ email: NEW_EMAIL });

      await expect(confirmUserEmailChange(USER_ID, lastCode())).rejects.toThrow('already in use');
      expect((await userRow()).email).toBe(EMAIL);
    });
  });
});
