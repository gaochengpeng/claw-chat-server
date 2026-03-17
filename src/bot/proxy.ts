/**
 * Bot 消息代理
 * 处理 1v1 和群聊中的 Bot 消息转发
 */

import type { ServerWebSocket } from "bun";
import { getDB } from "../db/database.js";
import { getGatewayConnection, sendToGateway } from "./gateway-pool.js";
import { shouldForwardToBot } from "./filter.js";

interface BotProxyTarget {
  botId: string;
  ws: ServerWebSocket<any>;       // 发送者的 WS 连接
  senderId: string;
  groupId?: string;               // 群聊时
  broadcastToGroup?: (msg: object) => void;  // 群聊广播函数
}

/**
 * 处理发给 Bot 的 1v1 消息
 */
export async function proxyToBot(
  botId: string,
  content: string,
  senderId: string,
  senderWs: ServerWebSocket<any>,
  clientId: string
): Promise<void> {
  const db = getDB();

  // 验证 Bot 存在
  const bot = db.prepare("SELECT id, name FROM bots WHERE id = ?").get(botId) as { id: string; name: string } | undefined;
  if (!bot) {
    senderWs.send(JSON.stringify({ type: "error", message: "bot not found" }));
    return;
  }

  // 存储用户发送的消息
  const userMsg = db.prepare(`
    INSERT INTO messages (sender_id, sender_type, receiver_id, content, msg_type, is_bot)
    VALUES (?, 'user', ?, ?, 'text', 0)
    RETURNING id, created_at
  `).get(senderId, botId, content) as { id: string; created_at: number };

  // 确认消息已发送
  senderWs.send(JSON.stringify({
    type: "message.status", id: userMsg.id, clientId, status: "sent",
  }));

  // 连接 Gateway 并转发
  try {
    const conn = await getGatewayConnection(botId);

    const fullText = await sendToGateway(conn, content, (chunk, done) => {
      // 流式推送给用户
      senderWs.send(JSON.stringify({
        type: "bot.chunk",
        botId,
        conversationId: botId,
        text: chunk,
        done,
        ...(done ? {} : {}),
      }));
    });

    // 流式完成，存储 Bot 回复
    if (fullText.trim()) {
      const botMsg = db.prepare(`
        INSERT INTO messages (sender_id, sender_type, receiver_id, content, msg_type, is_bot)
        VALUES (?, 'bot', ?, ?, 'text', 1)
        RETURNING id, created_at
      `).get(botId, senderId, fullText) as { id: string; created_at: number };

      // 发送完整消息
      senderWs.send(JSON.stringify({
        type: "message",
        id: botMsg.id,
        from: botId,
        fromType: "bot",
        to: senderId,
        toType: "user",
        msgType: "text",
        content: fullText,
        isBot: true,
        createdAt: botMsg.created_at,
      }));
    }
  } catch (e) {
    senderWs.send(JSON.stringify({
      type: "error",
      message: `Bot offline or unreachable: ${(e as Error).message}`,
    }));
  }
}

/**
 * 处理群聊消息中的 Bot 转发
 * 群消息已广播给人类成员后，调用此函数转发给群内 Bot
 */
export async function forwardGroupMessageToBots(
  groupId: string,
  content: string,
  senderId: string,
  senderType: string,
  broadcastToGroup: (msg: object) => void
): Promise<void> {
  // 过滤检查
  if (!shouldForwardToBot(content, senderType)) return;

  const db = getDB();

  // 查找群内所有 Bot 成员
  const bots = db.prepare(`
    SELECT b.id, b.name FROM bots b
    JOIN group_members gm ON gm.member_id = b.id AND gm.member_type = 'bot'
    WHERE gm.group_id = ?
  `).all(groupId) as { id: string; name: string }[];

  if (bots.length === 0) return;

  // 并行转发给所有 Bot（但每个 Bot 串行处理）
  const tasks = bots.map(async (bot) => {
    try {
      const conn = await getGatewayConnection(bot.id);

      const fullText = await sendToGateway(conn, content, (chunk, done) => {
        // 流式推送给群
        broadcastToGroup({
          type: "bot.chunk",
          botId: bot.id,
          conversationId: groupId,
          text: chunk,
          done,
        });
      });

      // 存储 Bot 回复
      if (fullText.trim()) {
        const botMsg = db.prepare(`
          INSERT INTO messages (sender_id, sender_type, group_id, content, msg_type, is_bot)
          VALUES (?, 'bot', ?, ?, 'text', 1)
          RETURNING id, created_at
        `).get(bot.id, groupId, fullText) as { id: string; created_at: number };

        // 广播完整消息给群
        broadcastToGroup({
          type: "message",
          id: botMsg.id,
          from: bot.id,
          fromType: "bot",
          groupId,
          msgType: "text",
          content: fullText,
          isBot: true,
          createdAt: botMsg.created_at,
        });
      }
    } catch (e) {
      // Bot 不可达，通知群
      broadcastToGroup({
        type: "bot.status",
        botId: bot.id,
        online: false,
      });
    }
  });

  await Promise.allSettled(tasks);
}
