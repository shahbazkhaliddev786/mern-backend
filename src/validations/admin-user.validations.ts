import { body, param } from 'express-validator';

export const adminUserIdParamValidation = [
  param('userId').isMongoId().withMessage('Valid user ID is required'),
];

export const adminUpdateUserRoleValidation = [
  param('userId').isMongoId().withMessage('Valid user ID is required'),
  body('role').isIn(['user', 'admin']).withMessage('Role must be user or admin'),
];
