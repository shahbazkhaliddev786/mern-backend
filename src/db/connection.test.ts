import { describe, expect, it } from 'vitest';
import { pgConfig } from './connection';

// The URL shapes Vercel's Neon integration gives (spec 023), with stand-in credentials.
const POOLED = 'postgresql://neondb_owner:secret@ep-x-pooler.c-16.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require';
const UNPOOLED = 'postgresql://neondb_owner:secret@ep-x.c-16.us-east-1.aws.neon.tech/neondb?sslmode=require';

describe('pgConfig', () => {
  it("turns the pooled URL's libpq settings into pg's: full certificate checks and channel binding", () => {
    expect(pgConfig(POOLED)).toEqual({
      connectionString: 'postgresql://neondb_owner:secret@ep-x-pooler.c-16.us-east-1.aws.neon.tech/neondb?sslmode=verify-full',
      enableChannelBinding: true,
    });
  });

  it('asks for verify-full outright on the direct URL, which pg did already', () => {
    expect(pgConfig(UNPOOLED)).toEqual({ connectionString: 'postgresql://neondb_owner:secret@ep-x.c-16.us-east-1.aws.neon.tech/neondb?sslmode=verify-full' });
    for (const mode of ['prefer', 'verify-ca']) expect(pgConfig(`postgres://u:p@h/db?sslmode=${mode}`).connectionString).toBe('postgres://u:p@h/db?sslmode=verify-full');
  });

  it('keeps other parameters, wherever channel_binding sits', () => {
    expect(pgConfig('postgres://u:p@h/db?channel_binding=require&connect_timeout=15&sslmode=require')).toEqual({
      connectionString: 'postgres://u:p@h/db?connect_timeout=15&sslmode=verify-full',
      enableChannelBinding: true,
    });
    expect(pgConfig('postgres://u:p@h/db?sslmode=require&channel_binding=prefer').connectionString).toBe('postgres://u:p@h/db?sslmode=verify-full');
    expect(pgConfig('postgres://u:p@h/db?channel_binding=require')).toEqual({ connectionString: 'postgres://u:p@h/db', enableChannelBinding: true });
  });

  it('leaves channel binding off when the URL says disable or nothing', () => {
    expect(pgConfig('postgres://u:p@h/db?channel_binding=disable&sslmode=verify-full')).toEqual({ connectionString: 'postgres://u:p@h/db?sslmode=verify-full' });
    expect(pgConfig('postgres://postgres@127.0.0.1:5432/postgres')).toEqual({ connectionString: 'postgres://postgres@127.0.0.1:5432/postgres' });
  });

  it('never touches the rest of the URL: the password, verify-full and disable stay as given', () => {
    const encoded = 'postgres://user:p%40ss%23w0rd%3F@h:5432/db?sslmode=verify-full';
    expect(pgConfig(encoded).connectionString).toBe(encoded);
    expect(pgConfig('postgres://u:p@h/db?sslmode=disable').connectionString).toBe('postgres://u:p@h/db?sslmode=disable');
  });
});
