import { corsMiddleware } from '../middlewares/cors.js'
import express from 'express';
import type { Express } from 'express';
import helmetPkg from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import MongoStorePkg from 'connect-mongo';
import mongoose from 'mongoose';
import { handleStripeWebhook } from '../services/order.service.js';
import logger from '../utils/logger.js';

const helmet = helmetPkg as any;
const MongoStore = MongoStorePkg as any;

export default async function expressLoader(app: Express) {
  app.set('trust proxy', 1);

//   // Security practices implemented:
//   // 1. Helmet to set various HTTP headers for security
//   // 2. CORS to allow cross-origin requests
//   // 3. Limiting request body size to prevent DOS attacks
//   // 4. Using cookie-parser to handle cookies securely
//   // 5. Morgan for logging HTTP requests
//   // 6. Validations on routes to ensure data 
//   // integrity and prevent injection attacks and XXS attacks


/*
//    How cast error works in expressjs?

In Express, the order you define your routes matters.
Express checks routes from top to bottom and uses the first one that matches.

Why does this matter?
If you put /:orderId before /my-orders, then /my-orders will be treated as an orderId (which is wrong).
If you put /my-orders before /:orderId, Express will correctly match /my-orders first.

orderRouter.get('/my-orders', authMiddleware, getMyOrdersController);
orderRouter.get('/:orderId', authMiddleware, getOrder);
*/

  app.use(
    helmet({
      contentSecurityPolicy: false,
    })
  );

    app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }), // raw body for signature
    async (req, res) => {
      const sig = req.headers['stripe-signature'] as string;

      try {
        // On Vercel, the body may arrive pre-parsed as an object even with
        // bodyParser disabled (edge cases / cold starts). If so, convert it
        // back to a Buffer so Stripe signature verification works.
        const rawBody = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(JSON.stringify(req.body));

        await handleStripeWebhook(rawBody, sig);
        res.json({ received: true });
      } catch (err: any) {
        logger.error('Webhook error', { error: err.message });
        res.status(400).send(`Webhook Error: ${err.message}`);
      }
    }
  );


  app.use(corsMiddleware);
  app.use(express.json({ limit: '15kb' }));
  app.use(express.urlencoded({ extended: true, limit: '15kb' }));
  app.use(cookieParser());
  // === SESSION MIDDLEWARE FOR GUEST CART ===
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'fallback-secret-change-in-production',
      resave: false,
      saveUninitialized: true,
      store: MongoStore.create({
        client: mongoose.connection.getClient(),
      }),
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    })
  );

}

