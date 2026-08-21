/**
 * 世界推荐核心 — 多源候选池 + wrld_id 反查闭环 + 评分融合
 *
 * 数据流（recommendWorlds 编排）:
 *   collectCandidates（local world_kb / PlanetVRC 排行 / 官方主题搜索）
 *   → 合并去重 + excludeTheme 过滤 → resolveWorldId（planet 卡片名称反查官方）
 *   → scoreCandidate（热度 × Planet 信号 × 新鲜度 × 主题 × 作者画像）
 *   → excludeVisited 过滤 → 排序 → 取 limit → 组装输出
 *
 * 注意：本模块内部对官方 API 调用逐个走 rateLimiter.execute，
 * 外层（rpc-router）不能再包 rateLimiter（嵌套死锁，见 scan_new_worlds 注释）。
 */

import { ctx, log } from './server-context.js';
import { getThemeRegex } from './theme-config.js';
import { handleRecommendPlanetWorlds } from './handlers/planet.js';
import { handleSearchWorlds } from './handlers/groups.js';

// ── 权重常量（集中便于调参）──
const W_PLANET = 8;          // PlanetVRC log10(visitors) 系数
const W_FRESH = 20;          // 30 天内新图满额加分
const FRESH_DAYS = 30;
const W_SLEEP_OK = 40;       // sleep 主题下人工筛选睡觉图强信号
const W_THEME = 15;          // 其他主题关键词命中
const W_AUTHOR_SELF = 15;    // 自己熟客作者（逛过 ≥2 张）
const W_AUTHOR_FRIENDS = 10; // 好友圈热度作者（逛过 ≥2 张）
const AUTHOR_CAP = 30;       // 作者维度封顶 ±30

const PLANET_CACHE_TTL = 21600000;  // Planet 排行缓存 6h
const RESOLVE_CACHE_TTL = 86400000; // 名称反查缓存 24h

const THEMES = ['sleep', 'chat', 'onsen', 'game', 'default'];

/**
 * 世界主题/排除匹配的文本来源：名称 + 简介 + 标签（tags）。
 * #73：原先只拼 name/description，漏掉 author_tag_* 标签，导致名不副实的世界（如中文名/
 * 简称/翻译名）无法被主题正则命中。tags 统一纳入后，关键词与人工 sleep_ok 语义互补。
 * @param {{name?: string, description?: string, tags?: string[]}} c 候选对象（可能无 tags）
 * @returns {string} 用于正则匹配的合并文本
 */
function buildMatchText(c) {
  const tags = Array.isArray(c.tags) ? c.tags.join(' ') : '';
  return `${c.name || ''} ${c.description || ''} ${tags}`;
}

/**
 * sleep 主题命中判定（#73 补充）：除了 sleep_ok 强信号与 sleep 关键词正则，
 * 还直接认作者标签 author_tag_sleep —— 使名字/简介不含 sleep 词但作者已打
 * sleep 标签的世界（常见于英文/翻译名）也能进入 sleep 主题，避免漏判。
 * @param {object} c 候选结构（含 tags/sleep_ok/name/description）
 * @returns {boolean} 是否命中 sleep 主题
 */
function isSleepTheme(c) {
  if (c.sleep_ok === true || c.sleep_ok === 1) return true;
  const tags = Array.isArray(c.tags) ? c.tags : [];
  if (tags.some(t => String(t).toLowerCase() === 'author_tag_sleep')) return true;
  return getThemeRegex('sleep').some(re => re.test(buildMatchText(c)));
}

/**
 * 作者画像（动态统计，不建表）：
 * - self:   自己逛过的世界（events type='user-location'）→ world_cache.author_id 聚合
 * - friends: 好友圈（events type='friend-location'）同理聚合
 * count 为该作者的世界被逛过的不同世界数（≥2 视为熟客），lastSeen 为最近事件时间。
 * 无数据/查询失败时返回空 Map，不崩。
 * @param {object} ctx 服务上下文（需 ctx.storage）
 * @returns {{self: Map<string, {count: number, lastSeen: string}>, friends: Map<string, {count: number, lastSeen: string}>}}
 */
