"""vrc-monitor 服务启动器 — 以独立（detached）进程启动 node start-monitor.js。

用途：开机登录自启动（配合 setup-windows.cmd 生成的计划任务 / 启动 VBS）。
幂等：服务已在运行则直接退出（不重复启动）。

路径配置（环境变量，与 start-monitor.js 的 .env 约定一致）：
  VRC_MONITOR_DIR       项目根目录（默认：本脚本所在目录的上一级）
  VRC_MONITOR_NODE      node 可执行文件（默认：PATH 中的 node）
  VRC_MONITOR_LOG_DIR   服务日志目录（默认：<项目>/service-logs）

平台：主要面向 Windows（detached + 无窗口启动）；非 Windows 下同样可用（仅无窗口标志）。
"""
import subprocess, sys, os, urllib.request

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


def port_listening(port=8799):
    """仅 Windows 使用 netstat 探测端口占用（避免重复实例）。"""
    if sys.platform != "win32":
        return False
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, timeout=15).stdout
        for line in out.decode("utf-8", errors="ignore").splitlines():
            if f":{port}" in line and "LISTENING" in line:
                return True
    except Exception:
        pass
    return False


def main():
    if healthy() or port_listening():
        return 0  # 已在运行

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
