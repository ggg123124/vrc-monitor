#!/usr/bin/env node
/**
 * VRChat 新地图追踪器 (new-worlds-tracker)
 * 
 * 功能：
 * 1. 从 VRChat API 拉取最近 N 天创建的新世界（游戏内「新地图-推荐」分类的判定：
 *    tags 含 system_created_recently，或 created_at 在窗口内）
 * 2. 写入 VRCX 本地收藏「新地图」分组（favorite_world 表，防重复）
 * 3. 与 VRCX gamelog_location 比对，标记每个新地图「已逛/未逛」
 * 4. 按热度（收藏数/在线/热度分）输出推荐列表
 * 
 * 用法：
 *   node new-worlds-tracker.mjs            # 默认拉最近 7 天
 *   node new-worlds-tracker.mjs 14         # 拉最近 14 天
 *   node new-worlds-tracker.mjs 7 --dry    # 只看不写（dry-run）
 * 
 * 输出 JSON：{ collected, skipped, visited, unvisited, recommended, group }
 */
import { VrchatApiClient } from './vrchat-api.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRED_FILE = path.join(__dirname, 'credentials.json');
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');
const VRCX_DB = process.env.VRCX_DB || 'C:/Users/Windows/AppData/Roaming/VRCX/VRCX.sqlite3';

const DAYS = parseInt(process.argv[2] || '7', 10);
const DRY = process.argv.includes('--dry');
const GROUP = '新地图';           // VRCX 本地收藏分组名
const MAX_FETCH = 200;            // 最多拉多少条候选（翻页）

async function fetchOtp() {
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const { execSync } = await import('node:child_process');
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  let cmd = `python "${path.join(__dirname, 'fetch-otp.py')}" "${creds.email}" "${authCode}"`;
  if (creds.imap_host) cmd += ` "${creds.imap_host}"`;
  return execSync(cmd, { timeout: 15000, encoding: 'utf-8' }).trim();
}

/**
 * 过滤测试图/垃圾图/开发中世界
 * 规则：名字含测试关键词（子串），或作者信息缺失，或容量异常
 */
function isJunkWorld(w) {
  const name = (w.name || '').toLowerCase().trim();
  // 子串匹配：test/test1/测试/习作/示例/临时/新建世界 等
  const junkPatterns = [
    /test/i, /测试/i, /習作/i, /习作/i, /sample/i, /示例/i,
    /placeholder/i, /wip/i, /untitled/i, /tmp/i, /temp/i,
    /new world/i, /新建世界/i, /frist create/i, /first create/i,
    /^0+[0-9]{0,3}$/, /^room\d*$/i, /^a room$/i, /^\[?beta\]?$/i,
    /unity input/i, /tutorial/i, /sdk test/i, /do not use/i,
  ];
  const hitJunk = junkPatterns.some(re => re.test(name));
  const hasAuthor = w.authorName && w.authorName !== 'Unknown' && w.authorName !== 'unknown';
  return (
    hitJunk ||
    !hasAuthor ||
    (typeof w.capacity === 'number' && w.capacity < 4)
  );
}

const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
const api = new VrchatApiClient(creds.email, creds.password);
if (existsSync(COOKIE_FILE)) api.loadCookieFromFile(COOKIE_FILE);

// ── 认证 ──
try {
  const user = await api.ensureAuthWithAutoOtp(fetchOtp);
  api.saveCookieToFile(COOKIE_FILE);
  console.error(`[auth] ${user.displayName}`);
} catch (e) {
  console.error('[auth] 失败:', e.message);
  process.exit(1);
}

// ── 1. 拉新世界（按创建时间倒序，翻页）──
const cutoff = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
const candidates = [];
for (let offset = 0; offset < MAX_FETCH; offset += 100) {
  const r = await api._request('GET', `/worlds?sort=created&order=descending&n=100&offset=${offset}`);
  if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;
  candidates.push(...r.data);
  if (r.data.length < 100) break;
}
console.error(`[fetch] 候选世界 ${candidates.length} 个`);

