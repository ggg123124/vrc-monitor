/**
 * 跨平台通知通道 — 供 notifier.js 注册使用
 *
 * desktop: 系统桌面通知
 *   - Linux: notify-send（DBUS 会话可用时）
 *   - macOS: osascript display notification
 *   - Windows: PowerShell toast（无实测，失败静默回退——仅日志/webhook，交由上游验证）
 * webhook: POST JSON 到配置的 webhook_url（群机器人 / push 服务），跨平台通用
 *
 * 所有通道失败一律静默吞掉（不抛），保证通知失败不影响主服务。
 */

import { execFileSync } from 'node:child_process';

function makeDesktopChannel() {
  const platform = process.platform;
  return (kind, message) => {
    // 桌面通知失败一律静默降级（DBUS/notify 守护不可用时不应抛错影响主服务）
    try {
      const title = {
        needsTotp: 'VRChat 需要人工介入：TOTP 验证码',
        otpFailed: 'VRChat 登录失败：邮箱验证码获取失败',
        reauthFailed: 'VRChat 会话失效：自动重认证失败',
        recovered: 'VRChat 已恢复正常',
      }[kind] || 'VRChat 通知';

      if (platform === 'linux') {
        execFileSync('notify-send', ['--urgency=critical', title, message], { timeout: 5000 });
      } else if (platform === 'darwin') {
        // 用 osascript 弹出 macOS 系统通知
        const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
        execFileSync('osascript', ['-e', script], { timeout: 5000 });
      } else if (platform === 'win32') {
        // PowerShell toast 实现（本机 Linux 无法实测，交由上游验证；失败静默降级）
        const ps = [
          '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
          '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
          `$toastXml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
          `$textNodes = $toastXml.GetElementsByTagName('text')`,
          `$textNodes.Item(0).AppendChild($toastXml.CreateTextNode('${title}')) | Out-Null`,
          `$textNodes.Item(1).AppendChild($toastXml.CreateTextNode('${message.replace(/'/g, "''")}')) | Out-Null`,
          `$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)`,
          `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('VRChat Monitor').Show($toast)`,
        ].join('; ');
        execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 5000 });
      }
      // 其他未知平台：静默跳过（无桌面通知能力）
    } catch {
      // 静默：通知失败不影响主服务（notifier 层还会再兜底记录）
    }
  };
}

function makeWebhookChannel(webhookUrl) {
  return async (kind, message) => {
    const payload = {
      event: kind,
      title: {
        needsTotp: 'VRChat 需要人工介入：TOTP 验证码',
        otpFailed: 'VRChat 登录失败：邮箱验证码获取失败',
        reauthFailed: 'VRChat 会话失效：自动重认证失败',
        recovered: 'VRChat 已恢复正常',
      }[kind] || 'VRChat 通知',
      message,
      time: new Date().toISOString(),
    };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`webhook HTTP ${res.status}`);
    }
  };
}

/** 根据 notify-config 构建并返回通道列表（未启用/无法构建的通道自动跳过） */
export function buildChannels(config = {}) {
  const channels = [];
  const list = Array.isArray(config.channels) ? config.channels : [];

  if (list.includes('desktop')) {
    try {
      channels.push(makeDesktopChannel());
    } catch {
      // 平台不支持的 desktop 实现：跳过
    }
  }
  if (list.includes('webhook')) {
    if (config.webhook_url) {
      channels.push(makeWebhookChannel(config.webhook_url));
    }
  }
  return channels;
}
