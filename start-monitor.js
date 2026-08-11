/**
 * VRChat 好友监控系统 — 主入口
 * 
 * 独立 MCP 服务（不依赖 VRCX-0）
 * 提供 WebSocket 实时监控 + SQLite 存储 + 55 个 MCP 工具
 * 
 * 启动: node start-monitor.js
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

// ── 路径常量 → 写入 ctx.paths ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');
const CRED_FILE = path.join(__dirname, 'credentials.json');
const DB_PATH = path.join(__dirname, 'vrc-monitor.sqlite3');
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每 24h 自动备份

Object.assign(ctx.paths, { __dirname, PORT, COOKIE_FILE, CRED_FILE, DB_PATH, BACKUP_DIR, BACKUP_INTERVAL_MS });

// ── .env 加载（只取 VRC_MONITOR_*）──
// 注意：无条件覆盖 process.env——服务被插件 spawn 时可能继承旧值，跳过会导致 .env 配置失效
// 个人配置（分组权重/联系人名单等）放仓库根 .env（.gitignore 已忽略），不硬编码进代码
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

// ── 启动 ──

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  VRChat 好友监控系统 v1.14.0');
  console.log('══════════════════════════════════════════════\n');

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
  ctx.api.loadCookieFromFile(COOKIE_FILE);
  try {
    const user = await ctx.api.ensureAuthWithAutoOtp(fetchOtpFromEmail);
    ctx.serverState.authUser = { id: user.id, displayName: user.displayName };
    ctx.serverState.needsOtp = false;
    log(`   ✅ 已登录: ${user.displayName} (${user.id})`);
    ctx.api.saveCookieToFile(COOKIE_FILE);
  } catch (err) {
    ctx.serverState.needsOtp = false;
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
