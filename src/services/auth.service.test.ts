import { describe, it, expect, vi, beforeEach } from 'vitest';
import config from '../config/config';
import { hashRefreshToken } from '../utils/auth.utils';
import {
  changeUserPassword,
  confirmUserEmailChange,
  CredentialError,
  requestUserEmailChange,
  resetPasswordWithOtp,
  sendOTP,
  verifyOTP,
} from './auth.service';

// In-memory stand-ins for the User and OTP models and the mailer, so the auth
// flows run without a database or SMTP. Only the calls the service makes exist.
const db = vi.hoisted(() => {
  const users = new Map<string, any>();
  const otps = new Map<string, any>();
  const sendOTPEmail = vi.fn(async (_to: string, _otp: string, _purpose?: string) => {});

  // A query that can be awaited directly or narrowed with .select().
  const query = (value: unknown) => ({
    select: async () => value,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  });

  const User = {
    findById: (id: string) => query(users.get(String(id)) ?? null),
    findOne: ({ email }: { email: string }) => query([...users.values()].find((u) => u.email === email) ?? null),
    exists: async ({ email, _id }: { email: string; _id?: { $ne: string } }) =>
      [...users.values()].some((u) => u.email === email && u._id !== _id?.$ne) ? { _id: 'match' } : null,
  };

  const OTP = {
    findOne: async ({ email }: { email: string }) => otps.get(email) ?? null,
    findOneAndUpdate: async ({ email }: { email: string }, update: object) => {
      const record: any = { _id: `otp-${email}`, email, ...update, async save() { return record; } };
      otps.set(email, record);
    },
    deleteOne: async ({ _id }: { _id: string }) => {
      for (const [email, record] of otps) if (record._id === _id) otps.delete(email);
    },
  };

  return { users, otps, sendOTPEmail, User, OTP };
});

vi.mock('../models/index.js', () => ({ User: db.User, OTP: db.OTP }));
vi.mock('../utils/email.js', () => ({ sendOTPEmail: db.sendOTPEmail }));
vi.mock('../utils/cloudinary.js', () => ({ default: {} }));

const USER_ID = 'user-1';
const EMAIL = 'jane@example.com';
const NEW_EMAIL = 'jane.new@example.com';

const addUser = (overrides: Record<string, unknown> = {}) => {
  const user: any = {
    _id: USER_ID,
    email: EMAIL,
    password: 'Old-pass1!',
    isVerified: false,
    refreshTokens: ['existing-session'],
    async comparePassword(candidate: string) {
      return candidate === user.password;
    },
    async save() {
      return user;
    },
    ...overrides,
  };
  db.users.set(user._id, user);
  return user;
};

// The code in the most recent email the mailer mock was asked to send.
const lastCode = () => db.sendOTPEmail.mock.calls.at(-1)![1];
const wrongCodeFor = (code: string) => (code === '111111' ? '222222' : '111111');

beforeEach(() => {
  db.users.clear();
  db.otps.clear();
  db.sendOTPEmail.mockClear();
  config.JWT_SECRET = 'test-secret';
});

describe('one-time codes (sign-up and password reset)', () => {
  it('emails a 6-digit code for the requested purpose', async () => {
    addUser();
    await sendOTP(EMAIL, 'reset');

    expect(db.sendOTPEmail).toHaveBeenCalledWith(EMAIL, expect.stringMatching(/^\d{6}$/), 'reset');
    expect(db.otps.get(EMAIL).otp).toBe(lastCode());
  });

  it('locks the code after 5 wrong guesses, even if the next one is right', async () => {
    addUser();
    await sendOTP(EMAIL);
    const code = lastCode();

    for (let i = 0; i < 5; i++) {
      await expect(verifyOTP(EMAIL, wrongCodeFor(code))).rejects.toThrow('Invalid or expired OTP');
    }
    await expect(verifyOTP(EMAIL, code)).rejects.toThrow('Too many attempts');
  });

  it('rejects an expired code', async () => {
    addUser();
    await sendOTP(EMAIL);
    db.otps.get(EMAIL).expiresAt = new Date(Date.now() - 1000);

    await expect(verifyOTP(EMAIL, lastCode())).rejects.toBeInstanceOf(CredentialError);
  });

  it('verifies the account with the right code, which then cannot be reused', async () => {
    const user = addUser();
    await sendOTP(EMAIL);
    const code = lastCode();

    const result = await verifyOTP(EMAIL, code);

    expect(user.isVerified).toBe(true);
    expect(result.accessToken).toBeTruthy();
    await expect(verifyOTP(EMAIL, code)).rejects.toThrow('Invalid or expired OTP');
  });

  it('resets the password and signs out every device', async () => {
    const user = addUser();
    await sendOTP(EMAIL, 'reset');

    await resetPasswordWithOtp(EMAIL, lastCode(), 'New-pass1!');

    expect(user.password).toBe('New-pass1!');
    expect(user.refreshTokens).toEqual([]);
  });
});