export function buildAuthorProfile(ctx) {
  const profile = { self: new Map(), friends: new Map() };
  const storage = ctx?.storage;
  if (!storage) return profile;
  try {
    // 30 天窗口（issue #18 定案：按 30 天窗口切分，避免远古事件让「熟客」失真）
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const aggregate = (type) => {
      const rows = storage._query(
        `SELECT wc.author_id AS author_id, COUNT(DISTINCT e.world_id) AS cnt, MAX(e.created_at) AS last_seen
         FROM events e
         JOIN world_cache wc ON wc.world_id = e.world_id
         WHERE e.type = $type
           AND e.world_id IS NOT NULL AND e.world_id != ''
           AND wc.author_id IS NOT NULL AND wc.author_id != ''
           AND e.created_at >= $cutoff
         GROUP BY wc.author_id`,
        { $type: type, $cutoff: cutoff }
      );
      const map = new Map();
      for (const r of rows) {
        map.set(r.author_id, { count: r.cnt, lastSeen: r.last_seen });
      }
      return map;
    };
    profile.self = aggregate('user-location');
    profile.friends = aggregate('friend-location');
  } catch (e) { /* 空库/缺列时返回空画像 */ }
  return profile;
}

// ── 候选池 ──

/** local 源：world_kb 全量（sleep_ok 列旧库可能缺失，PRAGMA 检查回退） */
function collectLocalCandidates(storage) {
  const cols = storage._query(`PRAGMA table_info(world_kb)`);
  const hasSleepOk = cols.some(c => c.name === 'sleep_ok');
  const rows = storage._query(
    `SELECT world_id, world_name, author_name, author_id, created_at, favorites,
            occupants, popularity, visited, visited_at, tags, description, user_rating
            ${hasSleepOk ? ', sleep_ok' : ''}
     FROM world_kb`
  );
  return rows.map(r => {
    let tags = [];
    try { tags = JSON.parse(r.tags || '[]'); } catch (e) { /* tags 脏数据按空数组 */ }
    return {
      worldId: r.world_id, name: r.world_name || '',
      authorId: r.author_id || '', authorName: r.author_name || '',
      capacity: 0, favorites: r.favorites || 0, occupants: r.occupants || 0,
      popularity: r.popularity || 0, tags: Array.isArray(tags) ? tags : [],
      description: r.description || '', imageUrl: '',
      created_at: r.created_at || null, visited: r.visited === 1,
      visitedAt: r.visited_at || null,
      sleep_ok: hasSleepOk ? (r.sleep_ok === 1) : null,
      userRating: r.user_rating || 0, source: 'local',
      planetVisitors: null, planetFavorites: null,
    };
  });
}

/** planet 源：PlanetVRC 热门排行（结果进 planet_cache 6h，命中直接读缓存） */
async function collectPlanetCandidates(ctxArg, limit) {
  const storage = ctxArg.storage;
  const key = `planet:popular:${limit}`;
  let result = storage.getPlanetCache(key, PLANET_CACHE_TTL);
  if (!result) {
    result = await handleRecommendPlanetWorlds({ sort: 'popular', limit });
    // 空结果不缓存（避免 6h 内永远拿不到数据）
    if (result && Array.isArray(result.worlds) && result.worlds.length > 0) {
      storage.setPlanetCache(key, result);
    }
  }
  return (result?.worlds || []).map(c => ({
    worldId: (typeof c.wrldId === 'string' && c.wrldId.startsWith('wrld_')) ? c.wrldId : null,
    name: c.name || '', authorId: '', authorName: '',
    capacity: c.maxPlayers || 0, favorites: 0, occupants: 0, popularity: 0,
    tags: Array.isArray(c.tags) ? c.tags : [],
    description: '', imageUrl: c.image || '',
    created_at: c.publishedAt || null, visited: false, visitedAt: null,
    sleep_ok: null, userRating: 0, source: 'planet',
    planetVisitors: Number.isFinite(c.visitors) ? c.visitors : null,
    planetFavorites: Number.isFinite(c.favorites) ? c.favorites : null,
  }));
}

