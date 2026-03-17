import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { resolve } from "path";
import { config } from "../config.js";

let db: Database | null = null;

export function getDB(): Database {
  if (!db) {
    db = new Database(config.dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}

export function initDB() {
  const d = getDB();
  const schema = readFileSync(resolve(import.meta.dir, "schema.sql"), "utf-8");
  d.exec(schema);
  console.log("✅ Database initialized");
}
