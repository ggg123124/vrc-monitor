/**
 * OTP 邮箱获取 — 调用 fetch-otp.py 从邮箱提取 VRChat 验证码
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ctx } from './server-context.js';

export async function fetchOtpFromEmail() {
  const { __dirname, CRED_FILE } = ctx.paths;
  const otpScript = path.join(__dirname, 'fetch-otp.py');
  if (!existsSync(otpScript)) {
    throw new Error('fetch-otp.py 不存在');
  }
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const { execSync } = await import('node:child_process');
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  let cmd = `python "${otpScript}" "${creds.email}" "${authCode}"`;
  if (creds.imap_host) cmd += ` "${creds.imap_host}"`;
  const otp = execSync(cmd, { timeout: 15000, encoding: 'utf-8' }).trim();
  return otp;
}
