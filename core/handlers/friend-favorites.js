/**
 * 好友收藏分组管理 handler — 查询分组 / 添加 / 移除 / 移动
 *
 * 基于 VRChat favorites type=friend 端点：
 * - 分组列表 GET /favorite/groups?type=friend → { id(fvgrp_), name(group_0), displayName }
 * - 收藏记录 GET /favorites?type=friend → { id(fvrt_ 记录id), favoriteId(userId), tags:[name] }
 * - 添加 POST /favorites { favoriteId: userId, tags: [name], type: 'friend' }（须已是好友，重复 400）
 * - 移除 DELETE /favorites/{记录id}（注意是记录 id 不是 userId）
 * - 移动 = 删旧建新（API 无原地更新 tags 端点，与 VRCX 行为一致）
 */

import { ctx, log } from '../server-context.js';

// 从 displayName 精确匹配解析 userId（与 friends.js 一致：大小写不敏感全等匹配）
async function resolveUserId(api, { userId, displayName }) {
  if (userId) return { userId, displayName: displayName || null };
  if (!displayName) throw new Error('userId or displayName is required');
  const r = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const users = Array.isArray(r.data) ? r.data : [];
  const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());
  if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
  if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);
  return { userId: matches[0].id, displayName: matches[0].displayName };
}

// 拉取好友收藏分组 + 收藏记录
async function fetchFriendGroups(api) {
  const groupsR = await api._request('GET', '/favorite/groups?type=friend&n=100');
  const favsR = await api._request('GET', '/favorites?type=friend&n=100&offset=0');
  const groups = (groupsR.status === 200 && Array.isArray(groupsR.data)) ? groupsR.data : [];
  const favs = (favsR.status === 200 && Array.isArray(favsR.data)) ? favsR.data : [];
  return { groups, favs };
}

// 按 displayName 或 name 匹配分组，返回分组对象（name 是 tags 用的真实值）
function findGroup(groups, groupName) {
  if (!groupName) return null;
  const q = String(groupName).toLowerCase();
  return groups.find(g => (g.displayName || '').toLowerCase() === q)
      || groups.find(g => (g.name || '').toLowerCase() === q)
      || null;
}

export async function handleGetFriendFavoriteGroups() {
  const { api, rateLimiter } = ctx;
  const { groups, favs } = await rateLimiter.execute(() => fetchFriendGroups(api));
  const byGroupTag = new Map();
  for (const f of favs) {
    const tag = (f.tags || [])[0] || '';
    byGroupTag.set(tag, (byGroupTag.get(tag) || 0) + 1);
  }
  return {
    totalGroups: groups.length,
    groups: groups.map(g => ({
      groupId: g.id,
      name: g.name,
      displayName: g.displayName || g.name,
      memberCount: byGroupTag.get(g.name) || 0,
    })),
  };
}

// 添加好友到收藏分组（可逆，confirm 护栏）
export async function handleFavoriteFriend({ userId, displayName, groupName, confirm }) {
  const { api, rateLimiter } = ctx;
  if (!groupName) throw new Error('groupName is required');
  const { userId: targetId, displayName: targetName } = await resolveUserId(api, { userId, displayName });
  const { groups } = await rateLimiter.execute(() => fetchFriendGroups(api));
  const group = findGroup(groups, groupName);
  if (!group) throw new Error(`收藏分组未找到：${groupName}（可用 get_friend_favorite_groups 查看现有分组）`);
  if (!confirm) {
    return { userId: targetId, displayName: targetName, groupName: group.displayName || group.name, confirmRequired: true, message: `将把 ${targetName || targetId} 加入收藏分组「${group.displayName || group.name}」，请传 confirm: true 确认执行` };
  }
  const r = await rateLimiter.execute(() => api._request('POST', '/favorites', {
    favoriteId: targetId,
    tags: [group.name],
    type: 'friend',
  }));
  if (r.status === 400) {
    return { ok: false, userId: targetId, displayName: targetName, groupName: group.displayName || group.name, favorited: false, error: 'already favorited（该好友已在此分组）' };
  }
  if (r.status === 403) {
    return { ok: false, userId: targetId, displayName: targetName, groupName: group.displayName || group.name, favorited: false, error: 'not friends（对方还不是你的好友，无法收藏）' };
  }
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  log(`✅ favorite_friend: ${targetName || targetId} → ${group.displayName || group.name}`);
  return { ok: true, userId: targetId, displayName: targetName, groupName: group.displayName || group.name, favorited: true };
}

