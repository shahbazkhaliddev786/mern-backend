import mongoose from "mongoose";
import type { Connection } from "mongoose";
import dns from "dns";
import config from "../config/config.js";

// Only set external DNS in local Windows development if needed
if (process.platform === "win32" && config.ENV === "development" && !process.env.VERCEL) {
  try {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  } catch (e) {
    // Ignore in restrictive environments
  }
}

let cachedConnection: Connection | null = null;

export async function connectDB(): Promise<Connection> {
  // Reuse existing connection on serverless warm starts
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  const dbUrl = config.DATABASE_URL || (process.env.DATABASE_URL as string);

  try {
    const conn = await mongoose.connect(dbUrl, {
      family: 4, // Force IPv4 (prevents IPv6 DNS lookup hangs)
      serverSelectionTimeoutMS: 10000,
    });

    cachedConnection = conn.connection;
    console.log("MongoDB connected successfully");
    return cachedConnection;
  } catch (err) {
    console.error("MongoDB connection error:", err);
    throw err;
  }
}
