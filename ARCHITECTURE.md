# 系统架构

> 本文档面向需要理解系统内部结构的 AI Agent。部署配置见 [AGENTS.md](./AGENTS.md)，开发约束见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 数据流总览

```
VRChat WebSocket (wss://pipeline.vrchat.cloud)
        │
        ▼
  ws-manager.js ─── 认证/token 刷新/心跳/重连
        │
        ▼
  event-pipeline.js ─── 事件标准化 + 世界名解析
        │
        ▼
  storage.js (SQLite, WAL 模式)
        │
        ├── events 表（事件流：上下线/位置/Avatar/状态/Bio 变更）
        ├── friends 表（好友当前状态快照）
        ├── world_cache 表（世界名+元数据缓存）
        ├── nicknames 表（本地昵称映射）
        ├── watchlist 表（关注名单）
        ├── new_worlds 表（新世界追踪）
        ├── join_choices 表（推荐选择学习）
        ├── group_cache 表（群组信息缓存）
        └── world_history 表（世界信息变更记录）
        │
        ▼
  MCP tools/call (HTTP SSE, :8799/mcp)
        │
        ▼
  Hermes Agent / 任意 MCP 客户端
```

## core/ 模块职责

| 模块 | 行数 | 职责 | 关键导出 |
|------|------|------|----------|
| `storage.js` | 805 | SQLite 封装层。所有数据库读写通过此模块。WAL 模式即时落盘。含迁移逻辑（ALTER TABLE ADD COLUMN 幂等） | `Storage` 类 |
| `ws-manager.js` | 345 | WebSocket 连接生命周期。指数退避重连（1s→60s）、心跳保活（30s ping）、认证冷却（401 → 5min，普通失败 → 120s）、直连优先+代理回退 | `WsManager` 类 |
| `event-pipeline.js` | 217 | WebSocket 事件标准化与持久化。按事件类型分发处理（friend-online/offline/location/update、user-location、notification 等），更新 friends 表 + 写入 events 表 | `EventPipeline` 类 |
| `friend-state.js` | 114 | 好友在线状态内存缓存。O(1) 查询在线好友，重连后批量刷新。含状态变化监听器 | `FriendStateManager` 类 |
| `rate-limiter.js` | 82 | VRChat API 请求限流器。默认 2.6s 间隔，队列+并发控制，防止触发 API 限流 | `RateLimiter` 类 |
| `vrchat-launch.js` | 149 | 打开实例统一入口。Windows 命名管道直发（游戏内弹菜单）→ 探测失败静默回退 API 自我邀请。平台门控 + 超时保护 | `openInstance()` 函数 |
| `new-worlds.js` | 92 | 新世界扫描核心逻辑。垃圾过滤、热度评分、分类、翻页拉取。不含认证/数据库副作用，MCP handler 与 CLI 共用 | `isJunkWorld` / `worldScore` / `classifyWorlds` / `fetchFreshWorlds` |
| `backup.js` | 74 | 数据库在线备份。better-sqlite3 `db.backup()` API，WAL 模式无需停机。保留最近 2 份，旧备份自动清理 | `backupDatabase()` 函数 |
| `mcp-definitions.js` | 640 | MCP 工具定义。55 个工具的 name + description + inputSchema 纯数据，无运行时依赖 | `CUSTOM_TOOLS` 数组 |
| `server-context.js` | 66 | 共享上下文。可变 `ctx` 对象持有所有运行时状态（storage/api/rateLimiter/wsManager 等），`log()`、`parseLocation()`、watchlist 内存缓存管理 | `ctx` / `log` / `parseLocation` / `refreshWatchlistCache` / `invalidateWatchlistCache` |
| `http-server.js` | 140 | HTTP 服务器 + SSE 端点。McpSession 管理、`sendSSE`/`sendError` 响应辅助、`/health` + `/mcp` 请求路由 | `createServer` / `sendSSE` / `sendError` |
| `rpc-router.js` | 341 | RPC 分发。`handleRpc` 将 `tools/call` 映射到对应 handler，3 个内联 case（send_boop/send_invite/request_invite）直接访问 ctx.api | `handleRpc` |
| `otp-fetcher.js` | 22 | OTP 邮箱获取。调用 `fetch-otp.py` 从邮箱 IMAP 抓取验证码 | `fetchOtpFromEmail` |
| `init-db.sql` | 145 | 数据库 DDL（建表语句）。幂等写法（IF NOT EXISTS），`storage.js` 初始化时执行 | — |

## core/handlers/ 子目录

55 个 MCP 工具的 handler 按功能域分拆到 7 个文件，共享 `ctx` 上下文：

