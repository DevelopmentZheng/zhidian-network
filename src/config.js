import path from 'node:path';
import fs from 'node:fs';

const num = (v, d) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  siteDomain: process.env.SITE_DOMAIN || 'localhost',
  port: num(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  maxSiteSizeBytes: num(process.env.MAX_SITE_SIZE_MB, 100) * 1024 * 1024,
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
};

export const dirs = {
  sites: path.join(config.dataDir, 'sites'), // 部署后的静态文件: sites/<subdomain>/
  tmp: path.join(config.dataDir, 'tmp'), // 解压临时目录
};

for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

// 保留子域名黑名单:平台自用 + 易混淆/钓鱼高危词
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'dashboard', 'mail', 'ftp', 'ns', 'dns', 'cdn',
  'static', 'blog', 'docs', 'dev', 'test', 'login', 'auth', 'account',
  'pay', 'bank', 'official', 'root',
]);

// 子域名:3~30 位小写字母/数字/中横线,首尾非横线
export const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