const fresh = candidates
  .filter(w => {
    const created = new Date(w.created_at);
    const isFresh = created >= cutoff;
    const tagged = Array.isArray(w.tags) && w.tags.includes('system_created_recently');
    // 必须同时满足：创建时间在窗口内 + 有 recent 标签（避免捞到旧图/测试图）
    return isFresh && tagged;
  })
  .filter(w => w.releaseStatus === 'public')   // 只要公开世界
  .filter(w => !isJunkWorld(w));               // 过滤测试图/垃圾图

console.error(`[filter] 窗口内新世界 ${fresh.length} 个`);

// ── 2. 读 VRCX 本地数据 ──
let vrcx;
try {
  vrcx = new Database(VRCX_DB, { readonly: true, timeout: 10000 });
} catch (e) {
  console.error('[vrcx] 打开失败:', e.message);
  process.exit(1);
}

// 已逛过的世界（gamelog_location 记录 + 收藏历史）
const visitedRows = vrcx.prepare(
  "SELECT DISTINCT world_id FROM gamelog_location WHERE world_id IS NOT NULL AND world_id != ''"
).all();
const visited = new Set(visitedRows.map(r => r.world_id));

// 已有收藏（防重复）
const favRows = vrcx.prepare(
  "SELECT world_id FROM favorite_world WHERE group_name = ?"
).all(GROUP);
const existingFavs = new Set(favRows.map(r => r.world_id));

// 世界名缓存（给收藏记录填名字）
const nameCache = new Map();
for (const w of fresh) nameCache.set(w.id, w.name);

// ── 3. 分类 ──
const unvisited = fresh.filter(w => !visited.has(w.id));
const visitedFresh = fresh.filter(w => visited.has(w.id));
// 过滤：可选最低收藏数阈值（--min-favorites N，默认 0=全部）
const minFavIdx = process.argv.indexOf('--min-favorites');
const MIN_FAVORITES = minFavIdx > -1 ? parseInt(process.argv[minFavIdx + 1] || '0', 10) : 0;
const worthy = MIN_FAVORITES > 0 ? unvisited.filter(w => (w.favorites || 0) >= MIN_FAVORITES) : unvisited;
const toAdd = worthy.filter(w => !existingFavs.has(w.id));      // 未逛且未收藏 -> 写入
const alreadyTracked = fresh.filter(w => existingFavs.has(w.id));

// 热度排序（favorites 收藏数 + occupants 在线 + popularity）
const score = w => (w.favorites || 0) * 2 + (w.occupants || 0) * 10 + (w.popularity || 0);
const recommended = [...unvisited].sort((a, b) => score(b) - score(a)).slice(0, 10);

// ── 4. 写入 VRCX 本地收藏（非 dry-run）──
let written = 0;
if (!DRY && toAdd.length > 0) {
  const writeDb = new Database(VRCX_DB, { timeout: 15000 });
  const now = new Date().toISOString();
  const ins = writeDb.prepare(
    "INSERT INTO favorite_world (created_at, world_id, group_name) VALUES (?, ?, ?)"
  );
  const tx = writeDb.transaction(items => {
    for (const w of items) {
      ins.run(now, w.id, GROUP);
      written++;
    }
  });
  try {
    tx(toAdd);
    writeDb.close();
    console.error(`[write] 已收藏 ${written} 个新地图到「${GROUP}」`);
  } catch (e) {
    console.error('[write] 写入失败:', e.message);
    writeDb.close();
  }
} else if (DRY) {
  console.error(`[dry-run] 将收藏 ${toAdd.length} 个（未实际写入）`);
}

vrcx.close();

// ── 5. 输出报告 ──
const report = {
  group: GROUP,
  days: DAYS,
  dryRun: DRY,
  collected: fresh.length,
  unvisited: unvisited.map(w => w.name),
  visited: visitedFresh.map(w => w.name),
  newlyFavorited: toAdd.map(w => w.name),
  alreadyTracked: alreadyTracked.map(w => w.name),
  written,
  recommended: recommended.map(w => ({
    name: w.name,
    id: w.id,
    created: w.created_at.slice(0, 10),
    favorites: w.favorites || 0,
    occupants: w.occupants || 0,
    popularity: w.popularity || 0,
    author: w.authorName,
    tags: (w.tags || []).filter(t => t.startsWith('author_tag_')).map(t => t.replace('author_tag_', '')),
  })),
};
console.log(JSON.stringify(report, null, 2));
