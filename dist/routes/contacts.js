import { getDB } from "../db/database.js";
import { extractUser, unauthorized } from "../auth/middleware.js";
export async function handleContacts(req, path) {
    const user = await extractUser(req);
    if (!user)
        return unauthorized();
    const db = getDB();
    if (path === "/api/contacts" && req.method === "GET") {
        const rows = db.prepare(`
      SELECT u.id, u.username, u.nickname, u.avatar_url, c.alias
      FROM contacts c JOIN users u ON u.id = c.contact_id
      WHERE c.user_id = ? ORDER BY c.created_at
    `).all(user.sub);
        return Response.json(rows);
    }
    if (path === "/api/contacts" && req.method === "POST") {
        const body = await req.json();
        if (!body.userId)
            return Response.json({ error: "userId required" }, { status: 400 });
        const target = db.prepare("SELECT id FROM users WHERE id = ?").get(body.userId);
        if (!target)
            return Response.json({ error: "user not found" }, { status: 404 });
        // Add bidirectional contact
        const insert = db.prepare("INSERT OR IGNORE INTO contacts (user_id, contact_id) VALUES (?, ?)");
        const tx = db.transaction(() => {
            insert.run(user.sub, body.userId);
            insert.run(body.userId, user.sub);
        });
        tx();
        return Response.json({ ok: true });
    }
    // DELETE /api/contacts/:userId
    const deleteMatch = path.match(/^\/api\/contacts\/(.+)$/);
    if (deleteMatch && req.method === "DELETE") {
        const contactId = deleteMatch[1];
        db.prepare("DELETE FROM contacts WHERE user_id = ? AND contact_id = ?").run(user.sub, contactId);
        return Response.json({ ok: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
}
