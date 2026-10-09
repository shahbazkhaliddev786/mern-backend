import type { Request, Response, NextFunction } from 'express';
import type { ZodType } from 'zod';

// Reusable zod body validator. Parses req.body against the given schema and,
// on failure, returns the SAME 400 shape as the express-validator `validate`
// middleware so the API contract stays consistent. On success it writes the
// parsed (type-coerced, unknown-key-stripped) value back onto req.body.
//
// Reused by every future agent tool that validates input.
export const validateBody =
  <T>(schema: ZodType<T>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
        location: 'body',
      }));

      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors,
      });
    }

    req.body = result.data;
    next();
  };
