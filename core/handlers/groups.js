/**
 * 群组 handler — 群组查询/搜索/加入/退出/偷看公告
 */

import { ctx } from '../server-context.js';

export async function handleGetUserGroups({ userId, withDetails }) {
  const { api, serverState } = ctx;
  let targetId = userId;
  if (!targetId) {
    targetId = serverState.authUser?.id;
    if (!targetId) {
      const r = await api._request('GET', '/auth/user');
      if (r.status !== 200) throw new Error(`API error: ${r.status}`);
      targetId = r.data?.id;
    }
  }
  if (!targetId) throw new Error('Unable to determine target user id');
  const r = await api._request('GET', `/users/${targetId}/groups`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const groups = (r.data || []).map((g) => {
    const item = {};
    if (g.groupId !== undefined && g.groupId !== null) item.groupId = g.groupId;
    if (g.name !== undefined && g.name !== null) item.name = g.name;
    if (g.shortCode !== undefined && g.shortCode !== null) item.shortCode = g.shortCode;
    if (g.memberCount !== undefined && g.memberCount !== null) item.memberCount = g.memberCount;
    if (g.isVerified !== undefined && g.isVerified !== null) item.isVerified = g.isVerified;
    if (g.myRank !== undefined && g.myRank !== null) {
      item.myRank = typeof g.myRank === 'object' ? (g.myRank.id || null) : g.myRank;
    }
    return item;
  });
  if (withDetails && groups.length > 0) {
    const CONCURRENCY = 5;
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, groups.length) }, async () => {
      while (idx < groups.length) {
        const i = idx++;
        const g = groups[i];
        try {
          const d = await api._request('GET', `/groups/${g.groupId}`);
          if (d.status === 200 && d.data) {
            if (d.data.description) g.description = d.data.description;
            if (d.data.isVerified !== undefined && d.data.isVerified !== null) g.isVerified = d.data.isVerified;
          }
        } catch (e) { /* 单群失败忽略 */ }
      }
    });
    await Promise.all(workers);
  }
  return { userId: targetId, count: groups.length, groups };
}

export async function handleGetGroupInfo({ groupId, includeAnnouncement }) {
  const { api } = ctx;
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const d = r.data;
  const result = { groupId: d.id };
  if (d.name !== undefined && d.name !== null) result.name = d.name;
  if (d.shortCode !== undefined && d.shortCode !== null) result.shortCode = d.shortCode;
  if (d.memberCount !== undefined && d.memberCount !== null) result.memberCount = d.memberCount;
  if (d.isVerified !== undefined && d.isVerified !== null) result.isVerified = d.isVerified;
  if (d.description !== undefined && d.description !== null) result.description = d.description;
  if (d.discordId !== undefined && d.discordId !== null) result.discordId = d.discordId;
  if (d.bannerId !== undefined && d.bannerId !== null) result.bannerId = d.bannerId;
  if (d.tags !== undefined && d.tags !== null) result.tags = d.tags;
  if (d.joinState !== undefined && d.joinState !== null) result.joinState = d.joinState;
  if (d.allowGroupJoinPrompt !== undefined && d.allowGroupJoinPrompt !== null) result.allowGroupJoinPrompt = d.allowGroupJoinPrompt;
  if (includeAnnouncement) {
    try {
      const a = await api._request('GET', `/groups/${groupId}/announcement`);
      if (a.status === 200 && a.data && typeof a.data === 'object' && a.data.text) {
        result.announcement = {
          id: a.data.id, title: a.data.title, text: a.data.text,
          authorId: a.data.authorId, createdAt: a.data.createdAt,
          updatedAt: a.data.updatedAt, visibility: a.data.visibility,
        };
      } else {
        result.announcement = null;
      }
    } catch (e) {
      result.announcement = null;
    }
  }
  return result;
}

export async function handleGetGroupInstances({ groupId }) {
  const { api } = ctx;
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}/instances`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const instances = (r.data || []).map((inst) => ({
    instanceId: inst.instanceId,
    location: inst.location,
    memberCount: inst.memberCount,
    worldId: inst.world?.id || null,
    worldName: inst.world?.name || null,
    worldAuthor: inst.world?.authorName || null,
    worldCapacity: inst.world?.capacity || null,
    worldImageUrl: inst.world?.imageUrl || null,
  }));
  return { groupId, count: instances.length, instances };
}

export async function handleGetGroupAnnouncement({ groupId }) {
  const { api } = ctx;
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}/announcement`);
  if (r.status !== 200) {
    if (r.status === 403 || r.status === 404) return { groupId, announcement: null };
    throw new Error(`API error: ${r.status}`);
  }
  const d = r.data;
  if (!d || typeof d !== 'object' || !d.text) {
    return { groupId, announcement: null };
  }
  return {
    groupId,
    announcement: {
      id: d.id,
      title: d.title,
      text: d.text,
      authorId: d.authorId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      visibility: d.visibility,
      imageUrl: d.imageUrl,
    },
  };
}

