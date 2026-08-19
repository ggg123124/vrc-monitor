# VRChat 助手 (vrchat-assistant)

基于 Node.js 的 VRChat 好友在线状态监控服务，配合 Hermes 插件和桌面插件使用，支持自动抓取 OTP 验证码登录。

> 🤖 **AI-first 项目**：本程序只面向 AI Agent 使用与扩展，人类不直接编码；加功能 = 人类向 Agent 提需求 → Agent 实现。开发规范见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

**面向 AI Agent 的配置引导**：以下步骤可由 Agent 自动完成。建议 agent 在本仓库目录内运行（服务目录可自动探测，无需设置环境变量）。

## 安装前检查（Agent 必读）

> ⚠️ **在开始配置步骤 1 之前，Agent 必须先向用户核实以下问题：**

1. **是否安装/使用过 VRCX？**
   - VRCX 是一款流行的 VRChat 第三方工具，会在本地保存好友活动历史、世界缓存、好友备注等数据（SQLite 数据库）。本服务的 `migrate-vrcx0.mjs` 脚本可从 VRCX 数据库一键导入这些历史数据。
   - 若用户**使用过 VRCX**，继续追问第 2 个问题。
   - 若用户**从未使用过 VRCX**，可跳过数据导入，直接进入「配置步骤」。

2. **是否需要将 VRCX 中的历史数据导入到本系统？**
   - 导入内容包括：好友列表与信任等级、好友备注/昵称、世界缓存、位置变更历史、上下线记录、Avatar 变更、状态/Bio 变更等（详见下表）。
   - 导入是**可选**的——不导入也能正常使用本服务，只是查询历史活动记录时没有迁移前的旧数据。
   - 若用户**需要导入**，在完成「配置步骤」1-3（服务能正常启动）后，运行 `node migrate-vrcx0.mjs` 导入数据（脚本会自动探测 VRCX 数据库路径和 userId）。
   - **迁移引擎（v1.1.0 起）**：改用 **better-sqlite3**（与主服务同引擎，WAL 模式），已移除旧版 sql.js 整文件重写（该方式曾导致 `SQLITE_CORRUPT`，2026-08-12 实测踩坑后由 PR #10 防呆 + PR #12 根因修复）。服务运行中迁移不再损坏数据库，但仍**建议迁移前停止服务**（避免与服务的实时写入交错）。脚本内置 127.0.0.1:8799 端口检测：检测到服务运行时会给出警告，需加 `--force` 确认后继续（风险自负）。
   - **✅ 幂等说明（v1.2.0 起，PR #14 已修复）**：迁移记录带 `vrcxId` 标记 + events 表 JSON 表达式唯一索引 + `INSERT OR IGNORE`，**重复执行自动跳过已迁移记录**（只补新增，不重复插入）。旧版脚本（无 vrcxId）产生的迁移数据会被检测并提示，需 `--force` 才会重插（防误全量重插）。迁移完成后 `node start-monitor.js` 启动服务。
   - 若用户**不需要导入**，直接进入「配置步骤」。

3. **是否愿意参与本仓库的 PR/issue 协作审核（AGENT-REVIEW 协议）？**
   - 本仓库支持**协作审核**：多个独立部署的 AI Agent 可以共同参与 PR / issue 审核，通过认领评论声明参与，满员（默认 3 人）后不再重复劳动。协议见仓库根目录 `AGENT-REVIEW.md`。
   - 参与是**完全自愿、可随时退出**的：不参与不影响任何功能；参与后 Agent 会定时检查 open PR/issue，认领未满员的条目并提交审核意见（只读，不合并）。
   - 若用户**愿意参与**：Agent 在完成「配置步骤」后，按 `AGENT-REVIEW.md` §1 配置定时检查（参考脚本 `scripts/agent-review.py`）。
   - 若用户**不愿意参与**：跳过即可，Agent 不得自行参与。

