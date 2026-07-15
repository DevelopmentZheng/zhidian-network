import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from './db.js';
import { httpErr } from './errors.js';

const SESSION_DAYS = 7;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function register({ username, password, isAdmin = false }) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  if (!/^[a-z0-9_-]{3,20}$/.test(username)) throw httpErr(400, '用户名需为 3~20 位小写字母/数字/横线/下划线');
  if (password.length < 8) throw httpErr(400, '密码至少 8 位');

  const hash = bcrypt.hashSync(password, 10);
  try {
    const r = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, hash, isAdmin ? 1 : 0);
    return r.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw httpErr(409, '用户名已被注册');
    throw e;
  }
}

export function login({ username, password }) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    throw httpErr(401, '用户名或密码错误');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, expires);
  return { token, user };
}

export function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `)
    .get(sha256(token));
  return row || null;
}

// 启动时清理过期会话
db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
