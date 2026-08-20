/**
 * TOTP 生成模块离线测试 — RFC 6238 附录 B 官方测试向量
 *
 * 无凭据、纯算法验证（符合 DEVELOPMENT.md §6：CI 只能覆盖无凭据也能验证的部分）。
 * 运行: node test-totp.mjs
 */
import { parseTotpSecret, base32Decode, generateTotp, getTotpCodes } from './core/totp.js';

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    pass++;
    console.log(`  ✅ ${name} → ${expected}`);
  } else {
    fail++;
    console.error(`  ❌ ${name} → 实际 ${actual}，期望 ${expected}`);
  }
}

function checkThrows(name, fn, msgRe) {
  try {
    fn();
    fail++;
    console.error(`  ❌ ${name} → 未抛错`);
  } catch (err) {
    if (msgRe && !msgRe.test(err.message)) {
      fail++;
      console.error(`  ❌ ${name} → 抛错但信息不符: ${err.message}`);
    } else {
      pass++;
      console.log(`  ✅ ${name} → 正确抛错: ${err.message}`);
    }
  }
}

console.log('■ RFC 6238 附录 B 测试向量（key = ASCII "12345678901234567890"，SHA1）');
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
for (const [t, expected] of VECTORS) {
  const counter = Math.floor(t / 30);
  const code = generateTotp(RFC_KEY, counter, { digits: 8, algorithm: 'SHA1' });
  check(`T=${t} (8位)`, code, expected);
}

console.log('■ 6 位派生（官方向量后 6 位）');
for (const [t, expected8] of VECTORS.slice(0, 4)) {
  const counter = Math.floor(t / 30);
  const code = generateTotp(RFC_KEY, counter, { digits: 6, algorithm: 'SHA1' });
  check(`T=${t} (6位)`, code, expected8.slice(2));
}

console.log('■ otpauth:// URI 解析');
{
  const uri = 'otpauth://totp/VRChat:test@example.com?secret=JBSWY3DPEHPK3PXP&issuer=VRChat';
  const p = parseTotpSecret(uri);
  check('解析 secretB32', p.secretB32, 'JBSWY3DPEHPK3PXP');
  check('默认 digits', p.digits, 6);
  check('默认 period', p.period, 30);
  check('默认 algorithm', p.algorithm, 'SHA1');
}
{
  const uri = 'otpauth://totp/VRChat?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30&algorithm=SHA256';
  const p = parseTotpSecret(uri);
  check('自定义 digits', p.digits, 8);
  check('自定义 period', p.period, 30);
  check('自定义 algorithm', p.algorithm, 'SHA256');
}

console.log('■ base32 解码');
{
  const b = base32Decode('JBSWY3DPEHPK3PXP');
  check('base32 解码字节数', b.length, 10);
  check('base32 解码内容', b.toString('hex'), '48656c6c6f21deadbeef');
  const b2 = base32Decode('jbs w y3dpehpk3pxp'); // 容错：小写+空格
  check('容错解码', b2.equals(b), true);
}

console.log('■ getTotpCodes 窗口容错');
{
  const res = getTotpCodes('JBSWY3DPEHPK3PXP', { now: 59 }); // T=59 秒
  check('返回窗口数（count=1 → 3 个）', res.codes.length, 3);
  const nowCode = generateTotp(base32Decode('JBSWY3DPEHPK3PXP'), Math.floor(59 / 30), { digits: 6 });
  check('当前窗口码一致', res.codes[1], nowCode);
  check('前窗口码不同', res.codes[0] !== res.codes[1], true);
  check('后窗口码不同', res.codes[2] !== res.codes[1], true);
}

console.log('■ 无效输入抛错');
checkThrows('空输入', () => parseTotpSecret(''), /未提供/);
checkThrows('非法 base32 字符', () => parseTotpSecret('JBSWY3DPEHPK3PXP0'), /无效的 base32/);
checkThrows('URI 缺 secret', () => parseTotpSecret('otpauth://totp/VRChat?digits=6'), /缺少 secret/);

console.log('\n════════════════════════════');
console.log(`结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);