| 迁移项 | VRCX 数据表 | 说明 |
|--------|------------|------|
| 好友列表 | `friend_log_current` | 好友 userId、显示名、信任等级 |
| 好友备注 | `memos` | 好友昵称/备注文本 |
| 世界缓存 | `cache_world` | 世界 ID、名称、作者、缩略图等 |
| 位置变更 | `feed_gps` | 好友何时在哪个世界 |
| 自己的位置历史 | `gamelog_location` | 本账号自己的位置历史（VRCX 游戏日志解析），迁移为 `user-location` 事件，供 `get_companions` 交叉匹配好友位置查同屏 |
| 上下线记录 | `feed_online_offline` | 好友上线/下线时间及位置 |
| Avatar 变更 | `feed_avatar` | 好友更换 Avatar 记录 |
| 状态变更 | `feed_status` | 好友状态文本变更 |
| Bio 变更 | `feed_bio` | 好友个人简介变更 |

> **数据库位置**：迁移脚本会按平台自动探测以下路径：
> -  **Windows**：`%USERPROFILE%\AppData\Roaming\VRCX\VRCX.sqlite3`（VRCX-0：`%USERPROFILE%\AppData\Roaming\VRCX-0\VRCX-0.sqlite3`）
> -  **Linux**：`~/.config/VRCX/VRCX.sqlite3`（原生 Electron 版）；若通过 Wine 运行 Windows 版：`~/.wine/drive_c/users/<user>/AppData/Roaming/VRCX/VRCX.sqlite3`（自定义 Wine 前缀可用 `WINEPREFIX` 环境变量指定）
> -  **macOS**：`~/Library/Application Support/VRCX/VRCX.sqlite3`
>
> 若自动探测失败，Agent 可让用户提供数据库路径手动指定：`node migrate-vrcx0.mjs <VRCX数据库路径> <userId>`。

## 获取代码（Fork & Clone）

> 💡 本项目是 AI-first 项目，用户会持续向 Agent 提需求、由 Agent 实现功能。为保留这些变更并便于同步上游更新，**建议 Agent 先 Fork 本仓库到用户自己的 GitHub 账号，再克隆 Fork 到本地**，而非直接 clone 原仓库。

- **推荐**：Fork 后克隆
  ```bash
  # Agent 通过 GitHub 工具完成 fork，然后：
  git clone https://github.com/<用户名>/vrchat-assistant.git
  cd vrchat-assistant
  # upstream 指向原仓库（fork 来源）
  git remote add upstream https://github.com/ggg123124/vrchat-assistant.git
  ```
  之后 Agent 实现的新功能可直接 `git push origin` 保存到用户的 Fork；需要同步官方更新时执行 `git pull upstream main`。

- **可选**：仅直接 clone 原仓库（适用于不打算修改代码、只用现成功能的用户）。注意此方式下 Agent 产生的代码变更无法推送到远程，仅保留在本地，存在丢失风险。

## 配置步骤

### 1. 配置凭据文件

复制 `credentials.example.json` 为 `credentials.json`，填入以下信息：

```json
{
  "email": "你的 VRChat 登录邮箱",
  "password": "你的 VRChat 登录密码",
  "imap_auth_code": "你的邮箱 IMAP 授权码"
}
```

> 注意：支持任意提供 IMAP 服务的邮箱（QQ/163/Gmail/Outlook 等），服务根据邮箱域名自动选择 IMAP 服务器。若需手动指定服务器，可在 `credentials.json` 中添加 `imap_host` 字段。

**获取邮箱 IMAP 授权码：**
各邮箱服务商的 IMAP 开启方式不同，通用步骤为：登录邮箱网页版 -> 设置 -> 开启 IMAP/SMTP 服务 -> 生成授权码/专用密码。以 QQ 邮箱为例：设置 -> 账户 -> POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务 -> 开启 IMAP/SMTP 服务，按提示发送短信后生成授权码。

> `credentials.json` 已被 .gitignore 排除，不会提交到仓库。

### 2. 设置环境变量（可选）

