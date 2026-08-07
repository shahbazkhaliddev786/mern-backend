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

  // Catch-all handler for undefined routes (including root if nothing else matches)
  app.use("*", (req, res) => {
    // If it's the root URL, give a friendly welcome message instead of an error
    if (req.path === "/" || req.path === "/api/index") {
      return res.status(200).json({
        status: "success",
        message: "Welcome to the MERN eCommerce API! The backend is fully deployed and live on Vercel."
      });
    }

    res.status(404).json({
      status: "error",
      message: "Route not found",
    });
  });
}
