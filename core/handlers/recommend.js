/**
 * 推荐系统 handler — 好友收藏位置 / 推荐加入 / 偏好设置 / 选择学习
 *
 * 评分核心：熟悉度 + 收藏夹权重 + 安静图场景 + 实例人数/类型 + 偏好/学习调节
 */

import { ctx, log, parseLocation } from '../server-context.js';

// ── 评分上下文：权重来源（显式偏好 > 自动学习 > 默认）──

function buildScoreContext() {
  let joinPrefs = { crowd: 'normal' };
  try {
    const rawPref = ctx.storage.getConfig('join_prefs');
    if (rawPref) joinPrefs = { ...joinPrefs, ...JSON.parse(rawPref) };
  } catch (e) { /* 偏好解析失败按默认 */ }
  let learning = null;
  if (!joinPrefs.crowd || joinPrefs.crowd === 'normal') {
    try {
      const rawLearn = ctx.storage.getConfig('join_learning');
      if (rawLearn) { const l = JSON.parse(rawLearn); if (l && l.enabled) learning = l; }
    } catch (e) { /* 学习结果解析失败按默认 */ }
  }
  const isExplicitPref = joinPrefs.crowd && joinPrefs.crowd !== 'normal';
  const CROWD = joinPrefs.crowd || (learning && learning.crowd) || 'normal';
  // 动态调整保持均衡（成对系数，比例受控 0.72~1.55）：人数权重降 ↔ 熟悉度反向升
  const famAdjust = CROWD === 'avoid' ? 1.15 : (CROWD === 'love' ? 0.9 : 1);
  const famMult = Math.min((isExplicitPref ? 1 : (learning ? learning.familiarityMult : 1)) * famAdjust, 1.3);
  const crowdMult = CROWD === 'avoid' ? 0.75 : (CROWD === 'love' ? 1.25 : 1);
  const fullPenalty = CROWD === 'avoid' ? 60 : (CROWD === 'love' ? 30 : 50);
  const coldPenalty = CROWD === 'avoid' ? 0 : (CROWD === 'love' ? 15 : 10);
  const prefTag = CROWD === 'normal' ? '' : (isExplicitPref ? `偏好[${CROWD === 'avoid' ? '避人潮' : '爱热闹'}]` : `学习[${CROWD === 'avoid' ? '避人潮' : '爱热闹'}]`);
  // 睡觉图集合（new_worlds.sleep_ok=1）+ 安静图名字判定
  const sleepWorlds = new Set();
  try {
    const sw = ctx.storage._query('SELECT world_id FROM new_worlds WHERE sleep_ok=1');
    for (const r of sw) sleepWorlds.add(r.world_id);
  } catch (e) { /* 表不存在/无数据按空处理 */ }
  const QUIET_RE = /(寝|眠|睡眠|睡觉|睡|sleep|quiet|静か|静寂|calm|relax|リラックス|ゆったり|安らぎ|癒し|冥想|meditation)/i;
  const isQuietWorldName = (name) => typeof name === 'string' && QUIET_RE.test(name);
  return { joinPrefs, learning, isExplicitPref, CROWD, famMult, crowdMult, fullPenalty, coldPenalty, prefTag, sleepWorlds, isQuietWorldName };
}

async function buildFamiliarityScorer() {
  // 同屏统计（现成 storage.findCompanions，30天 + 一年各一次，带缓存）
  const SELF = ctx.api.currentUser?.id || (await ctx.api._request('GET', '/auth/user')).data?.id || '';
  const NOW_MS = Date.now();
  const DAY = 86400000;
  const companionsCache = {};
  async function getCompanionsMap(startMs, endMs) {
    const key = `${startMs}|${endMs}`;
    if (companionsCache[key]) return companionsCache[key];
    const r = ctx.storage.findCompanions(SELF, new Date(startMs).toISOString(), new Date(endMs).toISOString());
    const map = new Map((r.companions || []).map(c => [c.userId, c.matchCount || 0]));
    companionsCache[key] = map;
    return map;
  }
  async function familiarityScore(userId) {
    const recentMap = await getCompanionsMap(NOW_MS - 30 * DAY, NOW_MS);
    const histMap = await getCompanionsMap(NOW_MS - 365 * DAY, NOW_MS);
    const recent = recentMap.get(userId) || 0;
    const hist = histMap.get(userId) || 0;
    const recentScore = Math.min(recent * 2, 60) + (recent > 0 ? 10 : 0);
    const histScore = Math.min(hist * 0.5, 30) * 0.6;
    return { score: Math.round(recentScore + histScore), recentMatchCount: recent, histMatchCount: hist };
  }
  return { familiarityScore };
}

