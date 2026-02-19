import { corsMiddleware } from '../middlewares/cors.js'
import express from "express";
import type { Express } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "path";
import globalErrorHandler from "../middlewares/global-error.handler.js";
import { fileURLToPath } from "url";
import session from 'express-session';
import MongoStore from 'connect-mongo';
import config from "../config/config.js";
import { handleStripeWebhook } from "../services/order.service.js";
import logger from "../utils/logger.js";

// __dirname replacement in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function expressLoader(app: Express) {
  app.enable("trust-proxy");

//   // Security practices implemented:
//   // 1. Helmet to set various HTTP headers for security
//   // 2. CORS to allow cross-origin requests
//   // 3. Limiting request body size to prevent DOS attacks
//   // 4. Using cookie-parser to handle cookies securely
//   // 5. Morgan for logging HTTP requests
//   // 6. Validations on routes to ensure data 
//   // integrity and prevent injection attacks and XXS attacks

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
        await handleStripeWebhook(req.body, sig);
        res.json({ received: true });
      } catch (err: any) {
        logger.error('Webhook error', { error: err.message });
        res.status(400).send(`Webhook Error: ${err.message}`);
      }
    }
  );

  app.use(corsMiddleware);
  app.use(express.json({ limit: "15kb" }));
  app.use(express.urlencoded({ extended: true, limit: "15kb" }));
  app.use(cookieParser());
  // === SESSION MIDDLEWARE FOR GUEST CART ===
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'fallback-secret-change-in-production',
      resave: false,
      saveUninitialized: true,
      store: MongoStore.create({
        mongoUrl: config.DATABASE_URL,
      }),
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    })
  );

  app.use(express.static(path.join(__dirname, "../public")));

  // Global error handler
  app.use(globalErrorHandler);

 
}

