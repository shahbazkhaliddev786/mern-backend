// Chat uploads against MongoDB (spec 012), with the profile update mocked (no Cloudinary).
// Runs only when MONGO_URL is set.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

const profile = vi.hoisted(() => ({ calls: [] as { userId: string; type: string; bytes: number }[], fail: false }));
vi.mock('./auth.service.js', () => ({
  updateUserProfile: async (userId: string, _name: unknown, file: { mimetype: string; buffer: Buffer }) => {
    if (profile.fail) throw new Error('Failed to upload profile picture');
    profile.calls.push({ userId, type: file.mimetype, bytes: file.buffer.length });
    return { id: userId, name: 'Jane', email: 'jane@example.com', profile: 'https://res.cloudinary.com/x.png' };
  },
}));

const MONGO_URL = process.env.MONGO_URL;

describe.skipIf(!MONGO_URL)('upload.service', () => {
  let models: typeof import('../models/index.js');
  let uploads: typeof import('./upload.service.js');
  const alice = new mongoose.Types.ObjectId().toString();
  const mallory = new mongoose.Types.ObjectId().toString();
  const file = { buffer: Buffer.alloc(4096, 7), mimetype: 'image/webp', originalname: 'me.webp', size: 4096 };

  beforeAll(async () => {
    await mongoose.connect(`${MONGO_URL}/upload_service_test`);
    await mongoose.connection.dropDatabase();
    models = await import('../models/index.js');
    uploads = await import('./upload.service.js');
    await models.PendingUpload.init();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await models.PendingUpload.deleteMany({});
    profile.calls = [];
    profile.fail = false;
  });

  it('stores an upload for its owner only', async () => {
    const created = await uploads.createAvatarUpload(alice, file);
    expect(created).toMatchObject({ name: 'me.webp', size: 4096 });
    expect(await uploads.findOwnedUpload(alice, created.uploadId)).toEqual(created);
    expect(await uploads.findOwnedUpload(mallory, created.uploadId)).toBeNull();
    expect(await uploads.findOwnedUpload(alice, 'not-an-id')).toBeNull();
  });

  it('applies the stored bytes and type as the profile picture, then deletes the upload', async () => {
    const created = await uploads.createAvatarUpload(alice, file);
    await uploads.applyAvatarUpload(alice, created.uploadId);
    expect(profile.calls).toEqual([{ userId: alice, type: 'image/webp', bytes: 4096 }]);
    expect(await models.PendingUpload.countDocuments({})).toBe(0);
  });

  it('never applies another customer\'s upload', async () => {
    const created = await uploads.createAvatarUpload(alice, file);
    await expect(uploads.applyAvatarUpload(mallory, created.uploadId)).rejects.toThrow(uploads.UploadNotFoundError);
    expect(profile.calls).toHaveLength(0);
    expect(await models.PendingUpload.countDocuments({})).toBe(1);
  });

  it('keeps the upload when the picture can\'t be saved, so it can be tried again', async () => {
    const created = await uploads.createAvatarUpload(alice, file);
    profile.fail = true;
    await expect(uploads.applyAvatarUpload(alice, created.uploadId)).rejects.toThrow('Failed to upload profile picture');
    expect(await models.PendingUpload.countDocuments({})).toBe(1);
    profile.fail = false;
    await uploads.applyAvatarUpload(alice, created.uploadId);
    expect(profile.calls).toHaveLength(1);
  });

  it('expires uploads an hour after they arrive', async () => {
    const indexes = await models.PendingUpload.collection.indexes();
    expect(indexes.find((index) => index.key.createdAt === 1)?.expireAfterSeconds).toBe(3600);
  });
});
