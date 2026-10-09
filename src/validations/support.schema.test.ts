import { describe, it, expect } from 'vitest';
import { guestSupportRequestSchema, supportMessageSchema } from './support.schema';

const content = { subject: 'Order question', message: 'Where is my order #1234?' };
const guest = { name: 'Jane Doe', email: 'jane@example.com', ...content };

const invalidFields = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('supportMessageSchema (signed-in senders)', () => {
  it('strips name/email from the body — identity comes from the session', () => {
    expect(supportMessageSchema.parse({ ...content, name: 'CEO', email: 'ceo@aljo.store' })).toEqual(content);
  });

  it('rejects a too-short subject and message', () => {
    const result = supportMessageSchema.safeParse({ subject: 'Hi', message: 'Too short' });
    expect(result.success).toBe(false);
    expect(invalidFields(result)).toEqual(expect.arrayContaining(['subject', 'message']));
  });
});

describe('guestSupportRequestSchema', () => {
  it('accepts a complete guest request', () => {
    expect(guestSupportRequestSchema.safeParse(guest).success).toBe(true);
  });

  it('requires a name and a valid email', () => {
    const result = guestSupportRequestSchema.safeParse({ ...content, email: 'not-an-email' });
    expect(result.success).toBe(false);
    expect(invalidFields(result)).toEqual(expect.arrayContaining(['name', 'email']));
  });
});
