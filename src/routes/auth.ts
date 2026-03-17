import { getDB } from "../db/database.js";
import { hashPassword, comparePassword } from "../auth/password.js";
import { signToken } from "../auth/jwt.js";

export async function handleAuth(req: Request, path: string): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const body = await req.json() as Record<string, string>;

  if (path === "/api/auth/register") {
    const { username, password, nickname, inviteCode } = body;
    if (!username || !password || !nickname || !inviteCode) {
      return Response.json({ error: "username, password, nickname, inviteCode required" }, { status: 400 });
    }

    const db = getDB();
    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (existing) {
      return Response.json({ error: "username already taken" }, { status: 409 });
    }

    const invite = db.prepare(
      "SELECT code, used_at, used_by FROM invite_codes WHERE code = ?"
    ).get(inviteCode) as { code: string; used_at: number | null; used_by: string | null } | undefined;

    if (!invite) {
      return Response.json({ error: "invalid invite code" }, { status: 403 });
    }

    if (invite.used_at || invite.used_by) {
      return Response.json({ error: "invite code already used" }, { status: 409 });
    }

    const hashed = await hashPassword(password);

    const registerWithInvite = db.transaction((username: string, hashed: string, nickname: string, inviteCode: string) => {
      const freshInvite = db.prepare(
        "SELECT code, used_at, used_by FROM invite_codes WHERE code = ?"
      ).get(inviteCode) as { code: string; used_at: number | null; used_by: string | null } | undefined;

      if (!freshInvite) {
        throw new Error("INVITE_INVALID");
      }

      if (freshInvite.used_at || freshInvite.used_by) {
        throw new Error("INVITE_USED");
      }

      const user = db.prepare(
        "INSERT INTO users (username, password, nickname) VALUES (?, ?, ?) RETURNING id, username, nickname"
      ).get(username, hashed, nickname) as { id: string; username: string; nickname: string };

      db.prepare(
        "UPDATE invite_codes SET used_at = unixepoch(), used_by = ? WHERE code = ? AND used_at IS NULL AND used_by IS NULL"
      ).run(user.id, inviteCode);

      return user;
    });

    try {
      const user = registerWithInvite(username, hashed, nickname, inviteCode) as {
        id: string; username: string; nickname: string;
      };
      const token = await signToken({ sub: user.id, username: user.username });
      return Response.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname } });
    } catch (error) {
      if ((error as Error).message === "INVITE_INVALID") {
        return Response.json({ error: "invalid invite code" }, { status: 403 });
      }
      if ((error as Error).message === "INVITE_USED") {
        return Response.json({ error: "invite code already used" }, { status: 409 });
      }
      throw error;
    }
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
