// How a Neon connection string becomes `pg` settings (spec 023). Vercel's Neon integration gives
// URLs with libpq's `sslmode=require` and `channel_binding=require`; `pg` reads them differently:
// - `sslmode=require` (and `prefer`, `verify-ca`): `pg` already checks the certificate fully, as
//   `verify-full` does, and prints a security warning on every start saying so. Asking for
//   `verify-full` outright keeps the same check without the warning.
// - `channel_binding`: `pg` ignores it; its own switch is `enableChannelBinding` (SCRAM-SHA-256-PLUS).
// Only the query string is edited: the rest of the URL, password included, stays as it is.
// No app imports, so the migration runner can use it.

import type pg from 'pg';

const LOOSE_SSL_MODES = /([?&]sslmode=)(?:require|prefer|verify-ca)(?=&|#|$)/;
const CHANNEL_BINDING = /([?&])channel_binding=([^&#]*)&?/;

export function pgConfig(connectionString: string): pg.ClientConfig {
  let url = connectionString.replace(LOOSE_SSL_MODES, '$1verify-full');
  const binding = CHANNEL_BINDING.exec(url);
  if (binding) {
    url = url.replace(CHANNEL_BINDING, '$1').replace(/[?&]$/, '');
  }
  const channelBinding = binding?.[2] === 'require' || binding?.[2] === 'prefer';
  return { connectionString: url, ...(channelBinding ? { enableChannelBinding: true } : {}) };
}
