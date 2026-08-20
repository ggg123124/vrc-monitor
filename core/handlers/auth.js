/**
 * 认证 handler — TOTP 手动提交
 *
 * 账号仅启用 TOTP（或邮箱 OTP 抓取失败兜底）时，服务处于 needsTotp 状态，
 * Agent 调用 submit_totp 提交当前 Authenticator 验证码完成登录。
 */

import { ctx, log } from '../server-context.js';
import { notifier } from '../notifier.js';

export async function handleSubmitTotp({ code }) {
  const { api, serverState, wsManager } = ctx;
  if (!api) throw new Error('服务未初始化');

  const totpCode = String(code || '').trim();
  if (!/^\d{6}$/.test(totpCode)) {
    throw new Error('TOTP 验证码应为 6 位数字');
  }
  if (!api.tempAuthCookie) {
    throw new Error('当前没有待验证的 2FA 会话：请先触发一次 API 调用（如 get_online_friends），服务检测到 401 会自动进入重登录等待');
  }

  try {
    const user = await api.loginWithTotp(totpCode);
    serverState.authUser = { id: user.id, displayName: user.displayName };
    serverState.needsOtp = false;
    serverState.needsTotp = false;
    log(`🔐 TOTP 登录成功: ${user.displayName} (${user.id})`);
    notifier.notifyAuth('recovered', 'TOTP 验证码提交成功，服务已恢复正常');

    // 登录成功后立即让 WebSocket 重连上线
    if (wsManager) {
      wsManager.authCooldownUntil = 0;
      try { wsManager.forceReconnect(); } catch (e) { log(`⚠️ TOTP 后 WS 重连触发失败: ${e.message}`); }
    }
    return { success: true, displayName: user.displayName, userId: user.id };
  } catch (err) {
    throw new Error(`TOTP 验证失败: ${err.message}`);
  }
}
