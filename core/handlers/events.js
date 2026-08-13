/**
 * 事件历史 handler — 事件查询 / 世界名 / 世界备注 / 世界历史 / 周报
 */

import { ctx, log } from '../server-context.js';

export async function handleGetFriendEvents({ userId, limit = 20, offset = 0, types }) {
  const { storage } = ctx;
  // 单类型查询
  if (types && !types.includes(',')) {
    const events = storage.getEventsByUser(userId, { limit, offset, type: types.trim() });
    return { userId, total: events.length, events };
  }
  // 多类型/无类型过滤
  const events = storage.getEventsByUser(userId, { limit, offset });
  if (types) {
    const typeSet = new Set(types.split(',').map(t => t.trim()));
    const filtered = events.filter(e => typeSet.has(e.type));
    return { userId, total: filtered.length, events: filtered };
  }
  return { userId, total: events.length, events };
}

export function handleGetRecentEvents({ limit = 30, offset = 0, typeFilter, userIdFilter }) {
  const { storage } = ctx;
  let events;
  if (userIdFilter) {
    events = storage.getEventsByUser(userIdFilter, { limit, offset });
  } else {
    events = storage.getRecentEvents({ limit: limit + offset });
    if (offset > 0) events = events.slice(offset);
  }
  if (typeFilter) {
    const typeSet = new Set(typeFilter.split(',').map(t => t.trim()));
    events = events.filter(e => typeSet.has(e.type));
  }
  return { total: events.length, events };
}