- `VRC_MONITOR_DIR`：指向本仓库目录（克隆后服务所在目录）。若 agent 在仓库目录内运行，服务可自动探测，无需手动设置。
- `VRC_MONITOR_NODE`：指向 Node.js 可执行文件路径。若不设置，自动从 PATH 查找 `node`。
- `VRC_MONITOR_DB_PATH`：SQLite 数据库文件路径（默认 `<仓库>/vrc-monitor.sqlite3`）。可将数据库迁移到任意位置（如独立数据盘），配合常驻服务使用。
- `VRC_MONITOR_BACKUP_DIR`：自动备份目录（默认 `<仓库>/backups`）。
- `VRC_MONITOR_LOG_DIR`：常驻服务脚本的日志 / 修复记录目录（默认 `<仓库>/service-logs`，仅 `service-windows/` 脚本使用）。
- `VRC_MONITOR_PYTHON`：执行 fetch-otp.py 的 Python 解释器路径（默认 PATH 中的 `python`）。以计划任务 / systemd / 容器等方式运行且 PATH 中无 python 时必须设置，否则 OTP 自动登录失败会陷入重试循环（每次循环 VRChat 都会重新发送验证码邮件）。**路径含空格无需自带引号**（如 `C:\Program Files\Python311\python.exe`），脚本执行时会自动加引号。

### 3. 启动服务

```bash
node start-monitor.js
```

服务启动后自动完成：加载凭据 -> 校验 cookie -> 过期则自动从邮箱 IMAP 抓取 OTP 验证码登录 -> 建立 WebSocket 连接。

健康检查：

```bash
curl http://127.0.0.1:8799/health
```

**验证成功的标准**：返回 JSON 中 `auth.authenticated` 为 `true`、`ws.status` 为 `connected`、`friendState.online` 为在线好友数。

### 4. 安装 Hermes 插件（进程托管）

```bash
# 复制整个插件目录（含 dashboard 后端子目录，必须带 -r）
# <hermes home> 默认位置：Linux/macOS 为 ~/.hermes，Windows 为 %LOCALAPPDATA%\hermes
mkdir -p "$HERMES_HOME/plugins/vrc-monitor"
cp -r hermes-plugin/* "$HERMES_HOME/plugins/vrc-monitor/"

# 启用
hermes plugins enable vrc-monitor
```

插件提供 `vrc_status` / `vrc_start` / `vrc_stop` / `vrc_restart` 工具，并在每次 Hermes 会话开始时自动拉起服务（on_session_start 钩子）。

> **平台限制**：插件当前仅支持 Windows（`plugin.yaml` 中 `platforms: [windows]`）。macOS / Linux 用户需手动执行 `node start-monitor.js` 启动服务，或等待插件跨平台支持。Node.js 服务本身是跨平台的，仅 Hermes 插件托管层有此限制。

> 注意：`dashboard/` 子目录（manifest.json + plugin_api.py）是桌面插件和 `hermes dashboard` 的后端 API，复制时**不能遗漏**，否则桌面端「配置」功能不可用。
>
> 关于自动拉起：on_session_start 钩子依赖 `VRC_MONITOR_DIR` 环境变量或「agent 在仓库目录内运行」才能定位服务目录。**首次配置完成前（未设置环境变量且不在仓库目录内运行时）服务不会自动启动**，这是预期行为——先完成步骤 1-3 或在仓库目录内重启 Hermes 会话即可。

### 5. 安装桌面插件（GUI 配置入口）

```bash
mkdir -p "$HERMES_HOME/desktop-plugins/vrc-monitor"
cp desktop/plugin.js "$HERMES_HOME/desktop-plugins/vrc-monitor/"
```

然后：
1. 重启 Hermes Gateway（加载 dashboard 后端路由）
2. 桌面端按 Ctrl+K (Windows) / ⌘K (macOS) -> **Reload desktop plugins**

桌面端右侧出现「VRChat Monitor」面板：显示服务运行状态，点击「配置」可填写 VRChat 邮箱/密码/邮箱 IMAP 授权码（保存到 credentials.json），无需手工编辑文件。

