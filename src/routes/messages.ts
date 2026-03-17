import { getDB } from "../db/database.js";
import { extractUser, unauthorized } from "../auth/middleware.js";

export async function handleMessages(req: Request, path: string): Promise<Response> {
  const user = await extractUser(req);
  if (!user) return unauthorized();

  const db = getDB();
  const url = new URL(req.url);
  const before = Number(url.searchParams.get("before") || Math.floor(Date.now() / 1000) + 1);
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 100);

  // GET /api/messages/group/:groupId — 群聊消息历史
  const groupMatch = path.match(/^\/api\/messages\/group\/(.+)$/);
  if (groupMatch && req.method === "GET") {
    const groupId = groupMatch[1];

    // 验证群成员
    const isMember = db.prepare(
      "SELECT 1 FROM group_members WHERE group_id = ? AND member_id = ? AND member_type = 'user'"
    ).get(groupId, user.sub);
    if (!isMember) return Response.json({ error: "not a member" }, { status: 403 });

    const rows = db.prepare(`
      SELECT id, sender_id as "from", sender_type as "fromType", group_id as "groupId",
             msg_type as "msgType", content, audio_url as "audioUrl", audio_dur as "duration",
             is_bot as "isBot", status, created_at as "createdAt"
      FROM messages
      WHERE group_id = ? AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(groupId, before, limit);

    return Response.json(rows);
  }

  // GET /api/messages/:peerId?peerType=user — 1v1 消息历史
  const match = path.match(/^\/api\/messages\/(.+)$/);
  if (!match || req.method !== "GET") {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const peerId = match[1];
  const peerType = url.searchParams.get("peerType") || "user";

  if (peerType === "bot") {
    // Bot 1v1: sender 是 user 或 bot
    const rows = db.prepare(`
      SELECT id, sender_id as "from", sender_type as "fromType",
             receiver_id as "to", msg_type as "msgType",
             content, audio_url as "audioUrl", audio_dur as "duration",
             is_bot as "isBot", status, created_at as "createdAt"
      FROM messages
      WHERE group_id IS NULL
        AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        AND created_at < ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(user.sub, peerId, peerId, user.sub, before, limit);

    return Response.json(rows);
  }

  // User 1v1
  const rows = db.prepare(`
    SELECT id, sender_id as "from", sender_type as "fromType",
           receiver_id as "to", msg_type as "msgType",
           content, audio_url as "audioUrl", audio_dur as "duration",
           is_bot as "isBot", status, created_at as "createdAt"
    FROM messages
    WHERE group_id IS NULL
      AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
      AND created_at < ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(user.sub, peerId, peerId, user.sub, before, limit);

  return Response.json(rows);
}
