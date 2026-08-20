/**
 * VRChat 好友监控系统 — 主入口
 * 
 * 独立 MCP 服务（不依赖 VRCX-0）
 * 提供 WebSocket 实时监控 + SQLite 存储 + MCP 工具服务
 * 
 * 启动: node start-monitor.js
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';

import { ctx, log, refreshWatchlistCache } from './core/server-context.js';
import { CUSTOM_TOOLS } from './core/mcp-definitions.js';
import { Storage } from './core/storage.js';
import { RateLimiter } from './core/rate-limiter.js';
import { VrchatApiClient } from './vrchat-api.js';
import { WsManager } from './core/ws-manager.js';
import { EventPipeline } from './core/event-pipeline.js';
import { backupDatabase } from './core/backup.js';
import { FriendStateManager } from './core/friend-state.js';
import { createServer } from './core/http-server.js';
import { fetchOtpFromEmail } from './core/otp-fetcher.js';
import { parseTotpSecret, generateTotp } from './core/totp.js';
import { notifier } from './core/notifier.js';
import { buildChannels } from './core/notify-channels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载（只取 VRC_MONITOR_*）──
// 注意：无条件覆盖 process.env——服务被插件 spawn 时可能继承旧值，跳过会导致 .env 配置失效
// 个人配置（分组权重/联系人名单/DB 路径等）放仓库根 .env（.gitignore 已忽略），不硬编码进代码
try {
  const envFile = path.join(__dirname, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf-8').split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && m[1].startsWith('VRC_MONITOR_')) {
        process.env[m[1]] = m[2];
      }
    }
  }
} catch (e) { /* .env 加载失败不阻断 */ }

// ── 路径常量 → 写入 ctx.paths ──
// DB / 备份目录可通过 .env 的 VRC_MONITOR_DB_PATH / VRC_MONITOR_BACKUP_DIR 覆盖
const PORT = 8799;
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');
const CRED_FILE = path.join(__dirname, 'credentials.json');
const NOTIFY_FILE = path.join(__dirname, 'notify-config.json');
const DB_PATH = process.env.VRC_MONITOR_DB_PATH
  ? path.resolve(process.env.VRC_MONITOR_DB_PATH)
  : path.join(__dirname, 'vrc-monitor.sqlite3');
const BACKUP_DIR = process.env.VRC_MONITOR_BACKUP_DIR
  ? path.resolve(process.env.VRC_MONITOR_BACKUP_DIR)
  : path.join(__dirname, 'backups');
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每 24h 自动备份

Object.assign(ctx.paths, { __dirname, PORT, COOKIE_FILE, CRED_FILE, DB_PATH, BACKUP_DIR, BACKUP_INTERVAL_MS });

// ── WebSocket 事件 → 好友状态更新 ──
async function _updateFriendState(event) {
  const { friendState } = ctx;
  switch (event.type) {
    case 'friend-online':
      friendState.setOnline(event.userId, {
        displayName: event.displayName,
        location: event.location,
        worldId: event.worldId,
      });
      break;
    case 'friend-offline':
      friendState.setOffline(event.userId);
      break;
    case 'friend-location':
      friendState.updateLocation(event.userId, {
        displayName: event.displayName,
        location: event.location,
        worldId: event.worldId,
      });
      break;
    case 'friend-active':
      friendState.setOnline(event.userId);
      break;
  }
}

// ── WebSocket 重连后刷新全量在线状态 ──
async function _refreshOnlineState() {
  const { api, friendState } = ctx;
  try {
    const r = await api._request('GET', '/auth/user/friends?offline=false');
    if (r.status === 200 && Array.isArray(r.data)) {
      const online = r.data.filter(f => f.location && f.location !== 'offline');
      friendState.batchSetOnline(online.map(f => ({
        userId: f.id,
        displayName: f.displayName,
        location: f.location,
        worldId: f.worldId,
        isOnline: true,
      })));
      log(`🔄 刷新在线状态: ${friendState.getOnlineCount()} 人在线`);
    }
  } catch (err) {
    log(`⚠️ 刷新在线状态失败: ${err.message}`);
  }
}

// ── 端口占用探测（net.connect 成功 = 已有进程监听）──
function isPortBusy(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(false); });
  });
}

// ── 启动 ──

