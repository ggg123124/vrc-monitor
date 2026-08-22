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
        ├── config 表（本地配置键值对：推荐偏好/分组权重等）
        ├── world_kb 表（本地世界知识库：新世界追踪 + 用户状态 rating/visited/backlog）
        ├── join_choices 表（推荐选择学习）
        ├── group_cache 表（群组信息缓存）
        ├── world_history 表（世界信息变更记录）
        ├── world_zh_translations 表（中文简介翻译缓存）
        ├── planet_cache 表（PlanetVRC 世界信息缓存）
        ├── booth_items 表（BOOTH 商品快照缓存）
        └── booth_search_history 表（BOOTH 搜索历史）
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
| `storage.js` | 1508 | SQLite 封装层。所有数据库读写通过此模块。WAL 模式即时落盘。含迁移逻辑（ALTER TABLE ADD COLUMN 幂等）、同屏/见面分析、推荐评分查询 | `Storage` 类 |
| `ws-manager.js` | 359 | WebSocket 连接生命周期。指数退避重连（1s→60s）、心跳保活（30s ping）、认证冷却（401 → 5min，普通失败 → 120s）、直连优先+代理回退、TOTP/2FA 重连处理 | `WsManager` 类 |
| `event-pipeline.js` | 303 | WebSocket 事件标准化与持久化。按事件类型分发处理（friend-online/offline/location/update、user-location、notification 等），更新 friends 表 + 写入 events 表 | `EventPipeline` 类 |
| `friend-state.js` | 113 | 好友在线状态内存缓存。O(1) 查询在线好友，重连后批量刷新。含状态变化监听器 | `FriendStateManager` 类 |
| `rate-limiter.js` | 81 | VRChat API 请求限流器。默认 2.6s 间隔，队列+并发控制，防止触发 API 限流 | `RateLimiter` 类 |
| `vrchat-launch.js` | 148 | 打开实例统一入口。Windows 命名管道直发（游戏内弹菜单）→ 探测失败静默回退 API 自我邀请。平台门控 + 超时保护 | `openInstance()` 函数（默认导出含 `launchViaPipe` / `inviteSelfViaApi` / `buildLaunchUrl` / `isPipeSupported` / `LAUNCH_PIPE`） |
| `new-worlds.js` | 94 | 新世界扫描核心逻辑。垃圾过滤、热度评分、分类、翻页拉取。不含认证/数据库副作用，MCP handler 与 CLI 共用 | `isJunkWorld` / `worldScore` / `classifyWorlds` / `fetchFreshWorlds` |
| `recommend-worlds.js` | 488 | 多源融合世界推荐核心逻辑。作者画像构建、候选收集（local/planet/official）、评分（热度+新鲜度+主题+反馈）、可解释 reasons | `recommendWorlds` / `collectCandidates` / `scoreCandidate` / `buildAuthorProfile` |
| `fetch-x-worlds.js` | 650 | X 博主世界推荐抓取。RSS 抓取、推文解析、世界收藏/浏览统计入库、博主清单管理 | `fetchCreatorRss` / `scanCreatorWorlds` / `getWorldDigest` / `addCreator` / `removeCreator` |
| `world-names.js` | 115 | 世界名批量解析（缓存→API→写回→负缓存）。配合同屏/见面分析避免 N+1 | `resolveWorldNames` / `resolveWorldName` |
| `theme-config.js` | 51 | 主题关键词配置（sleep/chat/onsen/game/default 等）+ 正则编译 | `DEFAULT_THEME_CONFIG` / `getThemeRegex` |
| `backup.js` | 73 | 数据库在线备份。better-sqlite3 `db.backup()` API，WAL 模式无需停机。保留最近 2 份，旧备份自动清理 | `backupDatabase()` 函数 |
| `mcp-definitions.js` | 1056 | MCP 工具定义。name + description + inputSchema 纯数据，无运行时依赖 | `CUSTOM_TOOLS` 数组 |
| `safe-mode.js` | 52 | 安全模式。`VRC_MONITOR_SAFE_MODE=true` 时从 `tools/list` 剔除并拦截 `tools/call` 破坏性工具（删除/移除/退出/清除类），防御误删 | `DESTRUCTIVE_TOOLS` / `isSafeModeEnabled` / `filterTools` / `assertToolAllowed` |
| `server-context.js` | 66 | 共享上下文。可变 `ctx` 对象持有所有运行时状态（storage/api/rateLimiter/wsManager 等），`log()`、`parseLocation()`、watchlist 内存缓存管理 | `ctx` / `log` / `parseLocation` / `refreshWatchlistCache` / `invalidateWatchlistCache` |
| `http-server.js` | 152 | HTTP 服务器 + SSE 端点。McpSession 管理、`sendSSE`/`sendError` 响应辅助、`/health` + `/mcp` 请求路由 | `createServer` / `sendSSE` / `sendError` |
| `rpc-router.js` | 538 | RPC 分发。`handleRpc` 将 `tools/call` 映射到对应 handler，3 个内联 case（send_boop/send_invite/request_invite）直接访问 ctx.api | `handleRpc` |
| `otp-fetcher.js` | 23 | OTP 邮箱获取。调用 `fetch-otp.py` 从邮箱 IMAP 抓取验证码 | `fetchOtpFromEmail` |
| `totp.js` | 118 | RFC 6238 TOTP 生成（纯 Node crypto 零依赖）。URI/base32 解析、时钟窗口容错、参数合法性校验 | `parseTotpSecret` / `generateTotp` / `getTotpCodes` |
| `notifier.js` | 111 | 登录状态通知中心。needsTotp/otpFailed/reauthFailed/recovered 事件通知、去抖聚合、通道可插拔注册 | `notifier` 实例 |
| `notify-channels.js` | 97 | 跨平台通知通道：desktop（notify-send/osascript/PowerShell toast）+ webhook（POST JSON）。fail-safe 静默降级 | `buildChannels` |
| `vrcx-db-paths.js` | 61 | VRCX 数据库路径自动探测（Windows/Linux/macOS，含 Wine） | `findVrcxDb` / `candidateVrcxDbPaths` |
| `init-db.sql` | 204 | 数据库 DDL（建表语句）。幂等写法（IF NOT EXISTS），`storage.js` 初始化时执行 | — |
| `init-x-worlds.sql` | 22 | X 博主世界推荐相关表 DDL（幂等） | — |

