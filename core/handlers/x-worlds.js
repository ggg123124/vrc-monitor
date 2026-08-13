/**
 * X 博主世界推荐 handler — x_world_digest / x_add_creator / x_remove_creator / x_scan_creators / x_creators
 */

import { ctx, log } from '../server-context.js';
import {
  getCreators, addCreator, removeCreator,
  scanCreatorWorlds, getWorldDigest,
} from '../fetch-x-worlds.js';

/** 聚合查询：按时间窗口输出博主推荐的世界，按收藏排序，收藏/浏览比≥1/5 标注 */
export async function handleXWorldDigest({ days = 7, highlightRatio = 0.2, limit = 50, creator, refresh = false } = {}) {
  if (refresh) {
    await scanCreatorWorlds();
  }
  return getWorldDigest({ days, highlightRatio, limit, creator });
}

/** 立即抓取所有博主的最新推文并入库 */
export async function handleXScanCreators() {
  return scanCreatorWorlds();
}

/** 列出已配置博主 */
export function handleXCreators() {
  const { storage } = ctx;
  return { creators: getCreators(storage) };
}

/** 添加博主 */
export function handleXAddCreator({ screen_name, name } = {}) {
  const { storage } = ctx;
  const result = addCreator(storage, { screen_name, name });
  log(`➕ x-creator added: ${screen_name} (${name || ''})`);
  return result;
}

/** 移除博主 */
export function handleXRemoveCreator({ screen_name } = {}) {
  const { storage } = ctx;
  const result = removeCreator(storage, screen_name || '');
  if (result.removed) log(`➖ x-creator removed: ${screen_name}`);
  return result;
}

/** 查看已收录世界（调试用） */
export function handleXWorlds({ limit = 50 } = {}) {
  const { storage } = ctx;
  const rows = storage.getAllXWorlds(limit);
  return {
    total: rows.length,
    worlds: rows.map(r => ({
      worldId: r.world_id,
      worldName: r.world_name,
      authorName: r.author_name,
      favorites: r.favorites,
      visits: r.visits,
      popularity: r.popularity,
      lastRecommendedAt: r.last_recommended_at,
      tweetCount: r.tweet_count,
    })),
  };
}
