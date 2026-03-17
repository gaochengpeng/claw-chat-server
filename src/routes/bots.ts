import { getDB } from "../db/database.js";
import { extractUser, unauthorized } from "../auth/middleware.js";

export async function handleBots(req: Request, path: string): Promise<Response> {
  const user = await extractUser(req);
  if (!user) return unauthorized();

  const db = getDB();

  // GET /api/bots — 所有公开 Bot + 自己的 Bot
  if (path === "/api/bots" && req.method === "GET") {
    const rows = db.prepare(`
      SELECT b.id, b.name, b.avatar_url as "avatarUrl", b.owner_id as "ownerId",
             u.nickname as "ownerName", b.is_public as "isPublic", b.is_online as "isOnline"
      FROM bots b JOIN users u ON u.id = b.owner_id
      WHERE b.is_public = 1 OR b.owner_id = ?
      ORDER BY b.created_at
    `).all(user.sub);
    return Response.json(rows);
  }

  // GET /api/bots/mine — 我的 Bot (owner sees gatewayUrl but never token)
  if (path === "/api/bots/mine" && req.method === "GET") {
    const rows = db.prepare(`
      SELECT id, name, avatar_url as "avatarUrl", gateway_url as "gatewayUrl",
             is_public as "isPublic", is_online as "isOnline"
      FROM bots WHERE owner_id = ? ORDER BY created_at
    `).all(user.sub);
    return Response.json(rows);
  }

  // POST /api/bots — 创建 Bot
  if (path === "/api/bots" && req.method === "POST") {
    const body = await req.json() as {
      name: string; avatarUrl?: string; gatewayUrl: string;
      gatewayToken?: string; isPublic?: boolean;
    };
    if (!body.name?.trim() || !body.gatewayUrl?.trim()) {
      return Response.json({ error: "name and gatewayUrl required" }, { status: 400 });
    }

    const row = db.prepare(`
      INSERT INTO bots (owner_id, name, avatar_url, gateway_url, gateway_token, is_public)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id, name, avatar_url as "avatarUrl",
                is_public as "isPublic", is_online as "isOnline"
    `).get(
      user.sub, body.name.trim(), body.avatarUrl || null,
      body.gatewayUrl.trim(), body.gatewayToken || null,
      body.isPublic !== false ? 1 : 0
    );
    return Response.json(row, { status: 201 });
  }

  // PATCH /api/bots/:botId
  const patchMatch = path.match(/^\/api\/bots\/([^/]+)$/);
  if (patchMatch && req.method === "PATCH") {
    const botId = patchMatch[1];
    // Verify ownership
    const bot = db.prepare("SELECT owner_id FROM bots WHERE id = ?").get(botId) as { owner_id: string } | undefined;
    if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });
    if (bot.owner_id !== user.sub) return Response.json({ error: "forbidden" }, { status: 403 });

    const body = await req.json() as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) { fields.push("name = ?"); values.push(body.name); }
    if (body.avatarUrl !== undefined) { fields.push("avatar_url = ?"); values.push(body.avatarUrl); }
    if (body.gatewayUrl !== undefined) { fields.push("gateway_url = ?"); values.push(body.gatewayUrl); }
    if (body.gatewayToken !== undefined) { fields.push("gateway_token = ?"); values.push(body.gatewayToken); }
    if (body.isPublic !== undefined) { fields.push("is_public = ?"); values.push(body.isPublic ? 1 : 0); }

    if (fields.length === 0) return Response.json({ error: "nothing to update" }, { status: 400 });

    fields.push("updated_at = unixepoch()");
    values.push(botId);

    const row = db.prepare(`
      UPDATE bots SET ${fields.join(", ")} WHERE id = ?
      RETURNING id, name, avatar_url as "avatarUrl",
                is_public as "isPublic", is_online as "isOnline"
    `).get(...values);
    return Response.json(row);
  }

  // DELETE /api/bots/:botId
  const deleteMatch = path.match(/^\/api\/bots\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const botId = deleteMatch[1];
    const bot = db.prepare("SELECT owner_id FROM bots WHERE id = ?").get(botId) as { owner_id: string } | undefined;
    if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });
    if (bot.owner_id !== user.sub) return Response.json({ error: "forbidden" }, { status: 403 });

    // Remove from all groups
    db.prepare("DELETE FROM group_members WHERE member_id = ? AND member_type = 'bot'").run(botId);
    db.prepare("DELETE FROM bots WHERE id = ?").run(botId);
    return Response.json({ ok: true });
  }

  // POST /api/bots/:botId/test — 测试 Gateway 连接（至少完成 WS open + challenge）
  const testMatch = path.match(/^\/api\/bots\/([^/]+)\/test$/);
  if (testMatch && req.method === "POST") {
    const botId = testMatch[1];
    const bot = db.prepare(
      "SELECT gateway_url, gateway_token FROM bots WHERE id = ? AND (owner_id = ? OR is_public = 1)"
    ).get(botId, user.sub) as { gateway_url: string; gateway_token: string | null } | undefined;
    if (!bot) return Response.json({ error: "bot not found" }, { status: 404 });

    try {
      const start = Date.now();
      const ws = new WebSocket(bot.gateway_url);
      const result = await new Promise<{ ok: boolean; latencyMs: number; stage: string; detail?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error("timeout"));
        }, 10000);

        ws.onopen = () => {
          const connectMsg = {
            type: "req",
            id: "connect-1",
            method: "connect",
            params: {
              client: {
                id: "clawchat-proxy-test",
                mode: "webchat",
                version: "1.0.0",
                displayName: "ClawChat Bot Test",
              },
              auth: bot.gateway_token ? { token: bot.gateway_token } : undefined,
            },
          };
          ws.send(JSON.stringify(connectMsg));
        };

        ws.onmessage = (event) => {
          const text = typeof event.data === "string" ? event.data : event.data.toString();
          try {
            const msg = JSON.parse(text) as { type?: string; event?: string; ok?: boolean; error?: { message?: string } };
            if (msg.type === "event" && msg.event === "connect.challenge") {
              clearTimeout(timeout);
              const latencyMs = Date.now() - start;
              try { ws.close(); } catch {}
              resolve({ ok: true, latencyMs, stage: "challenge" });
              return;
            }
            if (msg.type === "res" && msg.ok === true) {
              clearTimeout(timeout);
              const latencyMs = Date.now() - start;
              try { ws.close(); } catch {}
              resolve({ ok: true, latencyMs, stage: "connected" });
              return;
            }
            if (msg.type === "res" && msg.ok === false) {
              clearTimeout(timeout);
              const latencyMs = Date.now() - start;
              try { ws.close(); } catch {}
              resolve({ ok: false, latencyMs, stage: "rejected", detail: msg.error?.message || "connect rejected" });
            }
          } catch {
            // ignore non-json frames
          }
        };

        ws.onerror = (e) => { clearTimeout(timeout); reject(e); };
      });
      const status = result.ok ? 200 : 502;
      return Response.json(result, { status });
    } catch (error) {
      return Response.json({ ok: false, error: String(error || "connection failed") }, { status: 502 });
    }
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
