import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config/config.js';

export const generateAccessToken = (userId: string): string => {
  const secret = config.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not defined in environment');
  }

  return jwt.sign(
    { userId },
    secret,
    { expiresIn: config.JWT_ACCESS_EXPIRES_IN || '15m' } as jwt.SignOptions
  );
};

export const generateRefreshToken = (): string => {
  return crypto.randomBytes(64).toString('hex');
};

export const hashRefreshToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

export const verifyAccessToken = (token: string): any => {
  const secret = config.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not defined');
  }

  return jwt.verify(token, secret);
};