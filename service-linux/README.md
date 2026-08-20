# vrc-monitor 常驻服务（Linux）

让 vrc-monitor 服务在 Linux 上**开机自启、崩溃自动重启、日志集中采集**，不需要人工干预，也不会因为终端关闭或 Hermes gateway 重启而中断记录。方案基于 **systemd 用户服务**（`systemctl --user`），无 GUI 依赖，适用于无头服务器 / VPS / NAS（glibc 发行版）。

## 组件

| 文件 | 作用 |
|------|------|
| `vrc-monitor.service` | systemd 用户单元模板：`Restart=always` 崩溃自愈 + journald 日志 + `%h` 路径占位 |
| `setup-linux.sh` | 一键安装 / 卸载：解析仓库路径 / node / python 生成真实单元并 `enable --now`，开启 linger |
| `README.md` | 本说明 |

## 快速开始

```bash
bash service-linux/setup-linux.sh
```

脚本会自动：

1. 解析仓库目录（脚本所在目录的上一级）与 `node` / `python` 可执行文件
2. 由模板生成 `~/.config/systemd/user/vrc-monitor.service`（`%h/vrchat-assistant` → 实际仓库路径，node 路径烘焙进 `ExecStart`；仓库或 node 路径含空格时自动对 `ExecStart` 含空格 token 加引号，避免 systemd 按空白拆分截断；node 不在 PATH 的 env 模式（`/usr/bin/env node`）保持两个 token，仅对仓库路径加引号）
3. `systemctl --user daemon-reload` + `enable --now`（立即启动 + 开机自启）
4. `loginctl enable-linger`（**登出后服务继续运行**，无头服务器必需）

> 前置条件：系统使用 systemd（glibc 发行版）。容器 / WSL 无 systemd 用户实例时不适用，可改用 Hermes 插件或手动 `node start-monitor.js`。

## 手动安装（可选）

仓库位于 `~/vrchat-assistant` 时，模板可直接使用：

```bash
mkdir -p ~/.config/systemd/user
cp service-linux/vrc-monitor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vrc-monitor
loginctl enable-linger    # 登出后继续运行
```

## 环境变量配置

服务读取的 `VRC_MONITOR_*` 环境变量（与 AGENTS.md 约定一致）。systemd 用户服务有两种配置方式：

1. **编辑单元文件**：`systemctl --user edit vrc-monitor`（drop-in，推荐，升级仓库不会覆盖）
2. **仓库根 `.env`**：`start-monitor.js` 启动时自动加载 `VRC_MONITOR_*` 变量（与手动启动行为一致）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VRC_MONITOR_DIR` | `start-monitor.js` 基于自身脚本目录自动探测 | 项目根目录（systemd 方案无需手动设置） |
| `VRC_MONITOR_NODE` | 安装脚本烘焙的 node 路径 | node 可执行文件路径 |
| `VRC_MONITOR_PYTHON` | PATH 中的 `python` | 执行 fetch-otp.py 的解释器。**systemd 用户服务 PATH 较精简，安装脚本检测到 PATH 无 `python` 时会自动注入 `python3` 路径**；若手动安装且 PATH 无 python，必须自行设置，否则 OTP 自动登录失败会陷入重试循环 |
| `VRC_MONITOR_DB_PATH` | `<仓库>/vrc-monitor.sqlite3` | 数据库文件位置（可迁移到独立数据盘） |
| `VRC_MONITOR_BACKUP_DIR` | `<仓库>/backups` | 自动备份目录 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 无 | 网络代理（服务自动直连 6s 失败后回退 WS 代理） |

示例（drop-in）：

```bash
systemctl --user edit vrc-monitor
```

```ini
[Service]
Environment=VRC_MONITOR_PYTHON=/usr/bin/python3
Environment=HTTPS_PROXY=http://127.0.0.1:7892
Environment=VRC_MONITOR_DB_PATH=/data/vrc-monitor.sqlite3
```

## 与 Windows 方案的差异

| 能力 | Windows（service-windows/） | Linux（本目录） |
|------|----------------------------|-----------------|
| 开机自启 | 计划任务 VrcMonLauncher（onlogon） | systemd 用户服务 + linger |
| 崩溃自愈 | VrcMonWatchdog 每分钟轮询健康端点 | systemd `Restart=always`（进程退出 5s 后自动重启） |
| 日志 | `service-logs/` 文件（`VRC_MONITOR_LOG_DIR`） | journald（`journalctl --user -u vrc-monitor`） |
| 每日修复报告 | `vrcmon_daily_report.py`（昨天有修复才输出一行） | 可复用同一脚本（见下） |

**每日修复报告（可选）**：`service-windows/vrcmon_daily_report.py` 是跨平台的（README 注明非 Windows 可用），用 cron 指向它即可，空输出时 cron 静默不投递：

```bash
# crontab: 每天 09:00
0 9 * * * python3 <仓库>/service-windows/vrcmon_daily_report.py
```

> systemd 方案下崩溃自愈由 systemd 承担，`vrcmon_repairs.log` 通常不会有修复记录——报告主要面向 Windows watchdog 场景。

## 常用命令

| 操作 | 命令 |
|------|------|
| 查看状态 | `systemctl --user status vrc-monitor` |
| 实时日志 | `journalctl --user -u vrc-monitor -f` |
| 最近日志 | `journalctl --user -u vrc-monitor -n 100 --no-pager` |
| 重启服务 | `systemctl --user restart vrc-monitor` |
| 停止服务 | `systemctl --user stop vrc-monitor` |
| 健康检查 | `curl http://127.0.0.1:8799/health` |

## 卸载

```bash
bash service-linux/setup-linux.sh --uninstall
```

会停止服务并删除用户单元文件。如需同时关闭 linger（影响所有用户服务）：

```bash
loginctl disable-linger <用户名>
```

## 故障排查

**Q: 服务启动后登录失败（OTP 一直重试）？**
A: 大概率是 systemd 用户服务 PATH 中没有 python。用 `systemctl --user edit vrc-monitor` 添加 `Environment=VRC_MONITOR_PYTHON=/usr/bin/python3`（安装脚本已自动处理常见情况）。

**Q: 登出后服务就停了？**
A: 执行 `loginctl enable-linger` 让用户服务在无登录会话时继续运行。

**Q: `systemctl --user` 报错不可达？**
A: 无 systemd 用户实例（容器 / WSL / SSH 无会话）。在桌面会话中执行，或用 Hermes 插件 / 手动启动。

**Q: 日志在哪里？**
A: journald：`journalctl --user -u vrc-monitor -f`。无需也不应设置 `VRC_MONITOR_LOG_DIR`（那是 Windows 文件日志目录）。

**Q: 服务反复崩溃后 systemd 停止重启了？**
A: systemd 默认启动限制（10 秒内最多 5 次）防止配置错误时无限循环重启。确认配置无误后可用 drop-in 放宽：`systemctl --user edit vrc-monitor` 添加 `[Service]` 段 `StartLimitIntervalSec=0`，再 `systemctl --user daemon-reload`。
