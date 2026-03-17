PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  username    TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,
  nickname    TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 邀请码表
CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  used_at     INTEGER,
  used_by     TEXT REFERENCES users(id),
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_used_by ON invite_codes(used_by);
CREATE INDEX IF NOT EXISTS idx_invite_codes_used_at ON invite_codes(used_at);

-- Bot 表 (用户绑定的 OpenClaw 实例)
CREATE TABLE IF NOT EXISTS bots (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  owner_id      TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  avatar_url    TEXT,
  gateway_url   TEXT NOT NULL,
  gateway_token TEXT,
  is_public     INTEGER NOT NULL DEFAULT 1,
  is_online     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);

-- 群组表
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name        TEXT NOT NULL,
  avatar_url  TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 群成员表
CREATE TABLE IF NOT EXISTS group_members (
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL,
  member_type TEXT NOT NULL CHECK(member_type IN ('user', 'bot')),
  role        TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  joined_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, member_id, member_type)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_id, member_type);

-- 联系人关系 (双向, 仅 user-to-user)
CREATE TABLE IF NOT EXISTS contacts (
  user_id    TEXT NOT NULL REFERENCES users(id),
  contact_id TEXT NOT NULL REFERENCES users(id),
  alias      TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_contact ON contacts(contact_id);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  sender_id   TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'bot')),
  receiver_id TEXT,
  group_id    TEXT,
  content     TEXT,
  msg_type    TEXT NOT NULL DEFAULT 'text',
  is_bot      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((receiver_id IS NOT NULL AND group_id IS NULL) OR (receiver_id IS NULL AND group_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
