import { getDB } from "../db/database.js";
import { extractUser, unauthorized } from "../auth/middleware.js";

export async function handleUsers(req: Request, path: string): Promise<Response> {
  const user = await extractUser(req);
  if (!user) return unauthorized();

  const db = getDB();

  if (path === "/api/users/me" && req.method === "GET") {
    const row = db.prepare("SELECT id, username, nickname, avatar_url FROM users WHERE id = ?").get(user.sub) as Record<string, string> | undefined;
    if (!row) return Response.json({ error: "user not found" }, { status: 404 });
    return Response.json({ id: row.id, username: row.username, nickname: row.nickname, avatarUrl: row.avatar_url });
  }

  if (path === "/api/users/me" && req.method === "PATCH") {
    const body = await req.json() as Record<string, string>;
    const { nickname } = body;
    if (nickname) {
      db.prepare("UPDATE users SET nickname = ?, updated_at = unixepoch() WHERE id = ?").run(nickname, user.sub);
    }
    return Response.json({ ok: true });
  }

  if (path === "/api/users/search" && req.method === "GET") {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") || "";
    if (q.length < 2) return Response.json([]);
    const rows = db.prepare(
      "SELECT id, nickname FROM users WHERE username LIKE ? AND id != ? LIMIT 10"
    ).all(`%${q}%`, user.sub);
    return Response.json(rows);
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
