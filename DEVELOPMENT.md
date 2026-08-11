# 开发规范（AI Agent 优先）

> 本文档面向**任何打算在本仓库上开发功能的 AI Agent**（及其背后的使用者）。
> 本项目是 **AI-first**：程序只面向 AI Agent 使用与扩展，默认不考虑人类直接操作或编码。
> 阅读顺序建议：README（项目概览）→ AGENTS.md（部署配置）→ ARCHITECTURE.md（系统架构）→ 本文档（开发约束）。
> 动手开发前请完整阅读本文档，**第 3 节「跨平台约束」是必读**。

## 1. 总体原则：AI 完成开发，人类提出需求

- **本项目是 AI Agent 优先（AI-first）**：配置、使用、扩展、维护全流程都通过 AI Agent 完成。程序本身面向 Agent（MCP 接口 + 文档引导），不设计人类直接操作界面。
- **开发流程**：人类**不直接编码**。添加 / 修改功能的标准流程是：使用者向 AI Agent 提出功能需求 → Agent 阅读本文档与相关代码 → Agent 实现 → Agent 自测验证 → 使用者验收 →（可选）Agent 提交 PR 惠及上游。
- **fork 自由，自用随意**：本仓库采用 MIT 协议，任何人可以 fork，让 AI Agent 按自己的需求添加 / 修改功能，无需征得作者同意。自用 fork 想怎么改都行。
- **PR 是自愿的**：自用功能不必提 PR。只有当你想让改动惠及上游（合回主仓库、让所有人受益）时，才需要走 PR 流程。
- **先讨论再大改**：涉及架构级改动（数据库 schema 变更、MCP 协议变更、WebSocket 事件处理流程）时，建议先开 issue 说明方案，减少返工。
- **对 Agent 的要求**：Agent 是功能实现的执行者，必须遵守本文档全部约束；遇到超出能力范围的决策（如破坏性接口变更、隐私边界问题），应明确告知使用者而不是擅自决定。

## 2. 提交 PR 的要求

PR 由 AI Agent 编写提交（人类只提出需求、不直接编码）。以下要求不满足的 PR 不会被合并：

1. **单一职责**：一个 PR 只做一件事（一个 feature 或一个 fix）。夹带无关重构、格式化、改名会整单打回。
2. **不引入个人环境的硬编码**：禁止本机路径（`C:\Users\xxx`、`/home/xxx`）、个人代理地址、个人账号信息、个人 Cookie。详见第 3 节。
3. **不破坏现有行为**：现有 MCP 工具的调用方式与返回结构不得随意改变；WebSocket 事件采集 / 落库逻辑不能回归；Hermes 插件与桌面插件依赖的接口保持不变。
4. **数据库变更必须带迁移**：只改 `core/init-db.sql` 不够——存量用户已有数据库（`vrc-monitor.sqlite3`，better-sqlite3 + WAL）。新增表 / 列必须提供幂等迁移（如 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，或独立迁移脚本），并在 PR 描述中注明。
5. **新增 MCP 工具需同步文档**：在 README「MCP 工具」章节和 AGENTS.md 工具清单中登记；若影响 `skills/` 下的 skill 文档，也要同步更新。
6. **提交信息遵循 Conventional Commits**：`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` 前缀（参考仓库 git log 风格）。
7. **版本号与发布由作者决定**：贡献者不要修改 package.json 的 `version`、不要打 tag、不要创建 release。
8. **文档使用中文**：README / AGENTS.md / skills 均为中文，新增或更新的文档用中文写。
9. **不提交任何密钥**：`credentials.json`、cookie、token、密码、IMAP 授权码严禁出现在 commit、PR 描述、issue、日志或测试输出中。提交前自查。
10. **MIT 许可延续**：保持 MIT 许可证及版权声明；提交代码即视为同意以 MIT 协议授权给项目。
11. **验证说明**：PR 描述必须写明「需求来源 → 实现方式 → 验证过程与结果」三段式说明（PR 的审查方也可能是 AI Agent，需要可复现的验证信息）。可参考 `test-apis.mjs` / `test-websocket.mjs` / `test-ws-direct.mjs`。
12. **平台专属代码（如 Windows 命名管道）必须满足**：平台门控（非目标平台直接禁用）、探测失败静默回退到跨平台路径、封装 `core/` 模块与跨平台路径共用同一入口、文档中标注适用平台与回退行为。禁止以「平台专属」为由绕过第 2 条（无个人环境硬编码）与第 5 条（文档同步）。