/** official 源（theme 非 default）：主题关键词转官方搜索（内部限流，外层勿再包） */
async function collectOfficialCandidates(ctxArg, theme) {
  const regexes = getThemeRegex(theme);
  if (regexes.length === 0) return [];
  const query = regexes.slice(0, 2).map(re => re.source).join(' ');
  const exec = ctxArg.rateLimiter?.execute
    ? (fn) => ctxArg.rateLimiter.execute(fn)
    : (fn) => fn();
  const result = await exec(() => handleSearchWorlds({ query, n: 5 }));
  return (result?.worlds || []).map(w => ({
    worldId: (typeof w.worldId === 'string' && w.worldId.startsWith('wrld_')) ? w.worldId : null,
    name: w.name || '', authorId: '', authorName: w.authorName || '',
    capacity: w.capacity || 0, favorites: 0, occupants: 0, popularity: 0,
    tags: [], description: w.description || '', imageUrl: w.imageUrl || '',
    created_at: null, visited: false, visitedAt: null,
    sleep_ok: null, userRating: 0, source: 'official',
    planetVisitors: null, planetFavorites: null,
  }));
}

/**
 * 多源候选池：按 sources 依次拉取（local/planet/official），单源失败不影响其他源。
 * @param {object} ctxArg 服务上下文
 * @param {object} opts {sources, theme, limit}
 * @returns {Promise<{candidates: object[], used: string[]}>}
 */
export async function collectCandidates(ctxArg, { sources = ['local', 'planet'], theme = 'default', limit = 5 } = {}) {
  const srcList = (Array.isArray(sources) ? sources : String(sources || '').split(','))
    .map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const candidates = [];
  const used = [];
  for (const src of srcList) {
    try {
      if (src === 'local') {
        candidates.push(...collectLocalCandidates(ctxArg.storage));
        used.push('local');
      } else if (src === 'planet') {
        candidates.push(...await collectPlanetCandidates(ctxArg, limit));
        used.push('planet');
      } else if (src === 'official') {
        candidates.push(...await collectOfficialCandidates(ctxArg, theme));
        used.push('official');
      }
    } catch (e) {
      log(`recommend_worlds ${src} 源失败: ${e.message}`);
    }
  }
  return { candidates, used };
}

// ── 合并 / 主题排除 ──

function candidateKey(c) {
  return (c.worldId && c.worldId.startsWith('wrld_'))
    ? c.worldId
    : `name:${String(c.name || '').trim().toLowerCase()}`;
}

/** 同 worldId / 同名候选合并（保信息更全者，补 planet 信号与标签） */
function mergeCandidates(candidates) {
  const map = new Map();
  for (const c of candidates) {
    const key = candidateKey(c);
    const prev = map.get(key);
    if (!prev) { map.set(key, { ...c }); continue; }
    const keep = prev.worldId ? prev : c;
    const other = prev.worldId ? c : prev;
    keep.planetVisitors = keep.planetVisitors ?? other.planetVisitors;
    keep.planetFavorites = keep.planetFavorites ?? other.planetFavorites;
    keep.imageUrl = keep.imageUrl || other.imageUrl;
    keep.description = keep.description || other.description;
    keep.authorName = keep.authorName || other.authorName;
    keep.authorId = keep.authorId || other.authorId;
    keep.capacity = keep.capacity || other.capacity;
    keep.created_at = keep.created_at || other.created_at;
    keep.userRating = keep.userRating || other.userRating;
    keep.visited = keep.visited || other.visited;
    keep.visitedAt = keep.visitedAt || other.visitedAt;
    keep.tags = [...new Set([...(keep.tags || []), ...(other.tags || [])])];
    map.set(key, keep);
  }
  return [...map.values()];
}

/** excludeTheme：tags 含 author_tag_<t> 或普通标签精确/子串命中，或名称/描述命中该主题正则 → 剔除。
 * storage 可选：提供时从 world_cache 补全官方 tags（候选阶段 tags 常不完整，输出前需复查）。 */
