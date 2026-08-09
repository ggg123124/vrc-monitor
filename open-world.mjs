#!/usr/bin/env node
/**
 * VRChat 开地图脚本 (open-world.mjs)
 *
 * 功能：创建一个新房间并在 VRChat 客户端内打开指定世界
 * 用法：
 *   node open-world.mjs wrld_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *   node open-world.mjs "地图名字"          # 支持按名字搜（本地缓存/线上 API）
 *
 * 原理（与 VRCX 的「创建房间并在 VRChat 内打开」一致）：
 *   1. 调 VRChat API 为指定世界创建新实例 -> 拿到 location + shortName
 *   2. 调系统打开 vrchat://launch?id=xxx&shortName=xxx（VRChat 运行中会直接跳转，
 *      未运行则会启动客户端）
 *   3. 若 API 创建失败，回退为直接 launch（默认公开实例）
 */
import { VrchatApiClient } from './vrchat-api.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRED_FILE = path.join(__dirname, 'credentials.json');
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');
const VRCX_DB = process.env.VRCX_DB || 'C:/Users/Windows/AppData/Roaming/VRCX/VRCX.sqlite3';

async function fetchOtp() {
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  let cmd = `python "${path.join(__dirname, 'fetch-otp.py')}" "${creds.email}" "${authCode}"`;
  if (creds.imap_host) cmd += ` "${creds.imap_host}"`;
  return execSync(cmd, { timeout: 15000, encoding: 'utf-8' }).trim();
}

// ── 解析参数：worldId 或地图名 ──
let target = process.argv[2];
if (!target) {
  console.error('用法: node open-world.mjs <worldId 或 地图名>');
  process.exit(1);
}

// ── 认证 ──
const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
const api = new VrchatApiClient(creds.email, creds.password);
if (existsSync(COOKIE_FILE)) api.loadCookieFromFile(COOKIE_FILE);
try {
  const user = await api.ensureAuthWithAutoOtp(fetchOtp);
  api.saveCookieToFile(COOKIE_FILE);
  console.error(`[auth] ${user.displayName}`);
} catch (e) {
  console.error('[auth] 失败:', e.message);
  process.exit(1);
}

// ── 解析世界 ID（支持名字）──
let worldId = target;
if (!/^wrld_/.test(target)) {
  let found = null;
  // 优先 API 搜索（精确 > 开头 > 包含 > 第一个）
  try {
    const r = await api._request('GET', `/worlds?search=${encodeURIComponent(target)}&n=15`);
    if (r.status === 200 && Array.isArray(r.data) && r.data.length) {
      const low = target.toLowerCase();
      const exact = r.data.find(w => (w.name || '').toLowerCase() === low);
      const starts = r.data.find(w => (w.name || '').toLowerCase().startsWith(low));
      const includes = r.data.find(w => (w.name || '').toLowerCase().includes(low));
      found = exact || starts || includes
        ? { id: (exact || starts || includes).id, name: (exact || starts || includes).name }
        : { id: r.data[0].id, name: r.data[0].name };
    }
  } catch (e) { console.error(`[search] API 搜索失败: ${e.message}`); }

  if (!found) {
    // 兜底：VRCX 本地缓存
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(VRCX_DB, { readonly: true, timeout: 10000 });
      const rows = db.prepare(
        "SELECT world_id, world_name FROM gamelog_location WHERE world_name = ? LIMIT 1"
      ).all(target);
      if (rows.length) found = { id: rows[0].world_id, name: rows[0].world_name };
      db.close();
    } catch (e) { /* ignore */ }
  }

  if (!found) {
    console.error(`❌ 找不到地图: ${target}`);
    process.exit(1);
  }
  worldId = found.id;
  console.error(`[resolve] ${target} -> ${found.name} (${worldId})`);
}

// 获取世界名（展示用）
let worldName = worldId;
try {
  const r = await api._request('GET', `/worlds/${worldId}`);
  if (r.status === 200 && r.data?.name) worldName = r.data.name;
} catch { /* 用 id 兜底 */ }

console.error(`[world] ${worldName} (${worldId})`);

// ── 1. 创建新实例 ──
let shortName = null;
let instanceLocation = null;
try {
  const r = await api._request('POST', `/instances`, { worldId, region: 'jp', type: 'public', platform: 'standalonewindows' });
  if (r.status === 200 && r.data?.location) {
    instanceLocation = r.data.location;
    shortName = r.data.shortName || r.data.secureName || null;
    console.error(`[instance] 已创建: ${instanceLocation}${shortName ? ` (shortName=${shortName})` : ''}`);
  } else {
    console.error(`[instance] 创建失败 (${r.status})，回退直接 launch`);
  }
} catch (e) {
  console.error(`[instance] 创建失败: ${e.message}，回退直接 launch`);
}

// ── 2. 打开 VRChat ──
const launchUrl = shortName
  ? `vrchat://launch?ref=vrcx.app&id=${worldId}&shortName=${encodeURIComponent(shortName)}`
  : `vrchat://launch?ref=vrcx.app&id=${worldId}`;

console.error(`[launch] ${launchUrl}`);
try {
  // Windows: 用 cmd start 打开 URL scheme
  execSync(`cmd /c start "" "${launchUrl}"`, { timeout: 10000, windowsHide: true });
  console.log(JSON.stringify({ ok: true, worldId, worldName, instance: instanceLocation, url: launchUrl }));
} catch (e) {
  console.error(`❌ 打开失败: ${e.message}`);
  console.log(JSON.stringify({ ok: false, error: e.message, url: launchUrl }));
  process.exit(1);
}
