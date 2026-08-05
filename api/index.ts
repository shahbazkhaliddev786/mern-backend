import { createApp } from "../src/app.js";
import { connectDB } from "../src/services/db.service.js";
import loaders from "../src/loaders/index.js";

const app = createApp();
let isInitialized = false;

export default async function handler(req: any, res: any) {
  try {
    if (!isInitialized) {
      await connectDB();
      await loaders({ app });
      isInitialized = true;
    }
    return app(req, res);
  } catch (error: any) {
    console.error("Vercel Serverless Crash:", error);
    res.status(500).json({ 
      error: "Initialization failed", 
      message: error.message,
      stack: error.stack 
    });
  }
}
