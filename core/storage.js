/**
 * VRChat 好友监控系统 — SQLite 存储层
 * 
 * 封装 better-sqlite3 的所有数据库操作（2026-08-09 由 sql.js 迁移）。
 * 为什么换：sql.js 是 WASM 内存库，_save() 整文件覆盖写，强杀进程会
 * 截断 303MB 大文件导致数据全丢（2026-08-09 真实事故）。better-sqlite3
 * 是原生绑定 + WAL 模式：每次写即时落盘、崩溃安全、支持并发读。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DDL_PATH = path.join(__dirname, 'init-db.sql');
const X_WORLDS_DDL_PATH = path.join(__dirname, 'init-x-worlds.sql');

export class Storage {
  /** @type {import('better-sqlite3').Database} */
  db = null;
  dbPath = '';

  async init(dbPath) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    const ddl = readFileSync(DDL_PATH, 'utf-8');
    this.db.exec(ddl);
    // X 博主世界推荐表（x_world_digest 工具，幂等 CREATE IF NOT EXISTS）
    try {
      const xddl = readFileSync(X_WORLDS_DDL_PATH, 'utf-8');
      this.db.exec(xddl);
    } catch (e) {
      console.warn(`[storage] x-worlds DDL 加载失败: ${e.message}`);
    }
    // 迁移：旧库 world_cache 缺 note 列
    const worldCols = this._query(`PRAGMA table_info(world_cache)`);
    if (!worldCols.some(c => c.name === 'note')) {
      this._run(`ALTER TABLE world_cache ADD COLUMN note TEXT`);
    }
    // 迁移：旧库 world_cache 缺 favorited 列（favorite_world 云端收藏本地标记，幂等）
    const wcFavCols = this._query(`PRAGMA table_info(world_cache)`);
    if (!wcFavCols.some(c => c.name === 'favorited')) {
      this._run(`ALTER TABLE world_cache ADD COLUMN favorited INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 new_worlds 缺 sleep_ok 列（recommend_join 睡觉图评分用，幂等）
    const nwCols = this._query(`PRAGMA table_info(new_worlds)`);
    if (!nwCols.some(c => c.name === 'sleep_ok')) {
      this._run(`ALTER TABLE new_worlds ADD COLUMN sleep_ok INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 join_choices 缺 world_tags 列（类型偏好学习用，幂等）
    const jcCols = this._query(`PRAGMA table_info(join_choices)`);
    if (!jcCols.some(c => c.name === 'world_tags')) {
      this._run(`ALTER TABLE join_choices ADD COLUMN world_tags TEXT DEFAULT ''`);
    }
    // 迁移：旧库 new_worlds 缺 tags/description/source 列（scan_new_worlds upsert 依赖，幂等）
    const nwCols2 = this._query(`PRAGMA table_info(new_worlds)`);
    if (!nwCols2.some(c => c.name === 'tags')) {
      this._run(`ALTER TABLE new_worlds ADD COLUMN tags TEXT DEFAULT ''`);
    }
    if (!nwCols2.some(c => c.name === 'description')) {
      this._run(`ALTER TABLE new_worlds ADD COLUMN description TEXT DEFAULT ''`);
    }
    if (!nwCols2.some(c => c.name === 'source')) {
      this._run(`ALTER TABLE new_worlds ADD COLUMN source TEXT DEFAULT 'new'`);
    }
    // 迁移：旧库 new_worlds 缺 user_rating 列（rate_world 用户反馈，幂等）
    const nwCols3 = this._query(`PRAGMA table_info(new_worlds)`);
    if (!nwCols3.some(c => c.name === 'user_rating')) {
      this._run(`ALTER TABLE new_worlds ADD COLUMN user_rating INTEGER DEFAULT 0`);
    }
    // 迁移：旧库 new_worlds 缺 author_id 列（作者维度推荐用，幂等）
    const nwCols4 = this._query(`PRAGMA table_info(new_worlds)`);
    if (!nwCols4.some(c => c.name === 'author_id')) {
      this._run(`ALTER TABLE new_worlds ADD COLUMN author_id TEXT DEFAULT ''`);
    }
    // 迁移：历史 tags='' 脏数据统一为 '[]'（json_each 对空串抛 malformed JSON，Review R2）
    this._run(`UPDATE new_worlds SET tags = '[]' WHERE tags IS NULL OR tags = ''`);
    return this;
  }

  // better-sqlite3 每次写操作即时落盘（WAL），无需手动保存。
  // 保留为 no-op 兼容旧调用方（save()/close()）。
  _save() {}

  // better-sqlite3 绑定键不带 $ 前缀（SQL 里 $x 对应对象键 x）
  _normParams(params = {}) {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      out[k.startsWith('$') ? k.slice(1) : k] = v;
    }
    return out;
  }

  _query(sql, params = {}) {
    if (Object.keys(params).length > 0) {
      return this.db.prepare(sql).all(this._normParams(params));
    }
    return this.db.prepare(sql).all();
  }

  _run(sql, params = {}) {
    if (Object.keys(params).length > 0) {
      this.db.prepare(sql).run(this._normParams(params));
    } else {
      this.db.prepare(sql).run();
    }
  }

  // ── 事件流 ──

  insertEvent({ type, userId, displayName, contentJson, worldId, worldName, createdAt, source = 'websocket' }) {
    this._run(
      `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
       VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`,
      { $type: type, $userId: userId, $displayName: displayName || '', $contentJson: JSON.stringify(contentJson), $worldId: worldId || '', $worldName: worldName || '', $createdAt: createdAt, $source: source }
    );
  }

  insertEventsBatch(events) {
    const stmt = this.db.prepare(
      `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
       VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
    );
    for (const e of events) {
      stmt.run(this._normParams({
        $type: e.type, $userId: e.userId, $displayName: e.displayName || '',
        $contentJson: JSON.stringify(e.contentJson || {}),
        $worldId: e.worldId || '', $worldName: e.worldName || '',
        $createdAt: e.createdAt, $source: e.source || 'migrate',
      }));
    }
  }

  getEventsByUser(userId, { limit = 50, offset = 0, type } = {}) {
    let sql = `SELECT * FROM events WHERE user_id = $userId`;
    const params = { $userId: userId };
    if (type) { sql += ` AND type = $type`; params.$type = type; }
    sql += ` ORDER BY created_at DESC LIMIT $limit OFFSET $offset`;
    params.$limit = limit;
    params.$offset = offset;
    return this._query(sql, params);
  }

  getRecentEvents({ limit = 50, type } = {}) {
    let sql = `SELECT * FROM events`;
    const params = {};
    if (type) { sql += ` WHERE type = $type`; params.$type = type; }
    sql += ` ORDER BY created_at DESC LIMIT $limit`;
    params.$limit = limit;
    return this._query(sql, params);
  }

  getEventsByTimeRange(start, end, { limit = 1000 } = {}) {
    return this._query(
      `SELECT * FROM events WHERE created_at >= $start AND created_at <= $end ORDER BY created_at DESC LIMIT $limit`,
      { $start: start, $end: end, $limit: limit }
    );
  }

  countEventsByUserInRange(userId, start, end) {
    return this._query(
      `SELECT type, COUNT(*) as count FROM events WHERE user_id = $userId AND created_at >= $start AND created_at <= $end GROUP BY type`,
      { $userId: userId, $start: start, $end: end }
    );
  }

  // ── 好友状态 ──

  upsertFriend(friend) {
    const params = {
      $userId: friend.userId,
      $displayName: friend.displayName || '',
      $memo: friend.memo ?? null,
      $trustLevel: friend.trustLevel ?? null,
      $isOnline: friend.isOnline ? 1 : 0,
      $location: friend.location || '',
      $worldId: friend.worldId || '',
      $worldName: friend.worldName || '',
      $platform: friend.platform || '',
      $status: friend.status || '',
      $statusDescription: friend.statusDescription || '',
      $avatarImageUrl: friend.avatarImageUrl || '',
      $lastSeen: friend.lastSeen || '',
      $lastOnline: friend.lastOnline || '',
      $lastOffline: friend.lastOffline || '',
    };

    this._run(
      `INSERT INTO friends (user_id, display_name, memo, trust_level, is_online, location,
        world_id, world_name, platform, status, status_description, avatar_image_url,
        last_seen, last_online, last_offline)
       VALUES ($userId, $displayName, $memo, $trustLevel, $isOnline, $location,
        $worldId, $worldName, $platform, $status, $statusDescription, $avatarImageUrl,
        $lastSeen, $lastOnline, $lastOffline)
       ON CONFLICT(user_id) DO UPDATE SET
        display_name=COALESCE($displayName, display_name),
        memo=COALESCE($memo, memo),
        trust_level=COALESCE($trustLevel, trust_level),
        is_online=COALESCE($isOnline, is_online),
        location=COALESCE($location, location),
        world_id=COALESCE($worldId, world_id),
        world_name=COALESCE($worldName, world_name),
        platform=COALESCE($platform, platform),
        status=COALESCE($status, status),
        status_description=COALESCE($statusDescription, status_description),
        avatar_image_url=COALESCE($avatarImageUrl, avatar_image_url),
        last_seen=COALESCE($lastSeen, last_seen),
        last_online=COALESCE($lastOnline, last_online),
        last_offline=COALESCE($lastOffline, last_offline),
        updated_at=datetime('now')`,
      params
    );
  }

  getAllFriends() {
    return this._query(`SELECT * FROM friends ORDER BY display_name`);
  }

  getOnlineFriends() {
    return this._query(`SELECT * FROM friends WHERE is_online = 1 ORDER BY display_name`);
  }

  getFriend(userId) {
    const rows = this._query(`SELECT * FROM friends WHERE user_id = $userId`, { $userId: userId });
    return rows[0] || null;
  }

  searchFriends(query) {
    return this._query(
      `SELECT * FROM friends WHERE display_name LIKE $q OR memo LIKE $q ORDER BY display_name LIMIT 50`,
      { $q: `%${query}%` }
    );
  }

  // ── 世界缓存 ──

  getWorldName(worldId) {
    const rows = this._query(`SELECT * FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    return rows[0] || null;
  }

  searchWorldsByName(keyword) {
    const like = `%${keyword}%`;
    const rows = this._query(
      `SELECT world_id, name FROM world_cache WHERE name LIKE $like ORDER BY name LIMIT 20`,
      { $like: like }
    );
    const eventRows = this._query(
      `SELECT world_id, world_name AS name FROM events WHERE world_name LIKE $like AND world_id != '' GROUP BY world_id, world_name ORDER BY world_name LIMIT 20`,
      { $like: like }
    );
    const seen = new Set();
    const merged = [];
    for (const r of [...rows, ...eventRows]) {
      if (!r.world_id || seen.has(r.world_id)) continue;
      seen.add(r.world_id);
      merged.push({ worldId: r.world_id, name: r.name || '' });
    }
    return merged;
  }

  _recordWorldChanges(world) {
    const old = this.getWorldName(world.worldId);
    if (!old) return;
    // 数据库列名 → upsertWorld 传入对象的驼峰字段名映射（避免取到 undefined）
    const fieldMap = {
      name: 'name',
      description: 'description',
      author_name: 'authorName',
      image_url: 'imageUrl',
      release_status: 'releaseStatus',
      capacity: 'capacity',
      tags: 'tags',
    };
    const fields = ['name', 'description', 'author_name', 'image_url', 'release_status', 'capacity', 'tags'];
    const newTags = JSON.stringify(world.tags || []);
    for (const f of fields) {
      const oldValue = f === 'tags' ? String(old.tags ?? '') : String(old[f] ?? '');
      const newValue = f === 'tags' ? newTags : String(world[fieldMap[f]] ?? '');
      if (oldValue !== newValue) {
        this._run(
          `INSERT INTO world_history (world_id, field, old_value, new_value)
           VALUES ($worldId, $field, $oldValue, $newValue)`,
          { $worldId: world.worldId, $field: f, $oldValue: oldValue, $newValue: newValue }
        );
      }
    }
  }

  upsertWorld(world) {
    this._recordWorldChanges(world);
    this._run(
      `INSERT INTO world_cache
       (world_id, name, author_id, author_name, description, image_url,
        release_status, capacity, favorites, tags, updated_at)
       VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
        $releaseStatus, $capacity, $favorites, $tags, datetime('now'))
       ON CONFLICT(world_id) DO UPDATE SET
        name = excluded.name,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        description = excluded.description,
        image_url = excluded.image_url,
        release_status = excluded.release_status,
        capacity = excluded.capacity,
        favorites = excluded.favorites,
        tags = excluded.tags,
        updated_at = datetime('now')`,
      {
        $worldId: world.worldId, $name: world.name || '',
        $authorId: world.authorId || '', $authorName: world.authorName || '',
        $description: world.description || '', $imageUrl: world.imageUrl || '',
        $releaseStatus: world.releaseStatus || '',
        $capacity: world.capacity || 0, $favorites: world.favorites || 0,
        $tags: JSON.stringify(world.tags || []),
      }
    );
  }

  upsertWorldsBatch(worlds) {
    for (const w of worlds) {
      this._recordWorldChanges(w);
    }
    const stmt = this.db.prepare(
      `INSERT INTO world_cache
       (world_id, name, author_id, author_name, description, image_url,
        release_status, capacity, favorites, tags, updated_at)
       VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
        $releaseStatus, $capacity, $favorites, $tags, datetime('now'))
       ON CONFLICT(world_id) DO UPDATE SET
        name = excluded.name,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        description = excluded.description,
        image_url = excluded.image_url,
        release_status = excluded.release_status,
        capacity = excluded.capacity,
        favorites = excluded.favorites,
        tags = excluded.tags,
        updated_at = datetime('now')`
    );
    for (const w of worlds) {
      stmt.run(this._normParams({
        $worldId: w.worldId, $name: w.name || '',
        $authorId: w.authorId || '', $authorName: w.authorName || '',
        $description: w.description || '', $imageUrl: w.imageUrl || '',
        $releaseStatus: w.releaseStatus || '',
        $capacity: w.capacity || 0, $favorites: w.favorites || 0,
        $tags: JSON.stringify(w.tags || []),
      }));
    }
  }

  // ── 群组缓存 ──

  getGroupCached(groupId) {
    const rows = this._query(`SELECT * FROM group_cache WHERE group_id = $g`, { $g: groupId });
    return rows[0] || null;
  }

  upsertGroupCache({ groupId, name, description, memberCount }) {
    this._run(
      `INSERT INTO group_cache (group_id, name, description, member_count, updated_at)
       VALUES ($g, $name, $desc, $mc, datetime('now'))
       ON CONFLICT(group_id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         member_count = excluded.member_count, updated_at = datetime('now')`,
      { $g: groupId, $name: name || '', $desc: description || '', $mc: memberCount || 0 }
    );
  }

  // ── PlanetVRC TTL 缓存 ──

  /** 读缓存：不存在或超 ttlMs 返回 null，否则 JSON.parse(payload) */
  getPlanetCache(key, ttlMs) {
    const rows = this._query(`SELECT payload, fetched_at FROM planet_cache WHERE key = $key`, { $key: key });
    if (rows.length === 0) return null;
    const row = rows[0];
    if (ttlMs && row.fetched_at) {
      const fetchedMs = Date.parse(row.fetched_at);
      if (Number.isFinite(fetchedMs) && Date.now() - fetchedMs > ttlMs) return null;
    }
    try { return JSON.parse(row.payload); } catch { return null; }
  }

  /** 写缓存：payload 传对象，内部 JSON.stringify，fetched_at 存 ISO 时间戳 */
  setPlanetCache(key, payload) {
    this._run(
      `INSERT INTO planet_cache (key, payload, fetched_at)
       VALUES ($key, $payload, $fetchedAt)
       ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      { $key: key, $payload: JSON.stringify(payload), $fetchedAt: new Date().toISOString() }
    );
  }

  setWorldNote({ worldId, note = '' }) {
    this._run(
      `INSERT INTO world_cache (world_id, name, note)
       VALUES ($worldId, '', $note)
       ON CONFLICT(world_id) DO UPDATE SET note = $note, updated_at = datetime('now')`,
      { $worldId: worldId, $note: note }
    );
    const rows = this._query(`SELECT world_id, note FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    const r = rows[0];
    return { worldId: r.world_id, note: r.note };
  }

  /** BOOTH 商品快照 upsert（Issue #28：落库旁路缓存，失败不影响实时返回——调用方 try-catch） */
  upsertBoothItem(item) {
    this._run(
      `INSERT INTO booth_items (id, name, price, wishlist_count, shop_name, description, tags, image_url, url, published_at, is_sold_out, updated_at)
       VALUES ($id, $name, $price, $wishlist, $shop, $desc, $tags, $img, $url, $published, $soldOut, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, price = excluded.price, wishlist_count = excluded.wishlist_count,
         shop_name = excluded.shop_name, description = excluded.description, tags = excluded.tags,
         image_url = excluded.image_url, url = excluded.url, published_at = excluded.published_at,
         is_sold_out = excluded.is_sold_out, updated_at = datetime('now')`,
      {
        $id: String(item.id),
        $name: item.name || '',
        $price: item.price || '',
        $wishlist: item.wishlistCount ?? 0,
        $shop: (item.shop && item.shop.name) || '',
        $desc: (item.description || '').slice(0, 2000),
        $tags: JSON.stringify(item.tags || []),
        $img: (item.images && item.images[0] && item.images[0].original) || '',
        $url: item.url || '',
        $published: item.publishedAt || '',
        $soldOut: item.isSoldOut ? 1 : 0,
      }
    );
  }

  /** BOOTH 商品快照读取（无缓存返回 null） */
  getBoothItemCache(id) {
    const rows = this._query(
      `SELECT id, name, price, wishlist_count AS wishlistCount, shop_name AS shopName,
              description, tags, image_url AS imageUrl, url, published_at AS publishedAt,
              is_sold_out AS isSoldOut, updated_at AS updatedAt
       FROM booth_items WHERE id = $id`,
      { $id: String(id) }
    );
    const r = rows[0];
    if (!r) return null;
    try { r.tags = JSON.parse(r.tags || '[]'); } catch { r.tags = []; }
    return r;
  }

  /** 按收藏数排序的商品快照列表（趋势跟踪用） */
  listBoothItems({ sortBy = 'wishlist', limit = 20, minWishlist = 0 } = {}) {
    const order = sortBy === 'wishlist' ? 'wishlist_count DESC' : 'updated_at DESC';
    const rows = this._query(
      `SELECT id, name, price, wishlist_count AS wishlistCount, shop_name AS shopName,
              image_url AS imageUrl, url, is_sold_out AS isSoldOut, updated_at AS updatedAt
       FROM booth_items WHERE wishlist_count >= $minWishlist
       ORDER BY ${order} LIMIT $limit`,
      { $minWishlist: minWishlist, $limit: Math.max(1, Math.min(100, limit)) }
    );
    return rows;
  }

  /** 记录一次 BOOTH 搜索（结果 id 列表入历史表） */
  recordBoothSearch(query, resultIds) {
    this._run(
      `INSERT INTO booth_search_history (query, result_ids, result_count, created_at)
       VALUES ($query, $ids, $count, datetime('now'))`,
      { $query: query, $ids: JSON.stringify(resultIds || []), $count: (resultIds || []).length }
    );
  }

  /** 最近搜索历史（含每次结果的商品快照信息） */
  getBoothSearches({ limit = 10 } = {}) {
    const rows = this._query(
      `SELECT id, query, result_ids AS resultIds, result_count AS resultCount, created_at AS createdAt
       FROM booth_search_history ORDER BY id DESC LIMIT $limit`,
      { $limit: Math.max(1, Math.min(50, limit)) }
    );
    for (const r of rows) {
      try { r.resultIds = JSON.parse(r.resultIds || '[]'); } catch { r.resultIds = []; }
    }
    return rows;
  }

  /** 云端收藏标记：favorite_world 成功后写本地 world_cache（Issue #25），世界不存在时插入兜底行 */
  setWorldFavorited({ worldId, favorited = 1 }) {
    this._run(
      `INSERT INTO world_cache (world_id, name, favorited)
       VALUES ($worldId, '', $favorited)
       ON CONFLICT(world_id) DO UPDATE SET favorited = $favorited, updated_at = datetime('now')`,
      { $worldId: worldId, $favorited: favorited ? 1 : 0 }
    );
    const rows = this._query(`SELECT world_id, name, favorited FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, name: row.name || '', favorited: row.favorited === 1 };
  }

  /**
   * 用户反馈：给世界打好评/差评标记（Issue #19）
   * rating: -1=烂图(junk) / 0=清除标记 / 1=好图
   * 若世界不在 new_worlds 表（如手动收藏的世界），自动插入一行兜底。
   */
  rateWorld({ worldId, rating = 0 }) {
    const r = parseInt(rating, 10);
    const finalRating = r === -1 ? -1 : (r === 1 ? 1 : 0);
    this._run(
      `INSERT INTO new_worlds (world_id, world_name, tags, user_rating)
       VALUES ($worldId, '', '[]', $rating)
       ON CONFLICT(world_id) DO UPDATE SET user_rating = $rating`,
      { $worldId: worldId, $rating: finalRating }
    );
    const rows = this._query(`SELECT world_id, world_name, user_rating FROM new_worlds WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, worldName: row.world_name || '', userRating: row.user_rating };
  }

  /** 显式确认逛过某个世界（Issue #19 痛点 3：事件驱动 visited 不可靠） */
  markWorldVisited({ worldId }) {
    const now = new Date().toISOString();
    this._run(
      `INSERT INTO new_worlds (world_id, world_name, tags, visited, visited_at)
       VALUES ($worldId, '', '[]', 1, $now)
       ON CONFLICT(world_id) DO UPDATE SET visited = 1, visited_at = $now`,
      { $worldId: worldId, $now: now }
    );
    const rows = this._query(`SELECT world_id, world_name, visited, visited_at FROM new_worlds WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, worldName: row.world_name || '', visited: row.visited === 1, visitedAt: row.visited_at };
  }

  getWorldHistory(worldId, limit = 50) {
    const rows = this._query(
      `SELECT field, old_value, new_value, changed_at FROM world_history WHERE world_id = $worldId ORDER BY id DESC LIMIT $limit`,
      { $worldId: worldId, $limit: limit }
    );
    return rows.map(r => ({ field: r.field, oldValue: r.old_value, newValue: r.new_value, changedAt: r.changed_at }));
  }

  // ── 关注名单 ──

  addToWatchlist(userId, displayName, priority = 0) {
    this._run(
      `INSERT OR REPLACE INTO watchlist (user_id, display_name, priority)
       VALUES ($userId, $displayName, $priority)`,
      { $userId: userId, $displayName: displayName || '', $priority: priority }
    );
  }

  removeFromWatchlist(userId) {
    this._run(`DELETE FROM watchlist WHERE user_id = $userId`, { $userId: userId });
  }

  getWatchlist() {
    return this._query(`SELECT * FROM watchlist ORDER BY priority DESC, display_name`);
  }

  // ── 配置 ──

  getConfig(key, defaultValue = null) {
    const rows = this._query(`SELECT value FROM config WHERE key = $key`, { $key: key });
    return rows.length > 0 ? rows[0].value : defaultValue;
  }

  setConfig(key, value) {
    this._run(`INSERT OR REPLACE INTO config (key, value) VALUES ($key, $value)`, { $key: key, $value: String(value) });
  }

  // ── 昵称映射 ──

  getNicknames({ userId, query } = {}) {
    if (userId) {
      const rows = this._query(
        `SELECT user_id, display_name, nickname, updated_at FROM nicknames WHERE user_id = $userId`,
        { $userId: userId }
      );
      return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
    }

    if (query) {
      const q = `%${query}%`;
      const rows = this._query(
        `SELECT user_id, display_name, nickname, updated_at FROM nicknames
         WHERE display_name LIKE $q OR nickname LIKE $q
         ORDER BY display_name`,
        { $q: q }
      );
      return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
    }

    const rows = this._query(`SELECT user_id, display_name, nickname, updated_at FROM nicknames ORDER BY display_name`);
    return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
  }

  setNickname({ userId, nickname, displayName = '' } = {}) {
    this._run(
      `INSERT INTO nicknames (user_id, display_name, nickname, updated_at)
       VALUES ($userId, $displayName, $nickname, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = CASE WHEN excluded.display_name = '' THEN nicknames.display_name ELSE excluded.display_name END,
         nickname = excluded.nickname,
         updated_at = datetime('now')`,
      { $userId: userId, $displayName: displayName || '', $nickname: nickname }
    );
    const rows = this._query(
      `SELECT user_id, display_name, nickname, updated_at FROM nicknames WHERE user_id = $userId`,
      { $userId: userId }
    );
    const r = rows[0];
    return { userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at };
  }

  // ── 工具方法 ──

  // ── 新增：查找同屏好友 ──

  findCompanions(userId, startTime, endTime) {
    // 1. 获取目标用户的时间范围内所有 location 事件
    //    - 查自己：user-location（自己的位置事件）
    //    - 查好友：friend-location（好友的位置事件）
    const userEvents = this._query(
      `SELECT * FROM events WHERE user_id = $userId AND type IN ('user-location', 'friend-location')
       AND created_at >= $start AND created_at <= $end
       ORDER BY created_at ASC`,
      { $userId: userId, $start: startTime, $end: endTime }
    );

    // 2. 提取用户去过的所有 unique instanceId
    const userInstances = new Set();
    const userTimeline = [];
    for (const ev of userEvents) {
      let location = '';
      try {
        const cj = JSON.parse(ev.content_json);
        location = cj.location || '';
      } catch {}
      if (location && location !== 'offline' && location !== 'traveling') {
        const parts = location.split(':');
        const worldId = parts[0];
        const instanceId = parts.slice(1).join(':');
        if (worldId && instanceId) {
          userInstances.add(instanceId);
          userInstances.add(`${worldId}:${instanceId}`);
        }
        userTimeline.push({
          id: ev.id,
          created_at: ev.created_at,
          type: ev.type,
          world_id: worldId,
          instance_id: instanceId,
          world_name: ev.world_name || '',
          content_json: ev.content_json,
        });
      } else {
        userTimeline.push({
          id: ev.id,
          created_at: ev.created_at,
          type: ev.type,
          world_id: location || 'offline',
          instance_id: null,
          world_name: ev.world_name || '',
          content_json: ev.content_json,
        });
      }
    }

    // 3. 获取所有好友在时间范围内的 friend-location 事件
    const friendEvents = this._query(
      `SELECT * FROM events WHERE type = 'friend-location'
       AND created_at >= $start AND created_at <= $end
       ORDER BY created_at ASC`,
      { $start: startTime, $end: endTime }
    );

    // 4. 交叉匹配（排除目标用户本人——查好友时 TA 自己的 friend-location 也会进 friendEvents）
    const matchedMap = new Map();
    for (const ev of friendEvents) {
      if (ev.user_id === userId) continue;
      let location = '';
      try {
        const cj = JSON.parse(ev.content_json);
        location = cj.location || '';
      } catch {}
      if (!location || location === 'offline' || location === 'traveling') continue;

      const parts = location.split(':');
      const worldId = parts[0];
      const instanceId = parts.slice(1).join(':');
      const key = `${worldId}:${instanceId}`;

      if (userInstances.has(instanceId) || userInstances.has(key)) {
        if (!matchedMap.has(ev.user_id)) {
          matchedMap.set(ev.user_id, {
            displayName: ev.display_name,
            events: [],
          });
        }
        matchedMap.get(ev.user_id).events.push({
          id: ev.id,
          created_at: ev.created_at,
          type: ev.type,
          world_id: worldId,
          instance_id: instanceId,
          world_name: ev.world_name || '',
        });
      }
    }

    // 5. 整理输出
    const companions = [];
    for (const [uid, info] of matchedMap) {
      const times = info.events.map(e => e.created_at).sort();
      const worlds = new Set(info.events.map(e => e.world_name || e.world_id));
      companions.push({
        userId: uid,
        displayName: info.displayName,
        firstSeen: times[0],
        lastSeen: times[times.length - 1],
        matchCount: info.events.length,
        worlds: [...worlds].filter(Boolean),
      });
    }

    companions.sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1));

    return {
      userId,
      timeRange: { start: startTime, end: endTime },
      userInstanceCount: userInstances.size,
      userTimeline,
      companionCount: companions.length,
      companions,
    };
  }

  // ── 新增：分析好友上线规律 ──

  getOnlinePattern(userId, { startTime, endTime, days } = {}) {
    let start, end, windowDays;
    if (startTime && endTime) {
      start = startTime;
      end = endTime;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new Error('Invalid startTime or endTime');
      }
      if (startMs > endMs) {
        throw new Error('startTime must be <= endTime');
      }
      windowDays = Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)));
    } else {
      const effectiveDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 30;
      const now = new Date();
      const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
      const beijingDateStr = beijingNow.toISOString().slice(0, 10);
      const endDate = new Date(`${beijingDateStr}T23:59:59.999+08:00`);
      const startDate = new Date(`${beijingDateStr}T00:00:00.000+08:00`);
      startDate.setDate(startDate.getDate() - effectiveDays + 1);
      start = startDate.toISOString();
      end = endDate.toISOString();
      windowDays = effectiveDays;
    }

    const rows = this._query(
      `SELECT * FROM events WHERE user_id = $userId
       AND (
         type LIKE 'friend-online%' OR type LIKE 'user-online%'
         OR type LIKE 'friend-offline%' OR type LIKE 'user-offline%'
         OR type LIKE 'friend-location%' OR type LIKE 'user-location%'
       )
       AND created_at >= $start AND created_at <= $end
       ORDER BY created_at ASC`,
      { $userId: userId, $start: start, $end: end }
    );

    const hourly = { online: {}, offline: {}, location: {} };
    const activeDatesSet = new Set();
    let displayName = '';

    for (const ev of rows) {
      if (!displayName && ev.display_name) displayName = ev.display_name;
      const date = new Date(ev.created_at);
      if (Number.isNaN(date.getTime())) continue;
      const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
      const hour = String(beijingDate.getUTCHours());
      const dateStr = beijingDate.toISOString().slice(0, 10);
      activeDatesSet.add(dateStr);

      if (ev.type.endsWith('-online')) {
        hourly.online[hour] = (hourly.online[hour] || 0) + 1;
      } else if (ev.type.endsWith('-offline')) {
        hourly.offline[hour] = (hourly.offline[hour] || 0) + 1;
      } else if (ev.type.endsWith('-location')) {
        hourly.location[hour] = (hourly.location[hour] || 0) + 1;
      }
    }

    if (!displayName) {
      const friend = this.getFriend(userId);
      if (friend) displayName = friend.display_name || '';
    }

    const total = {
      online: Object.values(hourly.online).reduce((a, b) => a + b, 0),
      offline: Object.values(hourly.offline).reduce((a, b) => a + b, 0),
      location: Object.values(hourly.location).reduce((a, b) => a + b, 0),
      activeDays: activeDatesSet.size,
    };

    const sortedDates = [...activeDatesSet].sort((a, b) => (a < b ? -1 : 1));
    const activeDates = [...sortedDates].reverse();

    const gaps = [];
    for (let i = 1; i < sortedDates.length; i++) {
      const diff = (new Date(sortedDates[i]) - new Date(sortedDates[i - 1])) / (24 * 60 * 60 * 1000);
      gaps.push(diff);
    }
    const avgGapDays = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const longestGapDays = gaps.length > 0 ? Math.max(...gaps) : 0;

    const endMs = Date.parse(end);
    const last30Start = new Date(endMs - 30 * 24 * 60 * 60 * 1000);
    const last30ActiveDays = [...activeDatesSet].filter(d => {
      const t = new Date(d).getTime();
      return t >= last30Start.getTime() && t <= endMs;
    }).length;

    const frequency = {
      windowDays,
      activeDays: activeDatesSet.size,
      activityRatio: windowDays > 0 ? activeDatesSet.size / windowDays : 0,
      last30ActiveDays,
      avgGapDays,
      longestGapDays,
    };

    function peakHour(dist) {
      let bestHour = null;
      let bestCount = -1;
      for (const [h, c] of Object.entries(dist)) {
        if (c > bestCount) {
          bestCount = c;
          bestHour = Number(h);
        }
      }
      return bestHour;
    }

    const loginPeakHour = peakHour(hourly.online);
    const activePeakHour = peakHour(hourly.location);
    const offlinePeakHour = peakHour(hourly.offline);

    function formatSuggestedWindow(h1, h2) {
      if (h1 === null && h2 === null) return null;
      if (h1 === null) return `${h2}:00`;
      if (h2 === null) return `${h1}:00`;
      if (h1 === h2) return `${h1}:00`;
      if (Math.abs(h1 - h2) === 1) return `${Math.min(h1, h2)}:00-${Math.max(h1, h2)}:00`;
      return `${h1}:00/${h2}:00`;
    }

    const suggestedWindow = formatSuggestedWindow(loginPeakHour, activePeakHour);

    return {
      userId,
      displayName,
      window: { start, end, days: windowDays },
      total,
      hourly,
      activeDates,
      frequency,
      peak: {
        loginPeakHour,
        activePeakHour,
        offlinePeakHour,
        suggestedWindow,
      },
    };
  }

  // ── 周报专用方法 ──

  getOwnWorldSessions(startTime, endTime) {
    const rows = this._query(
      `SELECT content_json, created_at FROM events WHERE type='user-location' AND created_at >= $start AND created_at <= $end ORDER BY created_at ASC`,
      { $start: startTime, $end: endTime }
    );
    const sessions = []; // {worldId, start, end, minutes}
    let curWorld = null, curStart = null;
    for (const row of rows) {
      let loc = '';
      try { loc = JSON.parse(row.content_json).location || ''; } catch {}
      const dt = row.created_at;
      if (loc.startsWith('wrld_')) {
        const wid = loc.split(':')[0];
        if (curWorld && wid !== curWorld) {
          sessions.push({ worldId: curWorld, start: curStart, end: dt });
        }
        curWorld = wid; curStart = dt;
      } else {
        if (curWorld) { sessions.push({ worldId: curWorld, start: curStart, end: dt }); curWorld = null; }
      }
    }
    if (curWorld) sessions.push({ worldId: curWorld, start: curStart, end: rows.length ? rows[rows.length-1].created_at : curStart });
    // 过滤 <3 分钟的跳转会话，计算 minutes
    return sessions.filter(s => (Date.parse(s.end) - Date.parse(s.start)) / 60000 >= 3)
      .map(s => ({ ...s, minutes: (Date.parse(s.end) - Date.parse(s.start)) / 60000 }));
  }

  getWeeklyCompanions(userId, startTime, endTime) {
    // startTime/endTime 为 UTC ISO；按北京自然日（UTC 16:00 日界）切分
    const BJ_OFFSET = 8 * 3600 * 1000;
    const startMs = Date.parse(startTime), endMs = Date.parse(endTime);
    const merged = new Map();

    // 对齐到北京天边界：北京 00:00 = UTC 16:00 前一天
    let dayStart = Math.floor((startMs + BJ_OFFSET) / 86400000) * 86400000 - BJ_OFFSET;

    while (dayStart < endMs) {
      const dayEnd = Math.min(dayStart + 86400000, endMs);
      const utcDayStart = new Date(dayStart).toISOString();
      const utcDayEnd = new Date(dayEnd).toISOString();
      const r = this.findCompanions(userId, utcDayStart, utcDayEnd);
      const dayLabel = new Date(dayStart + BJ_OFFSET).toISOString().slice(5, 10); // MM-DD 北京
      for (const c of (r.companions || [])) {
        if (!merged.has(c.userId)) {
          merged.set(c.userId, { displayName: c.displayName, matchCount: 0, days: new Set(), worlds: new Set() });
        }
        const m = merged.get(c.userId);
        m.matchCount += c.matchCount || 0;
        m.days.add(dayLabel);
        for (const w of (c.worlds || [])) m.worlds.add(w);
      }
      dayStart += 86400000;
    }
    return merged;
  }

  getFriendGroupStats(startTime, endTime) {
    const rows = this._query(
      `SELECT content_json FROM events WHERE type='friend-location'
       AND (content_json LIKE '%~group(grp_%' OR content_json LIKE '%~group(gmem_%')
       AND created_at >= $start AND created_at <= $end`,
      { $start: startTime, $end: endTime }
    );
    const stats = new Map(); // groupId -> {count, users:Set, worlds:Set}
    for (const row of rows) {
      try {
        const c = JSON.parse(row.content_json);
        const loc = c.location || '';
        // VRChat 群组 ID 已从 grp_ 迁移为 gmem_ (2026-08 实测), 两种前缀都匹配
        const m = loc.match(/~group\((grp_[a-f0-9-]+|gmem_[a-f0-9-]+)\)/);
        if (m && loc.startsWith('wrld_')) {
          const gid = m[1];
          if (!stats.has(gid)) stats.set(gid, { count: 0, users: new Set(), worlds: new Set() });
          const s = stats.get(gid);
          s.count++; s.users.add(c.userId || ''); s.worlds.add(loc.split(':')[0]);
        }
      } catch {}
    }
    return stats;
  }

  /**
   * 群组热度聚合: 统计窗口内好友/自己在群组房的活动事件
   * (type=friend-location|user-location 且 location 含 ~group(gmem_/grp_xxx)).
   * 返回 Map<groupId, {count, users:Set, worlds:Set, hourly:Map<'dow:hour', count>}>
   * 时间按北京时区分桶 (dow: 0=周日..6=周六).
   */
  getGroupHeat(startIso, endIso) {
    const rows = this._query(
      `SELECT type, content_json, created_at FROM events
       WHERE (type='friend-location' OR type='user-location')
         AND created_at >= $start AND created_at <= $end
         AND (content_json LIKE '%~group(grp_%' OR content_json LIKE '%~group(gmem_%')
       ORDER BY created_at ASC`,
      { $start: startIso, $end: endIso }
    );
    const groups = new Map();
    for (const row of rows) {
      try {
        const c = JSON.parse(row.content_json);
        const loc = c.location || '';
        const m = loc.match(/~group\((grp_[a-f0-9-]+|gmem_[a-f0-9-]+)\)/);
        if (!m || !loc.startsWith('wrld_')) continue;
        const gid = m[1];
        if (!groups.has(gid)) groups.set(gid, { count: 0, users: new Set(), worlds: new Set(), hourly: new Map() });
        const s = groups.get(gid);
        s.count++;
        s.users.add(c.userId || '');
        s.worlds.add(loc.split(':')[0]);
        const d = new Date(row.created_at);
        if (!Number.isNaN(d.getTime())) {
          const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
          const key = `${bj.getUTCDay()}:${bj.getUTCHours()}`;
          s.hourly.set(key, (s.hourly.get(key) || 0) + 1);
        }
      } catch {}
    }
    return groups;
  }

  getStats() {
    const result = {};
    for (const table of ['events', 'friends', 'world_cache', 'watchlist']) {
      const rows = this._query(`SELECT COUNT(*) as count FROM ${table}`);
      result[table] = rows[0]?.count || 0;
    }
    result.eventTypes = this._query(`SELECT type, COUNT(*) as count FROM events GROUP BY type ORDER BY count DESC`);
    return result;
  }

  save() { this._save(); }
  close() { this._save(); this.db.close(); }

  // ── X 博主世界推荐（x_world_digest） ──

  getXWorld(worldId) {
    const rows = this._query(
      `SELECT * FROM x_world_recommendations WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    return rows.length > 0 ? rows[0] : null;
  }

  insertXWorld({ worldId, worldName, authorName, description, imageUrl, favorites, visits, popularity, capacity, tags, firstSeenAt, lastRecommendedAt, creators, tweetCount }) {
    this._run(
      `INSERT INTO x_world_recommendations
        (world_id, world_name, author_name, description, image_url, favorites, visits, popularity, capacity, tags,
         first_seen_at, last_recommended_at, creators, tweet_count)
       VALUES ($worldId, $worldName, $authorName, $description, $imageUrl, $favorites, $visits, $popularity, $capacity, $tags,
         $firstSeenAt, $lastRecommendedAt, $creators, $tweetCount)
       ON CONFLICT(world_id) DO UPDATE SET
         world_name = $worldName, author_name = $authorName, description = $description, image_url = $imageUrl,
         favorites = $favorites, visits = $visits, popularity = $popularity, capacity = $capacity, tags = $tags,
         last_recommended_at = $lastRecommendedAt, tweet_count = $tweetCount`,
      {
        $worldId: worldId, $worldName: worldName || '', $authorName: authorName || '',
        $description: description || '', $imageUrl: imageUrl || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
        $capacity: capacity || 0, $tags: tags || '[]',
        $firstSeenAt: firstSeenAt || new Date().toISOString(),
        $lastRecommendedAt: lastRecommendedAt || new Date().toISOString(),
        $creators: creators || '[]', $tweetCount: tweetCount || 1,
      }
    );
  }

  updateXWorld(worldId, { worldName, authorName, description, imageUrl, favorites, visits, popularity, capacity, tags, lastRecommendedAt, creators, tweetCount }) {
    this._run(
      `UPDATE x_world_recommendations SET
         world_name = $worldName, author_name = $authorName, description = $description, image_url = $imageUrl,
         favorites = $favorites, visits = $visits, popularity = $popularity, capacity = $capacity, tags = $tags,
         last_recommended_at = $lastRecommendedAt, creators = $creators, tweet_count = $tweetCount
       WHERE world_id = $worldId`,
      {
        $worldId: worldId, $worldName: worldName || '', $authorName: authorName || '',
        $description: description || '', $imageUrl: imageUrl || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
        $capacity: capacity || 0, $tags: tags || '[]',
        $lastRecommendedAt: lastRecommendedAt || new Date().toISOString(),
        $creators: creators || '[]', $tweetCount: tweetCount || 1,
      }
    );
  }

  getXWorldsSince(sinceIso, { creator, limit = 100 } = {}) {
    let sql = `SELECT * FROM x_world_recommendations WHERE last_recommended_at >= $since`;
    const params = { $since: sinceIso };
    if (creator) {
      sql += ` AND creators LIKE $creator`;
      params.$creator = `%${creator}%`;
    }
    sql += ` ORDER BY last_recommended_at DESC LIMIT $limit`;
    params.$limit = limit;
    return this._query(sql, params);
  }

  getAllXWorlds(limit = 200) {
    return this._query(`SELECT * FROM x_world_recommendations ORDER BY favorites DESC LIMIT $limit`, { $limit: limit });
  }

  clearXWorlds() {
    this._run(`DELETE FROM x_world_recommendations`);
  }
}
