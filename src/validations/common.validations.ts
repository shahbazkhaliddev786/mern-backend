import {param} from 'express-validator';

export const IdValidation = [
  param('id') 
    .isMongoId()
    .withMessage('Invalid ID'),
];