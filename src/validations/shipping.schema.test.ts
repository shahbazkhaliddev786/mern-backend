import { describe, it, expect } from 'vitest';
import { shippingSchema } from './shipping.schema';

const validAddress = {
  fullName: 'Jane Doe',
  address: '123 Main Street',
  city: 'Springfield',
  postalCode: '12345',
  country: 'USA',
  phone: '+1 234 567 8900',
};

describe('shippingSchema', () => {
  it('accepts a valid address (phone optional)', () => {
    expect(shippingSchema.safeParse(validAddress).success).toBe(true);
    const { phone, ...noPhone } = validAddress;
    expect(shippingSchema.safeParse(noPhone).success).toBe(true);
  });

  it('rejects a too-short fullName and a missing city', () => {
    const bad = shippingSchema.safeParse({ ...validAddress, fullName: 'a', city: undefined });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      const fields = bad.error.issues.map((i) => i.path.join('.'));
      expect(fields).toContain('fullName');
      expect(fields).toContain('city');
    }
  });

  it('keeps the optional apartment and state fields', () => {
    const parsed = shippingSchema.parse({ ...validAddress, apartment: 'Apt 4B', state: 'IL' });
    expect(parsed).toMatchObject({ apartment: 'Apt 4B', state: 'IL' });
  });

  it('strips unknown keys (tax/shipping cannot ride along)', () => {
    const parsed = shippingSchema.parse({ ...validAddress, tax: 999, shipping: 999 });
    expect(parsed).not.toHaveProperty('tax');
    expect(parsed).not.toHaveProperty('shipping');
  });
});
