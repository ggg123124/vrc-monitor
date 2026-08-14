/**
 * X 博主世界推荐抓取模块（x_world_digest 工具的数据源）
 *
 * 数据流：
 *   1. 从 config 表读取博主清单（key='x_creators'，JSON 数组）
 *   2. 逐个抓取 Nitter RSS（https://nitter.net/{user}/rss，免费匿名，无需 X API）
 *   3. 解析推文：时间、文本、世界链接（vrchat.com/home/world/wrld_xxx）
 *   4. 从推文文本提取世界名（"World: XXX" / "ワールド名: XXX" 模式）→ VRChat API 搜索兜底
 *   5. 查询世界详情（favorites / visits / popularity）→ 写入 x_world_recommendations 表
 *
 * 用途：x_world_digest MCP 工具按 1/3/7/15/30 天窗口聚合博主推荐，按收藏排序输出。
 */

import { ctx, log } from './server-context.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Nitter 实例列表（按可达性排序，逐个尝试回退）
const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.tiekoetter.com',
  'https://xcancel.com',
  'https://nitter.1d4.us',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const NITTER_TIMEOUT_MS = 12000;   // 单实例超时（短，便于快速回退）
const NITTER_MIN_BYTES = 200;      // 空壳检测：响应体小于此字节视为不可用
const MAX_TWEETS_PER_CREATOR = 20; // Nitter RSS 固定返回最近 ~20 条

// 代理：复用 ws-manager.js 的 HttpsProxyAgent 方案（默认 127.0.0.1:7892，兼容 ws 代理）
function resolveProxy() {
  const env = process.env;
  return env.VRC_MONITOR_HTTP_PROXY || env.HTTPS_PROXY || env.https_proxy
    || env.HTTP_PROXY || env.http_proxy || 'http://127.0.0.1:7892';
}

function buildFetchOptions() {
  const opts = {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'Accept-Encoding': 'gzip, deflate',
    },
    // 显式禁用压缩以规避空壳（部分实例对 gzip 返回 0 字节）
    compress: false,
  };
  // 尝试走代理（与 ws-manager.js 一致）；若代理不可达则回退直连
  try {
    const proxy = resolveProxy();
    if (proxy) opts.agent = new HttpsProxyAgent(proxy);
  } catch { /* 代理构造失败则直连 */ }
  return opts;
}

/**
 * 抓取某博主的 Nitter RSS，返回推文数组：
 * [{ id, url, time (ISO), text, worldIds: [], worldNames: [] }]
 *
 * 多实例回退：依次尝试 NITTER_INSTANCES，任一实例返回非空 RSS 即成功；
 * 全部失败时返回结构化错误（含可达性诊断），不裸抛。
 */
export async function fetchCreatorRss(screenName) {
  const errors = [];
  for (const base of NITTER_INSTANCES) {
    const url = `${base}/${encodeURIComponent(screenName)}/rss`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NITTER_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { ...buildFetchOptions(), signal: ctrl.signal });
      if (!resp.ok) {
        errors.push(`${base} → HTTP ${resp.status}`);
        clearTimeout(timer);
        continue;
      }
      const xml = await resp.text();
      clearTimeout(timer);
      // 空壳检测：内容过短视为不可用（实测部分实例返回 200 但 0 字节）
      if (!xml || xml.length < NITTER_MIN_BYTES || !xml.includes('<rss')) {
        errors.push(`${base} → 空响应(${xml?.length || 0}B)`);
        continue;
      }
      const tweets = parseRss(xml, screenName);
      if (tweets.length === 0) {
        errors.push(`${base} → RSS 无推文条目`);
        continue;
      }
      return tweets; // 首个可用实例
    } catch (e) {
      clearTimeout(timer);
      errors.push(`${base} → ${e.name === 'AbortError' ? '超时' : e.message.split('\n')[0]}`);
    }
  }
  // 全部失败：结构化错误（供 handler 转成用户可读提示）
  const err = new Error(`Nitter 全部实例不可达（@${screenName}）：${errors.join('；')}。可能需要代理（HTTPS_PROXY）或更换网络。`);
  err.code = 'NITTER_UNREACHABLE';
  err.details = errors;
  throw err;
}

