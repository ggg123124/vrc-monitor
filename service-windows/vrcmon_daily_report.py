"""vrc-monitor 每日修复报告 — 统计昨天（自然日）的自动修复次数。

行为：
  - 昨天有 >= 1 次修复 → 打印一行报告（含当前服务状态），可接任意通知渠道
    （Hermes no_agent cron / Windows 计划任务 / cron 邮件等）。
  - 昨天没有修复 → 不打印任何内容（静默，零通知零消耗）。

路径配置（环境变量，与 start-monitor.js 的 .env 约定一致）：
  VRC_MONITOR_LOG_DIR   日志目录（默认：<项目>/service-logs）
    修复日志：<LOG_DIR>/vrcmon-repairs.log（watchdog 写入，格式：YYYY-MM-DD HH:MM:SS repair）
"""
import datetime, os, urllib.request


def log_dir():
    env = os.environ.get("VRC_MONITOR_LOG_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "service-logs",
    )


def main():
    repair_log = os.path.join(log_dir(), "vrcmon-repairs.log")
    yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    count = 0
    if os.path.exists(repair_log):
        with open(repair_log, encoding="utf-8") as f:
            for line in f:
                if line.startswith(yesterday):
                    count += 1
    if count == 0:
        return 0  # 昨天没有崩溃修复 -> 不输出、不通知

    ok = False
    try:
        with urllib.request.urlopen("http://127.0.0.1:8799/health", timeout=4) as r:
            ok = r.status == 200
    except Exception:
        pass
    status = "正常" if ok else "异常（watchdog 可能正在修复）"
    print(f"vrc-monitor 昨日修复报告：昨天（{yesterday}）共自动修复 {count} 次，服务目前{status}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
