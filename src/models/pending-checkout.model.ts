import mongoose, { Schema, Document } from 'mongoose';
import type { IOrderItem, IShippingAddress } from './order.model.js';

// Snapshot of a cart at the moment a Stripe checkout session is created.
// No Order is created until the webhook confirms payment succeeded — this
// is the holding record in between. Auto-expires 24h after creation so
// abandoned/never-completed checkouts don't accumulate (mirrors Stripe's
// own 24h checkout session expiry).
export interface IPendingCheckout extends Document {
  stripeSessionId: string;
  user: mongoose.Types.ObjectId | null;
  items: IOrderItem[];
  shippingAddress: IShippingAddress;
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
  createdAt: Date;
}

const PendingCheckoutSchema: Schema = new Schema(
  {
    stripeSessionId: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    items: [
      {
        product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 },
        image: { type: String },
      },
    ],

    shippingAddress: {
      fullName: { type: String, required: true },
      address: { type: String, required: true },
      city: { type: String, required: true },
      postalCode: { type: String },
      country: { type: String },
      phone: { type: String },
    },

    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    shipping: { type: Number, default: 0 },
    total: { type: Number, required: true },

    createdAt: { type: Date, default: Date.now, expires: '24h' },
  },
  { timestamps: false }
);

export const PendingCheckout = mongoose.model<IPendingCheckout>('PendingCheckout', PendingCheckoutSchema);
