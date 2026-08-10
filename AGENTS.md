# VRChat 好友监控服务 (vrc-monitor)

基于 Node.js 的 VRChat 好友在线状态监控服务，配合 Hermes 插件和桌面插件使用，支持自动抓取 OTP 验证码登录。

> 🤖 **AI-first 项目**：本程序只面向 AI Agent 使用与扩展，人类不直接编码；加功能 = 人类向 Agent 提需求 → Agent 实现。开发规范见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

**面向 AI Agent 的配置引导**：以下步骤可由 Agent 自动完成。建议 agent 在本仓库目录内运行（服务目录可自动探测，无需设置环境变量）。

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
2. 桌面端按 ⌘K -> **Reload desktop plugins**

桌面端右侧出现「VRChat Monitor」面板：显示服务运行状态，点击「配置」可填写 VRChat 邮箱/密码/邮箱 IMAP 授权码（保存到 credentials.json），无需手工编辑文件。

### 6. 配置 MCP 接口（可选但推荐）

服务通过 MCP 协议暴露 54 个工具（get_online_friends / get_friend_info / get_friend_events / get_companions / get_online_pattern / get_nicknames / set_nickname / get_world_name / set_world_note / get_world_history / get_weekly_report / scan_new_worlds / get_new_worlds / get_mutual_friends / search_users / search_groups / search_worlds / backup_database / get_user_groups / get_group_info / get_group_instances / get_group_announcement / join_group / leave_group / peek_group_announcement / send_boop / get_boop_emojis / upload_emoji / upload_print / upload_gallery_image / download_print / download_gallery_image / send_friend_request / remove_friend / create_instance / invite_myself / get_favorite_friends_locations / recommend_join / set_join_preference / get_join_preference / record_join_choice / get_join_learning 等，详见 README），Hermes Agent 可直接调用，无需 curl 手写 JSON-RPC。

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

仓库 `skills/` 目录自带 2 份开箱即用的 Agent skill（已去敏感化），复制到你的 Hermes skills 目录后，Agent 直接掌握全部查询工作流和陷阱：

```bash
mkdir -p "$HERMES_HOME/skills"
cp -r skills/vrc-monitor-agent "$HERMES_HOME/skills/"
cp -r skills/vrc-monitor-companion-query "$HERMES_HOME/skills/"
```

重启 Hermes 会话生效。详见 README「Agent Skill 安装」章节。

## 常用操作

| 操作 | 命令/方式 |
|------|----------|
| 启动服务 | `node start-monitor.js` 或 Hermes 插件自动拉起 |
| 健康检查 | `curl http://127.0.0.1:8799/health` |
| 查询在线好友 | `curl -X POST http://127.0.0.1:8799/mcp -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_online_friends","arguments":{}}}'` |
| 查看服务状态 | Hermes 工具 `vrc_status` 或桌面插件面板 |
| 配置账号 | 桌面插件「配置」弹窗，或编辑 `credentials.json` |
| 重启服务 | Hermes 工具 `vrc_restart` |
| 迁移 VRCX 数据 | `node migrate-vrcx0.mjs` |

## 常见问题

### OTP 验证码自动抓取失败

服务通过 IMAP 协议自动抓取邮箱中的 VRChat OTP 验证码邮件，无需手动输入验证码。排查顺序：
1. 确认 `credentials.json` 中的 `imap_auth_code` 是 **IMAP 授权码**（非登录密码）
2. 若自动推断的 IMAP 服务器不正确，可在 `credentials.json` 中添加 `"imap_host"` 手动指定（如 `"imap_host": "imap.gmail.com"`）
3. 连续多次触发 OTP 时，邮箱 IMAP 同步可能有延迟，服务会在冷却后自动重试（认证失败冷却 120s，限流 401 冷却 5min），无需人工干预

### 代理说明

如需通过代理访问 VRChat API，请在启动前设置 `HTTPS_PROXY` 或 `HTTP_PROXY` 环境变量。WebSocket 连接默认直连，6 秒超时后自动回退到代理（默认 `127.0.0.1:7892`，可用 `VRC_MONITOR_WS_PROXY` 环境变量覆盖）。

### 服务目录找不到

如果 `vrc_status` 或桌面端显示「未找到服务目录」，说明 `VRC_MONITOR_DIR` 未设置且 agent 不在仓库目录内运行。解决：设置 `VRC_MONITOR_DIR` 指向本仓库目录，或在仓库目录内重启服务。
