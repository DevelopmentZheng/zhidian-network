// 使用 Node 内置 SQLite(node:sqlite),零原生依赖。
// 原型阶段用 CREATE TABLE IF NOT EXISTS 直接建表(后续阶段再上版本化迁移)。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';

const db = new DatabaseSync(path.join(config.dataDir, 'zhidian.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sites (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  subdomain          TEXT UNIQUE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  moderation_status  TEXT NOT NULL DEFAULT 'pending',
  last_moderation_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending',
  dimension      TEXT,
  confidence     REAL,
  reason         TEXT,
  file_path      TEXT,
  content_snippet TEXT,
  model_used     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_moderations_site ON moderations(site_id);
CREATE INDEX IF NOT EXISTS idx_moderations_status ON moderations(status);
`);

import bcrypt from 'bcryptjs';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';

const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
if (!existingAdmin) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(ADMIN_USERNAME, hash, 1);
  console.log(`默认管理员账号已创建: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
}

export default db;
