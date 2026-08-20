/**
 * 世界名批量解析公共工具 — 统一「缓存 → API → 写回 → 失败负缓存」流程
 *
 * 解决多 handler 重复实现世界名解析的问题（friends.js / events.js 周报 / recommend.js 等）：
 * - 本地 world_cache 命中直接返回；
 * - 缺失的世界串行调 /worlds/{id}（带 throttleMs 节流），成功写回 world_cache；
 * - 失败写进程内负缓存（带 TTL），避免高频工具（如 get_online_friends）每次调用
 *   都对同一失败 worldId 重发 API、浪费配额（PR #36 W3）。
 *
 * 进程内负缓存（非持久化）：服务重启即清空，属可接受——重启后重新解析是合理的。
 * 所有 API 请求只串行 + 节流，不在本模块内再包 rateLimiter（外层 handler 已按调用级限流）。
 */

/** 进程内负缓存：Map<worldId, expiresAt> */
const negativeCache = new Map();
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // 5 分钟
// 定期清理过期条目，防止长期运行下失败 worldId 无限累积
const NEGATIVE_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 与 TTL 同频即可

/**
 * 移除所有已过期的负缓存条目。
 * 仅在读取与定期清理时惰性调用，避免每次判断都扫描全表。
 */
function pruneNegativeCache(now = Date.now()) {
  for (const [wid, expiresAt] of negativeCache) {
    if (expiresAt <= now) negativeCache.delete(wid);
  }
}

// 惰性定期清理：防止失败 worldId 条目长期累积（PR #64 review 建议）。
// 定时器不 keep 进程存活（.unref），服务退出即自然丢弃。
setInterval(() => pruneNegativeCache(), NEGATIVE_PRUNE_INTERVAL_MS).unref();

/**
 * 批量解析世界名。
 * @param {object} ctx 服务上下文（storage / api）
 * @param {Array<string>} worldIds 世界 ID 列表
 * @param {object} [opts]
 * @param {number} [opts.throttleMs=300] 缺失世界串行 API 查询之间的最小间隔
 * @param {(wid:string)=>string} [opts.nameOf] 从 API 返回对象提取世界名的函数，默认取 w.name
 * @param {(wid:string, fallback:string)=>string} [opts.onFail] 失败时的兜底值（默认返回 wid）
 * @returns {Promise<Map<string,string>>} worldId -> 世界名（失败为 onFail 兜底值）
 */
export async function resolveWorldNames(ctx, worldIds, opts = {}) {
  const { storage, api } = ctx;
  const { throttleMs = 300, nameOf = (w) => w?.name || '', onFail = (wid) => wid } = opts;

  const result = new Map();
  const missing = [];

  const now = Date.now();
  for (const wid of worldIds) {
    if (!wid) continue;
    // 负缓存命中：已知失败，直接兜底，不重试；过期条目惰性移除，避免累积
    const expiresAt = negativeCache.get(wid);
    if (expiresAt !== undefined) {
      if (expiresAt > now) {
        result.set(wid, onFail(wid));
        continue;
      }
      negativeCache.delete(wid);
    }
    const cached = storage.getWorldName(wid);
    if (cached && cached.name) {
      result.set(wid, cached.name);
    } else {
      missing.push(wid);
    }
  }

  for (const wid of missing) {
    await new Promise((r) => setTimeout(r, throttleMs));
    try {
      const r = await api._request('GET', `/worlds/${wid}`);
      if (r.status === 200 && r.data) {
        const name = nameOf(r.data);
        result.set(wid, name);
        try {
          storage.upsertWorld({
            worldId: r.data.id || wid,
            name,
            authorId: r.data.authorId || '',
            authorName: r.data.authorName || '',
            capacity: r.data.capacity || 0,
            favorites: r.data.favorites || 0,
            releaseStatus: r.data.releaseStatus || '',
            tags: r.data.tags || [],
            description: r.data.description || '',
            imageUrl: r.data.imageUrl || '',
          });
        } catch { /* 写回失败不阻断 */ }
      } else {
        negativeCache.set(wid, Date.now() + NEGATIVE_TTL_MS);
        result.set(wid, onFail(wid));
      }
    } catch {
      negativeCache.set(wid, Date.now() + NEGATIVE_TTL_MS);
      result.set(wid, onFail(wid));
    }
  }

  return result;
}

/**
 * 解析单个世界名（便捷包装）。
 * @returns {Promise<string>} 世界名或兜底值
 */
export async function resolveWorldName(ctx, worldId, opts = {}) {
  if (!worldId) return '';
  const map = await resolveWorldNames(ctx, [worldId], opts);
  return map.get(worldId) || '';
}

export default { resolveWorldNames, resolveWorldName };
