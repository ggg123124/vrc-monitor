"""vrc-monitor watchdog — 崩溃自动修复（建议由计划任务每分钟运行一次）。

行为：
  - 服务健康（http://127.0.0.1:8799/health 返回 200）→ 静默退出（不输出、不通知）。
  - 服务不健康 → 杀掉 :8799 残留监听进程（仅 Windows）→ 以独立进程重新启动 →
    等待 25 秒验证 → 成功则在修复日志追加一行；失败写入 watchdog 日志。
  - 全程无 stdout 输出（接入通知系统时：空输出 = 静默，可零成本轮询）。

路径配置（环境变量，与 start-monitor.js 的 .env 约定一致）：
  VRC_MONITOR_DIR       项目根目录（默认：本脚本所在目录的上一级）
  VRC_MONITOR_NODE      node 可执行文件（默认：PATH 中的 node）
  VRC_MONITOR_LOG_DIR   日志目录（默认：<项目>/service-logs）
    修复日志：<LOG_DIR>/vrcmon-repairs.log（每日报告脚本消费）
    watchdog 日志：<LOG_DIR>/vrcmon-watchdog.log
    服务日志：<LOG_DIR>/vrcmon-service.log

平台：kill 残留进程用 netstat/taskkill，仅 Windows 启用（sys.platform 门控）；
非 Windows 跳过该步直接重启，其余逻辑跨平台。
"""
import subprocess, sys, os, time, datetime, urllib.request

HEALTH_URL = "http://127.0.0.1:8799/health"


def project_dir():
    env = os.environ.get("VRC_MONITOR_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def node_bin():
    return os.environ.get("VRC_MONITOR_NODE") or "node"


def log_dir():
    env = os.environ.get("VRC_MONITOR_LOG_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.join(project_dir(), "service-logs")


def healthy():
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=4) as r:
            return r.status == 200
    except Exception:
        return False


def port_pid(port=8799):
    """Windows: 返回监听指定端口的 PID（netstat 输出按本机代码页解码，兼容中文系统）。"""
    if sys.platform != "win32":
        return None
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, timeout=15).stdout
        for line in out.decode("utf-8", errors="ignore").splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                if parts:
                    return int(parts[-1])
    except Exception:
        pass
    return None


def _append(path, text):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(text)
    except Exception:
        pass


def _launch_detached():
    os.makedirs(log_dir(), exist_ok=True)
    logf = open(os.path.join(log_dir(), "vrcmon-service.log"), "ab")
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        try:
            flags |= subprocess.CREATE_NO_WINDOW
        except AttributeError:
            pass
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    subprocess.Popen(
        [node_bin(), "start-monitor.js"],
        cwd=project_dir(),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=logf,
        stderr=logf,
        creationflags=flags,
        close_fds=True,
    )


def main():
    if healthy():
        return 0  # 一切正常，静默

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    pid = port_pid()
    if pid is not None:
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=15)
        except Exception:
            pass
        time.sleep(2)

    try:
        _launch_detached()
    except Exception as e:
        _append(os.path.join(log_dir(), "vrcmon-watchdog.log"), f"{now} launch error: {e}\n")
        return 0

    time.sleep(25)
    if healthy():
        _append(os.path.join(log_dir(), "vrcmon-repairs.log"), f"{now} repair\n")
    else:
        _append(os.path.join(log_dir(), "vrcmon-watchdog.log"), f"{now} repair attempt failed (not healthy after 25s)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