> 目前仓库没有 CI，上述脚本是手动验证工具。合并决策由作者（或其 AI Agent）实际运行验证后作出。

## 3. 跨平台约束（重点，必读）

**这个服务不一定运行在运行 VRChat 的那台电脑上。** 它可能跑在：

- Windows / macOS / Linux 桌面机（VRChat 在另一台机器上，甚至本机根本没装 VRChat）
- NAS（群晖、威联通等，常见 ARM 架构、精简系统）
- 云服务器 / VPS（headless：无显示器、无桌面、无交互）
- Docker 容器（Alpine 等精简发行版）

开发时必须遵守以下约束：

### 3.1 无 GUI / 无本地客户端依赖

- 服务是纯 Node.js 命令行进程，必须 headless 可运行。
- 禁止引入需要图形界面、桌面环境、或**硬性要求** VRChat 客户端装在本机的依赖——服务在无客户端的机器（NAS / 服务器 / 容器）上功能不得缺失。
- 允许**探测式本机增强**：运行时探测本机是否具备增强条件（如 Windows 命名管道 `\\.\pipe\VRChatURLLaunchPipe`），探测到才启用增强路径，探测失败**静默回退**到跨平台 API 路径，调用方无感知。
- 增强路径必须满足：
  - 平台门控（如 `process.platform === 'win32'`），非目标平台直接禁用；
  - 封装为 `core/` 下独立模块，与跨平台路径共用同一入口；
  - 不读取 VRChat 客户端安装目录、不依赖 GUI / 桌面环境；
  - 不引入个人环境硬编码（本机路径、个人代理等，见 §2 第 2 条）；
  - 探测与发送逻辑带超时保护，失败快速回退，不影响服务本身。
- 所有数据来自 VRChat API（REST + WebSocket），不读取 VRChat 客户端安装目录。`migrate-vrcx0.mjs` 只是可选的 VRCX-0 历史数据迁移工具，不是运行时依赖。

### 3.2 不假设操作系统

- 路径拼接必须用 `path.join()`，禁止手写 `/` 或 `\`。
- 禁止 spawn 依赖平台的外壳命令（cmd / PowerShell / bash 专属命令）；确需外部进程时，说明跨平台方案。
- 注意文件路径大小写敏感（Linux）与不敏感（Windows/macOS 默认）的差异、权限模型差异。

### 3.3 原生依赖要谨慎

- `better-sqlite3` 是原生模块，依赖各平台的预编译二进制（需匹配 Node ABI）。
- 新增依赖优先选纯 JS 实现；确需原生模块时，必须在 PR 中说明官方 prebuilt 对各目标平台（含 ARM NAS、Alpine Linux）的覆盖情况。
- 不要假设目标机器有编译工具链（node-gyp 失败是 NAS 上的常见坑）。

### 3.4 运行参数环境变量化

- 端口、绑定地址、数据目录、Node 路径等运行参数应可通过环境变量覆盖。
- 现状：端口（`start-monitor.js` 中硬编码 8799）与绑定地址（127.0.0.1）是已知限制，改造方向是环境变量可配置；已有 `VRC_MONITOR_DIR` / `VRC_MONITOR_NODE` 支持。**新增参数直接做成环境变量可配置，不要新增硬编码。**

### 3.5 网络环境差异

- 服务依赖外网出口：`api.vrchat.cloud`（REST + WebSocket）、邮箱 IMAP 服务器（OTP 自动登录）。
- 通过 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量支持代理。
- **禁止在代码中硬编码代理地址。** WebSocket 代理回退地址已支持 `VRC_MONITOR_WS_PROXY` 环境变量覆盖（默认仍为 `http://127.0.0.1:7892`，兼容旧部署），新代码不要再新增任何硬编码代理。
- 弱网环境：断线重连（`core/ws-manager.js`）、限流（`core/rate-limiter.js`）、认证冷却（401 冷却 5min）等机制是基本要求，新增网络逻辑要保持同样健壮。

### 3.6 时区

- 事件时间戳的存储与展示要明确时区语义：推荐数据库存 UTC，展示层再转本地时区。
- 禁止假设运行机器与「看数据的人」在同一个时区——监控服务很可能跑在服务器上，用户在另一台机器上看报表。

