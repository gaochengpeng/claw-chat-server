import { getDB } from "../db/database.js";
import { extractUser, unauthorized } from "../auth/middleware.js";

export async function handleGroups(req: Request, path: string): Promise<Response> {
  const user = await extractUser(req);
  if (!user) return unauthorized();

  const db = getDB();

  // GET /api/groups — 我的群组列表
  if (path === "/api/groups" && req.method === "GET") {
    const rows = db.prepare(`
      SELECT g.id, g.name, g.avatar_url as "avatarUrl", g.created_by as "createdBy",
             (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as "memberCount"
      FROM groups g
      JOIN group_members gm ON gm.group_id = g.id AND gm.member_id = ? AND gm.member_type = 'user'
      ORDER BY g.updated_at DESC
    `).all(user.sub);
    return Response.json(rows);
  }

  // POST /api/groups — 创建群组
  if (path === "/api/groups" && req.method === "POST") {
    const body = await req.json() as {
      name: string; avatarUrl?: string;
      memberIds?: { id: string; type: "user" | "bot" }[];
    };
    if (!body.name?.trim()) {
      return Response.json({ error: "name required" }, { status: 400 });
    }

    const group = db.prepare(`
      INSERT INTO groups (name, avatar_url, created_by)
      VALUES (?, ?, ?)
      RETURNING id, name, avatar_url as "avatarUrl", created_by as "createdBy"
    `).get(body.name.trim(), body.avatarUrl || null, user.sub) as {
      id: string; name: string; avatarUrl: string | null; createdBy: string;
    };

    // Add creator as owner
    const insertMember = db.prepare(
      "INSERT INTO group_members (group_id, member_id, member_type, role) VALUES (?, ?, ?, ?)"
    );
    insertMember.run(group.id, user.sub, "user", "owner");

    // Add initial members
    if (body.memberIds?.length) {
      const tx = db.transaction(() => {
        for (const m of body.memberIds!) {
          if (m.id === user.sub && m.type === "user") continue; // skip creator duplicate
          insertMember.run(group.id, m.id, m.type, "member");
        }
      });
      tx();
    }

    const members = db.prepare(`
      SELECT member_id as "id", member_type as "type", role FROM group_members WHERE group_id = ?
    `).all(group.id);

    return Response.json({ ...group, members }, { status: 201 });
  }

  // GET /api/groups/:groupId — 群组详情
  const detailMatch = path.match(/^\/api\/groups\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const groupId = detailMatch[1];

    // Verify membership
    const isMember = db.prepare(
      "SELECT 1 FROM group_members WHERE group_id = ? AND member_id = ? AND member_type = 'user'"
    ).get(groupId, user.sub);
    if (!isMember) return Response.json({ error: "not a member" }, { status: 403 });

    const group = db.prepare(`
      SELECT id, name, avatar_url as "avatarUrl", created_by as "createdBy"
      FROM groups WHERE id = ?
    `).get(groupId);
    if (!group) return Response.json({ error: "group not found" }, { status: 404 });

    // Get members with details
    const members = db.prepare(`
      SELECT gm.member_id as "id", gm.member_type as "type", gm.role,
        CASE gm.member_type
          WHEN 'user' THEN (SELECT nickname FROM users WHERE id = gm.member_id)
          WHEN 'bot'  THEN (SELECT name FROM bots WHERE id = gm.member_id)
        END as "name",
        CASE gm.member_type
          WHEN 'user' THEN (SELECT avatar_url FROM users WHERE id = gm.member_id)
          WHEN 'bot'  THEN (SELECT avatar_url FROM bots WHERE id = gm.member_id)
        END as "avatarUrl"
      FROM group_members gm WHERE gm.group_id = ?
    `).all(groupId);

    return Response.json({ ...(group as object), members });
  }

  // PATCH /api/groups/:groupId — 更新群组信息
  const patchMatch = path.match(/^\/api\/groups\/([^/]+)$/);
  if (patchMatch && req.method === "PATCH") {
    const groupId = patchMatch[1];
    const group = db.prepare("SELECT created_by FROM groups WHERE id = ?").get(groupId) as { created_by: string } | undefined;
    if (!group) return Response.json({ error: "group not found" }, { status: 404 });

    // Only creator or admin can update
    const membership = db.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND member_id = ? AND member_type = 'user'"
    ).get(groupId, user.sub) as { role: string } | undefined;
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    const body = await req.json() as Record<string, unknown>;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) { fields.push("name = ?"); values.push(body.name); }
    if (body.avatarUrl !== undefined) { fields.push("avatar_url = ?"); values.push(body.avatarUrl); }
    if (fields.length === 0) return Response.json({ error: "nothing to update" }, { status: 400 });

    fields.push("updated_at = unixepoch()");
    values.push(groupId);
    db.prepare(`UPDATE groups SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return Response.json({ ok: true });
  }

  // POST /api/groups/:groupId/members — 添加成员
  const addMemberMatch = path.match(/^\/api\/groups\/([^/]+)\/members$/);
  if (addMemberMatch && req.method === "POST") {
    const groupId = addMemberMatch[1];
    const membership = db.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND member_id = ? AND member_type = 'user'"
    ).get(groupId, user.sub) as { role: string } | undefined;
    if (!membership) return Response.json({ error: "not a member" }, { status: 403 });

    const body = await req.json() as { memberId: string; memberType: "user" | "bot" };
    if (!body.memberId || !body.memberType) {
      return Response.json({ error: "memberId and memberType required" }, { status: 400 });
    }

    try {
      db.prepare(
        "INSERT INTO group_members (group_id, member_id, member_type) VALUES (?, ?, ?)"
      ).run(groupId, body.memberId, body.memberType);
    } catch {
      return Response.json({ error: "already a member or invalid" }, { status: 409 });
    }

    return Response.json({ ok: true }, { status: 201 });
  }

  // DELETE /api/groups/:groupId/members/:memberId?type=user — 移除成员
  const removeMemberMatch = path.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)$/);
  if (removeMemberMatch && req.method === "DELETE") {
    const groupId = removeMemberMatch[1];
    const memberId = removeMemberMatch[2];
    const url = new URL(req.url);
    const memberType = url.searchParams.get("type") || "user";

    // Only owner/admin can remove others
    const membership = db.prepare(
      "SELECT role FROM group_members WHERE group_id = ? AND member_id = ? AND member_type = 'user'"
    ).get(groupId, user.sub) as { role: string } | undefined;
    if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    db.prepare(
      "DELETE FROM group_members WHERE group_id = ? AND member_id = ? AND member_type = ?"
    ).run(groupId, memberId, memberType);
    return Response.json({ ok: true });
  }

  // POST /api/groups/:groupId/leave — 退出群组
  const leaveMatch = path.match(/^\/api\/groups\/([^/]+)\/leave$/);
  if (leaveMatch && req.method === "POST") {
    const groupId = leaveMatch[1];
    db.prepare(
      "DELETE FROM group_members WHERE group_id = ? AND member_id = ? AND member_type = 'user'"
    ).run(groupId, user.sub);
    return Response.json({ ok: true });
  }

  // DELETE /api/groups/:groupId — 解散群组 (仅创建者)
  const deleteMatch = path.match(/^\/api\/groups\/([^/]+)$/);
  if (deleteMatch && req.method === "DELETE") {
    const groupId = deleteMatch[1];
    const group = db.prepare("SELECT created_by FROM groups WHERE id = ?").get(groupId) as { created_by: string } | undefined;
    if (!group) return Response.json({ error: "group not found" }, { status: 404 });
    if (group.created_by !== user.sub) return Response.json({ error: "only creator can delete" }, { status: 403 });

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM group_members WHERE group_id = ?").run(groupId);
      db.prepare("DELETE FROM groups WHERE id = ?").run(groupId);
    });
    tx();
    return Response.json({ ok: true });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}