function isExcludedByTheme(c, excludedThemes, storage) {
  if (excludedThemes.length === 0) return false;
  const tagSet = new Set((c.tags || []).map(t => String(t).toLowerCase()));
  if (storage && c.worldId && c.worldId.startsWith('wrld_')) {
    try {
      const wc = storage.getWorldName(c.worldId);
      const wcTags = wc && wc.tags ? JSON.parse(wc.tags) : [];
      if (Array.isArray(wcTags)) wcTags.forEach(t => tagSet.add(String(t).toLowerCase()));
    } catch (e) { /* world_cache tags 脏数据忽略 */ }
  }
  const text = buildMatchText(c);
  for (const t of excludedThemes) {
    if (tagSet.has(`author_tag_${t}`)) return true;
    if (tagSet.has(t)) return true;
    for (const tag of tagSet) if (tag.includes(t)) return true;
    if (getThemeRegex(t).some(re => re.test(text))) return true;
  }
  return false;
}

// ── wrld_id 反查闭环 ──

function nameMatches(apiName, target) {
  if (!apiName || !target) return false;
  const a = String(apiName).trim().toLowerCase();
  const b = target.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * wrld_id 反查闭环（方案 b）：planet 卡片无 worldId（或非 wrld_ 开头）时，
 * 用名称反查官方 /worlds?search=<name>&n=1（走 rateLimiter.execute），
 * 命中写 world_cache（upsertWorld），反查结果进 planet_cache 24h。
 * @returns {Promise<{worldId: string|null, canOpen: boolean}>}
 */
export async function resolveWorldId(ctxArg, candidate, rateLimiter) {
  if (candidate.worldId && candidate.worldId.startsWith('wrld_')) {
    return { worldId: candidate.worldId, canOpen: true };
  }
  const name = String(candidate.name || '').trim();
  if (!name) return { worldId: null, canOpen: false };

  const storage = ctxArg.storage;
  const cacheKey = `planet:resolve:${name}`;
  const cached = storage.getPlanetCache(cacheKey, RESOLVE_CACHE_TTL);
  if (cached && typeof cached === 'object' && 'worldId' in cached) {
    if (cached.worldId) {
      candidate.worldId = cached.worldId;
      return { worldId: cached.worldId, canOpen: true };
    }
    return { worldId: null, canOpen: false };
  }

  const exec = rateLimiter?.execute ? (fn) => rateLimiter.execute(fn) : (fn) => fn();
  try {
    const r = await exec(() =>
      ctxArg.api._request('GET', `/worlds?search=${encodeURIComponent(name)}&n=1`));
    const world = r?.status === 200 && Array.isArray(r?.data) ? r.data[0] : null;
    const id = world && typeof world.id === 'string' && world.id.startsWith('wrld_') ? world.id : null;
    if (id && nameMatches(world.name, name)) {
      candidate.worldId = id;
      try {
        storage.upsertWorld({
          worldId: world.id, name: world.name || name,
          authorId: world.authorId || '', authorName: world.authorName || '',
          description: world.description || '', imageUrl: world.imageUrl || '',
          releaseStatus: world.releaseStatus || '', capacity: world.capacity || 0,
          favorites: world.favorites || 0,
          tags: Array.isArray(world.tags) ? world.tags : [],
        });
      } catch (e) { /* world_cache 落库失败不影响反查结果 */ }
      storage.setPlanetCache(cacheKey, { worldId: id, name });
      return { worldId: id, canOpen: true };
    }
    storage.setPlanetCache(cacheKey, { worldId: null, name });
    return { worldId: null, canOpen: false };
  } catch (e) {
    log(`recommend_worlds 反查失败 ${name}: ${e.message}`);
    return { worldId: null, canOpen: false };
  }
}

// ── 评分 ──

/**
 * 评分融合：基础热度（worldScore 逻辑 + 反馈加权） + Planet 信号 + 新鲜度
 * + theme 匹配（sleep_ok 强信号 / 关键词命中） + 作者维度（封顶 ±30）。
 * @param {object} c 统一候选结构
 * @param {object} opts {theme, profile}
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreCandidate(c, { theme = 'default', profile } = {}) {
  const reasons = [];
  const rating = Number(c.userRating) || 0;
  const ratingBias = rating === 1 ? 50 : (rating === -1 ? -100 : 0);
  let score = (c.favorites || 0) * 2 + (c.occupants || 0) * 10 + (c.popularity || 0) + ratingBias;

  if (Number.isFinite(c.planetVisitors) && c.planetVisitors > 0) {
    const p = Math.log10(1 + c.planetVisitors) * W_PLANET;
    score += p;
    reasons.push(`Planet访问${c.planetVisitors}+${p.toFixed(1)}`);
  }

  if (c.created_at) {
    const ageDays = (Date.now() - Date.parse(c.created_at)) / 86400000;
    if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= FRESH_DAYS) {
      const f = Math.max(0, 1 - ageDays / FRESH_DAYS) * W_FRESH;
      score += f;
      reasons.push(`新图${Math.max(0, Math.round(ageDays))}天+${f.toFixed(1)}`);
    }
  }

  if (theme && theme !== 'default') {
    const sleepOk = c.sleep_ok === true || c.sleep_ok === 1;
    if (theme === 'sleep') {
      // 认 sleep_ok 强信号 / author_tag_sleep 标签 / sleep 关键词（#73）
      if (isSleepTheme(c)) {
        score += sleepOk ? W_SLEEP_OK : W_THEME;
        reasons.push(sleepOk ? `人工筛选睡觉图+${W_SLEEP_OK}` : `主题匹配[sleep]+${W_THEME}`);
      }
    } else {
      const text = buildMatchText(c);
      if (getThemeRegex(theme).some(re => re.test(text))) {
        score += W_THEME;
        reasons.push(`主题匹配[${theme}]+${W_THEME}`);
      }
    }
  }

  let authorScore = 0;
  const selfInfo = profile?.self?.get(c.authorId);
  if (selfInfo && selfInfo.count >= 2) {
    authorScore += W_AUTHOR_SELF;
    reasons.push(`作者[${c.authorName || c.authorId}]逛过${selfInfo.count}张+${W_AUTHOR_SELF}`);
  }
  const friendInfo = profile?.friends?.get(c.authorId);
  if (friendInfo && friendInfo.count >= 2) {
    authorScore += W_AUTHOR_FRIENDS;
    reasons.push(`好友圈[${c.authorName || c.authorId}]逛过${friendInfo.count}张+${W_AUTHOR_FRIENDS}`);
  }
  score += Math.min(authorScore, AUTHOR_CAP);

  return { score: Math.round(score * 10) / 10, reasons };
}

// ── 输出组装 ──

/** 单个候选 → MCP 输出结构（detail 时从 world_cache 补 description/imageUrl 等） */
function assembleItem(c, { theme, detail, storage }) {
  if (detail && c.worldId && c.worldId.startsWith('wrld_')) {
    const wc = storage.getWorldName(c.worldId);
    if (wc) {
      if (!c.imageUrl) c.imageUrl = wc.image_url || '';
      if (!c.description) c.description = wc.description || '';
      if (!c.authorName) c.authorName = wc.author_name || '';
      if (!c.authorId) c.authorId = wc.author_id || '';
      if (!c.capacity) c.capacity = wc.capacity || 0;
      c.note = wc.note || '';
      try {
        const wcTags = JSON.parse(wc.tags || '[]');
        if (Array.isArray(wcTags)) c.tags = [...new Set([...(c.tags || []), ...wcTags])];
      } catch (e) { /* world_cache tags 脏数据忽略 */ }
    }
  }
  return {
    worldId: (c.worldId && c.worldId.startsWith('wrld_')) ? c.worldId : null,
    name: c.name || '',
    authorId: c.authorId || '',
    authorName: c.authorName || '',
    capacity: c.capacity || 0,
    tags: (c.tags || [])
      .filter(t => typeof t === 'string' && t.startsWith('author_tag_'))
      .map(t => t.replace('author_tag_', '')),
    heat: {
      officialFavorites: c.favorites || 0,
      occupants: c.occupants || 0,
      planetVisitors: c.planetVisitors ?? null,
    },
    feedback: { rating: c.userRating || 0 },
    score: c.score,
    reasons: c.reasons || [],
    theme,
    note: c.note || '',
    visited: !!c.visited,
    visitedAt: c.visitedAt || null,
    visitedSource: c.visited ? 'event' : null,
    sleep_ok: c.sleep_ok === true ? true : (c.sleep_ok === false ? false : null),
    imageUrl: c.imageUrl || '',
    description: c.description || '',
    canOpen: !!(c.worldId && c.worldId.startsWith('wrld_')),
  };
}

/**
 * recommend_worlds 主函数：候选池 → 合并/排除 → 反查 → 评分 → 过滤 → 排序 → 输出。
 * @param {object} ctxArg 服务上下文（storage/api/rateLimiter）
 * @param {object} args {theme, excludeTheme, limit, sources, excludeVisited, detail}
 */
export async function recommendWorlds(ctxArg, args = {}) {
  const storage = ctxArg?.storage;
  if (!storage) throw new Error('storage unavailable');

  const theme = THEMES.includes(args.theme) ? args.theme : 'default';
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 10);
  const sources = String(args.sources ?? 'local,planet').split(',')
    .map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const excludeVisited = args.excludeVisited !== false;
  const detail = args.detail !== false;
  const excludedThemes = typeof args.excludeTheme === 'string' && args.excludeTheme.trim()
    ? args.excludeTheme.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  // 1. 多源候选池
  const { candidates, used } = await collectCandidates(ctxArg, { sources, theme, limit });
  // 2. 合并去重 + excludeTheme 过滤（世界 id 无关，先于反查省 API 调用）
  let pool = mergeCandidates(candidates).filter(c => !isExcludedByTheme(c, excludedThemes));
  // 3. wrld_id 反查（缺 worldId 的候选逐个走限流器，失败 → canOpen:false）
  for (const cand of pool) {
    if (!(cand.worldId && cand.worldId.startsWith('wrld_'))) {
      const r = await resolveWorldId(ctxArg, cand, ctxArg.rateLimiter);
      if (r.worldId) cand.worldId = r.worldId;
    }
  }
  // 反查后按 worldId 再合并一次（planet 卡与 local 同名行可能重合）
  pool = mergeCandidates(pool);
  // 4. 作者画像 + 评分
  const profile = buildAuthorProfile(ctxArg);
  let scored = pool.map(c => ({ ...c, ...scoreCandidate(c, { theme, profile }) }));
  // 5. excludeVisited 过滤（local visited 标记 + world_kb 反查）
  let skippedVisited = 0;
  if (excludeVisited) {
    const visitedSet = new Set(
      storage._query(`SELECT world_id FROM world_kb WHERE visited = 1`).map(r => r.world_id)
    );
    scored = scored.filter(c => {
      const visited = !!c.visited || (!!c.worldId && visitedSet.has(c.worldId));
      if (visited) skippedVisited++;
      return !visited;
    });
    // 5a. 待逛列表排除：正在待逛的世界不重复推荐（等用户逛完/移出后再推）
    const backlogSet = new Set(
      storage._query(`SELECT world_id FROM world_kb WHERE backlog = 1 AND visited = 0`).map(r => r.world_id)
    );
    if (backlogSet.size > 0) {
      scored = scored.filter(c => !(c.worldId && backlogSet.has(c.worldId)));
    }
  }
  // 5b. excludeTheme 复查（候选阶段 tags 可能未补全官方标签，world_cache 合并后重筛一次）
  if (excludedThemes.length > 0) {
    const before = scored.length;
    scored = scored.filter(c => !isExcludedByTheme(c, excludedThemes, storage));
    if (scored.length < before) log(`excludeTheme 复查剔除 ${before - scored.length} 个`);
  }
  // 5c. theme 软过滤：theme≠default 时优先只保留主题命中的候选（命中为空则回退全量，避免空结果）
  let themeFiltered = 0;
  if (theme !== 'default') {
    const hit = scored.filter(c => {
      if (theme === 'sleep') return isSleepTheme(c);
      const text = buildMatchText(c);
      return getThemeRegex(theme).some(re => re.test(text));
    });
    if (hit.length > 0) {
      themeFiltered = scored.length - hit.length;
      scored = hit;
    }
  }
  // 6. 排序 → 取 limit → 组装输出
  scored.sort((a, b) => b.score - a.score);
  const recommended = scored.slice(0, limit)
    .map(c => assembleItem(c, { theme, detail, storage }));
  return { recommended, sourcesUsed: used, skippedVisited, themeFiltered, total: recommended.length };
}

// 保留引用：模块 import 时 server-context 的 ctx 可能尚未初始化，
// 所有函数通过 ctxArg 参数接收上下文（handler 层传 server-context 的 ctx）。
void ctx;
