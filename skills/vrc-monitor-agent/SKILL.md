---
name: vrc-monitor-agent
description: "Use for VRChat friend queries (online status, who played with whom, activity timelines, online patterns) and VRChat social actions (boop, invite, join world, friend management, group operations, image uploads) via the vrc-monitor MCP server on port 8799."
version: 1.1.0
metadata:
  hermes:
    tags: [vrchat, gaming, social, mcp, monitoring]
---

# vrc-monitor Agent Skill — 好友监控系统使用指南

本 skill 面向**任何 AI Agent**：当用户询问 VRChat 好友相关问题（谁在线、谁和谁一起玩、某人的活动时间线、上线规律）时，通过 `vrc-monitor` 的 MCP 接口查询。安装配置见项目根 `AGENTS.md` / `README.md`。

> ⚠️ **Agent 义务**：使用中发现本软件代码存在漏洞 / bug（功能异常、数据损坏风险、安全隐患等），应主动提交 issue + PR 修复让所有使用者受益，详见项目根 `AGENTS.md`「发现漏洞 / 缺陷时」小节与 `DEVELOPMENT.md` §1。

- MCP 端点：`http://127.0.0.1:8799/mcp`
- 服务启动：项目目录下 `node start-monitor.js`（首次需配置 `credentials.json`，见 AGENTS.md）
- 数据库：本地 SQLite（WebSocket 实时采集事件，含历史上线/位置/同屏记录）

## MCP 工具（55 个）

