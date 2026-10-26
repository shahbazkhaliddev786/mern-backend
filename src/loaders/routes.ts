import type { Express } from 'express';

import {
  healthRouter,
  brandRouter,
  categoryRouter,
  productRouter,
  authRouter,
  cartRouter,
  adminCartRouter,
  adminOrderRouter,
  adminUserRouter,
  adminDashboardRouter,
  supportRouter,
  agentRouter
} from '../routes/index.js';
import orderRouter from '../routes/order.routes.js';

export default async function routesLoader(app: Express) {
  // Root endpoint
  app.get('/', (_, res) => {
    res.status(200).json({ status: 'success', message: 'Welcome to the MERN eCommerce API! The backend is live.' });
  });

  // API versioned routes
  app.use('/api/v1', healthRouter); 
  app.use('/api/v1/brands', brandRouter); 
  app.use('/api/v1/categories', categoryRouter); 
  app.use('/api/v1/products', productRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/cart', cartRouter);
  app.use('/api/v1/admin/carts', adminCartRouter);
  app.use('/api/v1/admin/orders', adminOrderRouter);
  app.use('/api/v1/admin/users', adminUserRouter);
  app.use('/api/v1/admin/dashboard', adminDashboardRouter);
  app.use('/api/v1/orders', orderRouter);
  app.use('/api/v1/support', supportRouter);
  app.use('/api/v1/agent', agentRouter);

  // Universal catch-all for unmatched routes (handles root URL and 404s)
  app.use((req, res) => {
    if (req.path === '/' || req.path === '/api/index' || req.path === '/api/index.ts' || req.path === '') {
      return res.status(200).json({
        status: 'success',
        message: 'Welcome to the MERN eCommerce API! The backend is live.'
      });
    }

    res.status(404).json({
      status: 'error',
      message: 'Route not found',
    });
  });
}
