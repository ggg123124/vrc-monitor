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
    authenticated: !!serverState.authUser,
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

  const trackedRows = storage._query('SELECT world_id FROM new_worlds');
  const tracked = new Set(trackedRows.map(r => r.world_id));

  const { unvisited, visitedFresh, toAdd, alreadyTracked } = classifyWorlds(fresh, visited, tracked);

  let written = 0;
  let updated = 0;
  const now = new Date().toISOString();

  if (!dryRun) {
    const upsert = storage.db.prepare(
      `INSERT INTO new_worlds (world_id, world_name, author_name, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at, tags, description)
       VALUES (@world_id, @world_name, @author_name, @created_at, @first_seen_at, @favorites, @occupants, @popularity, @visited, @visited_at, @tags, @description)
       ON CONFLICT(world_id) DO UPDATE SET
         world_name = excluded.world_name,
         favorites = excluded.favorites,
         occupants = excluded.occupants,
         popularity = excluded.popularity,
         visited = excluded.visited,
         visited_at = excluded.visited_at,
         tags = excluded.tags,
         description = excluded.description`
    );
    const markVisited = storage.db.prepare(
      `UPDATE new_worlds SET visited = 1, visited_at = @visited_at
       WHERE world_id = @world_id AND visited = 0`
    );

    const tx = storage.db.transaction(() => {
      for (const w of toAdd) {
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

  const recommended = [...unvisited]
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

export function handleGetNewWorlds({ onlyUnvisited = false, limit = 10, sortBy = 'favorites' }) {
  const { storage } = ctx;
  if (!['favorites', 'occupants', 'popularity', 'created_at'].includes(sortBy)) sortBy = 'favorites';
  limit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

  const total = storage._query(
    `SELECT COUNT(*) AS cnt FROM new_worlds${onlyUnvisited ? ' WHERE visited = 0' : ''}`
  )[0].cnt;

  const rows = storage._query(
    `SELECT world_id, world_name, author_name, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at
     FROM new_worlds
     ${onlyUnvisited ? 'WHERE visited = 0' : ''}
     ORDER BY ${sortBy} DESC
     LIMIT ${limit}`
  );

  const worlds = rows.map(r => ({
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
  }));

  return { total, worlds };
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

export function handleGetCompanions({ startTime, endTime, userId }) {
  const { storage, serverState } = ctx;
  const targetUserId = userId || serverState.authUser?.id;
  if (!targetUserId) throw new Error('No userId provided and not authenticated');
  return storage.findCompanions(targetUserId, startTime, endTime);
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
