import mongoose, { Schema, Document } from 'mongoose';

export interface IOrderItem {
  product: mongoose.Types.ObjectId;
  name: string;
  price: number;
  quantity: number;
  image?: string;
}

export interface IShippingAddress {
  fullName: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface IOrder extends Document {
  user: mongoose.Types.ObjectId;
  items: IOrderItem[];

  subtotal: number;
  tax: number;
  shipping: number;
  total: number;

  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';

  paymentStatus: 'pending' | 'paid' | 'failed';
  paymentMethod: 'stripe' | 'cod';

  stripeSessionId?: string;

  shippingAddress: IShippingAddress;

  paidAt?: Date;
  deliveredAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const OrderSchema: Schema = new Schema(
  {
    user: { 
      type: Schema.Types.ObjectId, 
      ref: 'User', 
      required: true 
    },

    items: [
      {
        product: { 
          type: Schema.Types.ObjectId, 
          ref: 'Product', 
          required: true 
        },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 },
        image: { type: String },
      },
    ],

    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    shipping: { type: Number, default: 0 },
    total: { type: Number, required: true },

    status: {
      type: String,
      enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
      default: 'pending',
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed'],
      default: 'pending',
    },

    paymentMethod: {
      type: String,
      enum: ['stripe', 'cod'],
      default: 'stripe',
    },

    stripeSessionId: { 
      type: String, 
      unique: true, 
      sparse: true // prevents duplicate null errors
    },

    shippingAddress: {
      fullName: { type: String, required: true },
      address: { type: String, required: true },
      city: { type: String, required: true },
      postalCode: { type: String },
      country: { type: String },
      phone: { type: String },
    },

    paidAt: { type: Date },
    deliveredAt: { type: Date },
  },
  { timestamps: true }
);

// Indexes (optimized for dashboard queries)
OrderSchema.index({ user: 1, createdAt: -1 });
OrderSchema.index({ stripeSessionId: 1 });
OrderSchema.index({ status: 1 });

export const Order = mongoose.model<IOrder>('Order', OrderSchema);