// ── 博主清单 ──────────────────────────────────────────────

export function getCreators(storage) {
  const raw = storage.getConfig('x_creators');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function setCreators(storage, creators) {
  storage.setConfig('x_creators', JSON.stringify(creators));
}

/**
 * 添加博主（upsert）。entry: { screen_name, name? }
 */
export function addCreator(storage, entry) {
  const creators = getCreators(storage);
  const screen = (entry.screen_name || '').replace(/^@/, '').trim();
  if (!screen) throw new Error('screen_name is required');
  const existing = creators.find(c => c.screen_name === screen);
  if (existing) {
    if (entry.name) existing.name = entry.name;
    return { added: false, creators: getCreators(storage) };
  }
  creators.push({ screen_name: screen, name: entry.name || screen });
  setCreators(storage, creators);
  return { added: true, creators: getCreators(storage) };
}

export function removeCreator(storage, screenName) {
  const creators = getCreators(storage);
  const screen = (screenName || '').replace(/^@/, '').trim();
  const next = creators.filter(c => c.screen_name !== screen);
  if (next.length === creators.length) {
    return { removed: false, creators: getCreators(storage) };
  }
  setCreators(storage, next);
  return { removed: true, creators: next };
}

// ── Nitter RSS 抓取（多实例回退 + 代理支持，见上方 fetchCreatorRss） ──

/**
 * 解析 Nitter RSS XML → 推文数组
 */
export function parseRss(xml, screenName) {
  const tweets = [];
  // 提取 <item> 块
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, 'title') || '';
    const link = extractTag(block, 'link') || '';
    const pubDate = extractTag(block, 'pubDate') || '';
    const desc = extractTag(block, 'description') || '';

    const tweetIdMatch = link.match(/\/status\/(\d+)/);
    const tweetId = tweetIdMatch ? tweetIdMatch[1] : '';
    const time = pubDate ? new Date(pubDate).toISOString() : null;

    // 合并 title + description 提取世界链接（Nitter 的 description 含完整链接）
    const fullText = `${title} ${stripHtml(desc)}`;

    // 世界链接：vrchat.com/home/world/wrld_xxx 或 vrchat.com/home/launch?worldId=wrld_xxx
    const worldIds = [...new Set(
      [
        ...fullText.matchAll(/vrchat\.com\/home\/world\/(wrld_[0-9a-f-]+)/gi),
        ...fullText.matchAll(/vrchat\.com\/home\/launch\?[^"'\s]*worldId=([0-9a-f-]+)/gi),
        ...fullText.matchAll(/vrchat\.com\/home\/launch\?worldId=wrld_([0-9a-f-]+)/gi),
      ].map(x => {
        // 归一化：带 wrld_ 前缀的直接用；launch 里可能带或不带前缀
        const raw = x[1];
        return raw.startsWith('wrld_') ? raw : `wrld_${raw}`;
      })
    )];

    // 世界名（多格式兼容）：
    //   "World: XXX" / "ワールド：XXX" / "World name: XXX" / "World：XXX"
    // 名字在 By:/Platform:/换行/# 处截断，避免吞掉作者和描述
    const worldNames = [];
    const nameRe = /(?:World(?:\s*name)?|ワールド)\s*[:：]\s*([^\n#|]{2,80}?)(?=\s*(?:By|by|作者|Platform|プラットフォーム)[:：]|\n|#|\||$)/gi;
    let nm;
    while ((nm = nameRe.exec(fullText)) !== null) {
      const name = nm[1].replace(/https?:\/\/\S+/g, '').trim().replace(/[|｜].*$/, '').trim();
      if (name && !worldNames.includes(name)) worldNames.push(name);
    }

    // 作者名提取（By: XXX，到 Platform/#/换行/描述边界截断）
    // 用于搜索辅助匹配，防止"名字包含"误报（如 NOIR → Noir - Nocturne）
    const authorName = extractAuthor(fullText);

    // 三行格式（八谷凛奈等）："世界名\n作者名\n-- 描述" 或 "世界名 作者名 -- 描述"
    // 且文本带 #VRChat_world紹介
    const looksLikeWorldIntro = /#VRChat_world紹介|#VRChat_world紹介|ワールド紹介|World.*紹介/i.test(fullText);
    if (looksLikeWorldIntro && worldNames.length === 0 && worldIds.length === 0) {
      // 优先同行式 "名称 作者 -- 描述"（Nitter 标题行，最可靠）
      // 其次换行分隔三行式（desc 的 <br> 换行）
      const inline = fullText.match(/([^\n#|]{2,60}?)\s+([A-Za-z0-9_\-\.]{2,40})\s+--\s+/);
      const threeLine = !inline
        ? fullText.match(/([^\n]{2,60})\n\s*([A-Za-z0-9_\-\.]{2,40})\n\s*--/)
        : null;
      const matched = inline || threeLine;
      if (matched) {
        const wName = matched[1].trim();
        if (wName && !/[#|]/.test(wName) && !/^RT\b/.test(wName)) {
          worldNames.push(wName);
        }
      }
    }

    tweets.push({
      id: tweetId,
      url: link,
      time,
      text: title,
      worldIds,
      worldNames,
      authorName,
    });
  }
  return tweets;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeXml(m[1]) : '';
}

function stripHtml(s) {
  // 块级标签保留换行（<br>、</p>、</blockquote>、<hr>），其余标签清掉
  // <a href="..."> 保留完整 URL（显示文本可能被截断，如 vrchat.com/home/launch?world…）
  return s
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>/gi, '$1 ')
    .replace(/<a\s+[^>]*href='([^']+)'[^>]*>/gi, '$1 ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|blockquote|div|li)>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * 名称归一化：小写、去空格/全角空格、去零宽字符，用于匹配比较
 */
function normalizeName(s) {
  return (s || '').toLowerCase().replace(/[\s\u3000\u200b-\u200d\ufeff]+/g, '').trim();
}

/**
 * 从推文文本提取作者名（By: XXX 格式）。
 * 截断边界：Platform/プラットフォーム/#/换行/竖线/行尾。
 * 注意：无 Platform 分隔的格式（如 "World:X By:Y 描述..."）作者后紧跟描述，
 * 此时可能带出描述开头——但这类推文通常有链接（走 worldIds 路径），
 * 只有名字搜索的推文（Bradlee101 格式）都有 Platform 分隔，提取准确。
 */
function extractAuthor(text) {
  const m = text.match(/(?:^|\s)By\s*[:：]\s*([^\n#|]{2,40}?)(?=\s*(?:Platform|プラットフォーム)[:：]?|\n|#|\||$)/i);
  return m ? m[1].trim() : '';
}

// ── 世界数据查询 ───────────────────────────────────────────

/**
 * 查世界详情（VRChat API），带限流。返回完整统计字段或 null。
 * worldId 或 worldName 二选一（worldName 走搜索，取第一个结果）。
 */
export async function fetchWorldStats(api, rateLimiter, { worldId, worldName, authorName }) {
  try {
    if (worldId) {
      return await fetchWorldDetail(api, rateLimiter, worldId);
    }
    if (worldName) {
      // 搜索兜底：按名字查世界，拿到 worldId 后再查详情（搜索端点不含 visits）
      const r = await rateLimiter.execute(() => api._request('GET', `/worlds?search=${encodeURIComponent(worldName)}&n=10`));
      if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) {
        // 匹配策略（VRChat 搜索对中日文/短名匹配极差，需多重校验防误报）：
        // 1. 作者名强过滤：若推文带 By: 作者，结果作者必须匹配（归一化忽略大小写/空格）
        // 2. 名字精确匹配优先，其次包含匹配
        // 3. 无匹配返回 null（宁可漏抓，不可错记）
        const target = normalizeName(worldName);
        const targetAuthor = authorName ? normalizeName(authorName) : '';
        let exact = null;    // 名字精确匹配
        let inclAuthor = null; // 名字包含且作者匹配
        let incl = null;     // 名字包含（无作者约束）

        for (const w of r.data) {
          const wname = normalizeName(w.name || '');
          const wauthor = normalizeName(w.authorName || '');
          const nameMatch = wname === target;
          const containsMatch = wname.includes(target) || target.includes(wname);
          const authorMatch = targetAuthor && (wauthor === targetAuthor || wauthor.includes(targetAuthor) || targetAuthor.includes(wauthor));

          if (nameMatch && (!targetAuthor || authorMatch)) { exact = w; break; }
          if (!exact && containsMatch && (!targetAuthor || authorMatch)) inclAuthor = w;
          // 无作者约束时才用纯包含兜底（有作者名时必须作者匹配，防误报）
          if (!exact && !inclAuthor && containsMatch && !targetAuthor) incl = w;
        }

        const first = exact || inclAuthor || incl || null;
        if (!first) {
          // 名字搜索失败且有作者名 → 用 userId 参数精确搜该作者的世界
          // （VRChat 搜索对短名/新世界常搜不到，userId 过滤能直达作者作品）
          if (targetAuthor) {
            return await fetchWorldByAuthor(api, rateLimiter, worldName, authorName);
          }
          return null;
        }
        // 搜索响应若已含 visits 直接映射，否则补查详情
        if (first && typeof first.visits === 'number') {
          return mapWorld(first);
        }
        if (first && first.id) {
          return await fetchWorldDetail(api, rateLimiter, first.id);
        }
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 查世界详情端点（含完整统计：favorites/visits/popularity） */
async function fetchWorldDetail(api, rateLimiter, worldId) {
  const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${encodeURIComponent(worldId)}`));
  if (r.status === 200 && r.data) return mapWorld(r.data);
  return null;
}

/**
 * 按作者名搜世界：先查作者的 userId，再带 userId 参数搜世界。
 * 用于名字搜索失败时（VRChat 搜索对短名/新世界常搜不到）。
 */
async function fetchWorldByAuthor(api, rateLimiter, worldName, authorName) {
  try {
    // 1) 搜作者 userId（取第一个精确匹配）
    const ur = await rateLimiter.execute(() => api._request('GET', `/users?search=${encodeURIComponent(authorName)}&n=5`));
    if (ur.status !== 200 || !Array.isArray(ur.data) || ur.data.length === 0) return null;
    const target = normalizeName(authorName);
    let user = null;
    for (const u of ur.data) {
      if (normalizeName(u.displayName || '') === target) { user = u; break; }
    }
    if (!user) user = ur.data[0];
    if (!user?.id) return null;

    // 2) 带 userId 搜该作者的世界
    const wr = await rateLimiter.execute(() => api._request('GET', `/worlds?search=${encodeURIComponent(worldName)}&userId=${encodeURIComponent(user.id)}&n=10`));
    if (wr.status === 200 && Array.isArray(wr.data) && wr.data.length > 0) {
      // 名字匹配（作者已被 userId 过滤）
      const targetName = normalizeName(worldName);
      let best = null;
      for (const w of wr.data) {
        const wname = normalizeName(w.name || '');
        if (wname === targetName) { best = w; break; }
        if (!best && (wname.includes(targetName) || targetName.includes(wname))) best = w;
      }
      if (best) {
        if (typeof best.visits === 'number') return mapWorld(best);
        if (best.id) return await fetchWorldDetail(api, rateLimiter, best.id);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function mapWorld(w) {
  return {
    worldId: w.id,
    worldName: w.name,
    authorName: w.authorName || '',
    description: (w.description || '').slice(0, 500),
    imageUrl: w.imageUrl || '',
    favorites: w.favorites || 0,
    visits: w.visits || 0,
    popularity: w.popularity || 0,
    capacity: w.capacity || 0,
    tags: Array.isArray(w.tags) ? w.tags : [],
  };
}

// ── 扫描主流程 ─────────────────────────────────────────────

/**
 * 抓取所有博主的最新推文 → 提取世界 → 查询统计 → 写入数据库。
 * 返回本次扫描摘要。
 */
export async function scanCreatorWorlds({ force = false } = {}) {
  const { storage, api, rateLimiter } = ctx;
  const creators = getCreators(storage);
  if (creators.length === 0) {
    return { scanned: 0, tweets: 0, worlds: 0, creators: [], message: '未配置博主，请先用 x_add_creator 添加' };
  }

  const results = [];
  let totalTweets = 0;
  let totalWorlds = 0;

  for (const creator of creators) {
    const screen = creator.screen_name;
    try {
      const tweets = await fetchCreatorRss(screen);
      totalTweets += tweets.length;

      // 收集该博主推荐的世界（按推文时间去重，跨推文合并）
      const seenWorlds = new Map(); // worldId -> {tweetId, tweetTime, tweetUrl}
      const pendingByName = [];     // 只有名字的世界

      for (const t of tweets) {
        for (const wid of t.worldIds) {
          if (!seenWorlds.has(wid)) {
            seenWorlds.set(wid, { tweetId: t.id, tweetTime: t.time, tweetUrl: t.url });
          }
        }
        for (const name of t.worldNames) {
          if (t.worldIds.length === 0) {
            pendingByName.push({ name, authorName: t.authorName, tweetId: t.id, tweetTime: t.time, tweetUrl: t.url });
          }
        }
      }

      let saved = 0;
      // 1) 有链接的世界
      for (const [wid, info] of seenWorlds) {
        const stats = await fetchWorldStats(api, rateLimiter, { worldId: wid });
        if (stats) {
          saveRecommendation(storage, creator, stats, info);
          saved++;
        }
      }
      // 2) 只有名字的（搜索兜底，带作者名辅助匹配）
      for (const item of pendingByName) {
        const stats = await fetchWorldStats(api, rateLimiter, { worldName: item.name, authorName: item.authorName });
        if (stats) {
          saveRecommendation(storage, creator, stats, item);
          saved++;
        }
      }
      totalWorlds += saved;
      results.push({ screen_name: screen, name: creator.name || screen, tweets: tweets.length, worlds: saved });
    } catch (e) {
      log(`❌ x-world scan @${screen}: ${e.message}`);
      // 结构化错误：Nitter 不可达 → 用户可读的降级提示
      const errorInfo = e.code === 'NITTER_UNREACHABLE'
        ? `Nitter 全部实例不可达（网络受限/需代理）。请在服务环境设置 HTTPS_PROXY 或 VRC_MONITOR_HTTP_PROXY 后重试。`
        : e.message;
      results.push({ screen_name: screen, name: creator.name || screen, tweets: 0, worlds: 0, error: errorInfo });
    }
  }

  return { scanned: creators.length, tweets: totalTweets, worlds: totalWorlds, creators: results };
}

/**
 * 写入/更新推荐记录（跨博主去重累积）。
 */
export function saveRecommendation(storage, creator, world, tweetInfo) {
  const existing = storage.getXWorld(world.worldId);
  const rec = {
    tweetId: tweetInfo.tweetId || '',
    tweetTime: tweetInfo.tweetTime || new Date().toISOString(),
    tweetUrl: tweetInfo.tweetUrl || '',
  };

  if (existing) {
    // 更新统计 + 追加推荐记录
    let creatorsArr = [];
    try { creatorsArr = JSON.parse(existing.creators || '[]'); } catch {}
    const prev = creatorsArr.find(c => c.screen_name === creator.screen_name && c.tweet_id === rec.tweetId);
    if (!prev) {
      creatorsArr.push({
        screen_name: creator.screen_name,
        name: creator.name || creator.screen_name,
        tweet_id: rec.tweetId,
        tweet_time: rec.tweetTime,
        tweet_url: rec.tweetUrl,
      });
    }
    storage.updateXWorld(existing.world_id, {
      worldName: world.worldName || existing.world_name,
      authorName: world.authorName || existing.author_name,
      description: world.description || existing.description,
      imageUrl: world.imageUrl || existing.image_url,
      favorites: world.favorites,
      visits: world.visits,
      popularity: world.popularity,
      capacity: world.capacity,
      tags: JSON.stringify(world.tags),
      lastRecommendedAt: rec.tweetTime,
      creators: JSON.stringify(creatorsArr),
      tweetCount: creatorsArr.length,
    });
  } else {
    storage.insertXWorld({
      worldId: world.worldId,
      worldName: world.worldName,
      authorName: world.authorName,
      description: world.description,
      imageUrl: world.imageUrl,
      favorites: world.favorites,
      visits: world.visits,
      popularity: world.popularity,
      capacity: world.capacity,
      tags: JSON.stringify(world.tags),
      firstSeenAt: rec.tweetTime,
      lastRecommendedAt: rec.tweetTime,
      creators: JSON.stringify([{
        screen_name: creator.screen_name,
        name: creator.name || creator.screen_name,
        tweet_id: rec.tweetId,
        tweet_time: rec.tweetTime,
        tweet_url: rec.tweetUrl,
      }]),
      tweetCount: 1,
    });
  }
}

// ── 聚合查询（digest） ──────────────────────────────────────

/**
 * 按时间窗口聚合博主推荐的世界，按收藏数排序。
 *
 * days: 1/3/7/15/30 —— 只看 last_recommended_at 在最近 N 天内的世界
 * highlightRatio: 收藏/浏览比超过该值标注为重点（默认 0.2 = 五分之一）
 * 返回结构可直接展示。
 */
export function getWorldDigest({ days = 7, highlightRatio = 0.2, limit = 50, creator } = {}) {
  const { storage } = ctx;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = storage.getXWorldsSince(since, { creator, limit: limit * 3 }); // 多取一些便于排序

  const worlds = rows.map(r => {
    let creatorsArr = [];
    try { creatorsArr = JSON.parse(r.creators || '[]'); } catch {}
    const favorites = r.favorites || 0;
    const visits = r.visits || 0;
    const ratio = visits > 0 ? favorites / visits : 0;
    const highlight = ratio >= highlightRatio;
    return {
      worldId: r.world_id,
      worldName: r.world_name,
      authorName: r.author_name,
      description: (r.description || '').slice(0, 120),
      favorites,
      visits,
      popularity: r.popularity || 0,
      capacity: r.capacity || 0,
      favoriteVisitRatio: Number(ratio.toFixed(3)),
      highlight,                    // 收藏/浏览比 ≥ 1/5
      creators: [...new Set(creatorsArr.map(c => c.name || c.screen_name))],
      lastRecommendedAt: r.last_recommended_at,
      tweetCount: r.tweet_count || 0,
      tags: safeParseTags(r.tags),
    };
  });

  // 按收藏数降序
  worlds.sort((a, b) => b.favorites - a.favorites);

  const highlighted = worlds.filter(w => w.highlight);
  return {
    days,
    highlightRatio,
    total: worlds.length,
    highlightedCount: highlighted.length,
    highlighted: highlighted.slice(0, limit),
    worlds: worlds.slice(0, limit),
  };
}

function safeParseTags(s) {
  try { const t = JSON.parse(s || '[]'); return Array.isArray(t) ? t : []; }
  catch { return []; }
}
