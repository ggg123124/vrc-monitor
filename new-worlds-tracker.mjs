#!/usr/bin/env node
/**
 * VRChat 新地图追踪器 (new-worlds-tracker.mjs)
 *
 * 功能：
 * 1. 从 VRChat API 拉取最近 N 天创建的新世界（游戏内「新地图-推荐」分类的判定：
 *    tags 含 system_created_recently，且 created_at 在窗口内）
 * 2. 写入本仓库自己的数据库（vrc-monitor.sqlite3 的 new_worlds 表），
 *    不依赖 VRCX 本机库（符合项目「服务不一定跑在 VRChat/VRCX 所在机器」的定位）
 * 3. 用 events 表的 user-location 事件判断用户是否逛过该世界
 * 4. 按热度（收藏数/在线/热度分）输出推荐列表
 *
 * 用法：
 *   node new-worlds-tracker.mjs            # 默认拉最近 7 天
 *   node new-worlds-tracker.mjs 14         # 拉最近 14 天
 *   node new-worlds-tracker.mjs 7 --dry    # 只看不写（dry-run）
 *
 * 输出 JSON：{ collected, tracked, visited, unvisited, recommended }
 */
import { VrchatApiClient } from './vrchat-api.js';
import { RateLimiter } from './core/rate-limiter.js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRED_FILE = path.join(__dirname, 'credentials.json');
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');
// 数据库位于本仓库（VRC_MONITOR_DIR 定位，符合项目定位）
const DB_PATH = process.env.VRC_MONITOR_DB || path.join(__dirname, 'vrc-monitor.sqlite3');
// 当前账号 user_id（从 events 表反查，避免硬编码）
const SELF_USER_ID = process.env.VRC_MONITOR_USER_ID || '';

const DAYS = parseInt(process.argv[2] || '7', 10);
const DRY = process.argv.includes('--dry');
const MAX_FETCH = 200;            // 最多拉多少条候选（翻页）

// 限流器（与主服务同参数：VRChat API ~30 次/分钟，安全间隔 2.6s）
const rateLimiter = new RateLimiter({ minInterval: 2600, maxQueueSize: 30 });

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

// ── 认证（走限流器）──
let selfUserId = SELF_USER_ID;
try {
  const user = await rateLimiter.execute(() => api.ensureAuthWithAutoOtp(fetchOtp));
  api.saveCookieToFile(COOKIE_FILE);
  selfUserId = user.id || SELF_USER_ID;
  console.error(`[auth] ${user.displayName} (${selfUserId})`);
} catch (e) {
  console.error('[auth] 失败:', e.message);
  process.exit(1);
}

// ── 1. 拉新世界（按创建时间倒序，翻页，全部走限流器）──
const cutoff = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
const candidates = [];
for (let offset = 0; offset < MAX_FETCH; offset += 100) {
  const r = await rateLimiter.execute(() =>
    api._request('GET', `/worlds?sort=created&order=descending&n=100&offset=${offset}`));
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

// ── 2. 读本仓库数据库：visited（events.user-location）+ 已跟踪（new_worlds）──
let db;
try {
  db = new Database(DB_PATH, { timeout: 10000 });
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.error('[db] 打开失败:', e.message);
  process.exit(1);
}

// 用户去过哪些世界（events 表：user-location 为主，friend-location 中
// user_id=自己的也计入——自己加入实例时会触发 OnPlayerJoined 事件）
const visitedRows = db.prepare(
  `SELECT DISTINCT world_id FROM events
   WHERE world_id IS NOT NULL AND world_id != ''
     AND (
       type = 'user-location'
       OR (type = 'friend-location' AND user_id = @selfUserId)
     )`
).all({ selfUserId });
const visited = new Set(visitedRows.map(r => r.world_id));

// 已跟踪的世界（new_worlds 表）
const existingRows = db.prepare('SELECT world_id FROM new_worlds').all();
const existingTracked = new Set(existingRows.map(r => r.world_id));

// ── 3. 分类 ──
const unvisited = fresh.filter(w => !visited.has(w.id));
const visitedFresh = fresh.filter(w => visited.has(w.id));
const toAdd = unvisited.filter(w => !existingTracked.has(w.id));  // 未逛且未跟踪 -> 写入
const alreadyTracked = fresh.filter(w => existingTracked.has(w.id));

// 热度排序（favorites 收藏数 + occupants 在线 + popularity）
const score = w => (w.favorites || 0) * 2 + (w.occupants || 0) * 10 + (w.popularity || 0);
const recommended = [...unvisited].sort((a, b) => score(b) - score(a)).slice(0, 10);

// ── 4. 写入本仓库数据库（非 dry-run）──
let written = 0;
let updated = 0;
if (!DRY) {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO new_worlds (world_id, world_name, author_name, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at)
     VALUES (@world_id, @world_name, @author_name, @created_at, @first_seen_at, @favorites, @occupants, @popularity, @visited, @visited_at)
     ON CONFLICT(world_id) DO UPDATE SET
       world_name = excluded.world_name,
       favorites = excluded.favorites,
       occupants = excluded.occupants,
       popularity = excluded.popularity,
       visited = excluded.visited,
       visited_at = excluded.visited_at`
  );
  const markVisited = db.prepare(
    `UPDATE new_worlds SET visited = 1, visited_at = @visited_at
     WHERE world_id = @world_id AND visited = 0`
  );

  const tx = db.transaction(items => {
    for (const w of items) {
      upsert.run({
        world_id: w.id,
        world_name: w.name || '',
        author_name: w.authorName || '',
        created_at: w.created_at || null,
        first_seen_at: now,
        favorites: w.favorites || 0,
        occupants: w.occupants || 0,
        popularity: w.popularity || 0,
        visited: visited.has(w.id) ? 1 : 0,
        visited_at: visited.has(w.id) ? now : null,
      });
      written++;
    }
    // 对已跟踪但用户逛过的世界，更新 visited 标记
    for (const w of fresh) {
      if (visited.has(w.id)) {
        const r = markVisited.run({ world_id: w.id, visited_at: now });
        if (r.changes > 0) updated++;
      }
    }
  });

  try {
    tx(toAdd);
    console.error(`[write] 新增跟踪 ${written} 个，更新 visited 标记 ${updated} 个`);
  } catch (e) {
    console.error('[write] 写入失败:', e.message);
  }
} else {
  console.error(`[dry-run] 将跟踪 ${toAdd.length} 个（未实际写入）`);
}

// ── 5. 输出报告 ──
const report = {
  days: DAYS,
  dryRun: DRY,
  collected: fresh.length,
  unvisited: unvisited.map(w => w.name),
  visited: visitedFresh.map(w => w.name),
  newlyTracked: toAdd.map(w => w.name),
  alreadyTracked: alreadyTracked.map(w => w.name),
  written,
  visitedUpdated: updated,
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
db.close();
