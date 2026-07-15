// 原型测试:覆盖 docs/prototype-stage0.md 第 10 节最低清单。
// 每个文件独立进程,先设临时 DATA_DIR 再导入 app,避免触碰生产数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { test } from 'node:test';
import AdmZip from 'adm-zip';

// 必须在导入 app/db 之前设置环境(ESM 静态导入会先于赋值执行)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-proto-'));
process.env.DATA_DIR = tmp;
process.env.SITE_DOMAIN = 'example.com';
process.env.MAX_UPLOAD_MB = '1'; // 便于用小体积验证 413
process.env.NODE_ENV = 'test';

const { app } = await import('../src/server.js');
const db = (await import('../src/db.js')).default;

function reset() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM sites').run();
  db.prepare('DELETE FROM users').run();
}
test.beforeEach(reset);

function cookieFrom(h) { return h ? h.split(';')[0] : ''; }
async function req(method, url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  const res = await app.request(url, { method, headers, body });
  return { status: res.status, cookie: cookieFrom(res.headers.get('set-cookie')), json: async () => res.json().catch(() => ({})) };
}
function makeZip(files) {
  const z = new AdmZip();
  for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.from(c));
  return z.toBuffer();
}
async function deploy(siteId, cookie, zipBuf) {
  const fd = new FormData();
  fd.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'site.zip');
  const headers = cookie ? { Cookie: cookie } : {};
  const res = await app.request(`/api/sites/${siteId}/deploy`, { method: 'POST', body: fd, headers });
  return { status: res.status, json: async () => res.json().catch(() => ({})) };
}
async function register(username) {
  const r = await req('POST', '/api/register', { json: { username, password: 'password123' } });
  assert.equal(r.status, 200, `注册应成功: ${username}`);
  return { user: (await r.json()).user, cookie: r.cookie };
}

test('注册自动登录,/api/me 不含密码哈希', async () => {
  const { user, cookie } = await register('alice');
  const me = await req('GET', '/api/me', { cookie });
  assert.equal(me.status, 200);
  const md = await me.json();
  assert.equal(md.user.username, 'alice');
  assert.equal(md.user.password_hash, undefined);
});

test('错误密码登录失败(401),退出后 401', async () => {
  await register('bob');
  const bad = await req('POST', '/api/login', { json: { username: 'bob', password: 'wrong' } });
  assert.equal(bad.status, 401);
  const { cookie } = await register('carol'); // 不会与 bob 冲突(各自唯一)
  const ok = await req('POST', '/api/login', { json: { username: 'carol', password: 'password123' } });
  assert.equal(ok.status, 200);
  await req('POST', '/api/logout', { cookie: ok.cookie });
  const me = await req('GET', '/api/me', { cookie: ok.cookie });
  assert.equal(me.status, 401);
});

test('重复用户名冲突(409)', async () => {
  await register('dave');
  const r = await req('POST', '/api/register', { json: { username: 'dave', password: 'password123' } });
  assert.equal(r.status, 409);
});

test('未登录访问受保护接口 401', async () => {
  assert.equal((await req('GET', '/api/me')).status, 401);
  assert.equal((await req('GET', '/api/sites')).status, 401);
});

test('创建站点返回 URL,子域名规则与重复校验', async () => {
  const { cookie } = await register('erin');
  const r = await req('POST', '/api/sites', { cookie, json: { name: '博客', subdomain: 'erin-blog' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, 'http://erin-blog.example.com/');
  assert.equal((await req('POST', '/api/sites', { cookie, json: { name: 'x', subdomain: 'AB' } })).status, 400); // 非法
  assert.equal((await req('POST', '/api/sites', { cookie, json: { name: 'x', subdomain: 'admin' } })).status, 400); // 保留词
  assert.equal((await req('POST', '/api/sites', { cookie, json: { name: 'x', subdomain: 'erin-blog' } })).status, 409); // 重复
  const list = await (await req('GET', '/api/sites', { cookie })).json();
  assert.equal(list.sites.length, 1);
});

test('上传合法 ZIP 成功且生成 index.html;缺 index 被拒', async () => {
  const { cookie } = await register('frank');
  const cr = await req('POST', '/api/sites', { cookie, json: { name: 's', subdomain: 'franksite' } });
  const siteId = (await cr.json()).id;
  const d = await deploy(siteId, cookie, makeZip({ 'index.html': '<h1>hi</h1>', 'a.css': 'x' }));
  assert.equal(d.status, 200);
  assert.ok(fs.existsSync(path.join(tmp, 'sites', 'franksite', 'index.html')));
  const bad = await deploy(siteId, cookie, makeZip({ 'a.css': 'x' }));
  assert.equal(bad.status, 400);
});

test('超体积 ZIP 被拒(413)', async () => {
  const { cookie } = await register('grace');
  const cr = await req('POST', '/api/sites', { cookie, json: { name: 's', subdomain: 'gracesite' } });
  const siteId = (await cr.json()).id;
  const big = makeZip({ 'index.html': crypto.randomBytes(2 * 1024 * 1024) }); // 2MB 随机(不可压缩)> 1MB 上传上限
  const d = await deploy(siteId, cookie, big);
  assert.equal(d.status, 413);
});

test('租户隔离:用户不能操作他人站点', async () => {
  const a = await register('owner1');
  const b = await register('owner2');
  const cr = await req('POST', '/api/sites', { cookie: a.cookie, json: { name: 's', subdomain: 'ownedsite' } });
  const siteId = (await cr.json()).id;
  // B 部署到 A 的站点 → 403
  const d = await deploy(siteId, b.cookie, makeZip({ 'index.html': '<h1>x</h1>' }));
  assert.equal(d.status, 403);
  // B 删除 A 的站点 → 403
  assert.equal((await req('DELETE', `/api/sites/${siteId}`, { cookie: b.cookie })).status, 403);
});

test('删除站点后目录与记录消失', async () => {
  const { cookie } = await register('heidi');
  const cr = await req('POST', '/api/sites', { cookie, json: { name: 's', subdomain: 'heidisite' } });
  const siteId = (await cr.json()).id;
  await deploy(siteId, cookie, makeZip({ 'index.html': '<h1>hi</h1>' }));
  assert.ok(fs.existsSync(path.join(tmp, 'sites', 'heidisite')));
  assert.equal((await req('DELETE', `/api/sites/${siteId}`, { cookie })).status, 200);
  assert.ok(!fs.existsSync(path.join(tmp, 'sites', 'heidisite')));
  const list = await (await req('GET', '/api/sites', { cookie })).json();
  assert.equal(list.sites.length, 0);
});

test('静态资源与管理页可访问', async () => {
  assert.equal((await app.request('/app.css')).status, 200);
  assert.equal((await app.request('/')).status, 200);
});
