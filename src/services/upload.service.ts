// Images attached in the shopping assistant's chat (spec 012). An upload is stored for its
// owner only; the agent refers to it by id and never sees the bytes (security.md §9).

import mongoose from 'mongoose';
import { PendingUpload } from '../models/index.js';
import { updateUserProfile } from './auth.service.js';

export class UploadNotFoundError extends Error {
  constructor() {
    super('That picture has expired or isn\'t yours. Please attach it again.');
    this.name = 'UploadNotFoundError';
  }
}

export interface UploadInfo {
  uploadId: string;
  name: string;
  size: number;
}

// The parts of a multer file this service needs.
type IncomingFile = Pick<Express.Multer.File, 'buffer' | 'mimetype' | 'originalname' | 'size'>;

export const createAvatarUpload = async (userId: string, file: IncomingFile): Promise<UploadInfo> => {
  const upload = await PendingUpload.create({
    user: userId,
    kind: 'avatar',
    data: file.buffer,
    mimeType: file.mimetype,
    size: file.size,
    originalName: file.originalname,
  });
  return { uploadId: String(upload._id), name: upload.originalName, size: upload.size };
};

/** The upload's name and size if it exists and belongs to this user; otherwise null. */
export const findOwnedUpload = async (userId: string, uploadId: string): Promise<UploadInfo | null> => {
  if (!mongoose.Types.ObjectId.isValid(uploadId)) return null;
  const upload = await PendingUpload.findOne({ _id: uploadId, user: userId }).select('originalName size').lean();
  return upload ? { uploadId: String(upload._id), name: upload.originalName, size: upload.size } : null;
};

/**
 * Sets the upload as the user's profile picture, exactly as the Edit Profile page does, then
 * deletes it. If the picture can't be saved, the upload is kept so the customer can try again.
 */
export const applyAvatarUpload = async (userId: string, uploadId: string) => {
  if (!mongoose.Types.ObjectId.isValid(uploadId)) throw new UploadNotFoundError();
  const upload = await PendingUpload.findOne({ _id: uploadId, user: userId, kind: 'avatar' });
  if (!upload) throw new UploadNotFoundError();
  const file = { buffer: upload.data, mimetype: upload.mimeType, originalname: upload.originalName, size: upload.size } as Express.Multer.File;
  const profile = await updateUserProfile(userId, undefined, file);
  await PendingUpload.deleteOne({ _id: upload._id });
  return profile;
};

/** Human-readable size for summaries and notes, e.g. "340 KB". */
export const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
