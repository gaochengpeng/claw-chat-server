/**
 * Bot 消息代理
 * 处理 1v1 和群聊中的 Bot 消息转发
 */
import { getDB } from "../db/database.js";
import { getGatewayConnection, sendToGateway } from "./gateway-pool.js";
import { shouldForwardToBot } from "./filter.js";
/**
 * 处理发给 Bot 的 1v1 消息
 */
export async function proxyToBot(botId, content, senderId, senderWs, clientId) {
    const db = getDB();
    // 验证 Bot 存在
    const bot = db.prepare("SELECT id, name FROM bots WHERE id = ?").get(botId);
    if (!bot) {
        senderWs.send(JSON.stringify({ type: "error", message: "bot not found" }));
        return;
    }
    // 存储用户发送的消息
    const userMsg = db.prepare(`
    INSERT INTO messages (sender_id, sender_type, receiver_id, content, msg_type, is_bot)
    VALUES (?, 'user', ?, ?, 'text', 0)
    RETURNING id, created_at
  `).get(senderId, botId, content);
    // 确认消息已发送
    senderWs.send(JSON.stringify({
        type: "message.status", id: userMsg.id, clientId, status: "sent",
    }));
    // 连接 Gateway 并转发
    try {
        const conn = await getGatewayConnection(botId);
        const fullText = await sendToGateway(conn, content, (chunk, done) => {
            senderWs.send(JSON.stringify({
                type: "bot.chunk",
                botId,
                conversationId: botId,
                text: chunk,
                done,
            }));
        });
        // 流式完成，存储 Bot 回复
        if (fullText.trim()) {
            const botMsg = db.prepare(`
        INSERT INTO messages (sender_id, sender_type, receiver_id, content, msg_type, is_bot)
        VALUES (?, 'bot', ?, ?, 'text', 1)
        RETURNING id, created_at
      `).get(botId, senderId, fullText);
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
    }
    catch (e) {
        senderWs.send(JSON.stringify({
            type: "error",
            message: `Bot offline or unreachable: ${e.message}`,
        }));
    }
}
/**
 * 处理群聊消息中的 Bot 转发
 */
export async function forwardGroupMessageToBots(groupId, content, senderId, senderType, broadcastToGroup) {
    if (!shouldForwardToBot(content, senderType))
        return;
    const db = getDB();
    const bots = db.prepare(`
    SELECT b.id, b.name FROM bots b
    JOIN group_members gm ON gm.member_id = b.id AND gm.member_type = 'bot'
    WHERE gm.group_id = ?
  `).all(groupId);
    if (bots.length === 0)
        return;
    const tasks = bots.map(async (bot) => {
        try {
            const conn = await getGatewayConnection(bot.id);
            const fullText = await sendToGateway(conn, content, (chunk, done) => {
                broadcastToGroup({
                    type: "bot.chunk",
                    botId: bot.id,
                    conversationId: groupId,
                    text: chunk,
                    done,
                });
            });
            if (fullText.trim()) {
                const botMsg = db.prepare(`
          INSERT INTO messages (sender_id, sender_type, group_id, content, msg_type, is_bot)
          VALUES (?, 'bot', ?, ?, 'text', 1)
          RETURNING id, created_at
        `).get(bot.id, groupId, fullText);
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
        }
        catch (e) {
            broadcastToGroup({
                type: "bot.status",
                botId: bot.id,
                online: false,
            });
        }
    });
    await Promise.allSettled(tasks);
}
