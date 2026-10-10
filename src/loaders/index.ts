import type { Express } from 'express';
import expressLoader from './express.js';
import routesLoader from './routes.js';
import globalErrorHandler from '../middlewares/global-error.handler.js';
import logger from '../utils/logger.js';

export default async function loaders({ app }: { app: Express }) {
  await expressLoader(app);
  logger.info('Express initialized');

  await routesLoader(app);
  logger.info('Routes initialized');

  // Global error handler must be registered AFTER all routes
  app.use(globalErrorHandler);
  logger.info('Error handler initialized');
}
