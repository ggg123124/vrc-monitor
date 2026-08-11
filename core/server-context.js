/**
 * 共享服务上下文 — 所有模块通过此对象访问运行时状态
 *
 * start-monitor.js main() 初始化后赋值各字段；
 * handler / rpc-router / http-server 模块通过 import { ctx } 使用。
 */

export const ctx = {
  storage: null,
  api: null,
  rateLimiter: null,
  wsManager: null,
  eventPipeline: null,
  friendState: null,
  serverState: { started: null, authUser: null, friendCount: 0, needsOtp: false },
  watchlist: { cache: [], dirty: false },
  paths: {
    __dirname: null,
    PORT: 8799,
    COOKIE_FILE: null,
    CRED_FILE: null,
    DB_PATH: null,
    BACKUP_DIR: null,
    BACKUP_INTERVAL_MS: 24 * 60 * 60 * 1000,
  },
};

export function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

export function parseLocation(loc) {
  if (!loc) return null;
  if (loc === 'offline') return { type: 'offline' };
  if (loc === 'traveling') return { type: 'traveling' };
  if (loc === 'private') return { type: 'private' };
  const sep = loc.indexOf(':');
  const worldId = sep >= 0 ? loc.slice(0, sep) : loc;
  const rest = sep >= 0 ? loc.slice(sep + 1) : '';
  const instMatch = rest.match(/^([^~]+)/);
  // 白名单匹配实例类型（~private/hidden/friends/group/public 带 owner 括号）；~region(jp) / ~groupAccessType(x) 是元字段
  const typeMatch = rest.match(/~(private|hidden|friends|group|public)\(([^)]+)\)/);
  // ~local 无括号（VRChat 本地实例格式 `~local`）
  const localMatch = rest.match(/~local\b/);
  const regionMatch = rest.match(/~region\(([^)]+)\)/);
  const gAccessMatch = rest.match(/~groupAccessType\(([^)]+)\)/);
  return {
    // 有 instanceId 但无类型标记 = VRChat 无房主公开实例 → 'public'
    type: typeMatch ? typeMatch[1] : (localMatch ? 'local' : (instMatch ? 'public' : null)),
    ownerId: typeMatch ? typeMatch[2] : null,
    worldId: worldId || null,
    instanceId: instMatch ? instMatch[1] : null,
    region: regionMatch ? regionMatch[1] : null,
    groupAccessType: gAccessMatch ? gAccessMatch[1] : null,
  };
}

export function refreshWatchlistCache() {
  ctx.watchlist.cache = ctx.storage.getWatchlist();
  ctx.watchlist.dirty = false;
}

export function invalidateWatchlistCache() {
  ctx.watchlist.dirty = true;
}
