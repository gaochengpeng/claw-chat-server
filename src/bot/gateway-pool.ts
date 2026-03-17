/**
 * OpenClaw Gateway 连接池管理
 * 每个 Bot 维护一个到其 Gateway 的 WS 连接
 */

import WebSocket from "ws";
import { getDB } from "../db/database.js";

interface GatewayConnection {
  ws: WebSocket;
  botId: string;
  gatewayUrl: string;
  connected: boolean;
  lastActivity: number;
  pendingResolve: ((value: void) => void) | null;
  messageHandler: ((data: GatewayEvent) => void) | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface GatewayEvent {
  type: string;
  event?: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  data?: {
    kind?: string;   // "chunk" | "done" | "error"
    text?: string;
    sessionKey?: string;
  };
}

const pool = new Map<string, GatewayConnection>();

const IDLE_TIMEOUT = 5 * 60 * 1000;       // 5 min
const CONNECT_TIMEOUT = 10 * 1000;         // 10s
const MAX_RECONNECT_DELAY = 30 * 1000;     // 30s
const BASE_RECONNECT_DELAY = 1000;         // 1s

/**
 * 获取或创建到 Bot Gateway 的连接
 */
export async function getGatewayConnection(botId: string): Promise<GatewayConnection> {
  const existing = pool.get(botId);
  if (existing?.connected) {
    resetIdleTimer(existing);
    return existing;
  }

  // 从数据库获取 Bot 信息
  const db = getDB();
  const bot = db.prepare(
    "SELECT gateway_url, gateway_token FROM bots WHERE id = ?"
  ).get(botId) as { gateway_url: string; gateway_token: string | null } | undefined;

  if (!bot) throw new Error(`Bot ${botId} not found`);

  return createConnection(botId, bot.gateway_url, bot.gateway_token);
}

async function createConnection(
  botId: string, gatewayUrl: string, gatewayToken: string | null
): Promise<GatewayConnection> {
  // 清理旧连接
  const old = pool.get(botId);
  if (old) {
    clearTimers(old);
    try { old.ws.close(); } catch {}
  }

  return new Promise<GatewayConnection>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Gateway connection timeout for bot ${botId}`));
      try { ws.close(); } catch {}
    }, CONNECT_TIMEOUT);

    const ws = new WebSocket(gatewayUrl);

    const conn: GatewayConnection = {
      ws,
      botId,
      gatewayUrl,
      connected: false,
      lastActivity: Date.now(),
      pendingResolve: null,
      messageHandler: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      idleTimer: null,
    };

    pool.set(botId, conn);

    ws.onopen = () => {
      // 发送 connect 握手
      const connectMsg = {
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          client: {
            id: "clawchat-proxy",
            mode: "webchat",
            version: "1.0.0",
            displayName: "ClawChat Bot Proxy",
          },
          auth: gatewayToken ? { token: gatewayToken } : undefined,
        },
      };
      ws.send(JSON.stringify(connectMsg));
    };

    ws.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : event.data.toString();
      let msg: GatewayEvent;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      // 处理 connect 响应
      if (msg.type === "res" && msg.id === "connect-1") {
        clearTimeout(timeout);
        if (msg.ok) {
          conn.connected = true;
          conn.reconnectAttempts = 0;
          updateBotOnlineStatus(botId, true);
          resetIdleTimer(conn);
          resolve(conn);
        } else {
          pool.delete(botId);
          reject(new Error(`Gateway auth failed for bot ${botId}`));
        }
        return;
      }

      // 转发给当前消息处理器
      if (conn.messageHandler) {
        conn.messageHandler(msg);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      conn.connected = false;
      updateBotOnlineStatus(botId, false);
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      conn.connected = false;
      updateBotOnlineStatus(botId, false);

      // 自动重连（如果不是主动关闭）
      if (pool.has(botId)) {
        scheduleReconnect(conn, gatewayToken);
      }
    };
  });
}

function scheduleReconnect(conn: GatewayConnection, gatewayToken: string | null) {
  if (conn.reconnectTimer) return;

  const delay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, conn.reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  conn.reconnectAttempts++;

  conn.reconnectTimer = setTimeout(async () => {
    conn.reconnectTimer = null;
    try {
      await createConnection(conn.botId, conn.gatewayUrl, gatewayToken);
    } catch {
      // 重连失败，会在 onclose 中再次触发
    }
  }, delay);
}

function resetIdleTimer(conn: GatewayConnection) {
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => {
    disconnectBot(conn.botId);
  }, IDLE_TIMEOUT);
  conn.lastActivity = Date.now();
}

function clearTimers(conn: GatewayConnection) {
  if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
  if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = null; }
}

/**
 * 发送消息到 Gateway 并监听流式回复
 */
export function sendToGateway(
  conn: GatewayConnection,
  message: string,
  onChunk: (text: string, done: boolean) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reqId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let fullText = "";

    conn.messageHandler = (msg: GatewayEvent) => {
      // chat.send 响应
      if (msg.type === "res" && msg.id === reqId) {
        if (!msg.ok) {
          conn.messageHandler = null;
          reject(new Error("Gateway chat.send failed"));
        }
        // 响应 ok，等待 agent events
        return;
      }

      // 流式 agent 事件
      if (msg.type === "event" && msg.event === "agent" && msg.data) {
        if (msg.data.kind === "chunk" && msg.data.text) {
          fullText += msg.data.text;
          onChunk(msg.data.text, false);
        } else if (msg.data.kind === "done") {
          conn.messageHandler = null;
          onChunk("", true);
          resolve(fullText);
        } else if (msg.data.kind === "error") {
          conn.messageHandler = null;
          reject(new Error("Gateway agent error"));
        }
      }
    };

    // 发送 chat.send
    const chatMsg = {
      type: "req",
      id: reqId,
      method: "chat.send",
      params: {
        message,
        sessionKey: "agent:main:main",
      },
    };

    try {
      conn.ws.send(JSON.stringify(chatMsg));
      resetIdleTimer(conn);
    } catch (e) {
      conn.messageHandler = null;
      reject(e);
    }
  });
}

/**
 * 断开 Bot 连接
 */
export function disconnectBot(botId: string) {
  const conn = pool.get(botId);
  if (conn) {
    clearTimers(conn);
    try { conn.ws.close(); } catch {}
    pool.delete(botId);
    updateBotOnlineStatus(botId, false);
  }
}

/**
 * 断开所有连接
 */
export function disconnectAll() {
  for (const [botId] of pool) {
    disconnectBot(botId);
  }
}

/**
 * 获取连接池状态
 */
export function getPoolStatus(): { botId: string; connected: boolean; lastActivity: number }[] {
  return Array.from(pool.values()).map(c => ({
    botId: c.botId,
    connected: c.connected,
    lastActivity: c.lastActivity,
  }));
}

function updateBotOnlineStatus(botId: string, online: boolean) {
  try {
    const db = getDB();
    db.prepare("UPDATE bots SET is_online = ? WHERE id = ?").run(online ? 1 : 0, botId);
  } catch {}
}