async function buildGroupMap() {
  // 收藏夹分组（熟悉度补充信号，权重配置化：VRC_MONITOR_GROUP_WEIGHTS / VRC_MONITOR_CONTACT_GROUPS）
  let groupWeights = {};
  const contactGroups = new Set();
  try {
    if (process.env.VRC_MONITOR_GROUP_WEIGHTS) groupWeights = JSON.parse(process.env.VRC_MONITOR_GROUP_WEIGHTS);
  } catch (e) { /* 解析失败按默认 */ }
  if (process.env.VRC_MONITOR_CONTACT_GROUPS) {
    for (const g of process.env.VRC_MONITOR_CONTACT_GROUPS.split(',')) contactGroups.add(g.trim());
  }
  const groupMap = new Map();
  try {
    const groupsR = await ctx.rateLimiter.execute(() => ctx.api._request('GET', '/favorite/groups?type=friend&n=100'));
    const favsR = await ctx.rateLimiter.execute(() => ctx.api._request('GET', '/favorites?type=friend&n=100'));
    const groups = (groupsR.status === 200 && Array.isArray(groupsR.data)) ? groupsR.data : [];
    const favs = (favsR.status === 200 && Array.isArray(favsR.data)) ? favsR.data : [];
    for (const g of groups) {
      const isContact = contactGroups.has(g.displayName || g.name);
      const weight = groupWeights[g.displayName || g.name] !== undefined ? groupWeights[g.displayName || g.name] : (isContact ? -40 : 5);
      const memberIds = new Set(favs.filter(f => (f.tags || [])[0] === g.name).map(f => f.favoriteId));
      groupMap.set(g.displayName || g.name, { memberIds, weight, isContact });
    }
  } catch (e) { /* 收藏夹失败不阻断 */ }
  return groupMap;
}

function computeEntryScore(scoreCtx, entry) {
  // 统一评分：熟悉度 + 收藏夹权重 + 安静图场景 + 实例人数/类型 + 偏好/学习调节
  const { CROWD, famMult, crowdMult, fullPenalty, coldPenalty, prefTag, sleepWorlds, isQuietWorldName, learning } = scoreCtx;
  const { loc, worldName, worldTags, instanceUsers, fillRatio, status, groupName, groupWeight, isContact, familiarity } = entry;
  let score = 0;
  const reasons = [];
  if (isContact) { score -= 40; reasons.push('活动联系人-40'); }
  else {
    // 熟悉度（×1.5，上限 132）与地图属性（人数×1+黄金区30 等）同量级——均衡，互不碾压
    const famScore = famMult !== 1 ? Math.min(Math.round(familiarity.score * famMult * 1.5), 132) : Math.min(familiarity.score * 1.5, 132);
    score += famScore;
    reasons.push(`熟悉度${famScore}${famMult !== 1 ? `(加权×${Math.round(famMult*10)/10})` : ''}(30天${familiarity.recentMatchCount}次)`);
    if (groupName) {
      const bonus = Math.min(groupWeight, 10);
      if (bonus !== 0) { score += bonus; reasons.push(`[${groupName}]+${bonus}`); }
    }
  }
  const isSleepWorld = loc.worldId && sleepWorlds.has(loc.worldId);
  const isQuietWorld = isSleepWorld || isQuietWorldName(worldName);
  if (instanceUsers !== undefined) {
    if (isQuietWorld) {
      // 安静图：人少是理想状态，人多反而打扰（破坏氛围/电灯泡）
      const quietBonus = learning && learning.quietBias ? 25 : 15;
      if (instanceUsers === 0) { reasons.push('安静图空房可进'); }
      else if (instanceUsers <= 3) { score += quietBonus; reasons.push(`安静图${instanceUsers}人正合适+${quietBonus}`); }
      else if (instanceUsers <= 6) { score += 0; reasons.push(`安静图${instanceUsers}人适中`); }
      else { score -= 50; reasons.push(`安静图${instanceUsers}人太多-50`); }
    } else {
      // 热闹图：人多正向，黄金区最理想（人数权重/爆满/冷清受偏好调节）
      if (instanceUsers < 3 && instanceUsers > 0) { score -= 15; reasons.push(`人少${instanceUsers}人可能私聊-15`); }
      // 个性化黄金区：学习到人数舒适区时按绝对人数判断，否则用固定填充率 30-80%
      const comfy = learning && learning.preferredCrowdRange;
      let inComfort = false;
      if (comfy) {
        // 兼容「4-8人」和「61+人」两种格式（61+ 无连字符）
        const m = comfy.match(/^(\d+)(?:-(\d+))?\+?人?$/);
        if (m) {
          const lo = parseInt(m[1], 10), hi = m[2] ? parseInt(m[2], 10) : Infinity;
          inComfort = instanceUsers >= lo && instanceUsers <= hi;
        }
      }
      if (comfy && inComfort) { score += 30; reasons.push(`舒适区${comfy}+30`); }
      else if (comfy) { score -= 10; reasons.push(`舒适区${comfy}外-10`); }
      else if (fillRatio >= 0.3 && fillRatio <= 0.8) { score += 30; reasons.push(`黄金区${Math.round(fillRatio*100)}%+30`); }
      if (fillRatio > 0.9) { score -= fullPenalty; reasons.push(`${prefTag}爆满-${fullPenalty}`); }
      else if (fillRatio < 0.1) { score -= coldPenalty; reasons.push(`${prefTag}冷清-${coldPenalty}`); }
      score += Math.round(instanceUsers * crowdMult); reasons.push(`人数${instanceUsers}${CROWD === 'normal' ? '' : `×${crowdMult}`}`);
    }
  }
  // 类型偏好：学习到的 author_tag 命中 → 加分（安静图类型由 quietBias 单独处理）
  if (learning && learning.worldType) {
    const tagHit = Array.isArray(worldTags) && worldTags.includes('author_tag_' + learning.worldType);
    if (tagHit) { score += 15; reasons.push(`类型[${learning.worldType}]+15`); }
  }
  if (loc.type === 'public') { score += 10; reasons.push('public+10'); }
  else if (loc.type === 'friends' || loc.type === 'hidden') { score += 5; reasons.push(loc.type === 'hidden' ? 'friend++5' : 'friends+5'); }
  else if (loc.type === 'group') { score += 3; reasons.push('group+3'); }
  if (status === 'active') { score += 5; reasons.push('active+5'); }
  return { score: Math.round(score), reasons, isQuietWorld, isSleepWorld };
}

