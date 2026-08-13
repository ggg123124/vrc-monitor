-- X 博主世界推荐追踪（x_world_digest MCP 工具维护）
-- 博主清单存 config 表 key='x_creators'（JSON 数组）
-- 推荐世界存本表（跨博主去重累积）

CREATE TABLE IF NOT EXISTS x_world_recommendations (
  world_id TEXT PRIMARY KEY,
  world_name TEXT NOT NULL DEFAULT '',
  author_name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  favorites INTEGER DEFAULT 0,
  visits INTEGER DEFAULT 0,
  popularity INTEGER DEFAULT 0,
  capacity INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',
  first_seen_at TEXT DEFAULT (datetime('now')),      -- 首次被任一博主推荐
  last_recommended_at TEXT DEFAULT (datetime('now')), -- 最近一次被推荐
  creators TEXT DEFAULT '[]',                        -- 推荐记录 JSON: [{screen_name, name, tweet_id, tweet_time, tweet_url}]
  tweet_count INTEGER DEFAULT 0                      -- 累计推荐次数
);
CREATE INDEX IF NOT EXISTS idx_x_world_rec_last ON x_world_recommendations(last_recommended_at);
CREATE INDEX IF NOT EXISTS idx_x_world_rec_fav ON x_world_recommendations(favorites);
