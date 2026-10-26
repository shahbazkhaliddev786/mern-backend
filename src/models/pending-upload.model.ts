import mongoose, { Schema, type Document } from 'mongoose';

// An image attached in the shopping assistant's chat, held until the customer confirms what
// to do with it (spec 012). The model only ever sees its id. Expires an hour after upload.
export const PENDING_UPLOAD_TTL_SECONDS = 3600;

export interface IPendingUpload extends Document {
  user: mongoose.Types.ObjectId;
  kind: 'avatar';
  data: Buffer;
  mimeType: string;
  size: number;
  originalName: string;
  createdAt: Date;
}

const PendingUploadSchema = new Schema<IPendingUpload>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['avatar'], required: true },
    data: { type: Buffer, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    originalName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: PENDING_UPLOAD_TTL_SECONDS },
  },
  { timestamps: false },
);

export const PendingUpload = mongoose.model<IPendingUpload>('PendingUpload', PendingUploadSchema);
