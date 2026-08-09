# VRChat 好友监控系统 (vrc-monitor)

> 自建 VRChat 好友动态监控系统 · 替代 VRCX-0
> 技术栈：Node.js + SQLite + WebSocket + MCP + Hermes 插件

监控 VRChat 好友的上下线、世界切换、Avatar/状态变化，通过 WebSocket 实时采集入库，经 MCP 协议暴露给 AI Agent（Hermes）查询，并附带 Hermes 插件实现进程托管。

---

## ✨ 功能

- ✅ **WebSocket 实时监控** — 好友上线/下线/换世界即时入库
- ✅ **自动重连 + 认证自愈** — 指数退避（1s→60s）+ cookie 过期自动 OTP 邮箱取码登录，无需人工干预
- ✅ **自动 OTP 登录** — 邮箱验证码自动从邮箱 IMAP 抓取，全链路无人值守
- ✅ **历史数据迁移** — 从 VRCX-0 导入 10 个月的 33 万条活动记录
- ✅ **世界名缓存** — 自动解析 `wrld_xxx` 为可读世界名（懒刷新：缓存命中直接用，`forceRefresh: true` 手动刷新防改名陈旧）
- ✅ **关注名单** — 标记核心好友，活动时特别通知
- ✅ **MCP 工具接口** — 44 个工具供 Hermes / 任意 MCP 客户端调用
- ✅ **数据库自动备份** — 启动 + 每 24h 自动备份（WAL 在线备份，无需停机），保留最近 2 份到 `backups/`；`backup_database` 工具可随时手动触发
- ✅ **Hermes 插件托管** — 会话自动拉起、崩溃自愈、`vrc_status` 等管理工具

---

> 🤖 **AI Agent 看这里**：完整配置引导见 [AGENTS.md](AGENTS.md)——凭据、环境变量、启动、插件安装的逐步说明，可让 Agent 自动完成配置。
>
> 📦 **开箱即用的 Agent Skill**：仓库自带 2 份面向 AI Agent 的 skill（查询工作流 + 常见陷阱，已去敏感化），复制到你的 Hermes skills 目录即可直接使用，见下方「Agent Skill 安装」。

## 🚀 快速开始

### 0. 准备

- Node.js ≥ 18
- 一个 VRChat 账号（需开启邮箱 2FA）
- 一个支持 IMAP 的邮箱（用于接收 OTP 验证码，需生成 IMAP 授权码/专用密码）

### 1. 配置凭据

复制模板并填入真实凭据（**该文件不会入库**）：

```bash
cp credentials.example.json credentials.json
```

```json
{
  "email": "你的VRChat登录邮箱",
  "password": "你的VRChat密码",
  "imap_auth_code": "邮箱IMAP授权码"
}
```

> IMAP 授权码获取：登录邮箱网页版 → 设置 → 开启 IMAP/SMTP → 生成授权码/专用密码。以 QQ 邮箱为例：设置 → 账号 → 开启 IMAP/SMTP → 生成授权码。

### 2. 启动服务

```bash
cd <本仓库目录>
node start-monitor.js
```

首次启动会提示邮箱验证码，系统自动从 QQ 邮箱抓取并完成登录，随后保持运行。

### 3. 健康检查

```bash
curl http://127.0.0.1:8799/health
```

正常响应：`Auth: true`、`WS: connected`、在线好友数。

## 📦 Agent Skill 安装（开箱即用）

仓库 `skills/` 目录自带 2 份**面向 AI Agent 的 skill 文档**（已隐去所有敏感信息，任何用户可直接使用）。安装后，Agent 无需 curl 手写 JSON-RPC，直接掌握查询工作流、正确工具选择和常见陷阱：

| Skill | 内容 | 适用场景 |
|-------|------|----------|
| `skills/vrc-monitor-agent/` | 38 个 MCP 工具清单、5 大查询工作流（在线/同屏/时间线/上线规律/昵称）、常见陷阱、健康检查 | 日常好友查询 |
| `skills/vrc-monitor-companion-query/` | 「谁和我/和 XX 一起玩过」同屏交叉查询的正确姿势（为何不委派子 agent） | 同屏/玩伴查询 |

**安装方式**（以 Hermes 为例，其他 Agent 框架同理）——把 skill 目录复制到你的 skills 目录：

```bash
# <hermes home> 默认位置：Linux/macOS 为 ~/.hermes，Windows 为 %LOCALAPPDATA%\hermes
mkdir -p "$HERMES_HOME/skills"
cp -r skills/vrc-monitor-agent "$HERMES_HOME/skills/"
cp -r skills/vrc-monitor-companion-query "$HERMES_HOME/skills/"
```