| 文件 | 行数 | 工具域 | 导出函数数 |
|------|------|--------|----------|
| `recommend.js` | 778 | 推荐系统（好友收藏位置/推荐加入/偏好/选择学习） | 6 |
| `friends.js` | 188 | 好友查询（在线/详情/搜索/共同好友/添加/删除） | 6 |
| `instance.js` | 101 | 实例操作（创建/自我邀请/打开世界） | 3 |
| `events.js` | 251 | 事件历史（好友事件/最近事件/世界名/周报） | 6 |
| `groups.js` | 253 | 群组操作（查询/搜索/加入/退出/窥探公告） | 9 |
| `media.js` | 282 | 媒体（Boop emoji/Print 相册/Gallery 图库上传下载） | 10 |
| `misc.js` | 231 | 杂项（数据库统计/服务状态/新世界扫描/关注名单/同屏/上线规律/昵称/备份） | 12 |

## start-monitor.js 内部分区

`start-monitor.js` 是薄入口（~200 行），仅保留启动流程与 WS 事件处理：

| 区域 | 行范围（约） | 职责 |
|------|-------------|------|
| import + 路径常量 | 1-40 | 模块 import、路径常量 → `ctx.paths`、.env 解析（只取 `VRC_MONITOR_*`） |
| WS 事件处理 | 41-100 | `_updateFriendState` / `_refreshOnlineState`（使用 `ctx.friendState` / `ctx.api`） |
| 启动主流程 | 102-220 | `main()`：初始化 DB → API 认证 → WS → 定时备份 → HTTP 监听，实例赋值给 `ctx.storage` / `ctx.api` 等 |
| 优雅关闭 + 异常兜底 | 222-264 | SIGINT/SIGTERM 处理、uncaughtException/unhandledRejection 兜底 |

## 依赖关系图

```
start-monitor.js
  ├── core/server-context.js  (ctx, log, parseLocation, watchlist cache)
  ├── core/mcp-definitions.js  (CUSTOM_TOOLS 纯数据)
  ├── core/http-server.js      (createServer, SSE 辅助)
  │     └── core/rpc-router.js (handleRpc)
  │           ├── core/handlers/recommend.js ──┐
  │           ├── core/handlers/friends.js      ├── server-context.js
  │           ├── core/handlers/instance.js     │
  │           ├── core/handlers/events.js       │
  │           ├── core/handlers/groups.js      ─┤
  │           ├── core/handlers/media.js       ─┤
  │           └── core/handlers/misc.js        ─┘
  ├── core/otp-fetcher.js
  └── (existing core/ modules: storage, ws-manager, etc.)
```

> rpc-router.js 导入 `sendSSE`/`sendError` from http-server.js，http-server.js 导入 `handleRpc` from rpc-router.js — ESM live binding 支持此循环依赖，运行时调用无问题。

## 数据库 Schema 概览

| 表 | 用途 | 关键字段 |
|----|------|----------|
| `events` | WebSocket 事件流 + 迁移历史 | type, user_id, content_json, world_id, created_at, source |
| `friends` | 好友当前状态快照 | user_id(PK), display_name, is_online, location, last_seen |
| `world_cache` | 世界名+元数据缓存（懒刷新） | world_id(PK), name, note, author_name, tags |
| `nicknames` | 本地昵称映射 | user_id(PK), nickname, display_name |
| `watchlist` | 关注名单 | user_id(PK), priority |
| `new_worlds` | 新世界追踪 | world_id(PK), favorites, visited, tags |
| `join_choices` | 推荐选择学习数据 | user_id, world_id, recommend_score, rank_in_list |
| `group_cache` | 群组信息缓存（周报用，TTL 7 天） | group_id(PK), name, member_count |
| `world_history` | 世界信息变更记录 | world_id, field, old_value, new_value |
| `config` | 本地配置键值对 | key(PK), value |

## 外部依赖

| 依赖 | 用途 | 备注 |
|------|------|------|
| `better-sqlite3` | SQLite 原生绑定 | WAL 模式，崩溃安全，支持并发读。ARM/Alpine 需确认 prebuilt |
| `ws` | WebSocket 客户端 | 连接 VRChat pipeline |
| `https-proxy-agent` | HTTPS 代理 | WS 直连失败后回退代理 |
| `fetch-otp.py` | 邮箱 IMAP OTP 抓取 | Python 脚本，由 Node `execFileSync` 调用 |

## 外部集成

| 集成 | 位置 | 说明 |
|------|------|------|
| Hermes 插件 | `hermes-plugin/` | 进程托管：on_session_start 自动拉起、崩溃自愈、vrc_status 等管理工具。仅 Windows |
| 桌面插件 | `desktop/plugin.js` | GUI 配置入口：填写凭据、查看状态 |
| Dashboard 后端 | `hermes-plugin/dashboard/` | `/status` `/credentials` `/doctor` 等 API 路由 |
| Agent Skill | `skills/` | 2 份开箱即用的 skill 文档（查询工作流 + 同屏查询陷阱） |