export async function handleGetWorldName({ worldId, forceRefresh }) {
  const { storage, api } = ctx;
  // 懒刷新：缓存命中直接返回，只有 forceRefresh 或缓存不存在时才走 API
  if (!forceRefresh) {
    const cached = storage.getWorldName(worldId);
    if (cached) {
      return { worldId, name: cached.name, source: 'cache', ...cached };
    }
  }
  // 调 API
  const prev = storage.getWorldName(worldId);
  const r = await api._request('GET', `/worlds/${worldId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const w = r.data;
  const result = {
    worldId: w.id,
    name: w.name,
    authorName: w.authorName,
    capacity: w.capacity,
    occupants: w.occupants,
    releaseStatus: w.releaseStatus,
    tags: w.tags,
    description: (w.description || '').slice(0, 200),
    imageUrl: w.imageUrl,
    favorites: w.favorites,
    note: prev?.note ?? null,
    source: 'api',
  };
  // 写入缓存（不覆盖 note）
  storage.upsertWorld({
    worldId: w.id, name: w.name, authorName: w.authorName,
    capacity: w.capacity, favorites: w.favorites,
    releaseStatus: w.releaseStatus, tags: w.tags || [],
    description: w.description || '', imageUrl: w.imageUrl || '',
  });
  return result;
}

export function handleSetWorldNote({ worldId, note }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  if (note === undefined || note === null) throw new Error('note is required (empty string clears)');
  const result = storage.setWorldNote({ worldId, note });
  storage.save();
  return result;
}

export function handleGetWorldHistory({ worldId, limit = 50 }) {
  const { storage } = ctx;
  if (!worldId) throw new Error('worldId is required');
  return { worldId, history: storage.getWorldHistory(worldId, limit) };
}

export async function handleGetWeeklyReport({ days = 7 }) {
  const { storage, api, serverState } = ctx;
  if (!days || days < 1 || days > 90) days = 7;
  // 北京时间窗口（UTC - 8h）
  const endUtc = new Date(Date.now() - 8 * 3600 * 1000);  // 北京当前时刻转 UTC
  const startMs = endUtc.getTime() - days * 86400000;
  const startUtc = new Date(startMs);
  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();

  const userId = serverState.authUser?.id;
  if (!userId) throw new Error('Not authenticated');

  // 1. 会话切分 → 世界停留统计
  const sessions = storage.getOwnWorldSessions(startIso, endIso);
  const worldMinutes = new Map();  // worldId -> {minutes, visits}
  const dayWorlds = new Map();     // MM-DD -> Set<worldId>
  for (const s of sessions) {
    if (!worldMinutes.has(s.worldId)) worldMinutes.set(s.worldId, { minutes: 0, visits: 0 });
    const w = worldMinutes.get(s.worldId); w.minutes += s.minutes; w.visits++;
    const dayLabel = new Date(Date.parse(s.start) + 8 * 3600 * 1000).toISOString().slice(5, 10);
    if (!dayWorlds.has(dayLabel)) dayWorlds.set(dayLabel, new Set());
    dayWorlds.get(dayLabel).add(s.worldId);
  }

  // 2. 同屏合并
  const companions = storage.getWeeklyCompanions(userId, startIso, endIso);

  // 3. 自己的上线规律（复用 getOnlinePattern，window = 30 天）
  const pattern = storage.getOnlinePattern(userId, { days: Math.max(days, 30) });

  // 4. 世界名解析（缓存优先，缺失批量 API 查询并写 world_cache——懒刷新，无 TTL 自动过期）
  const allWorldIds = new Set([...worldMinutes.keys(), ...(function(){ const s=new Set(); for (const d of dayWorlds.values()) for (const w of d) s.add(w); return s; })()]);
  const worldNameMap = {};
  const missingWorlds = [];
  for (const wid of allWorldIds) {
    const cached = storage.getWorldName(wid);
    if (cached && cached.name) worldNameMap[wid] = cached.name;
    else missingWorlds.push(wid);
  }
  // 批量 API 查缺失世界名（串行，rateLimiter 在 RPC case 外层已包）
  for (const wid of missingWorlds) {
    try {
      const r = await api._request('GET', `/worlds/${wid}`);
      if (r.status === 200 && r.data) {
        const w = r.data;
        worldNameMap[wid] = w.name || wid;
        storage.upsertWorld({ worldId: w.id, name: w.name, authorName: w.authorName, capacity: w.capacity, favorites: w.favorites, releaseStatus: w.releaseStatus, tags: w.tags || [], description: w.description || '', imageUrl: w.imageUrl || '' });
      } else worldNameMap[wid] = wid;
    } catch { worldNameMap[wid] = wid; }
  }

  // 5. 群组活动（自己进过的群组房）——从 sessions 对应的事件里找 ~group(grp_/gmem_xxx)
  //    直接查 user-location 事件的 groupId
  const myGroupRows = storage._query(
    `SELECT content_json, created_at FROM events WHERE type='user-location' AND created_at >= $s AND created_at <= $e
     AND (content_json LIKE '%~group(grp_%' OR content_json LIKE '%~group(gmem_%') ORDER BY created_at`,
    { $s: startIso, $e: endIso }
  );
  const groupActivities = [];
  const groupIds = new Set();
  for (const row of myGroupRows) {
    try {
      const c = JSON.parse(row.content_json);
      const loc = c.location || '';
      // VRChat 群组 ID 已从 grp_ 迁移为 gmem_ (2026-08 实测), 两种前缀都匹配
      const m = loc.match(/~group\((grp_[a-f0-9-]+|gmem_[a-f0-9-]+)\)/);
      if (m) {
        groupIds.add(m[1]);
        const wid = loc.split(':')[0];
        groupActivities.push({ time: row.created_at, worldId: wid, worldName: worldNameMap[wid] || wid, groupId: m[1] });
        // 群组房可能停留 <3min 未进 worldMinutes，这里补入世界名解析集合
        if (!worldNameMap[wid] && !missingWorlds.includes(wid)) missingWorlds.push(wid);
      }
    } catch {}
  }
  // 补充解析群组房的世界名（第 4 步未覆盖的）
  for (const wid of missingWorlds) {
    if (worldNameMap[wid]) continue;
    try {
      const r = await api._request('GET', `/worlds/${wid}`);
      if (r.status === 200 && r.data) {
        const w = r.data;
        worldNameMap[wid] = w.name || wid;
        storage.upsertWorld({ worldId: w.id, name: w.name, authorName: w.authorName, capacity: w.capacity, favorites: w.favorites, releaseStatus: w.releaseStatus, tags: w.tags || [], description: w.description || '', imageUrl: w.imageUrl || '' });
      } else worldNameMap[wid] = wid;
    } catch { worldNameMap[wid] = wid; }
  }
  // 回填 groupActivities 的世界名
  for (const a of groupActivities) {
    if (worldNameMap[a.worldId]) a.worldName = worldNameMap[a.worldId];
  }

  // 6. 圈内活动日历（好友群组房统计）
  const friendGroups = storage.getFriendGroupStats(startIso, endIso);
  for (const gid of friendGroups.keys()) groupIds.add(gid);

  // 7. 群组信息（group_cache 优先，缺失查 API 并缓存；TTL 7 天）
  const groupInfoMap = {};
  const missingGroups = [];
  for (const gid of groupIds) {
    const cached = storage.getGroupCached(gid);
    if (cached && cached.name && (Date.now() - Date.parse(cached.updated_at.replace(' ', 'T') + 'Z')) < 7 * 86400000) {
      groupInfoMap[gid] = { groupId: gid, name: cached.name, description: cached.description, memberCount: cached.member_count };
    } else missingGroups.push(gid);
  }
  let groupCacheUpdated = false;
  for (const gid of missingGroups) {
    try {
      const r = await api._request('GET', `/groups/${gid}`);
      if (r.status === 200 && r.data) {
        const d = r.data;
        groupInfoMap[gid] = { groupId: gid, name: d.name || gid, description: d.description || '', memberCount: d.memberCount || 0 };
        storage.upsertGroupCache({ groupId: gid, name: d.name || '', description: d.description || '', memberCount: d.memberCount || 0 });
        groupCacheUpdated = true;
      } else groupInfoMap[gid] = { groupId: gid, name: gid, description: '', memberCount: 0 };
    } catch { groupInfoMap[gid] = { groupId: gid, name: gid, description: '', memberCount: 0 }; }
  }
  if (groupCacheUpdated) storage.save();

  // 8. 昵称映射（带昵称展示）
  const nicknames = storage.getNicknames({});
  const nickMap = {};
  for (const n of nicknames) nickMap[n.userId] = n.nickname || n.displayName;

  // 组装结果
  const topWorlds = [...worldMinutes.entries()]
    .map(([wid, v]) => ({ worldId: wid, name: worldNameMap[wid] || wid, minutes: Math.round(v.minutes), visits: v.visits }))
    .sort((a, b) => b.minutes - a.minutes);

  const topCompanions = [...companions.entries()]
    .map(([uid, v]) => ({ userId: uid, displayName: v.displayName, nickname: nickMap[uid] || null, matchCount: v.matchCount, days: v.days.size, dayList: [...v.days].sort() }))
    .sort((a, b) => b.days - a.days || b.matchCount - a.matchCount);

  const friendGroupCalendar = [...friendGroups.entries()]
    .map(([gid, v]) => ({ groupId: gid, groupName: groupInfoMap[gid]?.name || gid, friendCount: v.users.size, eventCount: v.count, worldCount: v.worlds.size, memberCount: groupInfoMap[gid]?.memberCount || 0 }))
    .sort((a, b) => b.friendCount - a.friendCount || b.eventCount - a.eventCount);

  return {
    period: { start: startIso, end: endIso, days, tz: 'UTC' },
    overview: {
      activeDays: dayWorlds.size,
      totalMinutes: Math.round(sessions.reduce((a, s) => a + s.minutes, 0)),
      worldsVisited: worldMinutes.size,
      companionUsers: companions.size,
      topCompanion: topCompanions[0] ? { userId: topCompanions[0].userId, displayName: topCompanions[0].displayName, nickname: topCompanions[0].nickname, days: topCompanions[0].days, matchCount: topCompanions[0].matchCount } : null,
    },
    daily: [...dayWorlds.entries()].sort().map(([day, worlds]) => ({ day, worlds: [...worlds].map(w => ({ worldId: w, name: worldNameMap[w] || w })) })),
    topWorlds,
    ownPattern: {
      activeDays30: pattern.activeDates?.length || 0,
      hourly: pattern.hourly?.location || {},
      peakHour: pattern.peak?.activePeakHour ?? null,
      avgGapDays: pattern.frequency?.avgGapDays ?? null,
      longestGapDays: pattern.frequency?.longestGapDays ?? null,
    },
    topCompanions,
    groupActivities: groupActivities.map(a => ({ ...a, groupName: groupInfoMap[a.groupId]?.name || a.groupId, memberCount: groupInfoMap[a.groupId]?.memberCount || 0 })),
    friendGroupCalendar,
  };
}