然后重启 Hermes 会话，Agent 即具备完整的 vrc-monitor 查询能力。前提：vrc-monitor 服务已按上文配置并运行（MCP 端点 `http://127.0.0.1:8799/mcp`）。

> 提示：skill 里的昵称管理走 `get_nicknames` / `set_nickname` MCP 工具（存本地库），不写死在 skill 文件里——新用户给自己的好友取昵称后直接写入即可。

## 🤖 Hermes 插件（进程托管）

服务本身是独立 Node 进程；若要交给 Hermes 托管（会话启动自动拉起、崩溃自愈），安装 `hermes-plugin/` 下的插件：

```bash
# 1. 复制插件到 Hermes 用户插件目录（含 dashboard 后端子目录，必须带 -r）
#    <hermes home> 默认位置：Linux/macOS 为 ~/.hermes，Windows 为 %LOCALAPPDATA%\hermes
mkdir -p "$HERMES_HOME/plugins/vrc-monitor"
cp -r hermes-plugin/* "$HERMES_HOME/plugins/vrc-monitor/"

# 2. 启用（需要 hermes 环境）
hermes plugins enable vrc-monitor

# 3. 重启 Hermes 会话生效
```

桌面插件（GUI 配置入口，可选）：

```bash
mkdir -p "$HERMES_HOME/desktop-plugins/vrc-monitor"
cp desktop/plugin.js "$HERMES_HOME/desktop-plugins/vrc-monitor/"
# 重启 Gateway + 桌面端 ⌘K → Reload desktop plugins
```

### 插件提供的工具

| 工具 | 说明 |
|------|------|
| `vrc_status` | 服务状态：进程存活 + auth/WS/在线数 |
| `vrc_start` | 幂等启动服务（已运行则返回现状） |
| `vrc_stop` | 停止服务 |
| `vrc_restart` | 重启服务 |

### 环境变量（可选覆盖）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VRC_MONITOR_DIR` | 自动探测（agent 在仓库目录内运行） | 服务目录（含 start-monitor.js），未探测到时需显式设置 |
| `VRC_MONITOR_NODE` | PATH 中的 node | Node 可执行文件路径 |

### 进程托管原理

- **on_session_start 钩子**：每次 Hermes 会话开始，探测 `:8799/health`，未运行则自动 spawn `node start-monitor.js`（detached）
- **状态文件**：`$HERMES_HOME/workspace/vrc-monitor/.active.json`（pid / started_at / log_file）
- **双路检测**：状态文件 pid 存活 **或** 端口探测成功，均可识别为运行中（防状态文件丢失误判）
- **日志**：`$HERMES_HOME/workspace/vrc-monitor/monitor.log`

## 🔌 MCP 工具（38 个）

服务监听 `http://127.0.0.1:8799/mcp`，通过 HTTP SSE 提供 MCP 协议。Hermes 用户可在 `$HERMES_HOME/config.yaml`（Windows 为 `%LOCALAPPDATA%\hermes\config.yaml`）配置：

```yaml
mcp_servers:
  vrcx-monitor:
    url: http://127.0.0.1:8799/mcp
```

### 好友查询

| 工具 | 说明 |
|------|------|
| `get_online_friends` | 当前在线好友列表（含昵称 nickname + 房型解析 locationParsed：worldId/instanceId/type/ownerId/region） |
| `get_friend_info` | 好友详细信息 |
| `search_users` | 按名字搜索用户 |
| `search_groups` | 按名字搜索群组（API 用 query 参数，不是 search） |
| `search_worlds` | 按名字搜索世界（英文/日文走 API；中文自动加本地缓存兜底） |

### 事件历史

| 工具 | 说明 |
|------|------|
| `get_friend_events` | 某好友的事件历史（本地数据库） |
| `get_recent_events` | 最新事件流 |
| `get_companions` | 同屏交叉查询（指定时间窗口内同实例的好友；每条含 userId/displayName/firstSeen/lastSeen/matchCount/worlds，**worlds 是字符串数组**（世界名或 worldId），不是对象） |
| `get_online_pattern` | 上线规律分析：上线/下线/活跃时段分布（北京小时）+ 活跃天数/频率 + 最佳相遇时段建议 |

### 昵称映射

| 工具 | 说明 |
|------|------|
| `get_nicknames` | 查询昵称映射（userId 精确 / 昵称或显示名模糊 / 全部） |
| `set_nickname` | 写入/更新昵称映射（upsert，本地库操作） |
| `get_mutual_friends` | 共同好友列表（你与目标用户，userId 或 displayName 精确匹配，自动带本地昵称） |

### 世界名

