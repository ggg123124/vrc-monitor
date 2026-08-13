/**
 * PlanetVRC (planetvrchat.net) — VRChat 世界检索/推荐数据源
 *
 * PlanetVRC 是 WordPress 站 (VK Filter Search 插件), 无公开 API, 通过抓取 HTML 工作:
 *   - 关键词搜索:   /?s=<query>&vkfs_submitted=1
 *   - 热度排序:     /?s=&vkfs_orderby=custom-field.visits.desc.NUMERIC&vkfs_submitted=1
 *   - 最新发布:     /?s=&vkfs_orderby=custom-field.world_published.desc.DATE&vkfs_submitted=1
 *   - 最新更新:     /?s=&vkfs_orderby=custom-field.world_updated.desc.DATE&vkfs_submitted=1
 *   - 世界详情页:   /archives/{postId}  (含 wrld_ ID/最大人数/总访问者/收藏/公开日)
 * 列表卡片不含 wrld_ ID, 需对 Top N 抓详情页补充(串行, 每次约 1-2s)。
 */

import { ctx, log } from '../server-context.js';

const BASE = 'https://planetvrchat.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ORDERBY = {
  popular: 'custom-field.visits.desc.NUMERIC', // 访问者数 多
  new: 'custom-field.world_published.desc.DATE', // ワールド公開日 新しい
  updated: 'custom-field.world_updated.desc.DATE', // ワールド更新日 新しい
};

/** 抓取 HTML (15s 超时, 浏览器 UA) */
async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 解析列表页结果卡片 */
function parseCards(html) {
  const cards = [];
  // 按 <article ... post-{id} ...> 块切分
  const articleRe = /<article\s+class="[^"]*post-(\d+)[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = articleRe.exec(html))) {
    const postId = m[1];
    const block = m[2];
    const link = block.match(/href="https:\/\/planetvrchat\.net\/archives\/\d+"/);
    const title = block.match(/rel="bookmark"\s+title="([^"]*)"\s+class="post-list__link"/) ||
      block.match(/class="h2 entry-title">([^<]*)</);
    if (!link || !title) continue;
    const platform = block.match(/pvrc-world-platform-badge"[^>]*aria-label="([^"]*)"/);
    const cats = [...block.matchAll(/archive-taxonomy-chip--category">([^<]*)<\/span>/g)].map((x) => x[1]);
    const tagsBlock = block.match(/<\/span>\s*([^<]+)\s*<\/small>/);
    const tags = tagsBlock ? tagsBlock[1].trim().split(/\s+/).filter(Boolean) : [];
    const img = block.match(/src="([^"]*thumb[^"]*\.(?:webp|png|jpg))"/);
    cards.push({
      postId,
      name: decodeEntities(title[1] || title[2] || '').trim(),
      url: link[0].replace(/href="|"/g, ''),
      platform: platform ? decodeEntities(platform[1]) : '',
      categories: cats.map((c) => decodeEntities(c)),
      tags: tags.map((t) => decodeEntities(t)).slice(0, 8),
      image: img ? img[1] : '',
      wrldId: null,
      maxPlayers: null,
      visitors: null,
      favorites: null,
      publishedAt: null,
    });
  }
  return cards;
}

/** 解析世界详情页 (wrld_ ID / 最大人数 / 总访问者 / 收藏 / 公开日) */
function parseDetail(html) {
  const d = {};
  // HTML 标签可能穿插在文字间 (如 総訪問者 <span>146,375</span>), (?:<[^>]+>\s*)* 容忍
  const wid = html.match(/wrld_[a-f0-9-]{36}/);
  if (wid) d.wrldId = wid[0];
  const maxP = html.match(/最大人数(?:<[^>]+>\s*)*([\d,]+)\s*人/);
  if (maxP) d.maxPlayers = parseInt(maxP[1].replace(/,/g, ''), 10);
  const vis = html.match(/総訪問者(?:<[^>]+>\s*)*([\d,]+)/);
  if (vis) d.visitors = parseInt(vis[1].replace(/,/g, ''), 10);
  const fav = html.match(/⭐\s*(?:<[^>]+>\s*)*お気に入り(?:<[^>]+>\s*)*([\d,]+)/);
  if (fav) d.favorites = parseInt(fav[1].replace(/,/g, ''), 10);
  const pub = html.match(/公開日(?:<[^>]+>\s*)*(\d{4}-\d{2}-\d{2})/);
  if (pub) d.publishedAt = pub[1];
  return d;
}

/** 抓取 Top N 详情补充 wrld_ ID 等字段 (串行, 单卡失败不影响整体) */
async function enrich(cards, limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 8);
  for (const c of cards.slice(0, n)) {
    try {
      const html = await fetchHtml(c.url);
      Object.assign(c, parseDetail(html));
    } catch (e) {
      log(`PlanetVRC 详情失败 ${c.postId}: ${e.message}`);
    }
  }
  return cards;
}

/** 公共: 按 query 参数抓列表, 只返回前 limit 张卡 */
async function fetchCards(queryParams, limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 8);
  const qs = new URLSearchParams({ s: '', vkfs_submitted: '1', ...queryParams }).toString();
  const html = await fetchHtml(`${BASE}/?${qs}`);
  const cards = parseCards(html);
  if (!cards.length) throw new Error('PlanetVRC 无结果');
  await enrich(cards, n);
  return cards.slice(0, n);
}

function decodeEntities(s) {
  return s
    .replace(/&#8211;/g, '–').replace(/&#8220;/g, '“').replace(/&#8221;/g, '”')
    .replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘').replace(/&#8230;/g, '…')
    .replace(/&amp;/g, '&').replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** MCP: 关键词搜索 PlanetVRC */
export async function handleSearchPlanetWorlds({ query, limit = 5 }) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query is required');
  log(`PlanetVRC 搜索: ${q}`);
  const cards = await fetchCards({ s: q }, limit);
  return {
    source: 'planetvrchat.net',
    query: q,
    count: cards.length,
    worlds: cards,
  };
}

/** MCP: PlanetVRC 推荐排行 (热度/最新发布/最新更新) */
export async function handleRecommendPlanetWorlds({ sort = 'popular', limit = 5 }) {
  const key = ORDERBY[sort] ? sort : 'popular';
  log(`PlanetVRC 推荐: ${key}`);
  const cards = await fetchCards({ vkfs_orderby: ORDERBY[key] }, limit);
  return {
    source: 'planetvrchat.net',
    sort: key,
    count: cards.length,
    worlds: cards,
  };
}

// 保留引用, 便于将来复用
void ctx;
