import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  profile?: string;
  isVerified: boolean;
  refreshTokens: string[];
  role?: string;
  pendingEmail?: string | undefined;
  pendingEmailOtpHash?: string | undefined;
  pendingEmailExpiresAt?: Date | undefined;
  pendingEmailAttempts?: number | undefined;
  createdAt: Date;
  updatedAt: Date;

  comparePassword(candidatePassword: string): Promise<boolean>;
}

const UserSchema: Schema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    profile: { type: String }, 
    isVerified: { type: Boolean, default: false },
    refreshTokens: [{ type: String }],
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    // An email change waiting for the code sent to the new address (see requestUserEmailChange).
    pendingEmail: { type: String, lowercase: true, trim: true },
    pendingEmailOtpHash: { type: String, select: false },
    pendingEmailExpiresAt: { type: Date },
    pendingEmailAttempts: { type: Number },
  },
  { timestamps: true }
);

// Hash password before saving
UserSchema.pre('save', async function () {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password as string, 12);
  }
});

// Compare password method
UserSchema.methods.comparePassword = async function (candidatePassword: string) {
  return bcrypt.compare(candidatePassword, this.password);
};

export const User = mongoose.model<IUser>('User', UserSchema);