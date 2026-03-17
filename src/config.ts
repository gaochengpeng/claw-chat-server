import "dotenv/config";
import { mkdirSync } from "fs";
import { resolve } from "path";

export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  dbPath: process.env.DB_PATH || "./data/chat.db",
  audioDir: process.env.AUDIO_DIR || "./data/audio",
  // Security
  corsOrigins: (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),
  maxBodySize: Number(process.env.MAX_BODY_SIZE || 1024 * 1024), // 1MB
  wsAuthTimeoutMs: Number(process.env.WS_AUTH_TIMEOUT_MS || 10000), // 10s
  rateLimitWindowMs: 60 * 1000, // 1 min
  rateLimitMaxAuth: Number(process.env.RATE_LIMIT_AUTH || 10), // 10 attempts per min
  rateLimitMaxApi: Number(process.env.RATE_LIMIT_API || 60), // 60 req per min
  passwordMinLength: 8,
};

// Ensure data dirs exist
mkdirSync(resolve(config.audioDir), { recursive: true });
mkdirSync(resolve("data"), { recursive: true });
