import { getDB } from "../db/database.js";
import { hashPassword, comparePassword } from "../auth/password.js";
import { signToken } from "../auth/jwt.js";
import { validatePassword, sanitizeString } from "../security/index.js";
export async function handleAuth(req, path) {
    if (req.method !== "POST") {
        return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    let body;
    try {
        body = await req.json();
    }
    catch {
        return Response.json({ error: "invalid request body" }, { status: 400 });
    }
    if (path === "/api/auth/register") {
        const { username, password, nickname, inviteCode } = body;
        if (!username || !password || !nickname || !inviteCode) {
            return Response.json({ error: "username, password, nickname, inviteCode required" }, { status: 400 });
        }
        // Validate username format
        const cleanUsername = username.trim().toLowerCase();
        if (cleanUsername.length < 2 || cleanUsername.length > 32) {
            return Response.json({ error: "username must be 2-32 characters" }, { status: 400 });
        }
        if (!/^[a-z0-9_-]+$/.test(cleanUsername)) {
            return Response.json({ error: "username can only contain letters, numbers, - and _" }, { status: 400 });
        }
        // Validate password strength
        const pwError = validatePassword(password);
        if (pwError) {
            return Response.json({ error: pwError }, { status: 400 });
        }
        // Sanitize nickname
        const cleanNickname = sanitizeString(nickname, 50);
        if (cleanNickname.length < 1) {
            return Response.json({ error: "nickname required" }, { status: 400 });
        }
        const db = getDB();
        // Use generic error to prevent user enumeration
        const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(cleanUsername);
        if (existing) {
            return Response.json({ error: "registration failed" }, { status: 400 });
        }
        const invite = db.prepare("SELECT code, used_at, used_by FROM invite_codes WHERE code = ?").get(inviteCode.trim());
        if (!invite || invite.used_at || invite.used_by) {
            return Response.json({ error: "registration failed" }, { status: 400 });
        }
        const hashed = await hashPassword(password);
        const registerWithInvite = db.transaction((u, h, n, ic) => {
            const freshInvite = db.prepare("SELECT code, used_at, used_by FROM invite_codes WHERE code = ?").get(ic);
            if (!freshInvite || freshInvite.used_at || freshInvite.used_by) {
                throw new Error("INVITE_INVALID");
            }
            const user = db.prepare("INSERT INTO users (username, password, nickname) VALUES (?, ?, ?) RETURNING id, username, nickname").get(u, h, n);
            db.prepare("UPDATE invite_codes SET used_at = unixepoch(), used_by = ? WHERE code = ? AND used_at IS NULL AND used_by IS NULL").run(user.id, ic);
            return user;
        });
        try {
            const user = registerWithInvite(cleanUsername, hashed, cleanNickname, inviteCode.trim());
            const token = await signToken({ sub: user.id, username: user.username });
            return Response.json({ token, user: { id: user.id, username: user.username, nickname: user.nickname } });
        }
        catch {
            return Response.json({ error: "registration failed" }, { status: 400 });
        }
    }
    if (path === "/api/auth/login") {
        const { username, password } = body;
        if (!username || !password) {
            return Response.json({ error: "invalid credentials" }, { status: 401 });
        }
        const db = getDB();
        const row = db.prepare("SELECT id, username, nickname, password FROM users WHERE username = ?").get(username.trim().toLowerCase());
        // Constant-time-ish: always hash even if user not found
        if (!row) {
            await hashPassword("dummy-to-prevent-timing");
            return Response.json({ error: "invalid credentials" }, { status: 401 });
        }
        if (!(await comparePassword(password, row.password))) {
            return Response.json({ error: "invalid credentials" }, { status: 401 });
        }
        const token = await signToken({ sub: row.id, username: row.username });
        return Response.json({ token, user: { id: row.id, username: row.username, nickname: row.nickname } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
}
