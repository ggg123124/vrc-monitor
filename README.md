# VRChat 助手 (vrchat-assistant)

> 实时监控你的 VRChat 好友动态，让 AI 帮你社交、找图、管相册、做推荐。
> 技术栈：Node.js + SQLite + WebSocket + MCP

**中文 | [English](./README.en.md) | [日本語](./README.ja.md)**

---

## 这是什么？

一个**常驻后台服务**：通过 WebSocket 实时采集你 VRChat 好友的上下线、进房、换 Avatar、状态变化并存入本地数据库。所有能力通过 **MCP 接口**暴露给 AI Agent（如 Hermes），让 AI 替你完成社交互动、媒体管理、群组操作、智能推荐等任务——你不必亲手点 VRChat 客户端。

本项目是 **AI-first**：程序面向 AI Agent 使用与扩展，人类负责提需求、验收，开发由 AI 完成。详见下方文档导航。

## 核心能力

- 📡 **好友监控**：实时采集好友动态，断线自动重连，cookie 过期自动 OTP 邮箱取码登录，全链路无人值守
- 🤖 **智能推荐**：AI 好友推荐（熟悉度 + 收藏夹权重 + 房间场景），推荐当前最值得加入的房间；偏好可自然语言设置并自动学习
- 🗺 **地图推荐与查找**：世界检索（VRChat 官方 / PlanetVRC 日文目录 / 多源融合推荐）、新世界追踪、X 博主世界推荐聚合
- 💬 **社交互动**：戳戳（Boop）、邀请进房、请求加入、好友请求/删除、一键开房（命名管道直发 + API 回退），内置限流防封
- 🛍 **素材检索**：BOOTH（pixiv 数字商品平台）检索 VRChat 素材——avatar/衣装/3D 模型，含热度排行、详情、本地缓存与汉化展示
- 🖼 **媒体管理**：VRC+ 相册（Prints）/ 图库（Gallery）/ 自定义表情的上传、下载、删除
- 👥 **群组管理**：群组信息、群组房列表、加入/退出、公告窥探、群组热度
- 🗄 **数据与洞察**：事件历史、同屏交叉查询、上线规律分析、一周游戏周报、昵称映射、世界备注与变更历史
- 🛡 **运维自愈**：数据库自动备份（24h WAL 在线备份）、Hermes 插件托管（自动拉起 + 崩溃自愈）

## 快速开始

**前置条件**：Node.js ≥ 18、一个 VRChat 账号（开启邮箱 2FA）、一个支持 IMAP 的邮箱（接收 OTP 验证码）。

1. 克隆仓库，复制 `credentials.example.json` 为 `credentials.json`，填入 VRChat 账号与邮箱 IMAP 授权码
2. 启动服务：`node start-monitor.js`
3. 验证：`curl http://127.0.0.1:8799/health` 返回 `Auth: true`、`WS: connected`

> 完整的凭据、环境变量、开机自启、插件安装等配置步骤，交给 AI Agent 按 [AGENTS.md](./AGENTS.md) 自动完成即可——你只需要提供账号和验收。

## 文档导航

> 本项目所有文档面向 **AI Agent 与开发者**。读完本 README 后，按需阅读：

| 文档 | 内容 | 何时读 |
|------|------|--------|
| [AGENTS.md](./AGENTS.md) | 部署配置引导：凭据、环境变量、启动、Hermes 插件、Agent Skill 安装、MCP 接口配置 | 部署 / 配置 / 首次上手 |
| [skills/](./skills/) | 开箱即用的 Agent Skill 合集（含 MCP 工具清单、查询工作流、开发规范等，安装说明见 AGENTS.md） | 查询 / 调用工具 / 开发功能前 |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 开发规范：跨平台约束、PR 要求、数据隐私、代码规范 | 修改代码 / 提交 PR |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构：数据流、模块职责、依赖关系 | 理解代码结构 |
| [docs/history/](./docs/history/INDEX.md) | 项目演进记录：里程碑时间线、每月发布/PR 与演进意义 | 新 Agent 上手先读 |
| [service-windows/](./service-windows/README.md) | Windows 开机自启 + 崩溃自愈 + 每日修复报告（一键脚本） | Windows 常驻运行 |
| [service-linux/](./service-linux/README.md) | Linux systemd 用户服务：开机自启 + 崩溃自愈 + journal 日志（一键脚本） | Linux 常驻运行 |