export async function handleSearchGroups({ query, n }) {
  const { api } = ctx;
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const limit = Math.min(Math.max(parseInt(n, 10) || 30, 1), 100);
  const r = await api._request('GET', `/groups?query=${encodeURIComponent(query)}&n=${limit}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const groups = (r.data || []).map((g) => {
    const item = {};
    if (g.id !== undefined && g.id !== null) item.groupId = g.id;
    if (g.name !== undefined && g.name !== null) item.name = g.name;
    if (g.shortCode !== undefined && g.shortCode !== null) item.shortCode = g.shortCode;
    if (g.memberCount !== undefined && g.memberCount !== null) item.memberCount = g.memberCount;
    if (g.isVerified !== undefined && g.isVerified !== null) item.isVerified = g.isVerified;
    if (g.description !== undefined && g.description !== null) item.description = g.description;
    return item;
  });
  return { query, count: groups.length, groups };
}

export async function handleSearchWorlds({ query, n }) {
  const { api, storage } = ctx;
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const limit = Math.min(Math.max(parseInt(n, 10) || 10, 1), 30);
  const apiWorlds = [];
  try {
    const r = await api._request('GET', `/worlds?search=${encodeURIComponent(query)}&n=${limit}`);
    if (r.status === 200) {
      for (const w of (r.data || [])) {
        apiWorlds.push({
          worldId: w.id,
          name: w.name,
          authorName: w.authorName,
          capacity: w.capacity,
          imageUrl: w.imageUrl,
          description: (w.description || '').slice(0, 200),
        });
      }
    }
  } catch (e) { /* API 失败时仅用本地结果 */ }

  const local = storage.searchWorldsByName(query);

  // 合并：API 结果优先（完整信息），本地补充（可能命中 API 搜不到的）
  const seen = new Set(apiWorlds.map(w => w.worldId));
  const merged = [...apiWorlds];
  for (const lw of local) {
    if (!seen.has(lw.worldId)) {
      seen.add(lw.worldId);
      merged.push({ worldId: lw.worldId, name: lw.name });
    }
  }
  return { query, apiCount: apiWorlds.length, localCount: local.length, count: merged.length, worlds: merged };
}

export async function handleJoinGroup({ groupId }) {
  const { api } = ctx;
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('POST', `/groups/${groupId}/join`);
  if (r.status === 200 && r.data) {
    return { groupId, joined: true, membership: r.data.membershipId ? { membershipId: r.data.membershipId } : undefined };
  }
  if (r.status === 400 && typeof r.data?.error?.message === 'string' && r.data.error.message.includes('already a member')) {
    return { groupId, joined: false, alreadyMember: true };
  }
  throw new Error(`API error: ${r.status}`);
}

export async function handleLeaveGroup({ groupId, confirm }) {
  const { api } = ctx;
  if (!groupId) throw new Error('groupId is required');
  if (confirm !== true) {
    return { groupId, confirmRequired: true, message: 'Leaving a group removes you from it. Pass confirm: true to actually leave.' };
  }
  // 自己退出用 POST /groups/{id}/leave；DELETE /members/{userId} 是管理员移除成员（普通成员 403，实测 2026-08-09）
  const r = await api._request('POST', `/groups/${groupId}/leave`);
  if (r.status === 200) return { groupId, left: true };
  // 403 = 不是成员/群不存在（实测：POST leave 对无效群返回 403 而非 404）
  if (r.status === 403 || r.status === 404 || r.status === 400) return { groupId, left: false, notMember: true };
  throw new Error(`API error: ${r.status}`);
}

export async function handlePeekGroupAnnouncement({ groupId, confirm }) {
  const { api } = ctx;
  if (!groupId) throw new Error('groupId is required');
  if (confirm !== true) {
    return { groupId, confirmRequired: true, message: 'This auto-joins the group, reads its announcement, then leaves (members see the join feed). Pass confirm: true to proceed.' };
  }
  const g = await api._request('GET', `/groups/${groupId}`);
  if (g.status !== 200) throw new Error(`API error: ${g.status}`);
  const joinState = g.data?.joinState;
  if (joinState !== 'open') {
    return { groupId, joinState: joinState || 'unknown', peekable: false,
             message: joinState === 'request' ? 'Group requires request/approval - cannot auto-join.' :
                      joinState === 'invite' ? 'Group is invite-only - cannot auto-join.' : 'Group join state unknown.' };
  }
  let joinedNow = false;
  const j = await api._request('POST', `/groups/${groupId}/join`);
  if (j.status === 200) joinedNow = true;
  else if (!(j.status === 400 && typeof j.data?.error?.message === 'string' && j.data.error.message.includes('already a member'))) {
    throw new Error(`join failed: ${j.status}`);
  }
  try {
    const a = await api._request('GET', `/groups/${groupId}/announcement`);
    let announcement = null;
    if (a.status === 200 && a.data && typeof a.data === 'object' && a.data.text) {
      announcement = {
        id: a.data.id, title: a.data.title, text: a.data.text,
        authorId: a.data.authorId, createdAt: a.data.createdAt,
        updatedAt: a.data.updatedAt, visibility: a.data.visibility,
      };
    }
    return { groupId, joinState, peekable: true, joinedNow, announcement };
  } finally {
    // 4. 无论公告读取成功与否，刚加入就退出（POST leave，2026-08-09 实测正确端点）
    if (joinedNow) {
      try { await api._request('POST', `/groups/${groupId}/leave`); } catch (e) { /* 退出失败忽略 */ }
    }
  }
}

/**
 * 群组热度 — 基于本地事件库聚合群组房活动:
 *   - 热度榜: 窗口内群组房活动次数/活跃好友数/涉及世界数 + 较上一等长窗口趋势
 *   - 热力图: 前 topK 个群按 (星期×小时) 的北京时区分桶分布
 *   - 群名/成员数: group_cache 优先, 缺失查 API 并缓存
 * 数据源: friend-location / user-location 事件中 location 含 ~group(grp_/gmem_xxx) 的群组房。
 * VRChat 群组 ID 已从 grp_ 迁移为 gmem_ (2026-08 实测), 双前缀匹配。
 */
export async function handleGetGroupHeat({ days, startTime, endTime, topK = 5 }) {
  const { storage, api } = ctx;

  // ── 窗口解析: 默认最近 N 天(北京自然日), 或显式 startTime/endTime ──
  let start, end;
  if (startTime && endTime) {
    start = new Date(startTime).toISOString();
    end = new Date(endTime).toISOString();
  } else {
    const n = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30);
    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const todayStr = bjNow.toISOString().slice(0, 10);
    end = new Date(`${todayStr}T23:59:59.999+08:00`).toISOString();
    const first = new Date(`${todayStr}T00:00:00.000+08:00`);
    first.setUTCDate(first.getUTCDate() - (n - 1));
    start = new Date(`${first.toISOString().slice(0, 10)}T00:00:00.000+08:00`).toISOString();
  }
  const winLen = Date.parse(end) - Date.parse(start);
  if (!(winLen > 0)) throw new Error('Invalid time window');
  const prevStart = new Date(Date.parse(start) - winLen).toISOString();

  // ── 聚合 ──
  const groups = storage.getGroupHeat(start, end);
  const prev = storage.getGroupHeat(prevStart, start);

  // ── 群名/成员数回填 (group_cache 优先, 缺失查 API 并缓存) ──
  // 只回填活动最多的 backfillN 个群, 避免冷启动时串行 API 拖垮响应(周报场景才全量回填)
  const ranked = [...groups.entries()].map(([gid, s]) => {
    const prevCount = prev.has(gid) ? prev.get(gid).count : 0;
    const deltaPct = prevCount === 0
      ? (s.count > 0 ? 100 : 0)
      : Math.round(((s.count - prevCount) / prevCount) * 100);
    return {
      groupId: gid,
      name: '',
      memberCount: 0,
      activityCount: s.count,
      friendCount: s.users.size,
      worldCount: s.worlds.size,
      prevActivityCount: prevCount,
      trendPct: deltaPct,
    };
  }).sort((a, b) => b.activityCount - a.activityCount);

  const k = Math.min(Math.max(parseInt(topK, 10) || 5, 1), 10);
  const backfillN = Math.min(ranked.length, Math.max(10, k * 2));
  const backfillIds = new Set(ranked.slice(0, backfillN).map((g) => g.groupId));
  const cachedGids = [];
  for (const g of ranked) {
    if (!backfillIds.has(g.groupId)) continue;
    const cached = storage.getGroupCached(g.groupId);
    if (cached && cached.name) {
      g.name = cached.name;
      g.memberCount = cached.member_count || 0;
      cachedGids.push(g.groupId);
    }
  }
  const missing = ranked.filter((g) => backfillIds.has(g.groupId) && !cachedGids.includes(g.groupId));
  for (const g of missing) {
    try {
      const r = await api._request('GET', `/groups/${g.groupId}`);
      if (r.status === 200 && r.data) {
        g.name = r.data.name || g.groupId;
        g.memberCount = r.data.memberCount || 0;
        storage.upsertGroupCache({
          groupId: g.groupId, name: r.data.name || '', description: r.data.description || '',
          memberCount: r.data.memberCount || 0,
        });
      } else g.name = g.groupId;
    } catch { g.name = g.groupId; }
  }
  const heatmap = {};
  const rankByName = new Map(ranked.map((g) => [g.groupId, g.name]));
  for (const [gid, s] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, k)) {
    const cells = {};
    for (const [key, count] of s.hourly) {
      const [dow, hour] = key.split(':');
      if (!cells[dow]) cells[dow] = {};
      cells[dow][hour] = count;
    }
    heatmap[gid] = { name: rankByName.get(gid) || gid, cells };
  }

  return {
    window: { start, end, prevStart },
    totalActivity: ranked.reduce((a, g) => a + g.activityCount, 0),
    groupCount: ranked.length,
    groups: ranked,
    heatmap,
  };
}