| 工具 | 说明 |
|------|------|
| `get_world_name` | 世界信息查询（懒刷新：缓存命中直接返回，`forceRefresh: true` 才走 API；返回作者/容量/简介/标签/收藏数/用户备注 note，缓存含简介） |
| `set_world_note` | 写入/更新世界用户备注（本地存储，API 刷新不覆盖；空字符串清除） |
| `get_world_history` | 世界信息变更历史（name/description/author/image_url/release_status/capacity/tags 字段级变化记录） |
| `get_weekly_report` | 一周游戏周报（活跃天数/时长/世界 Top/同屏伙伴带昵称/自己的上线规律/群组活动/圈内活动日历；`days` 默认 7） |

### 关注名单

| 工具 | 说明 |
|------|------|
| `get_watchlist` / `add_to_watchlist` / `remove_from_watchlist` | 关注名单管理 |

### 写操作（VRChat 社交互动，限流 2.6s）

| 工具 | 功能 | 必填参数 | 可选参数 |
|------|------|----------|----------|
| `send_boop` | 戳一戳好友（Boop），对方收到戳戳通知 | `userId` | `emojiId`（戳戳表情，见 `get_boop_emojis`） |
| `get_boop_emojis` | 列出内置 boop 表情（65 个）及 emojiId 格式 | — | — |
| `upload_emoji` | 上传自定义 boop 表情（需 VRChat Plus），返回 fileId 用作 emojiId | `imagePath` | `animated`、`animationStyle` |
| `upload_print` | 上传照片到 VRChat **相册**（Prints，需 VRC+） | `imagePath` | `note`（备注） |
| `upload_gallery_image` | 上传图片到 VRC+ **图库**（Gallery，需 VRC+） | `imagePath` | — |
| `download_print` | 从相册下载照片到本地，返回路径（可 `MEDIA:` 发送） | `printId` | `outputDir` |
| `download_gallery_image` | 从图库下载图片到本地，返回路径 | `fileId` | `outputDir` |
| `send_invite` | 邀请好友加入**你当前所在房间**（拉人进房） | `userId`、`worldId`、`instanceId` | `message`（附带消息） |
| `request_invite` | 请求好友**邀请你加入 TA 的房间**（默认消息 "Can I join you?"） | `userId` | `message` |
| `send_friend_request` | **发送好友请求**（添加好友）：`userId` 直接加，或 `displayName` 精确匹配（不区分大小写）后加 | `userId` 或 `displayName` 至少一个 | — |
| `remove_friend` | **删除好友**（不可逆）：`userId` 或 `displayName` 精确匹配；**必须 `confirm: true` 才执行**，否则只返回目标信息预览 | `userId` 或 `displayName` 至少一个 | `confirm`（默认 false） |

### 系统

| 工具 | 说明 |
|------|------|
| `get_server_status` | 服务/认证状态 |
| `get_database_stats` | 数据库统计 |

### 群组（2026-08-08 新增）

