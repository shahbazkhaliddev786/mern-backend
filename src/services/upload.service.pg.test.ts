// Chat uploads against Postgres (spec 012), with the profile update mocked (no Cloudinary).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { getDb } from '../db/client';
import { pendingUploads, users } from '../db/schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';
import * as uploads from './upload.service';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

const profile = vi.hoisted(() => ({ calls: [] as { userId: string; type: string; bytes: number }[], fail: false }));
vi.mock('./auth.service.js', () => ({
  updateUserProfile: async (userId: string, _name: unknown, file: { mimetype: string; buffer: Buffer }) => {
    if (profile.fail) throw new Error('Failed to upload profile picture');
    profile.calls.push({ userId, type: file.mimetype, bytes: file.buffer.length });
    return { id: userId, name: 'Jane', email: 'jane@example.com', profile: 'https://res.cloudinary.com/x.png' };
  },
}));

describe.skipIf(!TEST_DATABASE_URL)('upload.service', () => {
  let testDb: TestDatabase;
  let alice = '';
  let mallory = '';
  const file = { buffer: Buffer.alloc(4096, 7), mimetype: 'image/webp', originalname: 'me.webp', size: 4096 };
  const stored = async () => (await getDb().select({ id: pendingUploads.id }).from(pendingUploads)).length;

  beforeAll(async () => {
    testDb = await createTestDatabase('uploads');
    const made = await getDb()
      .insert(users)
      .values([
        { name: 'Alice', email: 'alice@example.com', password: 'hash' },
        { name: 'Mallory', email: 'mallory@example.com', password: 'hash' },
      ])
      .returning();
    alice = made[0]!.id;
    mallory = made[1]!.id;
  }, 60_000);
  afterAll(async () => {
    await testDb?.drop();
  });
  beforeEach(async () => {
    await getDb().delete(pendingUploads);
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
    expect(await stored()).toBe(0);
  });

  it("never applies another customer's upload", async () => {
    const created = await uploads.createAvatarUpload(alice, file);
    await expect(uploads.applyAvatarUpload(mallory, created.uploadId)).rejects.toThrow(uploads.UploadNotFoundError);
    expect(profile.calls).toHaveLength(0);
    expect(await stored()).toBe(1);
  });

  it("keeps the upload when the picture can't be saved, so it can be tried again", async () => {
    const created = await uploads.createAvatarUpload(alice, file);
    profile.fail = true;
    await expect(uploads.applyAvatarUpload(alice, created.uploadId)).rejects.toThrow('Failed to upload profile picture');
    expect(await stored()).toBe(1);
    profile.fail = false;
    await uploads.applyAvatarUpload(alice, created.uploadId);
    expect(profile.calls).toHaveLength(1);
  });

  it('expires uploads an hour after they arrive, even before the cleanup removes them', async () => {
    const created = await uploads.createAvatarUpload(alice, file);
    const [row] = await getDb().select().from(pendingUploads);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeCloseTo(60 * 60 * 1000, -3);

    await getDb()
      .update(pendingUploads)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await uploads.findOwnedUpload(alice, created.uploadId)).toBeNull();
    await expect(uploads.applyAvatarUpload(alice, created.uploadId)).rejects.toThrow(uploads.UploadNotFoundError);
  });
});
