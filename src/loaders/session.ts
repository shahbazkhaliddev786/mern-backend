// Login sessions (the guest cart lives in one), kept in Postgres by connect-pg-simple (spec 023).
// Its table comes from the migrations, and expired sessions go with the daily cleanup.

import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { getTableName } from 'drizzle-orm';
import { getPool } from '../db/client.js';
import { sessions } from '../db/schema/index.js';

const PgStore = connectPgSimple(session);

export function sessionMiddleware() {
  return session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-change-in-production',
    resave: false,
    saveUninitialized: true,
    store: new PgStore({ pool: getPool(), tableName: getTableName(sessions), createTableIfMissing: false, pruneSessionInterval: false }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
}