### 6. 配置 MCP 接口（可选但推荐）

服务通过 MCP 协议暴露以下工具（get_online_friends / get_friend_info / get_friend_events / get_companions / get_online_pattern / get_nicknames / set_nickname / get_world_name / get_worlds_by_author / set_world_note / get_world_history / get_weekly_report / scan_new_worlds / get_new_worlds / get_mutual_friends / search_users / search_groups / search_worlds / search_planet_worlds / recommend_planet_worlds / search_booth_items / get_booth_item / get_booth_history / get_booth_searches / backup_database / get_user_groups / get_group_info / get_group_instances / get_group_announcement / get_group_heat / join_group / leave_group / peek_group_announcement / send_boop / get_boop_emojis / upload_emoji / upload_print / upload_gallery_image / download_print / download_gallery_image / send_friend_request / remove_friend / create_instance / invite_myself / open_world / rate_world / mark_world_visited / add_to_backlog / get_backlog / remove_from_backlog / recommend_worlds / favorite_world / get_favorite_friends_locations / recommend_join / set_join_preference / get_join_preference / record_join_choice / get_join_learning / x_world_digest / x_scan_creators / x_creators / x_add_creator / x_remove_creator / x_worlds / get_my_favorite_worlds / get_my_favorite_groups / get_friend_favorite_groups / favorite_friend / unfavorite_friend / move_friend_group / submit_totp 等，完整清单与参数见 `skills/vrc-monitor-agent/SKILL.md`「MCP 工具」章节），Hermes Agent 可直接调用，无需 curl 手写 JSON-RPC。 / get_notifications / see_notification / hide_notification / accept_friend_request / decline_friend_request / get_friend_profile_changes

在 Hermes 配置文件（`$HERMES_HOME/config.yaml`，Windows 为 `%LOCALAPPDATA%\hermes\config.yaml`）中添加：

```yaml
mcp_servers:
  vrcx-monitor:
    url: http://127.0.0.1:8799/mcp
```

添加后重启 Hermes 生效，工具以 `mcp_vrcx_monitor_*` 前缀暴露给 Agent。

常用查询示例（直接对 Hermes Agent 说）：
- "现在哪些好友在线？"
- "XX 今天和谁一起玩？"
- "查一下 XX 最近的活动记录"

### 7. 安装 Agent Skill（可选但推荐）

仓库 `skills/` 目录自带开箱即用的 Agent skill（已去敏感化），复制到你的 Hermes skills 目录后，Agent 直接掌握全部查询工作流、开发规范和陷阱：

```bash
mkdir -p "$HERMES_HOME/skills"
cp -r skills/vrc-monitor-agent "$HERMES_HOME/skills/"
cp -r skills/vrchat-social-queries "$HERMES_HOME/skills/"
cp -r skills/vrchat-world-queries "$HERMES_HOME/skills/"
cp -r skills/vrchat-group-queries "$HERMES_HOME/skills/"
cp -r skills/booth-query-display "$HERMES_HOME/skills/"
cp -r skills/vrchat-assistant-development "$HERMES_HOME/skills/"
cp -r skills/review-workflow "$HERMES_HOME/skills/"
```

| Skill | 用途 | 何时需要 |
|-------|------|----------|
| `vrc-monitor-agent` | 好友/社交/群组/推荐等主体 MCP 工具清单、查询工作流、陷阱 | 日常查询与社交操作 |
| `vrchat-social-queries` | 社交域工作流：在线五要素/同屏交叉查询/上线规律/昵称映射 | 同屏/玩伴查询、好友分析 |
| `vrchat-world-queries` | 世界域工作流：挑新世界/待逛 backlog/推荐/PlanetVRC/X 博主 | 世界推荐与情报挖掘 |
| `vrchat-group-queries` | 群组域工作流：群组查询/公告 403 分诊/join/leave/peek | 群组查询与操作 |
| `booth-query-display` | BOOTH 素材检索工具（搜索/详情/热度/汉化/格式化展示） | BOOTH 素材查询 |
| `vrchat-assistant-development` | **开发规范**：新增 MCP 工具三件套流程、跨平台约束、提交 PR 要求（DEVELOPMENT.md 的 skill 化） | **给本仓库添加/修改功能、提交 PR 时必装** |
| `review-workflow` | **审核工作流**：REST-only 审查、端到端实测、分级反馈、多轮复核、PR/issue 审核、协作审核参与（AGENT-REVIEW） | **审核 PR / issue、判断可合并性/可关闭性、参与协作审核时加载** |