// ── 好友收藏夹位置列表 ──

export async function handleGetFavoriteFriendsLocations({ groupName, favoriteGroupId, searchName }) {
  const { storage, api, rateLimiter } = ctx;
  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  // 0. searchName 模式：直接在好友列表（含离线=false）里按名字查位置
  if (searchName) {
    const kw = searchName.toLowerCase();
    const friendsR = await rateLimiter.execute(() => api._request('GET', '/auth/user/friends?offline=false'));
    if (friendsR.status !== 200) throw new Error(`API error: ${friendsR.status}`);
    const onlineFriends = Array.isArray(friendsR.data) ? friendsR.data : [];
    // 模糊匹配（在线好友里找；找不到再提示）
    const matched = onlineFriends.filter(f =>
      f.displayName.toLowerCase().includes(kw) ||
      (f.id || '').toLowerCase() === kw);
    if (matched.length === 0) {
      // 查离线好友列表确认是否好友
      const allR = await rateLimiter.execute(() => api._request('GET', '/auth/user/friends?offline=true'));
      const allFriends = (allR.status === 200 && Array.isArray(allR.data)) ? allR.data : [];
      const matchedAll = allFriends.filter(f => f.displayName.toLowerCase().includes(kw));
      if (matchedAll.length === 0) {
        throw new Error(`好友列表中没有找到「${searchName}」。`);
      }
      return {
        mode: 'search',
        query: searchName,
        offline: matchedAll.map(f => ({ userId: f.id, displayName: f.displayName, online: false })),
        message: '好友当前离线',
      };
    }
    // 在线：逐个解析位置（复用下方逻辑，但保留 private/hidden 并标记 joinable）
    const results = [];
    const worldCache = new Map();
    const instanceInfo = new Map();
    async function getWorldNameSafe(worldId) {
      if (worldCache.has(worldId)) return worldCache.get(worldId);
      let name = worldId;
      const cached = storage.getWorldName(worldId);
      if (cached && cached.name) {
        name = cached.name;
      } else {
        const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${worldId}`));
        if (r.status === 200 && r.data && r.data.name) {
          name = r.data.name;
          try { storage.upsertWorld({ worldId, name, authorId: r.data.authorId || '', authorName: r.data.authorName || '' }); } catch (e) {}
        }
      }
      worldCache.set(worldId, name);
      return name;
    }
    for (const f of matched) {
      const loc = parseLocation(f.location || 'private');
      if (!loc) continue;
      const isJoinable = loc.type === 'public' || loc.type === 'friends' || loc.type === 'group' || loc.type === 'hidden';
      const worldName = loc.worldId ? await getWorldNameSafe(loc.worldId) : null;
      const entry = {
        userId: f.id,
        displayName: f.displayName,
        online: true,
        joinable: isJoinable,
        instanceTypeDisplay: loc.type === 'hidden' ? 'friend+（好友+）' : (loc.type || 'unknown'),
        location: f.location || 'private',
        worldId: loc.worldId || null,
        worldName,
        instanceType: loc.type || 'unknown',
        instanceId: loc.instanceId || '',
        region: loc.region || '',
        status: f.status,
        statusDescription: f.statusDescription,
        platform: f.platform,
        nickname: nicknameMap.get(f.id) || null,
        avatarImageUrl: f.currentAvatarThumbnailImageUrl,
      };
      // 可加入的才查实例玩家数（private 查了也进不去）
      if (isJoinable && loc.instanceId && f.location && !f.location.includes('~private')) {
        const instKey = f.location;
        if (!instanceInfo.has(instKey)) {
          try {
            const r = await rateLimiter.execute(() => api._request('GET', `/instances/${instKey}`));
            if (r.status === 200 && r.data) {
              instanceInfo.set(instKey, { nUsers: r.data.n_users || 0, capacity: r.data.capacity || 0 });
            } else {
              instanceInfo.set(instKey, null);
            }
          } catch (e) {
            instanceInfo.set(instKey, null);
          }
        }
        const inst = instanceInfo.get(instKey);
        if (inst) {
          entry.instanceUsers = inst.nUsers;
          entry.instanceCapacity = inst.capacity;
          entry.fillRatio = inst.capacity > 0 ? +(inst.nUsers / inst.capacity).toFixed(2) : 0;
        }
      }
      results.push(entry);
    }
    return { mode: 'search', query: searchName, friends: results };
  }

  // 1. 全部好友收藏分组
  const groupsR = await rateLimiter.execute(() => api._request('GET', '/favorite/groups?type=friend&n=100'));
  if (groupsR.status !== 200) throw new Error(`API error: ${groupsR.status}`);
  const groups = Array.isArray(groupsR.data) ? groupsR.data : [];

  if (!groupName && !favoriteGroupId) {
    // 概览模式：返回全部分组 + 成员数（用分组的 name=group_N 匹配 tags）
    const favsAllR = await rateLimiter.execute(() => api._request('GET', '/favorites?type=friend&n=100'));
    const favsAll = (favsAllR.status === 200 && Array.isArray(favsAllR.data)) ? favsAllR.data : [];
    // 按 tags[0]（group_N）分组统计
    const byGroupTag = new Map();
    for (const f of favsAll) {
      const tag = (f.tags || [])[0] || '';
      byGroupTag.set(tag, (byGroupTag.get(tag) || 0) + 1);
    }
    const overview = groups.map(g => ({
      groupId: g.id,
      groupName: g.displayName || g.id,
      groupTag: g.name || '',
      memberCount: byGroupTag.get(g.name) || 0,
    }));
    return { mode: 'overview', groups: overview };
  }

  // 2. 定位分组
  let group = null;
  if (favoriteGroupId) {
    group = groups.find(g => g.id === favoriteGroupId) || null;
  } else if (groupName) {
    group = groups.find(g => (g.displayName || '') === groupName) ||
            groups.find(g => (g.displayName || '').toLowerCase() === groupName.toLowerCase()) || null;
  }
  if (!group) {
    const available = groups.map(g => g.displayName || g.id);
    throw new Error(`找不到收藏夹「${groupName || favoriteGroupId}」。可用分组: ${available.join(' / ')}`);
  }

  // 3. 组内好友：API 的 groupId 参数被忽略（永远返回全部），改用分组的 name=group_N 匹配 tags[0]
  const groupTag = group.name || '';
  const favsR = await rateLimiter.execute(() => api._request('GET', '/favorites?type=friend&n=100'));
  if (favsR.status !== 200) throw new Error(`API error: ${favsR.status}`);
  const allFavs = Array.isArray(favsR.data) ? favsR.data : [];
  const favs = groupTag
    ? allFavs.filter(f => (f.tags || [])[0] === groupTag)
    : allFavs;

  // 4. 逐个查好友位置（复用在线好友列表更快：一次请求拿到全部在线好友位置）
  //    先用 /auth/user/friends?offline=false 拿在线好友，再对组内好友查详情
  const onlineR = await rateLimiter.execute(() => api._request('GET', '/auth/user/friends?offline=false'));
  const onlineFriends = (onlineR.status === 200 && Array.isArray(onlineR.data)) ? onlineR.data : [];
  const onlineMap = new Map(onlineFriends.map(f => [f.id, f]));

  // 组内每个好友：在线直接取位置；离线标记
  const members = [];
  const onlineIds = [];
  for (const f of favs) {
    const uid = f.favoriteId;
    const online = onlineMap.get(uid);
    if (online) {
      members.push({ favoriteId: f.id, userId: uid, displayName: online.displayName, online: true, location: online.location || 'private', status: online.status, platform: online.platform, avatarImageUrl: online.currentAvatarThumbnailImageUrl });
      onlineIds.push(uid);
    } else {
      members.push({ favoriteId: f.id, userId: uid, displayName: null, online: false });
    }
  }

  // 5. 在线好友：补世界名 + 实例信息（玩家数/容量/类型），算推荐度
  //    共享评分系统：熟悉度 + 收藏夹权重 + 安静图场景 + 偏好/学习（与 recommend_join 同一套）
  const scoreCtx = buildScoreContext();
  const { familiarityScore } = await buildFamiliarityScorer();
  const groupMap = await buildGroupMap();
  const worldCache = new Map();
  const instanceInfo = new Map();
  //    位置解析 + 世界名缓存；实例详情批量查（限流）
  async function getWorldNameSafe(worldId) {
    if (worldCache.has(worldId)) return worldCache.get(worldId);
    let name = worldId;
    let tags = [];
    const cached = storage.getWorldName(worldId);
    if (cached && cached.name) {
      name = cached.name;
      tags = Array.isArray(cached.tags) ? cached.tags : (typeof cached.tags === 'string' && cached.tags ? JSON.parse(cached.tags) : []);
    } else {
      const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${worldId}`));
      if (r.status === 200 && r.data && r.data.name) {
        name = r.data.name;
        tags = Array.isArray(r.data.tags) ? r.data.tags.filter(t => t.startsWith('author_tag_')) : [];
        try { storage.upsertWorld({ worldId, name, authorId: r.data.authorId || '', authorName: r.data.authorName || '', tags: JSON.stringify(tags) }); } catch (e) {}
      }
    }
    worldCache.set(worldId, { name, tags });
    return { name, tags };
  }

  const detailed = [];
  for (const m of members) {
    if (!m.online) continue;
    const loc = parseLocation(m.location || 'private');
    // private 实例自动排除（Invite：仅被邀请者本人可进）
    // 注意：hidden 实例 = 游戏里的 friend+(好友+)实例，好友及好友的好友可进，不排除！
    if (!loc || loc.type === 'private' ||
        m.location === 'private' || m.location === 'offline' || m.location === 'traveling') {
      continue;
    }
    // traveling 也跳过（不在具体世界）
    if (loc.type === 'traveling') continue;

    const wInfo = await getWorldNameSafe(loc.worldId);
    const worldName = wInfo.name;
    const worldTags = wInfo.tags;
    const entry = {
      userId: m.userId,
      displayName: m.displayName,
      location: m.location,
      worldId: loc.worldId,
      worldName,
      worldTags,
      instanceType: loc.type,
      instanceId: loc.instanceId || '',
      region: loc.region || '',
      status: m.status,
      platform: m.platform,
      nickname: nicknameMap.get(m.userId) || null,
      avatarImageUrl: m.avatarImageUrl,
    };

    // 实例详情：玩家数/容量（限流；失败不阻断）
    // VRChat 实例查询 key 是完整 location 且不能 URL 编码（编码 :()~ 会 400 malformed url）
    if (loc.instanceId) {
      const instKey = m.location;   // 完整 location 字符串
      if (!instanceInfo.has(instKey)) {
        try {
          const r = await rateLimiter.execute(() => api._request('GET', `/instances/${instKey}`));
          if (r.status === 200 && r.data) {
            instanceInfo.set(instKey, {
              nUsers: r.data.n_users || 0,
              capacity: r.data.capacity || 0,
              recommendedCapacity: r.data.recommendedCapacity || 0,
              type: r.data.type || '',
            });
          } else {
            instanceInfo.set(instKey, null);
          }
        } catch (e) {
          instanceInfo.set(instKey, null);
        }
      }
      const inst = instanceInfo.get(instKey);
      if (inst) {
        entry.instanceUsers = inst.nUsers;
        entry.instanceCapacity = inst.capacity;
        entry.fillRatio = inst.capacity > 0 ? +(inst.nUsers / inst.capacity).toFixed(2) : 0;
      }
    }

    // 收藏夹分组 + 熟悉度（同一套评分：熟悉度 + 收藏夹权重 + 安静图 + 偏好/学习）
    let gName = null, groupWeight = 0, isContact = false;
    for (const [gn, info] of groupMap) {
      if (info.memberIds.has(m.userId)) {
        gName = gn; groupWeight = info.weight; isContact = info.isContact;
        break;
      }
    }
    const fam = await familiarityScore(m.userId);
    const scored = computeEntryScore(scoreCtx, {
      loc, worldName: entry.worldName, worldTags: entry.worldTags, instanceUsers: entry.instanceUsers,
      fillRatio: entry.fillRatio, status: m.status,
      groupName: gName, groupWeight, isContact, familiarity: fam,
    });
    entry.familiarity = fam;
    entry.isQuietWorld = scored.isQuietWorld;
    entry.relation = { group: gName, isContact, note: isContact ? '活动联系人(非好友)' : (gName ? `收藏夹[${gName}]` : '普通好友') };
    entry.recommendScore = scored.score;
    entry.reasons = scored.reasons;
    detailed.push(entry);
  }

  // 排序：推荐度降序
  detailed.sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0));

  const onlineCount = members.filter(m => m.online).length;
  const joinableCount = detailed.length;

  return {
    mode: 'list',
    groupName: group.displayName || group.id,
    groupId: group.id,
    memberCount: members.length,
    onlineCount,
    joinableCount,
    excludedPrivate: onlineCount - joinableCount,
    friends: detailed,
    offline: members.filter(m => !m.online).map(m => ({ userId: m.userId })),
  };
}

