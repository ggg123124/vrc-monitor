#!/usr/bin/env bash
# ============================================================
#  vrc-monitor 常驻服务一键设置（Linux systemd 用户服务）
#  用法: bash service-linux/setup-linux.sh [--uninstall]
#    - 默认安装：解析仓库路径 / node / python → 生成用户单元
#      ~/.config/systemd/user/vrc-monitor.service → enable --now
#    - --uninstall：停止并删除用户单元
#  说明:
#    - 崩溃自愈由 systemd Restart=always 提供（等价 Windows 方案 watchdog）
#    - 日志走 journald（journalctl --user -u vrc-monitor -f）
#    - loginctl enable-linger 保证登出后服务继续运行（无头服务器必需）
#    - 单元模板 service-linux/vrc-monitor.service 用 %h 占位，
#      本脚本安装时替换为实际仓库路径（不引入个人环境硬编码）
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNIT_NAME="vrc-monitor.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
TEMPLATE="$SCRIPT_DIR/$UNIT_NAME"

usage() {
  cat <<'EOF'
用法: bash service-linux/setup-linux.sh [选项]
选项:
  --uninstall   停止并删除 vrc-monitor 用户服务（linger 需手动关闭）
  -h, --help    显示本帮助

默认（无选项）执行安装：
  1) 解析仓库目录 / node / python 可执行文件
  2) 由模板生成用户单元（替换 %h/vrchat-assistant 为实际路径）
  3) systemctl --user daemon-reload && enable --now
  4) loginctl enable-linger（登出后继续运行）
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --uninstall)
    if [[ ! -f "$UNIT_FILE" ]]; then
      echo "[ok] 用户单元不存在（$UNIT_FILE），无需卸载"
      exit 0
    fi
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
    echo "[ok] 已卸载 $UNIT_NAME"
    echo "     服务已停止，用户单元文件已删除。"
    echo "     linger 如需关闭：loginctl disable-linger ${USER:-$(id -un)}"
    exit 0
    ;;
  "")
    ;;
  *)
    echo "[error] 未知参数: $1"
    usage
    exit 1
    ;;
esac

# ── 前置检查：systemd 用户管理器可达 ──
if ! command -v systemctl >/dev/null 2>&1; then
  echo "[error] 未找到 systemctl（系统无 systemd，容器 / WSL 等环境不适用本方案）"
  echo "       可改用 hermes 插件或手动执行 node start-monitor.js"
  exit 1
fi
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "[error] systemd 用户管理器不可达。常见原因与解决："
  echo "  - SSH / 无桌面会话：用户管理器未随会话启动，可用 loginctl enable-linger 常驻后重试"
  echo "  - 容器 / WSL 无 systemd：本方案不适用，可改用 hermes 插件或手动启动"
  exit 1
fi

# ── 解析 node / python（写入生成单元，规避 PATH 精简导致的坑）──
NODE_BIN="$(command -v node || true)"
PYTHON_BIN="$(command -v python || true)"
PYTHON3_BIN="$(command -v python3 || true)"

echo "[1/4] 仓库目录: $REPO_DIR"
echo "      node:     ${NODE_BIN:-未找到（ExecStart 保留 /usr/bin/env node，需 systemd 环境 PATH 可解析）}"
echo "      python:   ${PYTHON_BIN:-未找到} | python3: ${PYTHON3_BIN:-未找到}"

# ── 生成单元文件（模板 → 烘焙真实路径；bash 参数替换为字面替换，无需转义）──
unit="$(<"$TEMPLATE")"
# ExecStart 单独组装：node 与仓库路径含空格时 systemd 按空白拆分参数会截断，
# 需对含空格 token 加引号（无空格时保持模板原样，便于阅读/排查）。
# env 模式（node 不在 PATH）下 /usr/bin/env node 是两个独立 token，
# 只能对路径加引号，绝不能整体加引号（否则被当单个可执行文件路径导致启动失败）
main_arg="$REPO_DIR/start-monitor.js"
if [[ -n "$NODE_BIN" ]]; then
  if [[ "$NODE_BIN" == *" "* || "$main_arg" == *" "* ]]; then
    exec_line="ExecStart=\"$NODE_BIN\" \"$main_arg\""
  else
    exec_line="ExecStart=$NODE_BIN $main_arg"
  fi
else
  if [[ "$main_arg" == *" "* ]]; then
    exec_line="ExecStart=/usr/bin/env node \"$main_arg\""
  else
    exec_line="ExecStart=/usr/bin/env node $main_arg"
  fi
fi
unit="${unit//'ExecStart=/usr/bin/env node %h/vrchat-assistant/start-monitor.js'/$exec_line}"
unit="${unit//'%h/vrchat-assistant'/$REPO_DIR}"
# PATH 无 python 但存在 python3：解除注释并注入 VRC_MONITOR_PYTHON，
# 否则 OTP 自动登录失败会陷入重试循环（AGENTS.md 环境变量章节明确要求）
if [[ -z "$PYTHON_BIN" && -n "$PYTHON3_BIN" ]]; then
  unit="${unit//'# Environment=VRC_MONITOR_PYTHON=/usr/bin/python3'/"Environment=VRC_MONITOR_PYTHON=$PYTHON3_BIN"}"
  echo "      → PATH 无 python，已注入 Environment=VRC_MONITOR_PYTHON=$PYTHON3_BIN"
fi

mkdir -p "$UNIT_DIR"
printf '%s\n' "$unit" > "$UNIT_FILE"
echo "[2/4] 已生成用户单元: $UNIT_FILE"

# ── 注册并启动 ──
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"
echo "[3/4] 已 enable --now $UNIT_NAME"

# ── linger：登出后继续运行（无头服务器 / 监控常驻必需）──
if loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null; then
  echo "[4/4] 已启用 linger（登出后服务继续运行）"
else
  echo "[4/4] [warn] enable-linger 失败（无 logind / 容器环境），登出后服务会停止"
  echo "      手动执行: loginctl enable-linger ${USER:-$(id -un)}"
fi

echo
echo "完成。常用命令："
echo "  查看状态:   systemctl --user status $UNIT_NAME"
echo "  实时日志:   journalctl --user -u $UNIT_NAME -f"
echo "  重启服务:   systemctl --user restart $UNIT_NAME"
echo "  健康检查:   curl http://127.0.0.1:8799/health"
echo "  卸载:       bash $SCRIPT_DIR/setup-linux.sh --uninstall"