**MCP 工具**：服务通过 MCP 暴露工具，覆盖好友查询、社交互动、媒体管理、群组操作、世界推荐、素材检索等能力域。**完整工具清单（全部工具）统一登记在 [skills/vrc-monitor-agent/SKILL.md](./skills/vrc-monitor-agent/SKILL.md)「MCP 工具」章节**，Agent 照此调用。其余 skill 为各能力域的工作流补充（不重复登记工具）：`vrchat-social-queries`（社交域：在线五要素/同屏/规律/昵称）、`vrchat-world-queries`（世界域：待逛/推荐/情报挖掘）、`vrchat-group-queries`（群组域：查询/公告分诊）、`booth-query-display`（BOOTH 检索/展示格式）、`vrchat-assistant-development`（开发规范）、`review-workflow`（审核工作流：PR/issue 审核、端到端实测、多轮复核、协作审核）。

## 🧰 辅助工具（本机可选）

- `open-world.mjs`：创建房间并在**运行中的 VRChat 客户端**内打开（命名管道直发，失败静默回退 API 邀请）— `node open-world.mjs <世界ID或名字>`
- `prepare_image.py`：上传前图片处理（emoji 方形化 / Prints 16:9 / Gallery 4:3）
- `migrate-vrcx0.mjs`：从 VRCX 一键迁移历史数据 — `node migrate-vrcx0.mjs`

## 🛠 故障排查

**Q: WebSocket 连不上？**
A: 国内网络可能需代理。服务自动直连 6s 失败后回退到本地代理（默认 `127.0.0.1:7892`，可用 `VRC_MONITOR_WS_PROXY` 环境变量覆盖），无需人工干预。

**Q: 登录提示 OTP 但一直失败？**
A: 检查 `credentials.json` 的 `imap_auth_code` 是否为正确的 IMAP 授权码（非登录密码）。服务会在认证失败后冷却 120s（限流 401 则 5min）自动重试。

**Q: 账号启用了 Authenticator（TOTP）两步验证，无法自动登录？**
A: 支持自动登录：在 `credentials.json` 配置 `totp_secret`（Authenticator 的 otpauth:// URI 或 base32 密钥），服务用 RFC 6238 本地生成验证码，启动/运行期 401/WS 重连全程自动重登录（`/health` 的 `auth.totpAutoEnabled` 为 `true` 表示已启用）。未配置时，`/health` 返回 `auth.needsTotp: true` 后调用 MCP 工具 `submit_totp` 手动提交当前 6 位验证码。账号同时启用邮箱 OTP 时优先自动走邮箱；自动通道优先级：邮箱 OTP → 自动 TOTP → 手动 `submit_totp`。

**Q: cookie 过期了要手动处理吗？**
A: 不需要。服务启动和 WS 重连都会自动走 OTP 取码登录，有效 cookie 自动落盘 `auth_cookie.txt`。**运行中** API 返回 401（cookie 过期）时服务也会自动触发重新登录——若需要 TOTP 且配置了 `totp_secret` 会自动完成，否则进入 `needsTotp` 状态调用 `submit_totp` 即可，无需重启服务。

**Q: 服务登录失败/需要人工介入时怎么知道？**
A: 可配置**登录状态主动通知**（issue #69）：复制 `notify-config.example.json` 为 `notify-config.json` 并设 `enabled: true`，服务在进入 `needsTotp`、邮箱 OTP 抓取失败、运行期 401 自动重认证失败、认证恢复时主动提醒宿主（正常自动登录不通知）。`channels` 支持 `desktop`（Linux notify-send / macOS osascript / Windows PowerShell toast）与 `webhook`（POST JSON 到 webhook_url）。连续失败达 `consecutive_fail_threshold`（默认 3）才通知，`min_interval_sec`（默认 300）防刷屏。桌面通知需系统通知守护（Linux dunst/mako），无守护时静默降级不崩服务。

**Q: 数据库文件太大？**
A: 正常。约 30 万行事件 ≈ 300+ MB。better-sqlite3（WAL 模式）按需读取，不整库载入内存。

## 💬 交流群

QQ 群：**851865556** — 欢迎加入，交流使用问题、功能建议与反馈。

## ☕ Sponsor

如果你觉得这个项目有用，欢迎请我喝杯咖啡：

![收款码](assets/sponsor-qrcodes.png)

**请给我报销 token** 🙏

## 📄 License

MIT — 见 [LICENSE](LICENSE)。