// ── 推荐偏好：自然语言 → 权重调整（持久化到 config 表 join_prefs）──

function parseJoinPreference(text) {
  const t = String(text || '').trim();
  if (!t) return { error: 'preference 不能为空' };
  // 重置
  if (/(恢复|取消|重置|默认|清空|不要偏好)/.test(t)) {
    return { reset: true, message: '已恢复默认（无偏好）' };
  }
  let crowd = 'normal';
  // 爱热闹（优先匹配，避免「喜欢人多」被误判为避人潮）
  if (/(喜欢|爱|希望|想).*(热闹|人多|扎堆)|人越多越好|热闹一点|人多热闹/.test(t)) crowd = 'love';
  // 避人潮
  else if (/(不喜欢|讨厌|怕|不想|别).*(人多|热闹|挤|扎堆)|人.*太多|太挤|人少.*好|避开.*人群|清净/.test(t)) crowd = 'avoid';
  if (crowd === 'normal' && !/(热闹|人多|爆满|挤|人群)/.test(t)) {
    return { error: `未能识别偏好「${t}」——可试试「我不喜欢人太多」「喜欢热闹」「恢复默认」` };
  }
  const labels = { avoid: '避人潮（爆满重罚-80、人数权重×1.5、冷清不罚）', love: '爱热闹（人数权重×4、爆满轻罚-20）', normal: '默认' };
  return { crowd, label: labels[crowd] };
}

