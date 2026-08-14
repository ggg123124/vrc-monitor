@echo off
rem ============================================================
rem  vrc-monitor 常驻服务一键设置（Windows）
rem  用法: setup-windows.cmd [python解释器路径]
rem     - 不传参数时自动从 PATH 查找 python
rem  创建:
rem     1) VrcMonWatchdog 计划任务（每分钟检查，崩溃自动重启）
rem     2) VrcMonLauncher 登录自启动（onlogon 计划任务；若权限不足
rem        则回退写入当前用户 Startup 文件夹 VBS，等效）
rem  卸载: schtasks /delete /tn VrcMonWatchdog /f
rem        schtasks /delete /tn VrcMonLauncher /f  (或删除 Startup\VrcMon_Launcher.vbs)
rem ============================================================
setlocal
cd /d "%~dp0"

set "PYTHON=%~1"
if "%PYTHON%"=="" (
  for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PYTHON set "PYTHON=%%i"
  )
)
if "%PYTHON%"=="" (
  echo [ERROR] 找不到 python，请传入解释器路径: setup-windows.cmd C:\path\to\python.exe
  exit /b 1
)

echo [1/3] 创建 VrcMonWatchdog 计划任务（每 1 分钟崩溃自愈）...
schtasks /create /tn "VrcMonWatchdog" /tr "\"%PYTHON%\" \"%CD%\vrcmon_watchdog.py\"" /sc minute /mo 1 /f

echo [2/3] 创建 VrcMonLauncher 登录自启动（onlogon）...
schtasks /create /tn "VrcMonLauncher" /tr "\"%PYTHON%\" \"%CD%\vrcmon_service_launcher.py\"" /sc onlogon /f
if errorlevel 1 (
  echo       onlogon 权限不足，回退到当前用户 Startup 文件夹...
  set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
  > "%STARTUP%\VrcMon_Launcher.vbs" echo Set sh = CreateObject("WScript.Shell")
  >> "%STARTUP%\VrcMon_Launcher.vbs" echo sh.Run """%PYTHON%"" ""%CD%\vrcmon_service_launcher.py""", 0, False
  echo       已写入 "%STARTUP%\VrcMon_Launcher.vbs"
)

echo [3/3] 启动服务（若未运行）...
"%PYTHON%" "%CD%\vrcmon_service_launcher.py"

echo.
echo 完成。可选：每日修复报告（每天 09:00，昨天有修复才输出）可接入任意调度器：
echo   Hermes: cron no_agent 任务指向 vrcmon_daily_report.py（空输出 = 静默）
echo   Windows: schtasks /create /tn VrcMonDailyReport /tr "\"%PYTHON%\" \"%CD%\vrcmon_daily_report.py\"" /sc daily /st 09:00 /f
endlocal
