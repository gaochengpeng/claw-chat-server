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
// Initialize database
initDB();
const wsHandler = getWSHandler();
// Helper: collect request body
async function readBody(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString();
}
// Convert Node IncomingMessage to Web Request
async function toWebRequest(req) {
    const url = `http://${req.headers.host || "localhost"}${req.url || "/"}`;
    const method = req.method || "GET";
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
        if (val)
            headers.set(key, Array.isArray(val) ? val.join(", ") : val);
    }
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readBody(req) : undefined;
    return new Request(url, { method, headers, body });
}
// Convert Web Response to Node response
async function sendWebResponse(res, webRes) {
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    const buf = await webRes.arrayBuffer();
    res.end(Buffer.from(buf));
}
const server = createServer(async (req, res) => {
    try {
        const webReq = await toWebRequest(req);
        const url = new URL(webReq.url);
        const path = url.pathname;
        // CORS
        if (webReq.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            });
            res.end();
            return;
        }
        let webRes;
        // Audio files
        if (path.startsWith("/audio/")) {
            webRes = serveAudio(path);
        }
        else if (path.startsWith("/api/auth/")) {
            webRes = await handleAuth(webReq, path);
        }
        else if (path.startsWith("/api/users")) {
            webRes = await handleUsers(webReq, path);
        }
        else if (path.startsWith("/api/contacts")) {
            webRes = await handleContacts(webReq, path);
        }
        else if (path.startsWith("/api/bots")) {
            webRes = await handleBots(webReq, path);
        }
        else if (path.startsWith("/api/groups")) {
            webRes = await handleGroups(webReq, path);
        }
        else if (path.startsWith("/api/messages")) {
            webRes = await handleMessages(webReq, path);
        }
        else {
            webRes = Response.json({ error: "not found" }, { status: 404 });
        }
        // Add CORS to all responses
        webRes.headers.set("Access-Control-Allow-Origin", "*");
        await sendWebResponse(res, webRes);
    }
    catch (e) {
        console.error("Request error:", e);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
    }
});
// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
    const wrappedWs = Object.assign(ws, { data: { user: null } });
    wsHandler.open(wrappedWs);
    ws.on("message", (raw) => {
        wsHandler.message(wrappedWs, raw.toString());
    });
    ws.on("close", (code, reason) => {
        wsHandler.close(wrappedWs, code, reason.toString());
    });
});
server.listen(config.port, () => {
    console.log(`🦀 claw-chat-server running on http://localhost:${config.port}`);
});