export async function handleSetJoinPreference({ preference } = {}) {
  const parsed = parseJoinPreference(preference);
  if (parsed.error) throw new Error(parsed.error);
  if (parsed.reset) {
    ctx.storage.setConfig('join_prefs', '');
    return { success: true, reset: true, message: parsed.message };
  }
  const prefs = { crowd: parsed.crowd, label: parsed.label, updatedAt: new Date().toISOString() };
  ctx.storage.setConfig('join_prefs', JSON.stringify(prefs));
  return { success: true, ...prefs, message: `已保存：${parsed.label}` };
}

export async function handleGetJoinPreference() {
  try {
    const raw = ctx.storage.getConfig('join_prefs');
    if (!raw) return { preference: null, message: '当前无偏好（默认：人数×3、爆满-40、冷清-10）' };
    return { preference: JSON.parse(raw) };
  } catch (e) {
    return { preference: null, error: `读取失败: ${e.message}` };
  }
}

// ── 推荐选择学习：记录用户从推荐列表的选择，积累后自动分析偏好调整权重 ──

let lastRecommendSnapshot = null; // 最近一次推荐列表快照（record_join_choice 补全上下文用）

function computeListBaseline(top) {
  const rows = top.filter(f => f.instanceUsers !== undefined && f.instanceUsers !== null);
  if (rows.length === 0) return { list_count: top.length, list_avg_users: 0, list_avg_fill: 0, list_quiet_ratio: 0 };
  const avgUsers = rows.reduce((s, f) => s + (f.instanceUsers || 0), 0) / rows.length;
  const avgFill = rows.reduce((s, f) => s + (f.fillRatio || 0), 0) / rows.length;
  const quietRatio = rows.filter(f => f.isQuietWorld).length / rows.length;
  return {
    list_count: top.length,
    list_avg_users: Math.round(avgUsers * 10) / 10,
    list_avg_fill: Math.round(avgFill * 100) / 100,
    list_quiet_ratio: Math.round(quietRatio * 100) / 100,
  };
}

