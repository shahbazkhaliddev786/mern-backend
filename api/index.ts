import '../src/tracing.js';
import { createApp } from '../src/app.js';
import { connectDB } from '../src/services/db.service.js';
import loaders from '../src/loaders/index.js';
import logger from '../src/utils/logger.js';

const app = createApp();
let isInitialized = false;

// Disable Vercel's built-in body parser so the raw body stream is
// preserved for the Stripe webhook signature verification.
export const config = {
  api: {
    bodyParser: false,
  },
};


export default async function handler(req: any, res: any) {
  try {
    if (!isInitialized) {
      await connectDB();
      // Intercept root and vercel rewritten paths
      app.use((req, res, next) => {
        if (req.path === '/' || req.path === '/api/index' || req.path === '/api/index.ts' || req.path === '') {
          return res.status(200).json({ status: 'success', message: 'Welcome to the MERN eCommerce API! The backend is fully deployed and live on Vercel.' });
        }
        next();
      });
      await loaders({ app });
      isInitialized = true;
    }
    return app(req, res);
  } catch (error: any) {
    logger.error('Vercel serverless initialization failed', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      error: 'Initialization failed', 
      message: error.message,
      stack: error.stack 
    });
  }
}