describe('changeUserPassword', () => {
  it('requires the current password', async () => {
    addUser();

    await expect(changeUserPassword(USER_ID, 'wrong', 'New-pass1!')).rejects.toThrow('Current password is incorrect');
  });

  it('sets the new password and signs out other devices, but keeps this one signed in', async () => {
    const user = addUser();

    const tokens = await changeUserPassword(USER_ID, 'Old-pass1!', 'New-pass1!');

    expect(user.password).toBe('New-pass1!');
    expect(tokens.accessToken).toBeTruthy();
    // Only the new session's (hashed) refresh token survives.
    expect(user.refreshTokens).toEqual([hashRefreshToken(tokens.refreshToken)]);
  });
});

describe('email change', () => {
  it('refuses a wrong password, the current address and a taken address', async () => {
    addUser();
    addUser({ _id: 'user-2', email: 'taken@example.com' });

    await expect(requestUserEmailChange(USER_ID, NEW_EMAIL, 'wrong')).rejects.toThrow('Current password is incorrect');
    await expect(requestUserEmailChange(USER_ID, EMAIL, 'Old-pass1!')).rejects.toThrow('already your email');
    await expect(requestUserEmailChange(USER_ID, 'taken@example.com', 'Old-pass1!')).rejects.toThrow('already in use');
    expect(db.sendOTPEmail).not.toHaveBeenCalled();
  });

  it('emails a code to the new address and switches once that code comes back', async () => {
    const user = addUser();

    await requestUserEmailChange(USER_ID, NEW_EMAIL, 'Old-pass1!');

    expect(db.sendOTPEmail).toHaveBeenCalledWith(NEW_EMAIL, expect.stringMatching(/^\d{6}$/), 'email_change');
    expect(user.email).toBe(EMAIL); // unchanged until confirmed
    expect(user.pendingEmailOtpHash).not.toBe(lastCode()); // stored hashed

    await expect(confirmUserEmailChange(USER_ID, lastCode())).resolves.toEqual({ email: NEW_EMAIL });
    expect(user.email).toBe(NEW_EMAIL);
    expect(user.pendingEmail).toBeUndefined();
  });

  it('cancels the change after 5 wrong codes', async () => {
    const user = addUser();
    await requestUserEmailChange(USER_ID, NEW_EMAIL, 'Old-pass1!');
    const code = lastCode();

    for (let i = 0; i < 5; i++) {
      await expect(confirmUserEmailChange(USER_ID, wrongCodeFor(code))).rejects.toThrow('Invalid code');
    }
    await expect(confirmUserEmailChange(USER_ID, code)).rejects.toThrow('Too many attempts');
    expect(user.pendingEmail).toBeUndefined();
    expect(user.email).toBe(EMAIL);
  });

  it('rejects an expired code', async () => {
    const user = addUser();
    await requestUserEmailChange(USER_ID, NEW_EMAIL, 'Old-pass1!');
    user.pendingEmailExpiresAt = new Date(Date.now() - 1000);

    await expect(confirmUserEmailChange(USER_ID, lastCode())).rejects.toThrow('expired');
  });
});
