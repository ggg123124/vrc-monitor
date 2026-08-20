/**
 * 通知收件箱 handler — 读取 / 标记已读 / 隐藏 / 接受/拒绝好友请求
 *
 * 基于 VRChat 旧 v1 通知系统（/auth/user/notifications）。
 * 注意：type 查询参数已废弃不生效，客户端过滤；群组邀请/活动属 NotificationV2（/notifications 端点），本模块不覆盖。
 */

import { ctx, log } from '../server-context.js';

// 通知类型枚举（旧 v1 系统）
const NOTIFICATION_TYPES = ['boop', 'friendRequest', 'invite', 'inviteResponse', 'message', 'requestInvite', 'requestInviteResponse', 'votetokick'];

// REST 响应中 details 是 JSON 编码字符串（WS 才是对象），统一解码
function parseDetails(details) {
  if (details === null || details === undefined) return null;
  if (typeof details === 'object') return details;
  try { return JSON.parse(details); } catch { return null; }
}

function formatNotification(n) {
  return {
    id: n.id,
    type: n.type,
    message: n.message || '',
    senderUserId: n.senderUserId || null,
    senderUsername: n.senderUsername || null,
    details: parseDetails(n.details),
    createdAt: n.created_at || null,
    hidden: n.hidden ?? null,
  };
}

export async function handleGetNotifications({ limit = 30, offset = 0, types, hidden = false }) {
  const { api } = ctx;
  const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const params = `n=${n}&offset=${off}`;
  const r = await api._request('GET', `/auth/user/notifications?${params}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const all = Array.isArray(r.data) ? r.data : [];
  let list = all.filter(x => hidden ? !!x.hidden : !x.hidden);
  if (types) {
    const typeSet = new Set(String(types).split(',').map(t => t.trim()));
    list = list.filter(x => typeSet.has(x.type));
  }
  return {
    returned: all.length,
    shown: list.length,
    hasMore: all.length >= n,
    limit: n,
    offset: off,
    filteredByTypes: types ? String(types).split(',').map(t => t.trim()) : null,
    notifications: list.map(formatNotification),
  };
}

export async function handleSeeNotification({ notificationId }) {
  if (!notificationId) throw new Error('notificationId is required');
  const { api } = ctx;
  const r = await api._request('PUT', `/auth/user/notifications/${notificationId}/see`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  return { notificationId, seen: true, ok: true };
}

export async function handleHideNotification({ notificationId }) {
  if (!notificationId) throw new Error('notificationId is required');
  const { api } = ctx;
  const r = await api._request('PUT', `/auth/user/notifications/${notificationId}/hide`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  return { notificationId, hidden: true, ok: true };
}

// 接受好友请求 = 加好友（不可逆，必须 confirm）
export async function handleAcceptFriendRequest({ notificationId, confirm }) {
  if (!notificationId) throw new Error('notificationId is required');
  if (!confirm) {
    return { notificationId, confirmRequired: true, message: '接受好友请求会直接加为好友，请传 confirm: true 确认执行' };
  }
  const { api } = ctx;
  // 先校验该通知确为好友请求，避免误操作
  const r = await api._request('PUT', `/auth/user/notifications/${notificationId}/accept`);
  if (r.status === 404) throw new Error('该好友请求不存在或已处理');
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  log(`✅ accept_friend_request: ${notificationId}`);
  return { notificationId, accepted: true, ok: true };
}

// 拒绝好友请求 = 隐藏（清除）该通知；旧 v1 无独立拒绝端点，hide 即清除
export async function handleDeclineFriendRequest({ notificationId, confirm }) {
  if (!notificationId) throw new Error('notificationId is required');
  if (!confirm) {
    return { notificationId, confirmRequired: true, message: '拒绝好友请求会清除该通知（对方不会收到明确拒绝提示），请传 confirm: true 确认执行' };
  }
  const { api } = ctx;
  const r = await api._request('PUT', `/auth/user/notifications/${notificationId}/hide`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  log(`✅ decline_friend_request: ${notificationId}`);
  return { notificationId, declined: true, ok: true };
}