重启 Hermes 会话生效。skill 说明见 `skills/vrc-monitor-agent/SKILL.md`（README「文档导航」有入口）。

> **开发功能前必须加载** `vrchat-assistant-development` skill：它固化了仓库的全部开发约束（三件套模式、DB 迁移、文档同步、跨平台、提交规范），不加载直接开发容易违反 DEVELOPMENT.md 的硬性要求。

## 常用操作

| 操作 | 命令/方式 |
|------|----------|
| 启动服务 | `node start-monitor.js` 或 Hermes 插件自动拉起 |
| 健康检查 | `curl http://127.0.0.1:8799/health` |
| 查询在线好友 | `curl -X POST http://127.0.0.1:8799/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_online_friends","arguments":{}}}'` |
| 查看服务状态 | Hermes 工具 `vrc_status` 或桌面插件面板 |
| 配置账号 | 桌面插件「配置」弹窗，或编辑 `credentials.json` |
| 重启服务 | Hermes 工具 `vrc_restart` |
| 常驻服务（开机自启 + 崩溃自愈 + 每日修复报告） | `service-windows\setup-windows.cmd`（Windows；详见 `service-windows/README.md`） |
| 迁移 VRCX 数据 | `node migrate-vrcx0.mjs`（better-sqlite3 引擎，运行中迁移安全但仍建议先停服务；检测到服务运行会要求 `--force`；**可重复执行**——v1.2.0 起幂等，自动跳过已迁移记录，旧数据需 `--force` 重插，见 PR #14）；完成后 `node start-monitor.js` |

## X 博主世界推荐追踪

服务支持追踪 X（Twitter）上的 VRChat 世界推荐博主，自动抓取其推荐的世界（`x_add_creator` / `x_scan_creators` / `x_world_digest` 等工具，见 skill 工具章节）。

**推荐博主清单**（作者认可的价值博主）：

| 博主 | X 链接 | 备注 |
|------|--------|------|
| ヤタノ＠VRを楽しむバーチャルFOX | https://x.com/fox_yata9 | VR 游戏世界推荐 |
| 探跡家もっけい | https://x.com/mokkei_VE | 世界推荐 |
| 八谷凛奈 | https://x.com/n4rGm5DmrVXXz6I | 世界推荐 |
| Bradlee101 | https://x.com/Bradlee1011 | 世界推荐 |

**Agent 行为规则**：
- **安装/配置阶段主动询问**：Agent 按本指南完成部署配置后，主动询问用户"是否要添加上述推荐博主进行追踪？"，得到确认后再逐一 `x_add_creator {screen_name}` 添加，不要擅自添加，也不要跳过询问
- 添加后执行 `x_scan_creators` 抓取一次，向用户汇报抓到的推荐世界
- 用户也可以随时要求追踪/移除其他博主（`x_add_creator` / `x_remove_creator`）

## 发现漏洞 / 缺陷时（Agent 义务）

Agent 在配置、使用、维护本软件过程中，若发现原始代码存在漏洞 / bug（功能异常、数据损坏风险、安全隐患等），**应当主动提交 issue + PR 修复**，让所有使用者受益：

1. **开 issue**：描述现象、复现步骤、影响范围（不夹带任何凭据 / 本机路径 / 个人账号信息）。**上报前先搜索 issue / PR 是否已存在**，避免重复；若已存在且无人处理，可补充复现信息或认领修复；
2. **提修复 PR**：按 [DEVELOPMENT.md](./DEVELOPMENT.md) 的要求执行（单一职责、无个人环境硬编码、DB 变更带幂等迁移、文档同步、Conventional Commits、三段式验证说明）；
3. **无法自行修复时**：至少完成根因定位（到模块 / 函数级别）再提交 issue，说明已发现的证据与猜测方向，由作者或其他 Agent 跟进。

