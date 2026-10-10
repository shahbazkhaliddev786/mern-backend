import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uploadMultipleFiles, uploadSingleFile } from './multer.middleware';

// Real multipart requests against a throwaway server running the upload middlewares.
const MB = 1024 * 1024;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.post('/avatar', uploadSingleFile, (req, res) => {
    res.json({ received: req.file ? 1 : 0 });
  });
  app.post('/products', uploadMultipleFiles, (req, res) => {
    res.json({ received: Array.isArray(req.files) ? req.files.length : 0 });
  });

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const file = (type: string, bytes: number) => new Blob([new Uint8Array(bytes)], { type });

const upload = async (path: string, field: string, files: Blob[]) => {
  const form = new FormData();
  files.forEach((blob, i) => form.append(field, blob, `file-${i}`));
  const res = await fetch(baseUrl + path, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as { received?: number; message?: string } };
};

describe('avatar uploads (uploadSingleFile)', () => {
  it('accepts one image of up to 2 MB', async () => {
    const { status, body } = await upload('/avatar', 'profile', [file('image/webp', 2 * MB)]);

    expect(status).toBe(200);
    expect(body.received).toBe(1);
  });

  it('rejects a larger image with a 400', async () => {
    const { status, body } = await upload('/avatar', 'profile', [file('image/png', 2 * MB + 1)]);

    expect(status).toBe(400);
    expect(body.message).toBe('Each image must be 2 MB or smaller');
  });

  it('rejects files that are not JPEG, PNG, GIF or WEBP images', async () => {
    const { status, body } = await upload('/avatar', 'profile', [file('application/pdf', 1024)]);

    expect(status).toBe(400);
    expect(body.message).toBe('Only JPEG, PNG, GIF or WEBP images are allowed');
  });

  it('rejects a second file', async () => {
    const { status, body } = await upload('/avatar', 'profile', [file('image/png', 1024), file('image/png', 1024)]);

    expect(status).toBe(400);
    expect(body.message).toBe('Upload at most 1 image in the "profile" field');
  });
});

describe('product image uploads (uploadMultipleFiles)', () => {
  it('accepts up to 10 images', async () => {
    const images = Array.from({ length: 10 }, () => file('image/jpeg', 1024));
    const { status, body } = await upload('/products', 'files', images);

    expect(status).toBe(200);
    expect(body.received).toBe(10);
  });

  it('rejects an 11th image', async () => {
    const images = Array.from({ length: 11 }, () => file('image/jpeg', 1024));
    const { status, body } = await upload('/products', 'files', images);

    expect(status).toBe(400);
    expect(body.message).toBe('Upload at most 10 images in the "files" field');
  });

  it('rejects an image over 5 MB and types the product form does not offer', async () => {
    const tooBig = await upload('/products', 'files', [file('image/png', 5 * MB + 1)]);
    const gif = await upload('/products', 'files', [file('image/gif', 1024)]);

    expect(tooBig).toEqual({ status: 400, body: expect.objectContaining({ message: 'Each image must be 5 MB or smaller' }) });
    expect(gif).toEqual({ status: 400, body: expect.objectContaining({ message: 'Only JPEG, PNG or WEBP images are allowed' }) });
  });
});
