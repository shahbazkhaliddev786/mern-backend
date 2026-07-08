import type { Express } from "express";

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
  adminDashboardRouter
} from "../routes/index.js";
import orderRouter from "../routes/order.routes.js";

export default async function routesLoader(app: Express) {
  // Root endpoint
  app.get("/", (_, res) => {
    res.json({ message: "Welcome to the API" });
  });

  // API versioned routes
  app.use("/api/v1", healthRouter); 
  app.use("/api/v1/brands", brandRouter); 
  app.use("/api/v1/categories", categoryRouter); 
  app.use("/api/v1/products", productRouter);
  app.use("/api/v1/auth", authRouter);
  app.use('/api/v1/cart', cartRouter);
  app.use('/api/v1/admin/carts', adminCartRouter);
  app.use('/api/v1/admin/orders', adminOrderRouter);
  app.use('/api/v1/admin/users', adminUserRouter);
  app.use('/api/v1/admin/dashboard', adminDashboardRouter);
  app.use("/api/v1/orders", orderRouter);

  // Optional: 404 handler for undefined API routes
  app.use("/api/v1", (_, res) => {
    res.status(404).json({
      status: "error",
      message: "Route not found",
    });
  });
}