| 工具 | 说明 |
|------|------|
| `get_online_friends` | 当前在线好友列表（含昵称 nickname + 房型解析 locationParsed：worldId/instanceId/type/ownerId/region） |
| `get_friend_info` | 好友详细信息 |
| `search_users` | 按名字搜索用户 |
| `search_groups` | 按名字搜索群组（API 用 query 参数，不是 search） |
| `search_worlds` | 按名字搜索世界（英文/日文走 API；中文自动加本地缓存兜底） |
| `search_planet_worlds` | **PlanetVRC 地图检索**（planetvrchat.net 日文世界目录）：关键词搜索 → 世界名/wrld_id/平台/分类/收藏数；适合 VRChat API 搜不到的日文/小众图。limit 最大 8（每个结果抓详情页补 wrld_id，约 1-2s/个） |
| `recommend_planet_worlds` | **PlanetVRC 推荐排行**：sort=popular（访问者数最多）/ new（最新发布）/ updated（最新更新）→ 世界+wrld_id+最大人数+访问量+收藏数+公开日 |
| `backup_database` | 立即备份数据库（WAL 在线备份，保留最近 2 份到 backups/）；服务启动 + 每 24h 自动备份 |
| `get_friend_events` | 某好友的事件历史（本地库） |
| `get_recent_events` | 最新事件流 |
| `get_companions` | **同屏交叉查询**（指定时间窗口内同实例的好友；可查自己或任意好友） |
| `get_online_pattern` | **上线规律分析**（上线/下线/活跃时段分布 + 活跃天数/频率 + 峰值建议） |
| `get_world_name` | 世界信息查询（懒刷新：缓存命中直接返回，forceRefresh 才走 API；含作者/容量/简介/标签/用户备注 note） |
| `set_world_note` | 世界用户备注写入/更新（本地存储，API 刷新不覆盖；空串清除） |
| `get_world_history` | 世界信息变更历史（name/description/author/image_url/release_status/capacity/tags 字段级记录） |
| `get_weekly_report` | 一周游戏周报（活跃天数/时长/世界 Top/同屏伙伴带昵称/自己的上线规律/群组活动/圈内活动日历；days 默认 7） |
| `scan_new_worlds` | 扫描最近 N 天新世界（1-30，默认 7），过滤测试/垃圾图后写入 new_worlds 表，按热度推荐 TOP10；dryRun 只看不写 |
| `get_new_worlds` | 只读查询已跟踪新世界：onlyUnvisited 只看未逛过、sortBy（favorites/occupants/popularity/created_at）、limit（默认 10 最大 50） |
| `get_nicknames` / `set_nickname` | 好友昵称映射（查询/写入，本地库） |
| `get_mutual_friends` | 共同好友列表：你与目标用户（userId 或 displayName 精确匹配）的共同好友，自动带本地昵称 |
| `get_watchlist` / `add_to_watchlist` / `remove_from_watchlist` | 关注名单 |
| `send_boop` | 戳一戳好友（Boop），对方收到戳戳通知（参数：userId 必填、emojiId 可选） |
| `get_boop_emojis` | 列出内置 boop 表情（65 个）及 emojiId 格式（`default_<name>`） |
| `upload_emoji` | 上传自定义 boop 表情（需 VRChat Plus；imagePath 必填，animated/animationStyle 可选） |
| `upload_print` | 上传照片到 VRChat 相册 Prints（需 VRC+；imagePath 必填，note 可选备注） |
| `upload_gallery_image` | 上传图片到 VRC+ 图库 Gallery（需 VRC+；imagePath 必填） |
| `get_prints` | 相册照片列表（含 downloadUrl 直链） |
| `get_gallery_images` | 图库图片列表（含 downloadUrl 直链） |
| `download_print` | 从相册下载照片到本地（printId 必填；返回路径可 MEDIA: 发送） |
| `download_gallery_image` | 从图库下载图片到本地（fileId 必填；返回路径可 MEDIA: 发送） |
| `remove_print` | 删除相册照片（不可逆！必须 confirm: true） |
| `remove_gallery_image` | 删除图库图片（不可逆！必须 confirm: true） |
| `send_invite` | 邀请好友加入你当前所在房间（拉人进房；userId/worldId/instanceId 必填、message 可选） |
| `request_invite` | 请求好友邀请你加入 TA 的房间（userId 必填、message 可选，默认 "Can I join you?"） |
| `create_instance` | **创建新实例（房间）**：worldId 必填、type（默认 hidden）/region（默认 jp）可选；⚠️ 非 public 必须带 ownerId=当前用户（否则 400 "Invalid owner ID"，2026-08-09 实测，官方文档没写）；返回 location 可直接给 invite_myself |
| `invite_myself` | **打开指定实例**（与 open_world 同一引擎）：管道直发优先（Windows 游戏内静默弹菜单），失败静默回退 API 自我邀请（通知接受后传送）；location（worldId:instanceId）或 worldId+instanceId；forceApi 强制走 API |
| `open_world` | **一键打开世界/实例**：worldId（自动建实例）或 location（完整实例串直接开）；core/vrchat-launch.js openInstance 统一入口——命名管道直发（游戏内静默弹加入菜单，Windows 1 步直达）失败静默回退 API 自我邀请；forceApi 强制走 API |
| `send_friend_request` | 发送好友请求（添加好友；userId 直接加 或 displayName 精确匹配不区分大小写，二选一） |
| `remove_friend` | 删除好友（不可逆！userId 或 displayName 精确匹配，必须传 confirm: true 才执行，否则只预览目标） |
| `get_server_status` | 服务/认证状态 |
| `get_database_stats` | 数据库统计 |
| `get_user_groups` | 用户加入的群组列表（`userId` 可选，省略 = 当前账号；`withDetails: true` 批量带简介；`GET /users/{userId}/groups`） |
| `get_group_info` | 群组详情（名称/成员数/shortCode/描述/认证状态/joinState(open/request/invite)；`includeAnnouncement: true` 附带公告，非成员为 null） |
| `get_group_instances` | **群组当前开的房**（group rooms）：instanceId/location/memberCount + 世界信息；空 = 没开房。适合"XX 群今晚有没有活动房"类问题 |
| `get_group_announcement` | 群组公告（title/text/作者/时间；无公告或非成员返回 null 不报错） |
| `get_group_heat` | **群组热度**：群组房活动热度榜（活动次数/活跃好友/世界数/成员数/趋势）+ 前 topK 群（星期×小时）热力图；`grp_`/`gmem_` 兼容 |
| `join_group` | 加入群组（open 群直接加入；已是成员返回 alreadyMember:true；`groupId` 必填） |
| `leave_group` | 退出群组（`POST /groups/{id}/leave`；必须 `confirm: true`；非成员返回 notMember） |
| `peek_group_announcement` | **窥探群公告**：一键「加入→读公告→退出」，仅对 open 群生效，需 `confirm: true` |
| `get_favorite_friends_locations` | **好友收藏夹位置**：列出收藏分组内好友当前位置（支持 `searchName` 按名直查），按推荐度排序，private 自动排除 |
| `recommend_join` | **推荐加入**：全部在线好友综合评分推荐（熟悉度 + 收藏夹权重 + 圿间场景 + 实例人数/类型） |
| `set_join_preference` | 设置推荐偏好（自然语言，如「我不喜欢人太多」→ 爆满重罚） |
| `get_join_preference` | 查询当前推荐偏好 |
| `record_join_choice` | 记录一次推荐选择（自动补全上下文，≥5 次后自动学习权重） |
| `get_join_learning` | 查看选择学习状态与生效的权重调整 |

