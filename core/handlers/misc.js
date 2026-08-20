/**
 * 杂项 handler — 系统状态 / 数据库统计 / 新世界扫描 / 关注名单 / 同屏 / 上线规律 / 昵称 / 备份
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ctx, log, invalidateWatchlistCache } from '../server-context.js';
import { isJunkWorld, worldScore, classifyWorlds, fetchFreshWorlds } from '../new-worlds.js';
import { backupDatabase } from '../backup.js';

export function handleGetDatabaseStats() {
  const { storage, friendState, eventPipeline } = ctx;
  return {
    ...storage.getStats(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

export function handleGetServerStatus() {
  const { storage, wsManager, friendState, eventPipeline, serverState } = ctx;
  return {
    status: 'running',
    startedAt: serverState.started,
    // needsTotp 状态（运行期 401 需 TOTP）时账号并未真正登录，需报 authenticated:false（issue #59）
    authenticated: !!serverState.authUser && !serverState.needsTotp,
    needsTotp: serverState.needsTotp,
    user: serverState.authUser,
    dbEvents: storage.getStats().events,
    dbFriends: storage.getStats().friends,
    ws: wsManager?.getState(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

export async function handleScanNewWorlds({ days = 7, dryRun = false }) {
  const { storage, api, rateLimiter, serverState } = ctx;
  if (!days || days < 1 || days > 30) days = 7;
  const selfUserId = serverState.authUser?.id;
  if (!selfUserId) throw new Error('Not authenticated');

  const { fresh } = await fetchFreshWorlds(api, rateLimiter, { days, maxFetch: 200 });

  const visitedRows = storage._query(
    `SELECT DISTINCT world_id FROM events
     WHERE world_id IS NOT NULL AND world_id != ''
       AND (
         type = 'user-location'
         OR (type = 'friend-location' AND user_id = @selfUserId)
       )`,
    { $selfUserId: selfUserId }
  );
  const visited = new Set(visitedRows.map(r => r.world_id));

  const trackedRows = storage._query('SELECT world_id FROM world_kb');
  const tracked = new Set(trackedRows.map(r => r.world_id));

  const { unvisited, visitedFresh, toAdd, alreadyTracked } = classifyWorlds(fresh, visited, tracked);

  let written = 0;
  let updated = 0;
  const now = new Date().toISOString();

  if (!dryRun) {
    const upsert = storage.db.prepare(
      `INSERT INTO world_kb (world_id, world_name, author_name, author_id, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at, tags, description)
       VALUES (@world_id, @world_name, @author_name, @author_id, @created_at, @first_seen_at, @favorites, @occupants, @popularity, @visited, @visited_at, @tags, @description)
       ON CONFLICT(world_id) DO UPDATE SET
         world_name = excluded.world_name,
         author_id = excluded.author_id,
         favorites = excluded.favorites,
         occupants = excluded.occupants,
         popularity = excluded.popularity,
         visited = excluded.visited,
         visited_at = excluded.visited_at,
         tags = excluded.tags,
         description = excluded.description`
    );
    const markVisited = storage.db.prepare(
      `UPDATE world_kb SET visited = 1, visited_at = @visited_at
       WHERE world_id = @world_id AND visited = 0`
    );

    const tx = storage.db.transaction(() => {
      for (const w of toAdd) {
        upsert.run({
          world_id: w.id,
          world_name: w.name || '',
          author_name: w.authorName || '',
          author_id: w.authorId || '',
          created_at: w.created_at || null,
          first_seen_at: now,
          favorites: w.favorites || 0,
          occupants: w.occupants || 0,
          popularity: w.popularity || 0,
          visited: visited.has(w.id) ? 1 : 0,
          visited_at: visited.has(w.id) ? now : null,
          tags: Array.isArray(w.tags) ? JSON.stringify(w.tags) : '',
          description: w.description || '',
        });
        written++;
      }
      for (const w of fresh) {
        if (visited.has(w.id)) {
          const r = markVisited.run({ world_id: w.id, visited_at: now });
          if (r.changes > 0) updated++;
        }
      }
    });

    tx();
  }

  // 注入 DB 用户反馈（user_rating）到候选对象——否则 worldScore 加权对 API 对象恒为 0（Review 修复 #1）
  // unvisited 来自 API 拉取对象（无 userRating 字段），按 worldId 批量查 world_kb 的 user_rating
  const ratingParams = {};
  const ratingRows = unvisited.length > 0
    ? (() => {
        unvisited.forEach((w, i) => { ratingParams[`w${i}`] = w.id; });
        return storage._query(
          `SELECT world_id, user_rating FROM world_kb WHERE world_id IN (${unvisited.map((_, i) => `$w${i}`).join(',')})`,
          ratingParams
        );
      })()
    : [];
  const ratingMap = new Map(ratingRows.map(r => [r.world_id, r.user_rating || 0]));

  const recommended = [...unvisited]
    .map(w => ({ ...w, userRating: ratingMap.get(w.id) || 0 }))
    .sort((a, b) => worldScore(b) - worldScore(a))
    .slice(0, 10)
    .map(w => ({
      name: w.name,
      id: w.id,
      created: (w.created_at || '').slice(0, 10),
      favorites: w.favorites || 0,
      occupants: w.occupants || 0,
      popularity: w.popularity || 0,
      author: w.authorName,
      tags: (w.tags || []).filter(t => t.startsWith('author_tag_')).map(t => t.replace('author_tag_', '')),
      userRating: w.userRating,
    }));

  return {
    days,
    dryRun,
    collected: fresh.length,
    unvisited: unvisited.map(w => w.name),
    visited: visitedFresh.map(w => w.name),
    newlyTracked: toAdd.map(w => w.name),
    alreadyTracked: alreadyTracked.map(w => w.name),
    recommended,
  };
}

export function handleGetNewWorlds({ onlyUnvisited = false, limit = 10, sortBy = 'favorites', excludeTheme = '' }) {
  const { storage } = ctx;
  if (!['favorites', 'occupants', 'popularity', 'created_at'].includes(sortBy)) sortBy = 'favorites';
  limit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

  // Issue #19 痛点 4：排除主题（按 author_tag_* 匹配，逗号分隔）。SQL 层排除（Review 修复 #3），
  // 避免 LIMIT 后 JS 过滤导致返回 < limit；total 也按排除语义统计。
  const excludedThemes = typeof excludeTheme === 'string' && excludeTheme.trim()
    ? excludeTheme.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  // 构造排除条件：tags 列是 JSON 数组字符串（["author_tag_game",...]），用 json_each 拆行匹配主题
  let where = '';
  const whereParams = {};
  if (onlyUnvisited) where += 'WHERE visited = 0 AND backlog = 0';
  if (excludedThemes.length > 0) {
    // 排除 = 不存在任何匹配主题的行（json_each 拆 JSON tags 数组匹配）
    // 兜底：json_valid(tags) 为假（空串/脏数据）时按 '[]' 处理，避免 malformed JSON 崩溃
    const notExists = excludedThemes.map((_, i) =>
      `NOT EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(world_kb.tags) THEN world_kb.tags ELSE '[]' END)
        WHERE lower(value) = $th${i}
      )`
    ).join(' AND ');
    where += (where ? ' AND ' : 'WHERE ') + notExists;
    excludedThemes.forEach((t, i) => { whereParams[`th${i}`] = `author_tag_${t}`; });
  }

  const total = storage._query(
    `SELECT COUNT(*) AS cnt FROM world_kb ${where}`,
    whereParams
  )[0].cnt;

  // 超额取数兜底：排除后可能不足 limit，取 3 倍候选再 JS 精过滤（tags 解析）
  const fetchLimit = Math.min(limit * 3, 100);
  const rows = storage._query(
    `SELECT world_id, world_name, author_name, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at, tags, user_rating
     FROM world_kb
     ${where}
     ORDER BY ${sortBy} DESC
     LIMIT ${fetchLimit}`,
    whereParams
  );

  const worlds = rows
    .map(r => {
      let worldTags = [];
      try { worldTags = JSON.parse(r.tags || '[]'); } catch (_) {}
      const themeTags = worldTags.filter(t => t.startsWith('author_tag_')).map(t => t.replace('author_tag_', '').toLowerCase());
      return {
        worldId: r.world_id,
        worldName: r.world_name,
        authorName: r.author_name,
        created: r.created_at,
        firstSeen: r.first_seen_at,
        favorites: r.favorites,
        occupants: r.occupants,
        popularity: r.popularity,
        visited: r.visited === 1,
        visitedAt: r.visited_at,
        tags: themeTags,
        userRating: r.user_rating || 0,
      };
    })
    .slice(0, limit);

  return { total, worlds };
}

/** 用户反馈：好图/烂图标记（Issue #19） */
export function handleRateWorld({ worldId, rating = 0 }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const r = parseInt(rating, 10);
  if (r !== -1 && r !== 0 && r !== 1) {
    throw new Error('rating must be -1 (junk), 0 (clear), or 1 (good)');
  }
  const result = storage.rateWorld({ worldId, rating: r });
  log(`⭐ 用户反馈: ${worldId} → rating=${result.userRating}${result.worldName ? ` (${result.worldName})` : ''}`);
  return result;
}

