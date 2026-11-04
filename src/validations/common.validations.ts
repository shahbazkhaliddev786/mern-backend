import {param} from 'express-validator';

export const IdValidation = [
  param('id') 
    .isUUID()
    .withMessage('Invalid ID'),
];