调用方式（HTTP SSE JSON-RPC）：

```bash
curl -s http://127.0.0.1:8799/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<工具名>","arguments":{...}}}'
```

响应是 SSE 格式，取 `data:` 行，解析 `result.content[0].text` 为 JSON。

## 核心查询工作流

### 1. "XX 现在和谁一起？" / 同实例好友

```
1. get_friend_info(userId=目标) → 取 location 字段（如 "wrld_xxx:77182~hidden(usr_owner)~region(jp)"）
2. get_online_friends() → 所有在线好友的位置
3. 按完整 location 字符串匹配 → 同实例的好友
4. 从 location 解析 owner：hidden(usr_xxx)/private(usr_xxx)/friends(usr_xxx)/group(grp_xxx)
5. get_world_name(worldId) → 世界名（location.split(':')[0]）
```

- 只能看到你也是好友的人（API 限制）
- `~hidden(usr_A)` = A 的隐藏房；`~private(usr_B)` = B 的私密房；`~friends(usr_C)` = C 的好友房

### 2. "XX 今天/某天和谁一起玩过？" → `get_companions`

**不要委派子 agent 做同屏查询**——子 agent 只会查少量已知 userId，会漏掉其他人。直接用 MCP 工具：

```bash
curl -s http://127.0.0.1:8799/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_companions","arguments":{"startTime":"2026-08-01T11:00:00Z","endTime":"2026-08-01T17:00:00Z","userId":"<目标userId>"}}}'
```

- `startTime`/`endTime`：ISO 8601 UTC（北京时间 -8h），窗口 ≤24h
- `userId`：**可查自己（默认，即登录账号）或任意好友**——传好友 ID = "XX 和谁一起玩过"
- 原理：查目标用户的 location 事件 → 提取 worldId:instanceId → 全量比对好友 location 事件 → 排除目标本人 → 按 userId 分组
- 返回每个同屏好友的 matchCount（同屏次数）、worlds（世界列表）

### 3. "某天活动时间线" / "XX 和 YY 昨晚同房吗"

```
1. get_friend_events(userId=A, types="friend-location", limit=5) → 最近位置变化
   - created_at 是 UTC，+8 转北京时间
   - location 格式 "wrld_xxx:instanceId~hidden(usr_owner)~region(jp)"；traveling 时看 travelingToLocation
2. 比对 worldId + instanceId：相同 = 同房；确认时间重叠
3. get_world_name(worldId) → 世界名
```

陷阱：`get_friend_events` 每个事件嵌完整用户 JSON（~50KB），limit 大会爆响应。用 `limit=5` + `offset` 分页；或只读顶层字段。

### 4. "XX 几点上线 / 什么时候最容易碰到 TA" → `get_online_pattern`

一次调用拿全部规律，不要逐条翻事件：

