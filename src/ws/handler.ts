import type { ServerWebSocket } from "bun";
import { verifyToken, type JWTPayload } from "../auth/jwt.js";
import { getDB } from "../db/database.js";
import { proxyToBot, forwardGroupMessageToBots } from "../bot/proxy.js";

interface WSData {
  user: JWTPayload | null;
}

// userId → Set<ws>
const connections = new Map<string, Set<ServerWebSocket<WSData>>>();

export function getWSHandler() {
  return {
    open(ws: ServerWebSocket<WSData>) {
      ws.data = { user: null };
    },

    async message(ws: ServerWebSocket<WSData>, raw: string | Buffer) {
      const text = typeof raw === "string" ? raw : raw.toString();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "invalid json" }));
        return;
      }

      // Auth handshake
      if (msg.type === "auth") {
        const payload = await verifyToken(msg.token as string);
        if (!payload) {
          ws.send(JSON.stringify({ type: "auth.error", message: "invalid token" }));
          ws.close(4001, "unauthorized");
          return;
        }
        ws.data.user = payload;
        if (!connections.has(payload.sub)) connections.set(payload.sub, new Set());
        connections.get(payload.sub)!.add(ws);
        broadcastPresence(payload.sub, true);
        ws.send(JSON.stringify({
          type: "auth.ok",
          user: { id: payload.sub, username: payload.username },
        }));
        return;
      }

      if (!ws.data.user) {
        ws.send(JSON.stringify({ type: "error", message: "not authenticated" }));
        return;
      }

      const user = ws.data.user;

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === "message") {
        if (msg.groupId) {
          await handleGroupMessage(ws, user, msg);
        } else if (msg.toType === "bot") {
          await handleBotMessage(ws, user, msg);
        } else {
          handleChatMessage(ws, user, msg);
        }
        return;
      }

      if (msg.type === "read") {
        handleReadReceipt(user, msg);
        return;
      }
    },

    close(ws: ServerWebSocket<WSData>, code: number, reason: string) {
      const user = ws.data.user;
      if (user) {
        const set = connections.get(user.sub);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            connections.delete(user.sub);
            broadcastPresence(user.sub, false);
          }
        }
      }
    },
  };
}

// ─── 1v1 人对人消息（纯转发，不存储）───

function handleChatMessage(
  ws: ServerWebSocket<WSData>,
  sender: JWTPayload,
  msg: Record<string, unknown>
) {
  const to = msg.to as string;
  const msgType = (msg.msgType as string) || "text";
  const clientId = msg.id as string;
  const content = msg.content as string;
  const audioBase64 = msg.audio as string;
  const audioDur = (msg.duration as number) || 0;

  const outgoing = {
    type: "message",
    id: clientId,
    from: sender.sub,
    fromType: "user",
    to,
    toType: "user",
    msgType,
    content: content || null,
    audio: audioBase64 || null,
    duration: audioDur || null,
    isBot: false,
    createdAt: Math.floor(Date.now() / 1000),
  };

  const receiverSockets = connections.get(to);
  if (receiverSockets) {
    const payload = JSON.stringify(outgoing);
    for (const s of receiverSockets) s.send(payload);
    ws.send(JSON.stringify({ type: "message.status", id: clientId, status: "delivered" }));
  } else {
    ws.send(JSON.stringify({ type: "message.status", id: clientId, status: "sent" }));
  }
}

// ─── 1v1 Bot 消息（代理转发，不存储）───

async function handleBotMessage(
  ws: ServerWebSocket<WSData>,
  sender: JWTPayload,
  msg: Record<string, unknown>
) {
  const botId = msg.to as string;
  const content = msg.content as string;
  const clientId = msg.id as string;

  if (!content?.trim()) return;

  await proxyToBot(botId, content, sender.sub, ws, clientId);
}

// ─── 群聊消息（广播转发，不存储）───

async function handleGroupMessage(
  ws: ServerWebSocket<WSData>,
  sender: JWTPayload,
  msg: Record<string, unknown>
) {
  const groupId = msg.groupId as string;
  const msgType = (msg.msgType as string) || "text";
  const clientId = msg.id as string;
  const content = msg.content as string;
  const audioBase64 = msg.audio as string;
  const audioDur = (msg.duration as number) || 0;
  const db = getDB();

  // 验证发送者是群成员
  const membership = db.prepare(
    "SELECT 1 FROM group_members WHERE group_id = ? AND member_id = ? AND member_type = 'user'"
  ).get(groupId, sender.sub);
  if (!membership) {
    ws.send(JSON.stringify({ type: "error", message: "not a group member" }));
    return;
  }

  const outgoing = {
    type: "message",
    id: clientId,
    from: sender.sub,
    fromType: "user",
    groupId,
    msgType,
    content: content || null,
    audio: audioBase64 || null,
    duration: audioDur || null,
    isBot: false,
    createdAt: Math.floor(Date.now() / 1000),
  };

  // 广播给群内所有在线用户
  const broadcastPayload = JSON.stringify(outgoing);
  broadcastToGroupMembers(groupId, sender.sub, broadcastPayload);

  // 确认发送
  ws.send(JSON.stringify({ type: "message.status", id: clientId, status: "sent" }));

  // 转发给群内 Bot
  if (content) {
    const broadcastFn = (botMsg: object) => {
      const payload = JSON.stringify(botMsg);
      broadcastToGroupMembers(groupId, null, payload);
    };
    forwardGroupMessageToBots(groupId, content, sender.sub, "user", broadcastFn).catch(() => {});
  }
}

// ─── 已读回执（纯转发）───

function handleReadReceipt(user: JWTPayload, msg: Record<string, unknown>) {
  const conversationWith = msg.conversationWith as string;
  const upTo = msg.upTo as string;
  if (!conversationWith || !upTo) return;

  const senderSockets = connections.get(conversationWith);
  if (senderSockets) {
    const payload = JSON.stringify({ type: "message.status", id: upTo, status: "read" });
    for (const s of senderSockets) s.send(payload);
  }
}

// ─── 工具函数 ───

function broadcastToGroupMembers(groupId: string, excludeUserId: string | null, payload: string) {
  const db = getDB();
  const members = db.prepare(
    "SELECT member_id FROM group_members WHERE group_id = ? AND member_type = 'user'"
  ).all(groupId) as { member_id: string }[];

  for (const m of members) {
    if (m.member_id === excludeUserId) continue;
    const sockets = connections.get(m.member_id);
    if (sockets) {
      for (const s of sockets) s.send(payload);
    }
  }
}

function broadcastPresence(userId: string, online: boolean) {
  const payload = JSON.stringify({ type: "presence", userId, online });
  for (const [uid, sockets] of connections) {
    if (uid === userId) continue;
    for (const s of sockets) s.send(payload);
  }
}

export function isUserOnline(userId: string): boolean {
  return (connections.get(userId)?.size ?? 0) > 0;
}
