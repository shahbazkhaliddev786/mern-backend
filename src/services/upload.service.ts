// Images attached in the shopping assistant's chat (spec 012). An upload is stored for its
// owner only; the agent refers to it by id and never sees the bytes (security.md §9).

import { and, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { pendingUploads } from '../db/schema/index.js';
import { isId } from '../utils/ids.js';
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

// An upload is usable until it expires (an hour), whether or not the cleanup has removed it yet.
const ownedLive = (userId: string, uploadId: string) =>
  and(eq(pendingUploads.id, uploadId), eq(pendingUploads.userId, userId), gt(pendingUploads.expiresAt, sql`now()`));

export const createAvatarUpload = async (userId: string, file: IncomingFile): Promise<UploadInfo> => {
  const [upload] = await getDb()
    .insert(pendingUploads)
    .values({
      userId,
      kind: 'avatar',
      data: file.buffer,
      mimeType: file.mimetype,
      size: file.size,
      originalName: file.originalname,
    })
    .returning({ id: pendingUploads.id, originalName: pendingUploads.originalName, size: pendingUploads.size });
  return { uploadId: upload!.id, name: upload!.originalName, size: upload!.size };
};

/** The upload's name and size if it exists and belongs to this user; otherwise null. */
export const findOwnedUpload = async (userId: string, uploadId: string): Promise<UploadInfo | null> => {
  if (!isId(uploadId) || !isId(userId)) return null;
  const [upload] = await getDb()
    .select({ id: pendingUploads.id, originalName: pendingUploads.originalName, size: pendingUploads.size })
    .from(pendingUploads)
    .where(ownedLive(userId, uploadId));
  return upload ? { uploadId: upload.id, name: upload.originalName, size: upload.size } : null;
};

/**
 * Sets the upload as the user's profile picture, exactly as the Edit Profile page does, then
 * deletes it. If the picture can't be saved, the upload is kept so the customer can try again.
 */
export const applyAvatarUpload = async (userId: string, uploadId: string) => {
  if (!isId(uploadId) || !isId(userId)) throw new UploadNotFoundError();
  const [upload] = await getDb()
    .select()
    .from(pendingUploads)
    .where(and(ownedLive(userId, uploadId), eq(pendingUploads.kind, 'avatar')));
  if (!upload) throw new UploadNotFoundError();
  const file = { buffer: upload.data, mimetype: upload.mimeType, originalname: upload.originalName, size: upload.size } as Express.Multer.File;
  const profile = await updateUserProfile(userId, undefined, file);
  await getDb().delete(pendingUploads).where(eq(pendingUploads.id, upload.id));
  return profile;
};

/** Human-readable size for summaries and notes, e.g. "340 KB". */
export const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