> 这是本项目对 Agent 的明确义务（详见 DEVELOPMENT.md §1「发现缺陷必须主动上报」）：发现问题就地修复并回馈上游，而不是只在本地 fork 里静默改掉。**该义务不因 fork 自用而豁免**——即使改动只在本地使用，发现上游缺陷也必须上报。

## 常见问题

### OTP 验证码自动抓取失败

服务通过 IMAP 协议自动抓取邮箱中的 VRChat OTP 验证码邮件，无需手动输入验证码。排查顺序：
1. 确认 `credentials.json` 中的 `imap_auth_code` 是 **IMAP 授权码**（非登录密码）
2. 若自动推断的 IMAP 服务器不正确，可在 `credentials.json` 中添加 `"imap_host"` 手动指定（如 `"imap_host": "imap.gmail.com"`）
3. 连续多次触发 OTP 时，邮箱 IMAP 同步可能有延迟，服务会在冷却后自动重试（认证失败冷却 120s，限流 401 冷却 5min），无需人工干预

### TOTP（Authenticator 验证码）登录

若 VRChat 账号启用了 **TOTP 两步验证**（Authenticator 应用），以下情况会进入 `needsTotp` 状态（`/health` 的 `auth.needsTotp` 为 `true`，或日志提示调用 `submit_totp`）：

- **服务启动 / WS 重连**时：cookie 过期、自动重登录发现需要 2FA，且邮箱 OTP 不可用（未启用或抓取失败）；
- **服务运行中 API 返回 401**（运行期 cookie 过期）时：服务检测到 401 会自动触发重新登录，若需要 TOTP 同样进入 `needsTotp` 状态——**无需重启服务**。

此时：
1. 服务已保留待验证的临时会话，**只差验证码**；
2. Agent（或用户）打开 Authenticator 应用查看当前 6 位验证码；
3. 调用 MCP 工具 `submit_totp { code: "123456" }` 完成登录，WebSocket 会自动重连上线。

注意：
- 账号**同时启用邮箱 OTP 与 TOTP** 时，服务优先走邮箱 OTP 自动抓取，仅在邮箱抓取失败时才兜底转为需要 TOTP 手动提交；
- 账号**仅启用 TOTP** 时，服务不会尝试邮箱，直接等待 `submit_totp`；
- 验证码每 30 秒变化，过期需重新获取；提交失败后临时会话保留，可再次提交；
- 运行期 401 自动重登录失败（非 TOTP 原因，如网络/凭据错误）会冷却 60 秒再重试，不会高频刷认证接口。

### 代理说明

如需通过代理访问 VRChat API，请在启动前设置 `HTTPS_PROXY` 或 `HTTP_PROXY` 环境变量。WebSocket 连接默认直连，6 秒超时后自动回退到代理（默认 `127.0.0.1:7892`，可用 `VRC_MONITOR_WS_PROXY` 环境变量覆盖）。

### 端口 8799 被占用 / 提示双实例

服务启动前会预检 8799 端口：已被占用时立即退出并提示排查命令（`netstat -ano | findstr 8799` / `tasklist | findstr node`），防止新旧两个实例并存。两个实例同时运行会**互抢 OTP 验证码**（实例 A 提交成功、实例 B 提交失败 → VRChat 重复下发新验证码 → 邮箱被验证码邮件刷屏）。重启服务前请确认旧 node 进程已结束。

### 服务目录找不到

如果 `vrc_status` 或桌面端显示「未找到服务目录」，说明 `VRC_MONITOR_DIR` 未设置且 agent 不在仓库目录内运行。解决：设置 `VRC_MONITOR_DIR` 指向本仓库目录，或在仓库目录内重启服务。
