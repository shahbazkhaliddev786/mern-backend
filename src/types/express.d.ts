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