/** 显式确认逛过某世界（Issue #19 痛点 3） */
export function handleMarkWorldVisited({ worldId }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const result = storage.markWorldVisited({ worldId });
  log(`✅ 手动标记 visited: ${worldId}${result.worldName ? ` (${result.worldName})` : ''}`);
  return result;
}

/** 待逛列表：加入/更新（幂等） */
export function handleAddToBacklog({ worldId, reason = '', priority = 0 }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const result = storage.addToBacklog({ worldId, reason, priority });
  log(`📌 加入待逛: ${worldId}${result.worldName ? ` (${result.worldName})` : ''} priority=${result.priority}`);
  return result;
}

/** 待逛列表：查询 */
export function handleGetBacklog({ status = 'pending', sortBy = 'added_at', limit = 20 } = {}) {
  return ctx.storage.getBacklog({ status, sortBy, limit });
}

/** 待逛列表：移除 */
export function handleRemoveFromBacklog({ worldId }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  const result = storage.removeFromBacklog({ worldId });
  log(`🗑 移出待逛: ${worldId}`);
  return result;
}

export function handleGetWatchlist() {
  return { watchlist: ctx.storage.getWatchlist() };
}

export function handleAddToWatchlist({ userId, displayName, priority = 1 }) {
  const { storage } = ctx;
  storage.addToWatchlist(userId, displayName, priority);
  storage.save();
  invalidateWatchlistCache();
  return { success: true, userId, priority };
}

