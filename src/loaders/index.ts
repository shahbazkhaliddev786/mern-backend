import type { Express } from "express";
import expressLoader from "./express.js";
import routesLoader from "./routes.js";
import globalErrorHandler from "../middlewares/global-error.handler.js";

export default async function loaders({ app }: { app: Express }) {
  await expressLoader(app);
  console.log("Express Initialized");

  await routesLoader(app);
  console.log("Route Initialized");

  // Global error handler must be registered AFTER all routes
  app.use(globalErrorHandler);
  console.log("Error Handler Initialized");
}