### 3.7 数据可迁移

- 数据库文件应可整体拷贝 / 备份迁移（已有 `core/backup.js` 自动备份机制）。
- 禁止在代码中写死数据库绝对路径，应相对服务目录或由环境变量指定。

### 3.8 容器化 / 部署场景

服务可能被部署进 Docker、K8s 或 NAS 套件里，遵守以下约定：

- **无状态 + 数据卷挂载**：数据库（`vrc-monitor.sqlite3`）和 `credentials.json` 应通过挂载卷 / 环境变量提供，容器本身可随时重建。禁止把数据写死在镜像内。
- **日志走 stdout**：容器 / 进程管理器只采集 stdout，不要新增「写日志文件」的逻辑（或做成可选）。
- **信号处理**：不假设有 systemd / 服务管理器兜底。进程要优雅处理 `SIGTERM` / `SIGINT`（关闭 WebSocket、正常收尾 SQLite 事务），让容器编排能安全停止。
- **端口与绑定**：当前绑定 `127.0.0.1:8799` 意味着外部（宿主机 / 其他容器）无法直连；需要对外提供服务时，绑定地址要可配置，且暴露到公网前必须有鉴权（本服务目前无鉴权，默认只允许本机访问是有意为之）。
- **基础镜像**：better-sqlite3 的原生二进制在 glibc 发行版（如 `node:slim`）上最稳；Alpine（musl）需要确认 prebuilt 可用，或改用 glibc 镜像，别默认 Alpine。
- **时区**：容器默认 UTC，正好呼应 3.6——代码不要假设「本地时区 = 用户时区」。

### 3.9 资源占用约束（低配设备）

可能跑在 1~2GB 内存的 NAS 或便宜 VPS 上，遵守以下约定：

- **数据源是 push（WebSocket），不是 pull**：事件流实时推送，不要新增「每 N 秒全量轮询好友状态」之类的兜底逻辑（`migrate-vrcx0.mjs` / `analyze-db.mjs` 是一次性工具，不算）。
- **REST 调用走限流**：所有 VRChat API 请求必须经过 `core/rate-limiter.js` 的节奏，新增的「状态查询」类功能同样受限流约束。
- **避免定时任务重叠**：定时任务（备份、周报、重连）要防止上次没跑完又触发下一次（加锁或错峰）。
- **内存敏感**：不要在内存里长期缓存全量事件（当前设计是 SQLite 落盘 + 按需查询），新增聚合逻辑优先用 SQL 而非把数据全捞进内存。

## 4. 数据与隐私边界

- 本工具只处理**自己账号**在 VRChat 授权范围内能看到的**好友**数据。
- 禁止批量抓取非好友用户数据、规避限流做数据挖掘、或用于骚扰、人肉等用途。
- 采集的数据仅用于个人监控与分析，代码不得把数据上传到任何第三方服务。
- 不得在公开代码 / 文档 / 示例中夹带任何真实用户（作者本人除外）的隐私信息。

## 5. 代码规范

