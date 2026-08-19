-- VRChat 好友监控系统 — 数据库初始化 DDL
-- 文件: core/init-db.sql

-- 事件流：所有 WebSocket 事件 + 迁移的历史数据
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,              -- 'friend-online', 'friend-location', 'friend-offline' 等
  user_id TEXT NOT NULL,           -- usr_xxx
  display_name TEXT,               -- 事件发生时用户名（可能已改名）
  content_json TEXT NOT NULL,      -- 原始事件 JSON
  world_id TEXT,                   -- 从 content 提取的世界 ID
  world_name TEXT,                 -- 解析后的世界名
  created_at TEXT NOT NULL,
  source TEXT DEFAULT 'websocket'  -- 'websocket', 'migrate', 'api_poll'
);

CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, created_at);

-- 好友当前状态
CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  memo TEXT,                       -- 备注昵称（从 VRCX-0 memos 迁移）
  trust_level TEXT,                -- 信任等级
  is_online INTEGER DEFAULT 0,     -- 0=离线, 1=在线
  location TEXT,                   -- 当前位置
  world_id TEXT,                   -- 当前世界 ID
  world_name TEXT,                 -- 当前世界名
  platform TEXT,
  status TEXT,
  status_description TEXT,
  avatar_image_url TEXT,
  bio TEXT,                        -- 个人简介（friend-profile 变更追踪用）
  user_icon TEXT,                  -- 头像小图标 URL（friend-profile 变更追踪用）
  pronouns TEXT,                   -- 人称代词（friend-profile 变更追踪用）
  last_seen TEXT,                  -- 最后一次见到（任意活动）
  last_online TEXT,                -- 最后一次上线
  last_offline TEXT,               -- 最后一次下线
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 世界名缓存
CREATE TABLE IF NOT EXISTS world_cache (
  world_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT,                       -- 用户自定义备注（API 刷新不覆盖）
  author_id TEXT,
  author_name TEXT,
  description TEXT,
  image_url TEXT,
  release_status TEXT,
  capacity INTEGER,
  favorites INTEGER,
  tags TEXT,                       -- JSON array
  favorited INTEGER DEFAULT 0,     -- 云端收藏标记（favorite_world 成功时写 1）
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 本地配置（键值对）
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 关注的特定好友（核心关注名单）
CREATE TABLE IF NOT EXISTS watchlist (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  memo TEXT,
  priority INTEGER DEFAULT 0,      -- 0=普通, 1=高关注
  created_at TEXT DEFAULT (datetime('now'))
);

-- 好友昵称映射（display_name -> 中文昵称）
CREATE TABLE IF NOT EXISTS nicknames (
  user_id   TEXT PRIMARY KEY,
  display_name TEXT DEFAULT '',
  nickname  TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 世界信息变更历史
CREATE TABLE IF NOT EXISTS world_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL,
  field TEXT NOT NULL,           -- name / description / author_name / image_url / release_status / capacity / tags
  old_value TEXT,
  new_value TEXT,
  changed_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_world_history_world ON world_history(world_id);

-- 世界中文简介翻译（用户个人数据，本地存储不随仓库分发；get_my_favorite_worlds 输出 zhDescription）
CREATE TABLE IF NOT EXISTS world_zh_translations (
  world_id TEXT PRIMARY KEY,
  zh TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 群组信息缓存（周报/活动日历用，TTL 7 天）
CREATE TABLE IF NOT EXISTS group_cache (
  group_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  member_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- PlanetVRC 抓取结果 TTL 缓存（推荐融合用；排行/搜索页 6h、详情页 24h，调用方传 TTL）
CREATE TABLE IF NOT EXISTS planet_cache (
  key TEXT PRIMARY KEY,
  payload TEXT,                  -- JSON 字符串
  fetched_at TEXT                -- 写入时间 ISO 8601
);

-- 本地世界知识库（world_kb）：世界追踪 + 用户状态表
-- 原表名 new_worlds（2026-08-16 更名）：实际承担「世界知识 + 用户状态」——
-- 扫描追踪（scan_new_worlds 维护热度快照）、user_rating 反馈、visited 逛过标记、
-- sleep_ok 睡觉图、backlog 待逛列表均在此表。MCP 工具名 scan_new_worlds/get_new_worlds
-- 为 API 契约保留原名，仅表名更名。
CREATE TABLE IF NOT EXISTS world_kb (
  world_id TEXT PRIMARY KEY,
  world_name TEXT NOT NULL DEFAULT '',
  author_name TEXT DEFAULT '',
  author_id TEXT DEFAULT '',     -- 世界作者 ID（作者维度推荐用）
  created_at TEXT,               -- 世界创建时间（API）
  first_seen_at TEXT,            -- 首次被本工具记录的时间
  favorites INTEGER DEFAULT 0,   -- 最近一次抓取时的收藏数（热度）
  occupants INTEGER DEFAULT 0,   -- 在线人数
  popularity INTEGER DEFAULT 0,
  visited INTEGER DEFAULT 0,     -- 用户是否逛过（1=逛过）
  visited_at TEXT,               -- 逛过的时间（若已逛）
  tags TEXT DEFAULT '',          -- 作者标签 JSON 数组（author_tag_*，主题分类用）
  description TEXT DEFAULT '',   -- 世界描述（主题关键词匹配用）
  source TEXT DEFAULT 'new',     -- 来源: new=新发布-推荐 / hot=热门图追加
  user_rating INTEGER DEFAULT 0,  -- 用户反馈: -1=烂图(junk) / 0=无标记 / 1=好图（recommend 评分加权用）
  backlog INTEGER DEFAULT 0,          -- 待逛列表标记（1=在待逛列表，本地待办）
  backlog_added_at TEXT,              -- 加入待逛列表时间
  backlog_reason TEXT DEFAULT '',     -- 想逛的理由/备注（可空）
  backlog_priority INTEGER DEFAULT 0  -- 待逛优先级: 0=普通 / 1=优先 / 2=强烈想逛
);
CREATE INDEX IF NOT EXISTS idx_world_kb_visited ON world_kb(visited);


-- 推荐选择学习（recommend_join 用户选择记录，个性化权重学习的数据源）
-- 每次用户从推荐列表选择某人/某图记录一条快照，含当时列表基线用于对比分析
CREATE TABLE IF NOT EXISTS join_choices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  user_id TEXT DEFAULT '',          -- 被选择的好友 userId
  display_name TEXT DEFAULT '',     -- 被选择的好友显示名
  world_id TEXT DEFAULT '',
  world_name TEXT DEFAULT '',
  instance_type TEXT DEFAULT '',    -- public/friends/hidden/group
  instance_users INTEGER DEFAULT 0,
  instance_capacity INTEGER DEFAULT 0,
  fill_ratio REAL DEFAULT 0,
  familiarity_score INTEGER DEFAULT 0,
  is_quiet_world INTEGER DEFAULT 0,
  recommend_score INTEGER DEFAULT 0,
  rank_in_list INTEGER DEFAULT 0,   -- 在推荐列表中的排名（1=第一）
  list_count INTEGER DEFAULT 0,     -- 当时列表长度
  list_avg_users REAL DEFAULT 0,    -- 当时列表平均人数（基线）
  list_avg_fill REAL DEFAULT 0,     -- 当时列表平均填充率（基线）
  list_quiet_ratio REAL DEFAULT 0,  -- 当时列表安静图占比（基线，0-1）
  world_tags TEXT DEFAULT ''        -- 被选世界的 author_tag_* 标签 JSON 数组（类型偏好学习用）
);
CREATE INDEX IF NOT EXISTS idx_join_choices_created ON join_choices(created_at);

-- BOOTH 商品快照缓存（search_booth_items / get_booth_item 命中时 upsert，Issue #28）
-- 目的：搜过的商品事后可查、收藏数趋势跟踪、重复搜索走缓存避免触发 booth.pm 限流
CREATE TABLE IF NOT EXISTS booth_items (
  id TEXT PRIMARY KEY,               -- BOOTH item id（字符串，兼容数字）
  name TEXT NOT NULL DEFAULT '',
  price TEXT DEFAULT '',             -- 原价格字符串（¥ 5,500 / ¥ 500~ 多档变体）
  wishlist_count INTEGER DEFAULT 0,  -- 收藏数（BOOTH 唯一公开热度信号）
  shop_name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  tags TEXT DEFAULT '',              -- JSON 数组
  image_url TEXT DEFAULT '',         -- 首图 original URL
  url TEXT DEFAULT '',
  published_at TEXT DEFAULT '',
  is_sold_out INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_booth_items_wishlist ON booth_items(wishlist_count);

-- BOOTH 搜索历史（记录搜索词与结果，支持"查历史搜索"）
CREATE TABLE IF NOT EXISTS booth_search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  result_ids TEXT DEFAULT '',        -- JSON 数组（商品 id 列表）
  result_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_booth_search_created ON booth_search_history(created_at);
