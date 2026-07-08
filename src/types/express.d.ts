import type { UserType } from './auth.types.js'; 
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    cart?: {
      items: Array<{
        product: string;
        quantity: number;
      }>;
    };
  }
}



declare module 'express-serve-static-core' {
  interface Request {
    user?: UserType;
  }
}