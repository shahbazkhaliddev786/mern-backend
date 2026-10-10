// Backend shipping-address schema (zod).
//
// Mirrors mern-frontend/src/features/orders/schemas/shipping-schema.ts — keep
// the two in sync (there is no shared package yet). This is the server-side
// half of the "same schema as /checkout" promise (reconciliation.md Bug B /
// Gap 2) and the schema the agent's place_order tool will reuse.

import { z } from 'zod';

export const shippingSchema = z.object({
  fullName: z.string().min(2, 'Full name is required'),
  address: z.string().min(5, 'Address is required'),
  apartment: z.string().optional(),
  city: z.string().min(2, 'City is required'),
  state: z.string().optional(),
  postalCode: z.string().min(3, 'Postal code is required'),
  country: z.string().min(2, 'Country is required'),
  phone: z.string().optional(),
});

export type ShippingAddress = z.infer<typeof shippingSchema>;