## core/handlers/ 子目录

各 MCP 工具的 handler 按功能域分拆到 16 个文件，共享 `ctx` 上下文：

| 文件 | 行数 | 工具域 | 导出函数数 |
|------|------|--------|----------|
| `recommend.js` | 778 | 推荐系统（好友收藏位置/推荐加入/偏好/选择学习） | 6 |
| `friends.js` | 270 | 好友查询（在线/详情/搜索/共同好友/添加/删除） | 6 |
| `instance.js` | 101 | 实例操作（创建/自我邀请/打开世界） | 3 |
| `events.js` | 363 | 事件历史（好友事件/最近事件/世界名/周报/资料变更/好友对同屏见面） | 10 |
| `groups.js` | 353 | 群组操作（查询/搜索/加入/退出/窥探公告/热度） | 10 |
| `media.js` | 282 | 媒体（Boop emoji/Print 相册/Gallery 图库上传下载删除） | 10 |
| `misc.js` | 332 | 杂项（数据库统计/服务状态/新世界扫描/关注名单/同屏/上线规律/昵称/备份/待逛/评分） | 17 |
| `booth.js` | 200 | BOOTH 素材检索（搜索/详情/历史/搜索记录） | 4 |
| `favorite-worlds.js` | 265 | 收藏世界（我的收藏世界/收藏分组） | 2 |
| `favorites.js` | 49 | 收藏世界写操作（favorite_world） | 1 |
| `friend-favorites.js` | 155 | 好友收藏分组管理（查询/添加/移除/移动，favorites type=friend） | 4 |
| `notifications.js` | 98 | 通知收件箱（读取/已读/隐藏/接受/拒绝好友请求，旧 v1 通知系统） | 5 |
| `auth.js` | 40 | 认证兜底（submit_totp 手动提交验证码） | 1 |
| `planet.js` | 156 | PlanetVRC 检索/推荐 | 2 |
| `recommend-worlds.js` | 32 | 多源世界推荐（薄封装，核心在 core/recommend-worlds.js） | 1 |
| `x-worlds.js` | 63 | X 博主推荐（摘要/扫描/清单/增删） | 6 |