async function main() {
  // 动态读取版本号（package.json，避免硬编码漂移）
  let APP_VERSION = 'unknown';
  try {
    APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version;
  } catch { /* 读不到则显示 unknown，不阻断启动 */ }
  console.log('══════════════════════════════════════════════');
  console.log(`  VRChat-Assistant v${APP_VERSION}`);
  console.log('══════════════════════════════════════════════\n');

  // 0. 端口预检：MCP 端口已被占用 → 立即退出（防双实例并存 → OTP 验证码互抢循环，issue #49）
  //    必须前置：认证+OTP 抓取/WebSocket 在 main() 靠后位置，若等 listen 阶段才发现端口冲突，
  //    第二个实例早已抢走/消费验证码，触发 VRChat 重复下发，造成邮箱验证码轰炸
  if (await isPortBusy(PORT)) {
    console.error('');
    console.error(`❌ 端口 ${PORT} 已被占用，检测到监控服务可能已在运行`);
    console.error('   为避免双实例并存互抢 OTP 验证码（造成邮箱验证码轰炸），本进程将退出。');
    console.error('   请先确认旧实例状态并结束残留进程后重启：');
    console.error('     Windows: netstat -ano | findstr 8799  或  tasklist | findstr node');
    console.error('     Linux:   ss -ltnp | grep 8799         或  ps aux | grep start-monitor');
    console.error('');
    process.exit(1);
  }

  ctx.serverState.started = new Date().toISOString();

  // 1. 初始化数据库
  log('📦 初始化数据库...');
  ctx.storage = new Storage();
  await ctx.storage.init(DB_PATH);
  const stats = ctx.storage.getStats();
  log(`   ✅ 数据库就绪: ${DB_PATH}`);
  log(`   📊 事件: ${stats.events} 条 | 好友: ${stats.friends} 位 | 世界缓存: ${stats.world_cache} 个`);
  refreshWatchlistCache();  // 初始化 watchlist 内存缓存

  // 2. 初始化 API 客户端
  log('\n🔑 初始化 API 客户端...');
  if (!existsSync(CRED_FILE)) {
    console.error('\n❌ 未找到 credentials.json — 无法登录 VRChat');
    console.error('');
    console.error('   请先完成配置：');
    console.error('   1. 复制 credentials.example.json 为 credentials.json');
    console.error('   2. 填入 VRChat 邮箱、密码、邮箱 IMAP 授权码（imap_auth_code）');
    console.error('   3. 配置说明详见仓库根目录 AGENTS.md');
    console.error('');
    process.exit(1);
  }
  let creds;
  try {
    creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  } catch (parseErr) {
    console.error(`\n❌ credentials.json 解析失败: ${parseErr.message}`);
    console.error('   请检查文件是否为合法 JSON（参考 credentials.example.json 模板）');
    process.exit(1);
  }
  if (!creds.email || !creds.password) {
    console.error('\n❌ credentials.json 缺少 email 或 password 字段');
    console.error('   请参考 credentials.example.json 补全配置');
    process.exit(1);
  }
  ctx.api = new VrchatApiClient(creds.email, creds.password);
  ctx.api.setOtpFetcher(fetchOtpFromEmail);  // 401 自动重认证时复用邮箱 OTP 抓取

  // 可选的 TOTP 自动登录（credentials.json 配置 totp_secret 后启用）
  // 服务用 RFC 6238 本地生成验证码，登录/401 重认证/WS 重连全程自动，无需手动 submit_totp
  let totpFetcher = null;
  if (creds.totp_secret) {
    try {
      const { secretBytes, digits, period, algorithm } = parseTotpSecret(creds.totp_secret);
      // 利用前后窗口容错（审核 #70 🟡 建议 2）：返回 [前窗口, 当前, 后窗口] 三窗口验证码，
      // 由 _autoTotpLogin 依次尝试，容忍时钟漂移/窗口轮换（getTotpCodes count=1）
      totpFetcher = () => {
        const counter = Math.floor(Math.floor(Date.now() / 1000) / period);
        return [counter - 1, counter, counter + 1].map((c) => generateTotp(secretBytes, c, { digits, algorithm }));
      };
      ctx.api.setTotpFetcher(totpFetcher);
      log(`   🔐 TOTP 自动登录已启用（digits=${digits}, period=${period}s, ${algorithm}，前后窗口容错）`);
    } catch (parseErr) {
      console.error(`   ⚠️ totp_secret 解析失败（${parseErr.message}）：TOTP 自动登录不可用，将回退手动 submit_totp`);
    }
  }

  // 登录状态主动通知（issue #69）：加载 notify-config.json，注册跨平台通道
  // 默认关闭（缺文件 / enabled:false），只在需人工介入/异常时通知，多次失败聚合去抖
  let notifyConfig = { enabled: false };
  try {
    if (existsSync(NOTIFY_FILE)) {
      notifyConfig = JSON.parse(readFileSync(NOTIFY_FILE, 'utf-8'));
    }
  } catch (cfgErr) {
    console.error(`   ⚠️ notify-config.json 解析失败（${cfgErr.message}），通知已关闭`);
    notifyConfig = { enabled: false };
  }
  notifier.configure(notifyConfig);
  for (const ch of buildChannels(notifyConfig)) {
    notifier.registerChannel(ch);
  }
  if (notifier.enabled) {
    log(`   🔔 登录状态主动通知已启用（通道: ${(notifyConfig.channels || []).join(', ') || '无'}，连续失败阈值 ${notifier.config.consecutiveFailThreshold}，间隔 ${notifier.config.minIntervalSec}s）`);
  }
  ctx.api.loadCookieFromFile(COOKIE_FILE);
  try {
    const user = await ctx.api.ensureAuthWithAutoOtp(fetchOtpFromEmail);
    ctx.serverState.authUser = { id: user.id, displayName: user.displayName };
    ctx.serverState.needsOtp = false;
    log(`   ✅ 已登录: ${user.displayName} (${user.id})`);
    ctx.api.saveCookieToFile(COOKIE_FILE);
  } catch (err) {
    ctx.serverState.needsOtp = false;
    ctx.serverState.needsTotp = !!err.needsTotp;
    if (err.needsTotp) {
      if (totpFetcher) {
        log(`   ⚠️ 账号需要 TOTP 验证码：已配置自动登录，将在认证冷却后自动重试（或调用 submit_totp 手动提交）`);
        notifier.notifyAuth('needsTotp', '账号需要 TOTP 验证码（已配置自动登录，若持续失败请检查 totp_secret 或手动提交）');
      } else {
        log(`   ⚠️ 账号启用 TOTP 两步验证：请调用 MCP 工具 submit_totp 提交当前验证码（或在 credentials.json 配置 totp_secret 启用自动登录）`);
        notifier.notifyAuth('needsTotp', '账号需要 TOTP 验证码，服务暂停——请调用 submit_totp 提交当前验证码');
      }
    } else {
      notifier.notifyAuth('otpFailed', `启动登录失败：${err.message}`);
    }
    log(`   ❌ 登录失败: ${err.message}`);
    // 不退出进程，让 MCP/WS 服务启动以便后续重试
  }

  // 3. 初始化限流器
  ctx.rateLimiter = new RateLimiter({ minInterval: 2600 });
  log(`\n⏱  限流器: 间隔 ${ctx.rateLimiter.minInterval}ms`);

  // 4. 初始化好友状态管理器
  ctx.friendState = new FriendStateManager();
  log(`\n👥 好友状态管理器就绪`);

  // 5. 初始化事件处理管道
  ctx.eventPipeline = new EventPipeline(ctx.storage, null);
  log(`📨 事件处理管道就绪`);

  // 6. 启动 WebSocket
  log('\n🔌 启动 WebSocket 连接...');
  ctx.wsManager = new WsManager({
    apiClient: ctx.api,
    otpFetcher: fetchOtpFromEmail,
    onEvent: async (event) => {
      try {
        await ctx.eventPipeline.process(event);
        await _updateFriendState(event);
        
        // 核心关注好友活动日志（从内存缓存读取，不查 DB）
        if (ctx.watchlist.dirty) refreshWatchlistCache();
        const isWatched = ctx.watchlist.cache.some(w => w.user_id === event.userId);
        if (isWatched) {
          log(`⭐ [关注] ${event.displayName || event.userId}: ${event.type}`);
        }
      } catch (err) {
        log(`⚠️ 事件处理失败: ${err.message}`);
      }
    },
    onStatusChange: (status) => {
      log(`🔌 WebSocket: ${status}`);
      if (status === 'connected') {
        _refreshOnlineState(); // 连接后刷新全量状态
        // WS 重连成功但启动登录可能失败(如 OTP 错位)，此处复查认证并同步 authUser
        ctx.api.checkAuth().then((res) => {
          if (res.valid) {
            ctx.serverState.authUser = { id: res.user.id, displayName: res.displayName };
          }
        }).catch((err) => {
          log(`⚠️ 认证复查失败: ${err.message}`);
        });
      }
    },
  });
  ctx.wsManager.start();

  // 7a. 数据库自动备份：启动时立即做一次 + 每 24h 一次（保留最近 2 份）
  const runAutoBackup = async () => {
    try {
      const r = await backupDatabase(ctx.storage.db, BACKUP_DIR);
      log(`💾 自动备份完成: ${r.path} (${r.size} bytes)`);
    } catch (e) {
      log(`⚠️ 自动备份失败: ${e.message}`);
    }
  };
  runAutoBackup();
  setInterval(runAutoBackup, BACKUP_INTERVAL_MS);

  // 7b. 启动 MCP 服务
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    log(`\n🚀 MCP 服务运行在 http://127.0.0.1:${PORT}/mcp\n`);
    log('可用工具:');
    for (const t of CUSTOM_TOOLS) {
      log(`  ${t.name} — ${t.description}`);
    }
    log(`\n健康检查: http://127.0.0.1:${PORT}/health`);
    log('\n按 Ctrl+C 停止\n');
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// ── 优雅关闭 ──
async function shutdown(signal) {
  const { wsManager, eventPipeline, storage } = ctx;
  log(`\n⚠️ 收到 ${signal}，正在关闭...`);
  try {
    if (wsManager) wsManager.stop();
    if (eventPipeline) eventPipeline.flush();
    if (storage) storage.save();
    log('✅ 已保存数据');
  } catch (e) {
    console.error('关闭时出错:', e);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('beforeExit', () => {
  if (ctx.eventPipeline) ctx.eventPipeline.flush();
  if (ctx.storage) ctx.storage.save();
});

// ── 全局异常兜底（防止僵尸进程 + 端口残留）──
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
  shutdown('unhandledRejection');
});
