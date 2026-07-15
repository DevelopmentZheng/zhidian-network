import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { config, dirs } from './config.js';
import { httpErr } from './errors.js';
import { moderateContent, saveModeration } from './moderation.js';
import db from './db.js';

const MAX_ENTRIES = 5000;

/**
 * 校验并解析 ZIP。
 * 安全:zip slip(绝对路径/../ /反斜杠,adm-zip 会归一化,再用 dest.startsWith 二次兜底)、
 * zip bomb(文件数、声明体积、实际写入体积)、缺少 index.html。
 * 单一顶层目录自动剥掉(用户压缩了整个文件夹)。
 */
export function inspectZip(zipBuffer) {
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw httpErr(400, '不是有效的 ZIP 文件');
  }

  const raw = zip.getEntries().filter((e) => !e.isDirectory);
  if (raw.length === 0) throw httpErr(400, 'ZIP 里没有文件');
  if (raw.length > MAX_ENTRIES) throw httpErr(400, `文件数超过上限 ${MAX_ENTRIES}`);

  let totalSize = 0;
  for (const e of raw) {
    const name = e.entryName;
    if (name.includes('..') || path.isAbsolute(name) || name.includes('\\') || name.startsWith('/')) {
      throw httpErr(400, `检测到非法路径: ${name}`);
    }
    totalSize += e.header.size;
    if (totalSize > config.maxSiteSizeBytes) {
      throw httpErr(400, `解压后超过站点容量上限 ${Math.round(config.maxSiteSizeBytes / 1048576)}MB`);
    }
  }

  // 过滤系统垃圾文件
  const entries = raw.filter((e) => {
    const base = path.basename(e.entryName);
    return !e.entryName.startsWith('__MACOSX/') && base !== '.DS_Store' && base !== 'Thumbs.db';
  });

  // 单一顶层目录 → 剥掉
  const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
  let rootPrefix = '';
  if (tops.size === 1 && entries.every((e) => e.entryName.includes('/'))) {
    rootPrefix = [...tops][0] + '/';
  }

  if (!entries.some((e) => e.entryName === rootPrefix + 'index.html')) {
    throw httpErr(400, 'ZIP 根目录必须包含 index.html');
  }
  return { entries, rootPrefix };
}

export function deployZip(subdomain, zipBuffer, siteId) {
  const { entries, rootPrefix } = inspectZip(zipBuffer);

  const moderationResult = moderateContent(entries, rootPrefix);
  
  if (siteId) {
    saveModeration(db, siteId, moderationResult);
  }
  
  if (moderationResult.status === 'rejected') {
    throw httpErr(403, `内容审核未通过：${moderationResult.reason}`);
  }

  const liveDir = path.join(dirs.sites, subdomain);
  const tmpDir = path.join(dirs.tmp, `${subdomain}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const oldDir = tmpDir + '.old';

  fs.mkdirSync(tmpDir, { recursive: true });
  let written = 0;
  try {
    for (const e of entries) {
      const rel = e.entryName.slice(rootPrefix.length);
      if (!rel) continue;
      const dest = path.join(tmpDir, rel);
      if (!dest.startsWith(tmpDir + path.sep)) throw httpErr(400, `非法路径: ${e.entryName}`);
      let data;
      try {
        data = e.getData();
      } catch {
        throw httpErr(400, `ZIP 文件损坏: ${e.entryName}`);
      }
      written += data.length;
      if (written > config.maxSiteSizeBytes) {
        throw httpErr(400, `实际解压体积超过上限 ${Math.round(config.maxSiteSizeBytes / 1048576)}MB`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    if (fs.existsSync(liveDir)) fs.renameSync(liveDir, oldDir);
    fs.renameSync(tmpDir, liveDir);
    fs.rmSync(oldDir, { recursive: true, force: true });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (fs.existsSync(oldDir) && !fs.existsSync(liveDir)) fs.renameSync(oldDir, liveDir);
    throw err;
  }

  return { 
    fileCount: entries.length, 
    sizeBytes: written,
    moderation: moderationResult
  };
}

/** 删除站点文件(删除站点时调用) */
export function removeSiteFiles(subdomain) {
  fs.rmSync(path.join(dirs.sites, subdomain), { recursive: true, force: true });
}
