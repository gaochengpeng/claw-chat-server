import { getDB } from "../db/database.js";
import { hashPassword, comparePassword } from "../auth/password.js";
import { signToken } from "../auth/jwt.js";

export async function handleAuth(req: Request, path: string): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const body = await req.json() as Record<string, string>;

  if (path === "/api/auth/register") {
    const { username, password, nickname } = body;
    if (!username || !password || !nickname) {
      return Response.json({ error: "username, password, nickname required" }, { status: 400 });
    }

    const db = getDB();
    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (existing) {
      return Response.json({ error: "username already taken" }, { status: 409 });
    }

    const hashed = await hashPassword(password);
    const stmt = db.prepare(
      "INSERT INTO users (username, password, nickname) VALUES (?, ?, ?) RETURNING id, username, nickname"
    );
    const user = stmt.get(username, hashed, nickname) as { id: string; username: string; nickname: string };
    const token = await signToken({ sub: user.id, username: user.username });

    return Response.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname } });
  }

  if (path === "/api/auth/login") {
    const { username, password } = body;
    if (!username || !password) {
      return Response.json({ error: "username and password required" }, { status: 400 });
    }

    const db = getDB();
    const row = db.prepare("SELECT id, username, nickname, password FROM users WHERE username = ?").get(username) as
      | { id: string; username: string; nickname: string; password: string }
      | undefined;

    if (!row || !(await comparePassword(password, row.password))) {
      return Response.json({ error: "invalid credentials" }, { status: 401 });
    }

    const token = await signToken({ sub: row.id, username: row.username });
    return Response.json({ token, user: { id: row.id, username: row.username, nickname: row.nickname } });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
