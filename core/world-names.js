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

  for (const wid of worldIds) {
    if (!wid) continue;
    // 负缓存命中：已知失败，直接兜底，不重试
    if (negativeCache.has(wid) && negativeCache.get(wid) > Date.now()) {
      result.set(wid, onFail(wid));
      continue;
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
