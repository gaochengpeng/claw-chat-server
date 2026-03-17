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

// Initialize database
initDB();

const wsHandler = getWSHandler();

const server = Bun.serve({
  port: config.port,
  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (path === "/ws") {
      const upgraded = server.upgrade(req, { data: { user: null } });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // CORS headers
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Audio files
    if (path.startsWith("/audio/")) return serveAudio(path);

    // API routes
    if (path.startsWith("/api/auth/")) return handleAuth(req, path);
    if (path.startsWith("/api/users")) return handleUsers(req, path);
    if (path.startsWith("/api/contacts")) return handleContacts(req, path);
    if (path.startsWith("/api/bots")) return handleBots(req, path);
    if (path.startsWith("/api/groups")) return handleGroups(req, path);
    if (path.startsWith("/api/messages")) return handleMessages(req, path);

    return Response.json({ error: "not found" }, { status: 404 });
  },
  websocket: wsHandler as any,
});

console.log(`🦀 claw-chat-server running on http://localhost:${server.port}`);