function analyzeJoinLearning() {
  const { storage } = ctx;
  const MIN_SAMPLES = 5;
  const rows = storage._query('SELECT * FROM join_choices ORDER BY id DESC LIMIT 20');
  if (rows.length < MIN_SAMPLES) {
    return { enabled: false, samples: rows.length, minSamples: MIN_SAMPLES, crowd: null, familiarityMult: 1, quietBias: false, preferredCrowdRange: null, worldType: null };
  }
  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const avgChosenUsers = avg(rows.map(r => r.instance_users));
  const avgListUsers = avg(rows.map(r => r.list_avg_users));
  const avgFam = avg(rows.map(r => r.familiarity_score));
  const quietRatio = rows.filter(r => r.is_quiet_world).length / rows.length;

  // ── 维度1 重复选同一人：同一 userId 占比 ≥60% → 强熟人信号（不依赖熟悉度绝对值）──
  const userCounts = {};
  for (const r of rows) userCounts[r.user_id] = (userCounts[r.user_id] || 0) + 1;
  const topUser = Object.entries(userCounts).sort((a, b) => b[1] - a[1])[0] || null;
  const repeatRatio = topUser ? topUser[1] / rows.length : 0;
  const repeatPrefer = repeatRatio >= 0.6;

  // ── 维度2 熟悉度偏好：60% 以上选择熟悉度>=15 的好友（辅助，重复选择已覆盖）──
  const famPrefer = !repeatPrefer && avgFam >= 15 && rows.filter(r => r.familiarity_score >= 15).length >= Math.ceil(rows.length * 0.6);

  // ── 维度3 人数舒适区：选择人数分桶 ≥60% 集中 → 个性化黄金区 ──
  const CROWD_BUCKETS = [
    { label: '0-3人', min: 0, max: 3 },
    { label: '4-8人', min: 4, max: 8 },
    { label: '9-15人', min: 9, max: 15 },
    { label: '16-30人', min: 16, max: 30 },
    { label: '31-60人', min: 31, max: 60 },
    { label: '61+人', min: 61, max: Infinity },
  ];
  let preferredCrowdRange = null;
  const chosenUsersArr = rows.map(r => r.instance_users).filter(n => n > 0);
  if (chosenUsersArr.length >= Math.ceil(rows.length * 0.6)) {
    for (const b of CROWD_BUCKETS) {
      const ratio = chosenUsersArr.filter(n => n >= b.min && n <= b.max).length / chosenUsersArr.length;
      if (ratio >= 0.6) { preferredCrowdRange = b.label; break; }
    }
  }

  // ── 维度4 人数倾向（舒适区细化为 avoid/love，舒适区未命中时用旧逻辑）──
  let crowd = null;
  if (preferredCrowdRange) {
    if (preferredCrowdRange === '0-3人' || preferredCrowdRange === '4-8人') crowd = 'avoid';
    else if (preferredCrowdRange === '31-60人' || preferredCrowdRange === '61+人') crowd = 'love';
  }
  if (!crowd && avgListUsers > 3 && avgChosenUsers < avgListUsers * 0.6) crowd = 'avoid';
  else if (!crowd && avgListUsers > 3 && avgChosenUsers > avgListUsers * 1.3) crowd = 'love';

  // ── 维度5 类型偏好：某 author_tag 出现在 ≥60% 的选择行中 → 类型加分 ──
  // 按选择行数占比判定（世界通常带多个标签，按标签次数占比过严会被稀释）
  let worldType = null;
  const tagCounts = {};
  for (const r of rows) {
    let tags = [];
    try { tags = r.world_tags ? JSON.parse(r.world_tags) : []; } catch (e) {}
    for (const t of tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  const topTag = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])[0] || null;
  if (topTag && topTag[1] / rows.length >= 0.6) {
    worldType = topTag[0].replace('author_tag_', '');
  }

  // ── 安静图倾向：50% 以上选择安静图（并入类型体系，保留独立信号）──
  const quietBias = quietRatio >= 0.5;

  const learning = {
    enabled: true,
    samples: rows.length,
    crowd,
    // 重复选同一人 → 1.3（最强信号）；熟悉度偏好 → 1.2；否则 1
    familiarityMult: repeatPrefer ? 1.3 : (famPrefer ? 1.2 : 1),
    quietBias,
    preferredCrowdRange,
    worldType,
    stats: {
      avgChosenUsers: Math.round(avgChosenUsers * 10) / 10,
      avgListUsers: Math.round(avgListUsers * 10) / 10,
      avgFamiliarity: Math.round(avgFam * 10) / 10,
      quietRatio: Math.round(quietRatio * 100) / 100,
      repeatRatio: Math.round(repeatRatio * 100) / 100,
      repeatUser: repeatPrefer ? (topUser ? topUser[0].slice(0, 12) : null) : null,
      topTag: worldType ? 'author_tag_' + worldType : null,
    },
    updatedAt: new Date().toISOString(),
  };
  storage.setConfig('join_learning', JSON.stringify(learning));
  return learning;
}