// 从收藏分组移除好友（可逆，confirm 护栏；groupName 省略 = 从所有分组移除）
export async function handleUnfavoriteFriend({ userId, displayName, groupName, confirm }) {
  const { api, rateLimiter } = ctx;
  const { userId: targetId, displayName: targetName } = await resolveUserId(api, { userId, displayName });
  const { groups, favs } = await rateLimiter.execute(() => fetchFriendGroups(api));
  const targetTag = groupName ? (findGroup(groups, groupName)?.name || null) : null;
  const records = favs.filter(f => f.favoriteId === targetId && (!targetTag || (f.tags || [])[0] === targetTag));
  if (records.length === 0) {
    return { ok: false, userId: targetId, displayName: targetName, removed: false, error: groupName ? `该好友不在分组「${groupName}」中` : '该好友不在任何收藏分组中' };
  }
  if (!confirm) {
    const groupNames = records.map(r => (r.tags || [])[0]).join(', ');
    return { userId: targetId, displayName: targetName, groupName: groupNames, confirmRequired: true, message: `将从收藏分组「${groupNames}」移除 ${targetName || targetId}，请传 confirm: true 确认执行` };
  }
  for (const rec of records) {
    const r = await rateLimiter.execute(() => api._request('DELETE', `/favorites/${rec.id}`));
    if (r.status !== 200 && r.status !== 404) throw new Error(`API error: ${r.status}`);
  }
  log(`✅ unfavorite_friend: ${targetName || targetId} (${records.length} 条记录)`);
  return { ok: true, userId: targetId, displayName: targetName, removed: true, removedGroups: records.map(r => (r.tags || [])[0]) };
}

// 移动好友到另一分组（删旧建新，confirm 护栏）
export async function handleMoveFriendGroup({ userId, displayName, toGroup, confirm }) {
  const { api, rateLimiter } = ctx;
  if (!toGroup) throw new Error('toGroup is required');
  const { userId: targetId, displayName: targetName } = await resolveUserId(api, { userId, displayName });
  const { groups, favs } = await rateLimiter.execute(() => fetchFriendGroups(api));
  const targetGroup = findGroup(groups, toGroup);
  if (!targetGroup) throw new Error(`目标分组未找到：${toGroup}（可用 get_friend_favorite_groups 查看现有分组）`);
  const existing = favs.find(f => f.favoriteId === targetId && (f.tags || [])[0] === targetGroup.name);
  if (existing) {
    return { ok: false, userId: targetId, displayName: targetName, moved: false, error: `该好友已在目标分组「${targetGroup.displayName || targetGroup.name}」中` };
  }
  const oldRecords = favs.filter(f => f.favoriteId === targetId);
  if (!confirm) {
    return { userId: targetId, displayName: targetName, toGroup: targetGroup.displayName || targetGroup.name, confirmRequired: true, message: `将把 ${targetName || targetId} 从 ${oldRecords.length > 0 ? oldRecords.map(r => (r.tags || [])[0]).join(', ') || '无分组' : '无分组'} 移动到「${targetGroup.displayName || targetGroup.name}」（删旧建新），请传 confirm: true 确认执行` };
  }
  for (const rec of oldRecords) {
    const r = await rateLimiter.execute(() => api._request('DELETE', `/favorites/${rec.id}`));
    if (r.status !== 200 && r.status !== 404) throw new Error(`API error: ${r.status}`);
  }
  const r = await rateLimiter.execute(() => api._request('POST', '/favorites', {
    favoriteId: targetId,
    tags: [targetGroup.name],
    type: 'friend',
  }));
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  log(`✅ move_friend_group: ${targetName || targetId} → ${targetGroup.displayName || targetGroup.name}`);
  return { ok: true, userId: targetId, displayName: targetName, moved: true, fromGroups: oldRecords.map(r => (r.tags || [])[0]), toGroup: targetGroup.displayName || targetGroup.name };
}