import "dotenv/config";
import { mkdirSync } from "fs";
import { resolve } from "path";

export const config = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  dbPath: process.env.DB_PATH || "./data/chat.db",
  audioDir: process.env.AUDIO_DIR || "./data/audio",
};

// Ensure data dirs exist
mkdirSync(resolve(config.audioDir), { recursive: true });
mkdirSync(resolve("data"), { recursive: true });
