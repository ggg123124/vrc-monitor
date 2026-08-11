/**
 * 实例 handler — 创建实例 / 自邀请 / 打开世界
 */

import { ctx } from '../server-context.js';
import { openInstance } from '../vrchat-launch.js';

export async function handleCreateInstance({ worldId, type, region, instanceId, groupAccessType }) {
  const { api } = ctx;
  if (!worldId || !String(worldId).startsWith('wrld_')) {
    throw new Error('worldId 必须是 wrld_ 开头（如 wrld_xxxx）');
  }
  const instType = type || 'hidden';
  const body = {
    worldId,
    type: instType,
    region: region || 'jp',
  };
  if (instanceId) body.instanceId = instanceId;
  if (groupAccessType) body.groupAccessType = groupAccessType;
  // 非 public 实例必须显式带 ownerId（=当前用户），否则 API 400 "Invalid owner ID"（2026-08-09 实测）
  if (instType !== 'public') {
    await api.ensureAuth();
    const me = (api.currentUser && api.currentUser.id) || null;
    if (!me) throw new Error('无法获取当前用户 ID，不能创建非公开实例');
    body.ownerId = me;
  }
  const r = await api._request('POST', '/instances', body);
  if (r.status >= 400) {
    throw new Error(`创建实例失败 API ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const d = r.data || {};
  return {
    success: true,
    worldId: d.worldId || worldId,
    type: d.type || body.type,
    region: d.region || body.region,
    instanceId: d.instanceId || d.id || null,
    location: d.location || null,
    shortName: d.shortName || null,
    capacity: d.capacity || null,
  };
}

export async function handleInviteMyself({ location, worldId, instanceId, forceApi }) {
  const { api } = ctx;
  // 统一入口（与 open_world 同一套）：管道直发优先（游戏内静默弹加入菜单），
  // 管道不可用/非 Windows 时静默回退 API 自我邀请（客户端收到通知接受后传送）
  let loc = location;
  if (loc && typeof loc === 'string') {
    const idx = loc.indexOf(':');
    if (idx <= 0) throw new Error('location 格式应为 worldId:instanceId（如 wrld_x:12345~hidden(usr_x)~region(jp)）');
    if (!String(loc).startsWith('wrld_')) throw new Error('location 必须是 wrld_ 开头的完整实例串');
  } else {
    if (!worldId || !String(worldId).startsWith('wrld_')) throw new Error('worldId 必须是 wrld_ 开头');
    if (!instanceId) throw new Error('instanceId 不能为空（可用 create_instance 返回的 location）');
    loc = `${worldId}:${instanceId}`;
  }
  const res = await openInstance({ location: loc, api, forceApi: !!forceApi });
  if (!res.success) throw new Error(res.error || '邀请自己失败');
  const wId = loc.slice(0, loc.indexOf(':'));
  const iId = loc.slice(loc.indexOf(':') + 1);
  return {
    success: true,
    method: res.method,
    worldId: wId,
    instanceId: iId,
    notificationId: res.notificationId || null,
    notificationType: null,
    detail: res.detail || null,
  };
}

export async function handleOpenWorld({ worldId, location, type, region, shortName, forceApi }) {
  const { api } = ctx;
  // 1) 定位目标实例：直接给 location 就用它；只给 worldId 就先建实例（复用 handleCreateInstance）
  let loc = location;
  let sn = shortName || null;
  if (!loc || typeof loc !== 'string') {
    if (!worldId || !String(worldId).startsWith('wrld_')) {
      throw new Error('需要 worldId（wrld_ 开头，自动建实例后打开）或 location（完整实例串直接打开）');
    }
    const inst = await handleCreateInstance({ worldId, type, region });
    if (!inst.location) throw new Error('创建实例成功但未返回 location，无法打开');
    loc = inst.location;
    sn = sn || inst.shortName || null;
  } else if (!String(loc).startsWith('wrld_')) {
    throw new Error('location 必须是 wrld_ 开头的完整实例串（如 wrld_x:12345~hidden(usr_x)~region(jp)）');
  }
  // 2) 统一入口：管道直发（静默弹窗）→ 探测失败静默回退 API 自我邀请
  const res = await openInstance({ location: loc, shortName: sn, api, forceApi: !!forceApi });
  if (!res.success) throw new Error(res.error || '打开实例失败');
  return {
    success: true,
    method: res.method,
    location: loc,
    shortName: sn,
    notificationId: res.notificationId || null,
    detail: res.detail || null,
  };
}