## start-monitor.js 内部分区

`start-monitor.js` 是薄入口（~360 行），仅保留启动流程与 WS 事件处理：

| 区域 | 行范围（约） | 职责 |
|------|-------------|------|
| import + .env + 路径常量 | 1-60 | 模块 import、`.env` 解析（只取 `VRC_MONITOR_*`）、路径常量 → `ctx.paths`、端口/备份间隔常量 |
| WS 事件处理 | 62-108 | `_updateFriendState` / `_refreshOnlineState`（使用 `ctx.friendState` / `ctx.api`） |
| 端口占用探测 | 110-120 | `net.connect` 探测 8799，已占用则提示排查并退出（防双实例互抢 OTP） |
| 启动主流程 | 124-326 | `main()`：初始化 DB → API 认证（OTP/TOTP 自动链）→ WS → 定时备份 → HTTP 监听，实例赋值给 `ctx.storage` / `ctx.api` 等 |
| 优雅关闭 | 328-347 | SIGINT/SIGTERM 处理（关闭 WS、收尾 SQLite 事务） |
| 全局异常兜底 | 349-357 | uncaughtException/unhandledRejection 兜底（防僵尸进程 + 端口残留） |

## 依赖关系图

```
start-monitor.js
  ├── core/server-context.js  (ctx, log, parseLocation, watchlist cache)
  ├── core/mcp-definitions.js  (CUSTOM_TOOLS 纯数据)
  ├── core/http-server.js      (createServer, SSE 辅助)
  │     └── core/rpc-router.js (handleRpc)
  │           ├── core/safe-mode.js（安全模式：tools/list 过滤 + tools/call 拦截）─┐
  │           ├── core/handlers/*（16 个文件，按功能域分拆）─┐
  │           └── core/notifier.js                          ├── server-context.js
  ├── core/otp-fetcher.js      （fetch-otp.py 调用）
  ├── core/totp.js             （RFC 6238 TOTP 生成）
  ├── core/notifier.js + notify-channels.js  （登录状态主动通知）
  └── (existing core/ modules: storage, ws-manager, event-pipeline, friend-state,
       rate-limiter, vrchat-launch, new-worlds, recommend-worlds, fetch-x-worlds,
       world-names, backup, theme-config 等)
```

> rpc-router.js 导入 `sendSSE`/`sendError` from http-server.js，http-server.js 导入 `handleRpc` from rpc-router.js — ESM live binding 支持此循环依赖，运行时调用无问题。

## 数据库 Schema 概览

| 表 | 用途 | 关键字段 |
|----|------|----------|
| `events` | WebSocket 事件流 + 迁移历史 | type, user_id, content_json, world_id, created_at, source |
| `friends` | 好友当前状态快照 | user_id(PK), display_name, is_online, location, last_seen |
| `world_cache` | 世界名+元数据缓存（懒刷新） | world_id(PK), name, note, author_name, tags, favorited |
| `nicknames` | 本地昵称映射 | user_id(PK), nickname, display_name |
| `watchlist` | 关注名单 | user_id(PK), priority |
| `config` | 本地配置键值对（推荐偏好/分组权重等） | key(PK), value |
| `world_kb` | 本地世界知识库（新世界追踪 + 用户状态：rating/visited/backlog） | world_id(PK), favorites, visited, tags, user_rating, backlog |
| `join_choices` | 推荐选择学习数据 | user_id, world_id, recommend_score, rank_in_list |
| `group_cache` | 群组信息缓存（周报用，TTL 7 天） | group_id(PK), name, member_count |
| `world_history` | 世界信息变更记录 | world_id, field, old_value, new_value |
| `world_zh_translations` | 中文简介翻译缓存 | world_id(PK), zh, updated_at |
| `planet_cache` | PlanetVRC 世界信息缓存 | key(PK), payload(JSON), fetched_at |
| `booth_items` | BOOTH 商品快照缓存 | id(PK), name, price, wishlist_count, ... |
| `booth_search_history` | BOOTH 搜索历史 | id, query, result_ids(JSON), ... |

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
| Agent Skill | `skills/` | 7 份开箱即用的 skill 文档（vrc-monitor-agent 工具表总纲 + 社交/世界/群组/BOOTH 域工作流 + 开发规范 + 审核工作流） |
