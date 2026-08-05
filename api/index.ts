import { createApp } from "../src/app.js";
import { connectDB } from "../src/services/db.service.js";
import loaders from "../src/loaders/index.js";

const app = createApp();
let isInitialized = false;

export default async function handler(req: any, res: any) {
  if (!isInitialized) {
    await connectDB();
    await loaders({ app });
    isInitialized = true;
  }
  return app(req, res);
}
