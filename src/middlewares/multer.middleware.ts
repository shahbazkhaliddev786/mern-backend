import type { RequestHandler } from 'express';
import multer from 'multer';
import { apiResponse } from '../utils/api.response.js';

const MB = 1024 * 1024;

interface ImageUploadRules {
  field: string;
  maxFiles: number;
  maxMB: number;
  types: Record<string, string>; // accepted MIME type -> name used in messages
}

// Avatars match the edit-profile page's copy; product images match the checks
// in the admin product form (ProductFormModal).
const AVATAR: ImageUploadRules = {
  field: 'profile',
  maxFiles: 1,
  maxMB: 2,
  types: { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/webp': 'WEBP' },
};

const PRODUCT_IMAGES: ImageUploadRules = {
  field: 'files',
  maxFiles: 10,
  maxMB: 5,
  types: { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WEBP' },
};

class UnsupportedFileTypeError extends Error {}

const describeTypes = ({ types }: ImageUploadRules) => {
  const names = Object.values(types);
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
};

// The message for an upload problem the client can fix, or null for any other error.
const uploadErrorMessage = (error: unknown, rules: ImageUploadRules): string | null => {
  if (error instanceof UnsupportedFileTypeError) return `Only ${describeTypes(rules)} images are allowed`;
  if (!(error instanceof multer.MulterError)) return null;

  if (error.code === 'LIMIT_FILE_SIZE') return `Each image must be ${rules.maxMB} MB or smaller`;
  if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
    return `Upload at most ${rules.maxFiles} ${rules.maxFiles === 1 ? 'image' : 'images'} in the "${rules.field}" field`;
  }
  return error.message;
};

// Buffers images in memory with size, count and type limits. Problems the client
// can fix get a 400 here rather than the global error handler's 500. The type
// check trusts the declared MIME type; Cloudinary rejects anything that isn't
// really an image when it is uploaded.
const imageUpload = (rules: ImageUploadRules): RequestHandler => {
  const upload = multer({
    storage: multer.memoryStorage(),
    // busboy flags a file once it *reaches* fileSize, so +1 lets exactly maxMB through
    limits: { fileSize: rules.maxMB * MB + 1, files: rules.maxFiles },
    fileFilter: (_req, file, callback) => {
      if (Object.hasOwn(rules.types, file.mimetype)) callback(null, true);
      else callback(new UnsupportedFileTypeError(file.mimetype));
    },
  });
  const parse = rules.maxFiles === 1 ? upload.single(rules.field) : upload.array(rules.field, rules.maxFiles);

  return (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      if (!error) return next();

      const message = uploadErrorMessage(error, rules);
      if (message) return apiResponse(res, 400, 'error', message);
      next(error);
    });
  };
};

// For multiple files upload (e.g., product images)
export const uploadMultipleFiles = imageUpload(PRODUCT_IMAGES);

// For single file upload (e.g., profile picture)
export const uploadSingleFile = imageUpload(AVATAR);
