#!/usr/bin/env node
/**
 * VRChat 开地图脚本 (open-world.mjs) — 本机辅助工具
 *
 * 功能：创建一个新房间，并在运行中的 VRChat 客户端内打开指定世界
 *      （游戏内弹出确认菜单，不会新开 VRChat 进程）
 * 用法：
 *   node open-world.mjs wrld_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *   node open-world.mjs "地图名字"          # 支持按名字搜（API 搜索，优先精确匹配）
 *   node open-world.mjs --instance <完整location>   # 直接加入指定实例（弹世界房间菜单）
 *
 * 原理（探测式本机增强，core/vrchat-launch.js 统一入口）：
 *   1. 调 VRChat API 为指定世界创建新实例 -> 拿到 location + shortName
 *   2. 探测本机 VRChat 命名管道 \\.\pipe\VRChatURLLaunchPipe：存在则管道直发
 *      vrchat://launch?ref=vrcx.app&id=<完整location>&shortName=<sn>
 *      （游戏内弹确认菜单，一步直达，不新开进程）
 *   3. 管道探测失败（VRChat 未运行）→ 静默回退 API 邀请自己传送
 *      （POST /invite/myself/to/{worldId}:{instanceId}，客户端收到邀请通知）
 *
 * 注意：管道增强仅 Windows；API 邀请回退全平台可用。
 */
import { VrchatApiClient } from './vrchat-api.js';
import { openInstance } from './core/vrchat-launch.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { RateLimiter } from './core/rate-limiter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRED_FILE = path.join(__dirname, 'credentials.json');
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');

// 平台说明：命名管道增强仅 Windows（core/vrchat-launch.js 内平台门控）；
// 非 Windows / VRChat 未运行时自动回退 API 邀请（不在此处退出）

async function fetchOtp() {
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  // execFile 数组传参，避免授权码含引号/特殊字符破坏命令
  const args = [path.join(__dirname, 'fetch-otp.py'), creds.email, authCode];
  if (creds.imap_host) args.push(creds.imap_host);
  return execFileSync('python', args, { timeout: 15000, encoding: 'utf-8' }).trim();
}

// ── 解析参数：worldId / 地图名 / 主题词（开个XX的图）/ --instance ──
const INSTANCE_MODE = process.argv.includes('--instance');
let target = process.argv[2];
if (!target) {
  console.error('用法: node open-world.mjs <worldId 或 地图名 或 主题词>');
  console.error('      node open-world.mjs --instance <完整location>  # 加入指定实例');
  console.error('主题词: 夏天 海 雪 恐怖 太空 森林自然 游戏 音乐 社交 放松 夜晚星空');
  process.exit(1);
}
// 模式定位：--instance 后面跟的值
if (INSTANCE_MODE) {
  const idx = process.argv.indexOf('--instance');
  target = process.argv[idx + 1];
  if (!target) {
    console.error('❌ --instance 缺少参数');
    process.exit(1);
  }
}

// 主题词识别：如果参数是主题（或其关键词），用 world-themes.mjs 随机抽一个未逛的
const THEME_HINTS = ['夏天', '夏', '海', '雪', '恐怖', '太空', '宇宙', '森林', '自然',
  '游戏', '音乐', '社交', '放松', '夜晚', '星空', '月', 'summer', 'beach', 'snow',
  'horror', 'space', 'forest', 'game', 'music', 'chill', 'relax', 'night', 'moon'];
const isThemeHint = THEME_HINTS.some(h => target.includes(h));
if (isThemeHint && !/^wrld_/.test(target)) {
  // 主题词解析依赖 world-themes.mjs（可选增强：本仓库存在才启用，否则按地图名处理）
  if (!existsSync(path.join(__dirname, 'world-themes.mjs'))) {
    console.error('[theme] world-themes.mjs 不存在，跳过主题解析（按地图名处理）');
  } else {
    try {
      const out = execSync(`node world-themes.mjs "${target}" --random`, {
        cwd: __dirname, timeout: 15000, encoding: 'utf-8',
      });
      const pick = JSON.parse(out.slice(out.indexOf('{')));
      if (pick.world?.id) {
        target = pick.world.id;
        console.error(`[theme] ${pick.emoji} 主题「${pick.theme}」随机抽中: ${pick.world.name} (${pick.world.id})`);
      }
    } catch (e) {
      console.error(`[theme] 主题解析失败（按地图名处理）: ${e.message}`);
    }
  }
}

