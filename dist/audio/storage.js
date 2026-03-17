import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { config } from "../config.js";
export function serveAudio(path) {
    const match = path.match(/^\/audio\/(.+)$/);
    if (!match)
        return new Response("not found", { status: 404 });
    const filename = match[1].replace(/[^a-zA-Z0-9._-]/g, ""); // sanitize
    const filepath = resolve(config.audioDir, filename);
    if (!existsSync(filepath))
        return new Response("not found", { status: 404 });
    const data = readFileSync(filepath);
    return new Response(data, {
        headers: { "Content-Type": "audio/ogg", "Cache-Control": "public, max-age=86400" },
    });
}
