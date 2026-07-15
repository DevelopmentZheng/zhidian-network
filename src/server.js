import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { config, RESERVED_SUBDOMAINS, SUBDOMAIN_RE } from './config.js';
import { register, login, logout, userFromToken } from './auth.js';
import { deployZip, removeSiteFiles } from './deploy.js';
import { httpErr } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = new Hono();

const requireUser = async (c, next) => {
  const user = userFromToken(getCookie(c, 'session'));
  if (!user) return c.json({ error: '请先登录' }, 401);
  c.set('user', user);
  await next();
};

const requireAdmin = async (c, next) => {
  const user = userFromToken(getCookie(c, 'session'));
  if (!user) return c.json({ error: '请先登录' }, 401);
  if (!user.is_admin) return c.json({ error: '无管理员权限' }, 403);
  c.set('user', user);
  await next();
};

app.onError((err, c) => {
  if (err.status) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: '服务器内部错误' }, 500);
});

const pubUser = (u) => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin });
const isIp = (d) => /^\d{1,3}(\.\d{1,3}){3}$/.test(d);
const siteUrl = (sub) => (isIp(config.siteDomain) ? `/s/${sub}/` : `http://${sub}.${config.siteDomain}/`);
function setSession(c, token) {
  setCookie(c, 'session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: false,
    maxAge: 7 * 86400,
  });
}

// ---------- 认证 ----------
app.post('/api/register', async (c) => {
  const body = await c.req.json();
  register(body);
  const { token, user } = login(body);
  setSession(c, token);
  return c.json({ ok: true, user: pubUser(user) });
});

app.post('/api/login', async (c) => {
  const { token, user } = login(await c.req.json());
  setSession(c, token);
  return c.json({ ok: true, user: pubUser(user) });
});

app.post('/api/logout', (c) => {
  logout(getCookie(c, 'session'));
  deleteCookie(c, 'session', { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', requireUser, (c) => c.json({ user: pubUser(c.get('user')), siteDomain: config.siteDomain }));

// ---------- 站点 ----------
app.get('/api/sites', requireUser, (c) => {
  const sites = db
    .prepare('SELECT id, name, subdomain, status, moderation_status, created_at, updated_at FROM sites WHERE user_id = ? ORDER BY id DESC')
    .all(c.get('user').id);
  return c.json({ sites, siteDomain: config.siteDomain });
});

app.post('/api/sites', requireUser, async (c) => {
  const user = c.get('user');
  const { name, subdomain } = await c.req.json();
  const sub = String(subdomain || '').trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(sub)) throw httpErr(400, '子域名需为 3~30 位小写字母/数字/中横线,首尾非横线');
  if (RESERVED_SUBDOMAINS.has(sub)) throw httpErr(400, '该子域名为系统保留,请换一个');
  if (db.prepare('SELECT 1 FROM sites WHERE subdomain = ?').get(sub)) throw httpErr(409, '该子域名已被占用');

  const r = db.prepare('INSERT INTO sites (user_id, name, subdomain) VALUES (?, ?, ?)').run(user.id, String(name || sub).trim().slice(0, 50), sub);
  return c.json({ ok: true, id: r.lastInsertRowid, url: siteUrl(sub) });
});

const ownedSite = (c) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(c.req.param('id'));
  if (!site) throw httpErr(404, '站点不存在');
  if (site.user_id !== c.get('user').id) throw httpErr(403, '无权操作该站点');
  return site;
};

app.post('/api/sites/:id/deploy', requireUser, async (c) => {
  const site = ownedSite(c);
  const len = Number(c.req.header('content-length') || 0);
  if (len > config.maxUploadBytes + 1024 * 64) throw httpErr(413, `ZIP 不能超过 ${Math.round(config.maxUploadBytes / 1048576)}MB`);

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw httpErr(400, '请以 multipart 形式上传 file 字段');
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > config.maxUploadBytes) throw httpErr(413, 'ZIP 超过大小限制');

  const { fileCount, moderation } = deployZip(site.subdomain, buf, site.id);
  return c.json({ ok: true, fileCount, url: siteUrl(site.subdomain), moderation });
});

app.delete('/api/sites/:id', requireUser, (c) => {
  const site = ownedSite(c);
  removeSiteFiles(site.subdomain);
  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
  return c.json({ ok: true });
});

// ---------- 管理端 API ----------
app.get('/api/admin/moderations', requireAdmin, (c) => {
  const status = c.req.query('status');
  let where = '';
  let params = [];
  if (status && ['pending', 'suspect', 'rejected'].includes(status)) {
    where = 'WHERE m.status = ?';
    params = [status];
  }
  const moderations = db.prepare(`
    SELECT m.*, s.name as site_name, s.subdomain, u.username as user_name
    FROM moderations m
    JOIN sites s ON s.id = m.site_id
    JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY m.created_at DESC
  `).all(...params);
  return c.json({ moderations });
});

app.post('/api/admin/moderations/:id/approve', requireAdmin, (c) => {
  const mod = db.prepare('SELECT * FROM moderations WHERE id = ?').get(c.req.param('id'));
  if (!mod) throw httpErr(404, '审核记录不存在');
  
  db.prepare('UPDATE moderations SET status = ? WHERE id = ?').run('passed', mod.id);
  db.prepare('UPDATE sites SET moderation_status = ?, status = ? WHERE id = ?').run('passed', 'active', mod.site_id);
  
  return c.json({ ok: true });
});

app.post('/api/admin/moderations/:id/reject', requireAdmin, (c) => {
  const mod = db.prepare('SELECT * FROM moderations WHERE id = ?').get(c.req.param('id'));
  if (!mod) throw httpErr(404, '审核记录不存在');
  
  db.prepare('UPDATE moderations SET status = ? WHERE id = ?').run('rejected', mod.id);
  db.prepare('UPDATE sites SET moderation_status = ?, status = ? WHERE id = ?').run('rejected', 'offline', mod.site_id);
  
  return c.json({ ok: true });
});

app.get('/api/admin/sites', requireAdmin, (c) => {
  const sites = db.prepare(`
    SELECT s.*, u.username as user_name
    FROM sites s
    JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at DESC
  `).all();
  return c.json({ sites });
});

app.post('/api/admin/sites/:id/toggle-status', requireAdmin, async (c) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(c.req.param('id'));
  if (!site) throw httpErr(404, '站点不存在');
  
  const newStatus = site.status === 'active' ? 'offline' : 'active';
  db.prepare('UPDATE sites SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newStatus, site.id);
  
  return c.json({ ok: true, status: newStatus });
});

app.delete('/api/admin/sites/:id', requireAdmin, (c) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(c.req.param('id'));
  if (!site) throw httpErr(404, '站点不存在');
  
  removeSiteFiles(site.subdomain);
  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
  
  return c.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (c) => {
  const users = db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  return c.json({ users });
});

app.post('/api/admin/users/:id/toggle-admin', requireAdmin, (c) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(c.req.param('id'));
  if (!user) throw httpErr(404, '用户不存在');
  
  const newAdmin = user.is_admin ? 0 : 1;
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(newAdmin, user.id);
  
  return c.json({ ok: true, isAdmin: !!newAdmin });
});

// ---------- 静态:管理面板 ----------
app.use('/*', serveStatic({ root: path.relative(process.cwd(), path.join(__dirname, '..', 'public')) }));

if (process.env.NODE_ENV !== 'test') {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`zhidian-prototype listening on :${info.port}`);
    console.log(`  domain: *.${config.siteDomain}`);
    console.log(`  data:   ${config.dataDir}`);
  });
}

export { app };
