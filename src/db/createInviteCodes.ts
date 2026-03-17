import { randomBytes } from "crypto";
import { initDB, getDB } from "./database.js";

function generateCode(length = 10): string {
  return randomBytes(length)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, length)
    .toUpperCase();
}

function main() {
  initDB();
  const db = getDB();
  const count = Math.max(1, Number(process.argv[2] || 1));
  const note = process.argv[3] || null;

  const insert = db.prepare("INSERT INTO invite_codes (code, note) VALUES (?, ?)");

  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = generateCode(10);
    while (db.prepare("SELECT 1 FROM invite_codes WHERE code = ?").get(code)) {
      code = generateCode(10);
    }
    insert.run(code, note);
    codes.push(code);
  }

  console.log(codes.join("\n"));
}

main();