```bash
# 默认最近 30 天（北京时间自然日）；可传 days 或 startTime/endTime
curl -s http://127.0.0.1:8799/mcp -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_online_pattern","arguments":{"userId":"<目标userId>"}}}'
```

返回：`hourly`（上线/下线/位置活跃按北京小时分桶）、`activeDates`（活跃日期）、`frequency`（活跃天数/活动比率/平均间隔/最长空档）、`peak`（登录/活跃/下线峰值小时 + suggestedWindow 最佳相遇时段）。

### 5. 昵称管理

好友昵称映射存本地库（`nicknames` 表），**不维护在 skill 文件里**：

- 查询：`get_nicknames`（不带参数返回全部；`userId` 精确查；`query` 按昵称或显示名模糊查）
- 写入：`set_nickname {userId, nickname, displayName?}`（upsert 幂等）
- 建议工作流：用户给好友取中文昵称 → `search_users` 找 userId → `set_nickname` 写入 → 后续查询结果用昵称展示

## 结果格式

建议用昵称代替原始显示名以提高可读性。companion 数据可展示为：`| 排名 | 好友 | 共处时间 | 同屏实例 | 最近一次 |`，并附一行小结总结社交模式。

## 常见陷阱

### 时间戳

所有事件时间为 ISO 8601 UTC，展示转北京时间 +8。原始格式有两种（`...Z` 毫秒 / `+00:00` 微秒），解析时统一兼容。

### 展示时间必须带完整日期

事件按 created_at DESC 返回，可能混入数天前的旧事件。展示时间戳必须带年月日，只看时分秒会误读。

### 世界名可能为空 / 缓存陈旧

- `get_friend_events` 的 world_name 字段经常空，用 `get_world_name(worldId)` 单独查
- VRChat 世界可以改名，world_cache 懒刷新（缓存命中直接返回，无 TTL）；用户否认世界名时用 `get_world_name` 带 `forceRefresh: true` 强制刷新

### traveling 状态

`friend-location` 事件中 `location: "traveling"` 是转场，目的地看 `travelingToLocation`。

### boop 通知在 notification-v2 里

boop 通知落库的顶层事件类型是 `notification-v2`（不是 boop），boop 在 content_json.type 里。`get_recent_events(typeFilter="boop")` 查不到，用 `typeFilter="notification-v2"`。

### 存储引擎：better-sqlite3（WAL 模式，2026-08-09 起）

服务用 better-sqlite3（原生绑定，WAL 日志模式）：**每次写操作即时落盘，崩溃安全，支持服务运行中的并发读**。外部工具（sqlite3 CLI / Python）可直接读主库文件，看到的是最新数据（曾因 sql.js 内存库报 `database disk image is malformed`，换引擎后解决）。数据写入仍建议走 MCP 工具（SQL 封装层统一在 `core/storage.js`）。数据库文件是标准 SQLite format 3，可直接被任意 SQLite 工具打开。⚠️ WAL 模式下运行中会有 `-wal`/`-shm` 伴生文件（已 gitignore）。

### OTP 登录

- 服务自动从邮箱 IMAP 抓取 OTP 验证码登录，无人值守
- QQ 邮箱有"自动分类"功能会把验证码邮件归档到分类文件夹（IMAP 名含 `VRChat`，modified UTF-7 编码）——fetch-otp.py 已带文件夹遍历兜底，若 OTP 一直失败先想到这个
- 认证失败有 120s 冷却，401 限流 5min 冷却，会自愈

### 代理（国内网络）

WebSocket 直连失败 6s 后自动回退到本地代理（默认 `127.0.0.1:7892`，可在代码/环境变量中修改）。若 HTTP 请求报 502 且本机开了系统代理，设 `NO_PROXY=127.0.0.1,localhost` 环境变量。

## 服务健康检查

```bash
curl -s http://127.0.0.1:8799/health
```

正常：`auth.authenticated=true`、`ws.status=connected`。服务没起时：项目目录下 `node start-monitor.js` 后台启动（10-15s 完成登录+WS 连接）。改代码后必须重启才生效（进程常驻，不热加载）。