// ── 认证 ──
const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
const api = new VrchatApiClient(creds.email, creds.password);
const rateLimiter = new RateLimiter({ minInterval: 2600 });
if (existsSync(COOKIE_FILE)) api.loadCookieFromFile(COOKIE_FILE);
try {
  const user = await api.ensureAuthWithAutoOtp(fetchOtp);
  api.saveCookieToFile(COOKIE_FILE);
  console.error(`[auth] ${user.displayName}`);
} catch (e) {
  console.error('[auth] 失败:', e.message);
  process.exit(1);
}

// ── 模式分发：--instance 直接发 URL（跳过世界解析与建房间）──
// 注：--user 模式已废弃（VRChat 官方无 vrchat://user 协议，无法弹用户主页）
if (INSTANCE_MODE) {
  // 直接加入指定实例（弹世界房间菜单，不新建房间）
  // 统一入口：本机管道直发 → 探测失败静默回退 API 邀请
  console.error(`[instance] 直接加入实例: ${target}`);
  try {
    const res = await openInstance({ location: target, api });
    if (res.success) {
      console.error(`[launch] ✅ ${res.detail}`);
      console.log(JSON.stringify({ ok: true, via: res.method, mode: 'instance', target, display: target, notificationId: res.notificationId || null }));
    } else {
      throw new Error(res.error || '打开失败');
    }
  } catch (e) {
    console.error(`❌ 打开失败: ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message, url: target }));
    process.exit(1);
  }
  process.exit(0);
}

// ── 解析世界 ID（支持名字）──
let worldId = target;
if (!/^wrld_/.test(target)) {
  let found = null;
  // 优先 API 搜索（精确 > 开头 > 包含 > 第一个）
  try {
    const r = await rateLimiter.execute(() => api._request('GET', `/worlds?search=${encodeURIComponent(target)}&n=15`));
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
    // 兜底：vrc-monitor 自己的 events 表（world_name 记录，无第三方依赖）
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(path.join(__dirname, 'vrc-monitor.sqlite3'), { readonly: true, timeout: 10000 });
      const rows = db.prepare(
        `SELECT world_id, world_name FROM events
         WHERE world_name IS NOT NULL AND world_name != '' AND world_name = ?
         LIMIT 1`
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
    const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${worldId}`));
  if (r.status === 200 && r.data?.name) worldName = r.data.name;
} catch { /* 用 id 兜底 */ }

console.error(`[world] ${worldName} (${worldId})`);

// ── 1. 创建新实例 ──
let shortName = null;
let instanceLocation = null;
try {
    const r = await rateLimiter.execute(() => api._request('POST', `/instances`, { worldId, region: 'jp', type: 'public', platform: 'standalonewindows' }));
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
// 统一入口（core/vrchat-launch.js）：本机管道直发（一步直达）→ 探测失败静默回退 API 邀请
// 注意：id 必须是完整 location（含实例号），裸 worldId 游戏内无反应（实测）
if (!instanceLocation) {
  console.error('❌ 创建实例失败且无可用 location，无法打开（裸 worldId 实测无效）');
  console.log(JSON.stringify({ ok: false, error: 'instance creation failed', worldId }));
  process.exit(1);
}
const res = await openInstance({ location: instanceLocation, shortName, api });
if (res.success) {
  console.error(`[launch] ✅ ${res.detail}`);
  console.log(JSON.stringify({ ok: true, via: res.method, worldId, worldName, instance: instanceLocation, notificationId: res.notificationId || null }));
} else {
  console.error(`❌ 打开失败: ${res.error}`);
  console.log(JSON.stringify({ ok: false, error: res.error, worldId }));
  process.exit(1);
}