import { webcrypto } from "crypto";
if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;

import { createServer } from "http";
import { WebSocketServer } from "ws";
import { initDB } from "./db/database.js";
import { config } from "./config.js";
import { handleAuth } from "./routes/auth.js";
import { handleUsers } from "./routes/users.js";
import { handleContacts } from "./routes/contacts.js";
import { handleMessages } from "./routes/messages.js";
import { handleBots } from "./routes/bots.js";
import { handleGroups } from "./routes/groups.js";
import { serveAudio } from "./audio/storage.js";
import { getWSHandler } from "./ws/handler.js";
import {
  securityHeaders, corsHeaders, checkAuthRate, checkApiRate, getClientIP,
} from "./security/index.js";

// Initialize database
initDB();

const wsHandler = getWSHandler();

// Helper: collect request body with size limit
async function readBody(req: import("http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > config.maxBodySize) {
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

// Convert Node IncomingMessage to Web Request
async function toWebRequest(req: import("http").IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host || "localhost"}${req.url || "/"}`;
  const method = req.method || "GET";
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  return new Request(url, { method, headers, body });
}

// Convert Web Response to Node response
async function sendWebResponse(
  res: import("http").ServerResponse,
  webRes: Response,
  extraHeaders: Record<string, string> = {}
) {
  const headers: Record<string, string> = {
    ...Object.fromEntries(webRes.headers.entries()),
    ...extraHeaders,
  };
  res.writeHead(webRes.status, headers);
  const buf = await webRes.arrayBuffer();
  res.end(Buffer.from(buf));
}

const server = createServer(async (req, res) => {
  const ip = getClientIP(req);
  const origin = req.headers.origin || null;
  const secHeaders = { ...securityHeaders(), ...corsHeaders(origin) };

  try {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, secHeaders);
      res.end();
      return;
    }

    const path = (req.url || "/").split("?")[0];

    // Rate limiting
    const isAuthPath = path.startsWith("/api/auth/");
    if (isAuthPath && !checkAuthRate(ip)) {
      res.writeHead(429, { ...secHeaders, "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "too many requests" }));
      return;
    }
    if (!isAuthPath && !checkApiRate(ip)) {
      res.writeHead(429, { ...secHeaders, "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "too many requests" }));
      return;
    }

    let webReq: Request;
    try {
      webReq = await toWebRequest(req);
    } catch (e) {
      if ((e as Error).message === "BODY_TOO_LARGE") {
        res.writeHead(413, { ...secHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "request too large" }));
        return;
      }
      throw e;
    }

    let webRes: Response;

    // Audio files
    if (path.startsWith("/audio/")) {
      webRes = serveAudio(path);
    } else if (path.startsWith("/api/auth/")) {
      webRes = await handleAuth(webReq, path);
    } else if (path.startsWith("/api/users")) {
      webRes = await handleUsers(webReq, path);
    } else if (path.startsWith("/api/contacts")) {
      webRes = await handleContacts(webReq, path);
    } else if (path.startsWith("/api/bots")) {
      webRes = await handleBots(webReq, path);
    } else if (path.startsWith("/api/groups")) {
      webRes = await handleGroups(webReq, path);
    } else if (path.startsWith("/api/messages")) {
      webRes = await handleMessages(webReq, path);
    } else {
      webRes = Response.json({ error: "not found" }, { status: 404 });
    }

    await sendWebResponse(res, webRes, secHeaders);
  } catch (e) {
    console.error("Request error:", (e as Error).message);
    res.writeHead(500, { ...secHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal server error" }));
  }
});

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const wrappedWs = Object.assign(ws, { data: { user: null } });
  wsHandler.open(wrappedWs as any);

  // Auth timeout: close if not authenticated within limit
  const authTimer = setTimeout(() => {
    if (!wrappedWs.data.user) {
      ws.close(4001, "auth timeout");
    }
  }, config.wsAuthTimeoutMs);

  ws.on("message", (raw) => {
    if (wrappedWs.data.user) clearTimeout(authTimer);
    wsHandler.message(wrappedWs as any, raw.toString());
  });

  ws.on("close", (code, reason) => {
    clearTimeout(authTimer);
    wsHandler.close(wrappedWs as any, code, reason.toString());
  });
});

server.listen(config.port, () => {
  console.log(`🦀 claw-chat-server running on http://localhost:${config.port}`);
});