export async function handleRecordJoinChoice({ userId, displayName } = {}) {
  if (!lastRecommendSnapshot) throw new Error('还没有推荐列表——请先运行 recommend_join 再记录选择');
  const top = lastRecommendSnapshot.top || [];
  if (top.length === 0) throw new Error('最近一次推荐列表为空，无法记录');
  let hit = null;
  if (userId) hit = top.find(f => f.userId === userId);
  if (!hit && displayName) {
    const dn = String(displayName).toLowerCase();
    hit = top.find(f => (f.displayName || '').toLowerCase().includes(dn));
  }
  if (!hit) throw new Error(`推荐列表中没有找到「${displayName || userId}」——请先运行 recommend_join 并从中选择`);
  const rank = top.indexOf(hit) + 1;
  const baseline = lastRecommendSnapshot.baseline;
  ctx.storage._run(
    `INSERT INTO join_choices (user_id, display_name, world_id, world_name, instance_type, instance_users, instance_capacity, fill_ratio, familiarity_score, is_quiet_world, recommend_score, rank_in_list, list_count, list_avg_users, list_avg_fill, list_quiet_ratio, world_tags)
     VALUES ($userId, $displayName, $worldId, $worldName, $instanceType, $instanceUsers, $instanceCapacity, $fillRatio, $familiarityScore, $isQuietWorld, $recommendScore, $rank, $listCount, $listAvgUsers, $listAvgFill, $listQuietRatio, $worldTags)`,
    {
      $userId: hit.userId, $displayName: hit.displayName, $worldId: hit.worldId || '',
      $worldName: hit.worldName || '', $instanceType: hit.instanceType || '',
      $instanceUsers: hit.instanceUsers || 0, $instanceCapacity: hit.instanceCapacity || 0,
      $fillRatio: hit.fillRatio || 0, $familiarityScore: (hit.familiarity && hit.familiarity.score) || 0,
      $isQuietWorld: hit.isQuietWorld ? 1 : 0, $recommendScore: hit.recommendScore || 0,
      $rank: rank, $listCount: baseline.list_count, $listAvgUsers: baseline.list_avg_users,
      $listAvgFill: baseline.list_avg_fill, $listQuietRatio: baseline.list_quiet_ratio,
      $worldTags: Array.isArray(hit.worldTags) ? JSON.stringify(hit.worldTags) : '',
    },
  );
  const learning = analyzeJoinLearning();
  return {
    success: true,
    recorded: { userId: hit.userId, displayName: hit.displayName, worldName: hit.worldName, rank },
    learning,
  };
}

export async function handleGetJoinLearning() {
  try {
    const raw = ctx.storage.getConfig('join_learning');
    // 旧缓存可能缺 preferredCrowdRange/worldType 字段——缺则重新分析
    const cached = raw ? JSON.parse(raw) : null;
    const learning = (cached && 'preferredCrowdRange' in cached && 'worldType' in cached) ? cached : analyzeJoinLearning();
    const count = ctx.storage._query('SELECT COUNT(*) AS c FROM join_choices')[0].c;
    return { choicesCount: count, learning };
  } catch (e) {
    return { error: `读取失败: ${e.message}` };
  }
}

