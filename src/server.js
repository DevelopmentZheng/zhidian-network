// 指点网络 原型 —— Hono 应用 + 路由 + 启动。
// export app 供测试导入;仅当直接运行(node src/server.js)时才监听端口。
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

// ---------- 中间件 ----------
const requireUser = async (c, next) => {
  const user = userFromToken(getCookie(c, 'session'));
  if (!user) return c.json({ error: '请先登录' }, 401);
  c.set('user', user);
  await next();
};

app.onError((err, c) => {
  if (err.status) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: '服务器内部错误' }, 500);
});

const pubUser = (u) => ({ id: u.id, username: u.username });
function setSession(c, token) {
  setCookie(c, 'session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: false, // 原型 HTTP;上线改 true(见文档第 9 节)
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
    .prepare('SELECT id, name, subdomain, created_at, updated_at FROM sites WHERE user_id = ? ORDER BY id DESC')
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
  return c.json({ ok: true, id: r.lastInsertRowid, url: `http://${sub}.${config.siteDomain}` });
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

  const { fileCount } = deployZip(site.subdomain, buf);
  db.prepare("UPDATE sites SET updated_at = datetime('now') WHERE id = ?").run(site.id);
  return c.json({ ok: true, fileCount, url: `http://${site.subdomain}.${config.siteDomain}` });
});

app.delete('/api/sites/:id', requireUser, (c) => {
  const site = ownedSite(c);
  removeSiteFiles(site.subdomain);
  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
  return c.json({ ok: true });
});

// ---------- 静态:管理面板 ----------
app.use('/*', serveStatic({ root: path.relative(process.cwd(), path.join(__dirname, '..', 'public')) }));

// ---------- 启动(仅直接运行时) ----------
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`zhidian-prototype listening on :${info.port}`);
    console.log(`  domain: *.${config.siteDomain}`);
    console.log(`  data:   ${config.dataDir}`);
  });
}

export { app };
