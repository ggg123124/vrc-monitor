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
// VRCX 源码（src/stores/launch.js）: id 参数是完整 location（含实例号），
// 如 wrld_xxx:01277~region(jp)，不是 worldId！只有带实例号 VRChat 才能定位房间
const launchUrl = instanceLocation
  ? (shortName
      ? `vrchat://launch?ref=vrcx.app&id=${instanceLocation}&shortName=${encodeURIComponent(shortName)}`
      : `vrchat://launch?ref=vrcx.app&id=${instanceLocation}`)
  : `vrchat://launch?ref=vrcx.app&id=${worldId}`;

console.error(`[launch] ${launchUrl}`);
try {
  // 通过 VRChat 命名管道 IPC 直发（VRCX VRCIPC 同款协议）：
  //   管道: \\.\pipe\VRChatURLLaunchPipe
  //   协议: 写 UTF-8 URL -> 读 1 字节响应 (1=成功)
  // VRChat 运行时监听此管道，收到 URL 在游戏内弹确认菜单（不会新开进程）
  const pipePath = '\\\\.\\pipe\\VRChatURLLaunchPipe';
  const net = await import('node:net');
  const result = await new Promise((resolve, reject) => {
    const client = net.createConnection(pipePath);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('IPC 连接超时（VRChat 未运行或未监听管道）')); }, 1500);
    client.on('connect', () => {
      client.write(Buffer.from(launchUrl, 'utf-8'));
    });
    client.on('data', (buf) => {
      clearTimeout(timer);
      client.end();
      resolve(buf[0] === 1);
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  if (result) {
    console.error('[launch] ✅ 已通过 IPC 发送到运行中的 VRChat（游戏内应弹出确认菜单）');
    console.log(JSON.stringify({ ok: true, via: 'vrcipc', worldId, worldName, instance: instanceLocation, url: launchUrl }));
  } else {
    console.error('[launch] ⚠️ IPC 返回失败，尝试 Steam 启动回退');
    throw new Error('VRChat IPC 返回失败');
  }
} catch (e) {
  console.error(`❌ IPC 打开失败: ${e.message}`);
  console.log(JSON.stringify({ ok: false, error: e.message, url: launchUrl }));
  process.exit(1);
}
