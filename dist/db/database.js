import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
let db = null;
export function getDB() {
    if (!db) {
        db = new Database(config.dbPath);
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
    }
    return db;
}
export function initDB() {
    const d = getDB();
    const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
    d.exec(schema);
    console.log("✅ Database initialized");
}