export function handleRemoveFromWatchlist({ userId }) {
  const { storage } = ctx;
  storage.removeFromWatchlist(userId);
  storage.save();
  invalidateWatchlistCache();
  return { success: true, userId };
}

export function handleGetCompanions({ startTime, endTime, userId, includeTimeline }) {
  const { storage, serverState } = ctx;
  const targetUserId = userId || serverState.authUser?.id;
  if (!targetUserId) throw new Error('No userId provided and not authenticated');
  return storage.findCompanions(targetUserId, startTime, endTime, includeTimeline === true);
}

export function handleGetOnlinePattern({ userId, days, startTime, endTime }) {
  const { storage } = ctx;
  if (!userId) throw new Error('userId is required');
  const opts = {};
  if (startTime && endTime) {
    opts.startTime = startTime;
    opts.endTime = endTime;
  } else if (days !== undefined && days !== null) {
    opts.days = days;
  }
  return storage.getOnlinePattern(userId, opts);
}

export function handleGetNicknames({ userId, query }) {
  return { nicknames: ctx.storage.getNicknames({ userId, query }) };
}

export function handleSetNickname({ userId, nickname, displayName }) {
  const { storage } = ctx;
  if (!userId) throw new Error('userId is required');
  if (!nickname) throw new Error('nickname is required');
  const result = storage.setNickname({ userId, nickname, displayName });
  storage.save();
  return result;
}

export async function handleBackupDatabase() {
  try {
    const result = await backupDatabase(ctx.storage.db, ctx.paths.BACKUP_DIR);
    log(`💾 手动备份完成: ${result.path} (${result.size} bytes)`);
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
