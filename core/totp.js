/**
 * TOTP（RFC 6238）生成模块 — 纯 Node 内置 crypto 实现，零依赖
 *
 * 用途：账号仅启用 TOTP 两步验证时，服务用本地生成的验证码自动完成登录，
 * 无需手动调用 submit_totp（与 VRCX 的 Authenticator 自动登录行为一致）。
 *
 * 支持两种 secret 输入：
 *   1. otpauth://  URI（Authenticator 应用导出的完整链接，含 secret/digits/period/algorithm）
 *   2. 纯 base32 密钥（otpauth URI 中的 secret 参数）
 */
import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32 解码为原始字节（容错：忽略空白、连字符、填充 =） */
export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s\-=]/g, '');
  if (!clean) throw new Error('空的 base32 secret');
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`无效的 base32 字符: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * 解析 TOTP secret 输入，返回标准化参数。
 * @param {string} input otpauth:// URI 或 base32 密钥
 * @returns {{ secretBytes: Buffer, secretB32: string, digits: number, period: number, algorithm: string }}
 */
export function parseTotpSecret(input) {
  const str = String(input || '').trim();
  if (!str) throw new Error('未提供 TOTP secret');

  let secretB32 = null;
  let digits = 6;
  let period = 30;
  let algorithm = 'SHA1';

  if (/^otpauth:\/\/totp\//i.test(str)) {
    const url = new URL(str);
    secretB32 = url.searchParams.get('secret');
    const d = url.searchParams.get('digits');
    const p = url.searchParams.get('period');
    const a = url.searchParams.get('algorithm');
    if (d) digits = parseInt(d, 10);
    if (p) period = parseInt(p, 10);
    if (a) algorithm = a.toUpperCase();
    if (!secretB32) throw new Error('otpauth URI 缺少 secret 参数');
    // 参数合法性校验（审核 #70 🟡 建议 3）：digits 6-8 位、period 正整数、algorithm 受支持的 HMAC 算法
    if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
      throw new Error(`无效的 digits: "${d}"（应为 6-8 位整数）`);
    }
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error(`无效的 period: "${p}"（应为正整数秒）`);
    }
    const SUPPORTED = ['SHA1', 'SHA256', 'SHA512'];
    if (!SUPPORTED.includes(algorithm)) {
      throw new Error(`不支持的 algorithm: "${a}"（支持 ${SUPPORTED.join('/')}）`);
    }
  } else {
    secretB32 = str;
  }

  const secretBytes = base32Decode(secretB32);
  if (!secretBytes.length) throw new Error('base32 解码后 secret 为空');
  return { secretBytes, secretB32, digits, period, algorithm };
}

/**
 * RFC 6238 核心算法：给定原始密钥字节与时间步计数器，生成验证码。
 * @param {Buffer} keyBytes 密钥原始字节
 * @param {number} counter 时间步计数器（floor(time / period)）
 * @param {{ digits?: number, algorithm?: string }} [opts]
 * @returns {string} digits 位验证码
 */
export function generateTotp(keyBytes, counter, opts = {}) {
  const digits = opts.digits || 6;
  const algorithm = opts.algorithm || 'SHA1';
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, keyBytes).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff);
  const code = bin % (10 ** digits);
  return code.toString().padStart(digits, '0');
}

/**
 * 生成当前时间前后的 TOTP 验证码（容错时钟漂移 / 窗口轮换）。
 * @param {string} input otpauth:// URI 或 base32 密钥
 * @param {{ now?: number|Date, count?: number }} [opts] now 为 Unix 时间（秒或毫秒，缺省取当前时间）
 * @returns {{ digits: number, period: number, algorithm: string, codes: string[] }} codes[0]=前窗口, codes[1]=当前, codes[2]=后窗口（count=1）
 */
export function getTotpCodes(input, opts = {}) {
  const { secretBytes, digits, period, algorithm } = parseTotpSecret(input);
  const count = opts.count == null ? 1 : opts.count;

  let now = opts.now != null ? opts.now : Date.now();
  if (now instanceof Date) now = now.getTime();
  if (now > 1e12) now = Math.floor(now / 1000); // 毫秒 → 秒
  now = Math.floor(now);

  const counter = Math.floor(now / period);
  const codes = [];
  for (let i = -count; i <= count; i++) {
    codes.push(generateTotp(secretBytes, counter + i, { digits, algorithm }));
  }
  return { digits, period, algorithm, codes };
}