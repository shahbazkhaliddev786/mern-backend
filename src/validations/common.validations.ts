import { body } from "express-validator";

export const IdValidation = [
  body('id') 
    .isMongoId()
    .withMessage('Invalid brand ID'),
];