export async function handleRecommendJoin({ limit = 10, minScore = 0 } = {}) {
  const { storage, api, rateLimiter } = ctx;
  // 0. 评分上下文（显式偏好 > 自动学习 > 默认，含安静图集合）
  const scoreCtx = buildScoreContext();
  const { CROWD, isExplicitPref, joinPrefs, learning } = scoreCtx;

  // 1. 全部在线好友
  const onlineR = await rateLimiter.execute(() => api._request('GET', '/auth/user/friends?offline=false'));
  if (onlineR.status !== 200) throw new Error(`API error: ${onlineR.status}`);
  const onlineFriends = Array.isArray(onlineR.data) ? onlineR.data : [];

  // 2. 收藏夹分组（权重配置化，共享构建）
  const groupMap = await buildGroupMap();

  // 3. 熟悉度：同屏统计（现成 storage.findCompanions，共享构建）
  const { familiarityScore } = await buildFamiliarityScorer();

  // 4. 逐个好友：世界名 + 实例 + 综合评分
  const worldCache = new Map();
  const instanceInfo = new Map();

  const detailed = [];
  for (const f of onlineFriends) {
    const loc = parseLocation(f.location || 'private');
    if (!loc || loc.type === 'private' || loc.type === 'traveling' ||
        f.location === 'private' || f.location === 'offline' || f.location === 'traveling') continue;

    // 世界名 + 标签（类型偏好学习用）
    let worldName = f.worldId || loc.worldId || '';
    let worldTags = [];
    if (loc.worldId) {
      if (worldCache.has(loc.worldId)) {
        const c = worldCache.get(loc.worldId);
        worldName = c.name; worldTags = c.tags;
      } else {
        const cached = storage.getWorldName(loc.worldId);
        if (cached && cached.name) {
          worldName = cached.name;
          worldTags = Array.isArray(cached.tags) ? cached.tags : (typeof cached.tags === 'string' && cached.tags ? JSON.parse(cached.tags) : []);
        } else {
          const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${loc.worldId}`));
          if (r.status === 200 && r.data && r.data.name) {
            worldName = r.data.name;
            worldTags = Array.isArray(r.data.tags) ? r.data.tags.filter(t => t.startsWith('author_tag_')) : [];
            try { storage.upsertWorld({ worldId: loc.worldId, name: r.data.name, authorId: r.data.authorId || '', authorName: r.data.authorName || '', tags: JSON.stringify(worldTags) }); } catch (e) {}
          }
        }
        worldCache.set(loc.worldId, { name: worldName, tags: worldTags });
      }
    }

    // 实例详情
    let instanceUsers, instanceCapacity, fillRatio;
    if (loc.instanceId && f.location && !f.location.includes('~private')) {
      const instKey = f.location;
      if (!instanceInfo.has(instKey)) {
        try {
          const r = await rateLimiter.execute(() => api._request('GET', `/instances/${instKey}`));
          if (r.status === 200 && r.data) instanceInfo.set(instKey, { nUsers: r.data.n_users || 0, capacity: r.data.capacity || 0 });
          else instanceInfo.set(instKey, null);
        } catch (e) { instanceInfo.set(instKey, null); }
      }
      const inst = instanceInfo.get(instKey);
      if (inst) {
        instanceUsers = inst.nUsers;
        instanceCapacity = inst.capacity;
        fillRatio = inst.capacity > 0 ? +(inst.nUsers / inst.capacity).toFixed(2) : 0;
      }
    }

    // 收藏夹分组 + 熟悉度
    let gName = null, groupWeight = 0, isContact = false;
    for (const [gn, info] of groupMap) {
      if (info.memberIds.has(f.id)) {
        gName = gn; groupWeight = info.weight; isContact = info.isContact;
        break;
      }
    }
    const fam = await familiarityScore(f.id);

    // 综合评分（共享评分系统：熟悉度 + 收藏夹权重 + 安静图场景 + 实例 + 偏好/学习）
    const scored = computeEntryScore(scoreCtx, {
      loc, worldName, worldTags, instanceUsers, fillRatio, status: f.status,
      groupName: gName, groupWeight, isContact, familiarity: fam,
    });
    const { score, reasons, isQuietWorld } = scored;

    detailed.push({
      userId: f.id,
      displayName: f.displayName,
      worldId: loc.worldId,
      worldName,
      worldTags,
      instanceType: loc.type,
      instanceTypeDisplay: loc.type === 'hidden' ? 'friend+' : loc.type,
      instanceUsers, instanceCapacity, fillRatio,
      region: loc.region || '',
      status: f.status,
      isSleepWorld: scored.isSleepWorld,
      isQuietWorld,
      familiarity: fam,
      relation: { group: gName, isContact, note: isContact ? '活动联系人(非好友)' : (gName ? `收藏夹[${gName}]` : '普通好友') },
      recommendScore: score,
      reasons,
    });
  }

  detailed.sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0));
  const filtered = minScore > 0 ? detailed.filter(d => d.recommendScore >= minScore) : detailed;
  // 存推荐快照（record_join_choice 用它补全选择上下文）
  const baseline = computeListBaseline(filtered.slice(0, limit));
  lastRecommendSnapshot = { at: Date.now(), top: filtered.slice(0, limit), baseline };
  return {
    totalOnline: onlineFriends.length,
    joinable: detailed.length,
    top: filtered.slice(0, limit),
    method: 'familiarity+group+scene+instance',
    preference: isExplicitPref ? { crowd: CROWD, label: joinPrefs.label || '' } : null,
    learning: (!isExplicitPref && learning) ? { crowd: learning.crowd, familiarityMult: learning.familiarityMult, quietBias: learning.quietBias, samples: learning.samples } : null,
  };
}