- **语言**：JavaScript，ESM（`package.json` 中 `"type": "module"`）。
- **Node 版本**：≥ 18（better-sqlite3 v12 的要求；本地开发推荐 22.x）。`package.json` 已声明 `engines` 字段约束。
- **风格**：跟随现有代码风格（`start-monitor.js` 薄入口与 `core/` 下的模块 + `core/handlers/` 下的 handler）。
- **模块划分**：`start-monitor.js` 约 200 行薄入口，新增功能放 `core/` 下独立模块（参考 `storage.js` / `ws-manager.js` / `server-context.js` / `mcp-definitions.js` 的拆分方式）。MCP 工具 handler 放 `core/handlers/` 子目录，按功能域分拆文件（参考 `recommend.js` / `friends.js` / `events.js` / `groups.js` / `media.js` / `misc.js` / `instance.js`），通过 `ctx` 共享上下文访问运行时状态。RPC 分发在 `core/rpc-router.js`，HTTP 服务在 `core/http-server.js`。
- **平台专属逻辑**：Windows 专属增强（命名管道等）一律封装进 `core/` 独立模块，运行时探测 + 静默回退（见 §3.1），禁止散落在 CLI 脚本或 MCP handler 里。
- **新功能默认做成 MCP 工具，禁止只写孤立 CLI 脚本**（2026-08-09 用户要求固化）：本项目面向 AI Agent，Agent 通过 MCP 接口（`tools/call`）与功能交互；独立脚本无法被 Agent 直接调用，等于功能不可达。开发要求：
  - 新功能的标准形态是注册 MCP 工具（工具定义在 `core/mcp-definitions.js` + handler 函数在 `core/handlers/` 对应文件 + RPC case 在 `core/rpc-router.js` 三件套），Agent 一条 `tools/call` 即可使用。
  - 若确需保留独立入口（如 CLI 脚本 / 定时任务），**核心逻辑必须抽到 `core/` 下的共享模块**，CLI 与 MCP handler 双复用——禁止同一逻辑在两处各写一份（2026-08-09 实操：`new-worlds-tracker.mjs` 的拉取/过滤/评分/分类逻辑抽到 `core/new-worlds.js`，CLI 降级为薄封装；2026-08-10 该 CLI 薄封装已被移除，功能仅保留 MCP 工具形态，规范得到验证）。
  - MCP handler **复用主服务登录态**（`ctx.serverState.authUser` + `ctx.api` 实例），不要重复实现登录 / OTP / 凭据读取（参考 `handleGetWeeklyReport`）；只有独立 CLI 场景才自带认证。
  - 数据库读写走 `storage`（`_query` / `_run` / `db.transaction`），建表沿用 `core/init-db.sql` 幂等写法。
  - 文档同步：新增工具后 README / AGENTS.md / `skills/vrc-monitor-agent/SKILL.md` 三处工具表 + 工具数必须同步（`grep '个工具'` 核对）。
  - **限流不要嵌套**（2026-08-09 真实死锁事故）：handler 内部逐请求 `rateLimiter.execute` 时，RPC case 层**不要再包一层** `rateLimiter.execute`——外层执行时 `_processing=true`，内层请求永远排不上队，整个 handler 挂死（`scan_new_worlds` 首版即如此，120s 超时；修复：case 层裸调，内部已逐请求限流）。
- **错误处理**：异步路径必须有 try/catch 或 Promise 拒绝处理；WebSocket 消息处理不得因单条消息异常导致服务中断。
- **日志**：沿用现有 `log()` 输出风格（中文 + emoji），不引入额外日志库。
- **SQL**：建表 / 索引沿用 `core/init-db.sql` 的幂等写法（`IF NOT EXISTS`）；查询一律用参数占位符，禁止字符串拼接 SQL。

## 6. 测试与 CI

- **现状**：没有 CI。手动验证脚本：`test-apis.mjs`（REST API）、`test-websocket.mjs` / `test-ws-direct.mjs`（WebSocket）、`analyze-db.mjs`（数据库分析）。合并以作者实际运行为准。
- **Agent 义务**：涉及 API / WebSocket / 数据库的功能改动，Agent 必须在 PR 描述写明验证方式；能跑现有脚本就跑一遍，不能跑要说明原因。Agent 提交前必须实际运行验证，不能只做静态分析就声称完成。
- **CI 规划（待建设）**：未来接入 GitHub Actions，覆盖 Node 18/20/22 × Ubuntu + Windows + macOS 的启动与健康检查矩阵。注意：**CI 里不能放真实 VRChat 凭据**——自动化测试只能覆盖「无凭据也能验证」的部分（模块加载、DB 初始化、参数校验），涉及真实登录的验证仍需人工完成（可用 secrets 里的测试账号，但绝不能泄露到日志）。
- 新增测试脚本命名沿用 `test-*.mjs` 风格，方便 CI 统一发现。

## 7. AI Agent 提交前自检清单

以下清单由 AI Agent 在提交（commit / PR）前逐项自查：

- [ ] `git status` 中没有 `credentials.json` / cookie / token 等敏感文件
- [ ] 无本机路径、个人代理、个人账号信息残留
- [ ] `node start-monitor.js` 可正常启动，`/health` 返回 `authenticated: true`、`ws.status: connected`
- [ ] 至少跑一遍相关测试脚本（`test-apis.mjs` 等），或说明为什么不适用
- [ ] 新增 / 修改的功能已在 README 或 skills 文档中登记
- [ ] 数据库变更已考虑存量库迁移
- [ ] 提交信息符合 Conventional Commits 格式