| 工具 | 说明 |
|------|------|
| `get_user_groups` | 查询用户加入的群组列表（`userId` 可选，省略 = 当前账号；`withDetails: true` 时批量带简介，~1req/群；端点 `GET /users/{userId}/groups`，注意 `/auth/user/groups` 是 404 无效端点） |
| `get_group_info` | 群组详情（名称/成员数/shortCode/描述/认证状态/**joinState**(open/request/invite)等；`includeAnnouncement: true` 时附带公告，非成员为 null；`groupId` 必填） |
| `get_group_instances` | **群组当前开放的实例（群组房）**：返回 instanceId/location/memberCount + 世界信息；空数组 = 没开房（`groupId` 必填） |
| `get_group_announcement` | 群组公告（title/text/作者/时间；无公告或非成员返回 null 不报错；`groupId` 必填） |
| `join_group` | 加入群组（open 群直接加入；已是成员返回 alreadyMember:true 不报错；`groupId` 必填） |
| `leave_group` | 退出群组（`POST /groups/{id}/leave`；必须 `confirm: true`；非成员返回 notMember） |
| `peek_group_announcement` | **窥探群公告**（2026-08-09 新增）：一键「加入→读公告→退出」，仅对 open 群生效，需 `confirm: true` |

> **上传前图片处理**：emoji 需正方形（`square` 模式，fit/pad/smart）；Prints/Gallery 照片不强制方形（`landscape` 模式，竖图自动旋转90° + `auto` 策略——比较裁剪损失 vs 填充白边，选损失小的；可 `--strategy crop|fill` 强制）。脚本：`scripts/prepare_image.py`。

## 📁 目录结构

```
.
├── start-monitor.js        # 主入口（Node 服务）
├── core/
│   ├── init-db.sql         # 数据库 DDL
│   ├── storage.js          # SQLite 封装
│   ├── ws-manager.js       # WebSocket 管理
│   ├── event-pipeline.js   # 事件处理管道
│   ├── friend-state.js     # 好友状态管理
│   └── rate-limiter.js     # API 限流
├── vrchat-api.js           # VRChat API 客户端
├── fetch-otp.py            # 邮箱 IMAP OTP 自动抓取
├── migrate-vrcx0.mjs       # VRCX-0 数据迁移脚本
├── hermes-plugin/          # Hermes 托管插件
│   ├── plugin.yaml
│   ├── __init__.py
│   ├── process_manager.py  # 进程生命周期管理
│   ├── tools.py
│   └── dashboard/          # 桌面插件后端 API
│       ├── manifest.json
│       └── plugin_api.py   # /status /credentials /doctor 等路由
├── desktop/
│   └── plugin.js           # Hermes 桌面插件（GUI 配置面板）
├── skills/                 # 开箱即用的 Agent skill（已去敏感化）
│   ├── vrc-monitor-agent/          # 主使用指南（工具/工作流/陷阱）
│   └── vrc-monitor-companion-query/ # 同屏查询专项
├── scripts/
│   └── prepare_image.py            # 上传前图片处理（square 方形化 / landscape 旋转+auto裁剪填充）
├── credentials.example.json # 凭据模板（复制为 credentials.json）
└── README.md
```

## 📦 数据迁移（从 VRCX）

从 VRCX 的 SQLite 数据库导入历史数据，包括事件流（位置变更/上下线/Avatar 变更/状态变更/Bio 变更）、好友列表、世界缓存和备注。

```bash
# 自动模式（推荐）— 自动探测默认数据库路径 + 自动识别用户表前缀
node migrate-vrcx0.mjs

# 手动模式 — 显式指定数据库路径和 userId
node migrate-vrcx0.mjs <VRCX数据库路径> <userId>
```

> **注意**：userId 可在 VRChat 官网个人资料页查看，格式如 `usr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`。脚本会自动去掉横线匹配 VRCX 数据库表名格式。

## 🧰 辅助脚本（一次性工具）

### `new-worlds-tracker.mjs` — 新地图追踪

拉取最近 N 天发布的新世界（`system_created_recently` 标签 + 创建时间窗口），写入本仓库 `new_worlds` 表，用 `events` 表的 `user-location` 事件标记「用户是否逛过」，输出热度推荐列表。

```bash
node new-worlds-tracker.mjs [DAYS] [--dry] [--min-favorites N]
# 示例：最近 7 天新地图（dry-run 预览）
node new-worlds-tracker.mjs 7 --dry
```

- 数据全存本仓库 `vrc-monitor.sqlite3`（`new_worlds` 表），不依赖 VRCX 本机库
- API 调用走 `core/rate-limiter.js` 限流
- 输出 JSON：`{ collected, tracked, visited, unvisited, recommended }`
- 定时场景：cron 每天执行即可保持跟踪列表新鲜

### `open-world.mjs` — 在运行中的 VRChat 内打开世界（本机辅助）

通过命名管道 `\\.\pipe\VRChatURLLaunchPipe` 向**运行中**的 VRChat 客户端发送 `vrchat://launch` 请求，游戏内弹出确认菜单（不会新开进程）。仅支持 Windows + VRChat 本机运行环境。

```bash
node open-world.mjs "地图名"      # 按名字（API 搜索，精确优先）
node open-world.mjs wrld_xxx...   # 按 worldId
```

## 🛠 故障排查

**Q: WebSocket 连不上？**
A: 国内网络可能需代理。服务自动直连 6s 失败后回退到本地代理（默认 `127.0.0.1:7892`），无需人工干预。

**Q: 登录提示 OTP 但一直失败？**
A: 检查 `credentials.json` 的 `imap_auth_code` 是否为正确的 IMAP 授权码（非登录密码）。服务会在认证失败后冷却 120s（限流 401 则 5min）自动重试，不会高频刷验证码。

**Q: cookie 过期了要手动处理吗？**
A: 不需要。服务启动和 WS 重连都会自动走 OTP 取码登录，有效 cookie 自动落盘 `auth_cookie.txt`。

**Q: API 限流了怎么办？**
A: 系统内置 2.6s 间隔限流器。可在 `core/rate-limiter.js` 中调整 `minInterval`。

**Q: 数据库文件太大？**
A: 正常。约 30 万行事件 ≈ 300+ MB。better-sqlite3（WAL 模式）按需读取，不整库载入内存。

## ☕ Sponsor

如果你觉得这个项目有用，欢迎请我喝杯咖啡：

![收款码](assets/sponsor-qrcodes.png)

**请给我报销 token** 🙏

## 📄 License

MIT — 见 [LICENSE](LICENSE)。
