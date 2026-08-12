/**
 * VRChat 好友监控系统 — 数据迁移脚本
 *
 * 从 VRCX SQLite 数据库导入历史数据到新系统
 *
 * 使用:
 *   自动模式:  node migrate-vrcx0.mjs                                   （自动探测数据库路径 + userId）
 *   手动模式:  node migrate-vrcx0.mjs <VRCX数据库路径> <userId>
 *   自定义目标: node migrate-vrcx0.mjs --db <目标数据库路径>             （默认: ./vrc-monitor.sqlite3）
 *   跳过检测:  node migrate-vrcx0.mjs --force                            （服务运行时强制迁移，风险自负）
 *
 * ⚠️ 引擎说明：v1.1.0 起改用 better-sqlite3（流式迁移 + 事务提交），
 *    不再整文件重写数据库（旧版 sql.js 的 export() 全量写出是 SQLITE_CORRUPT 根因）。
 *    better-sqlite3 与主服务 storage.js 同引擎（WAL 模式），运行中迁移不再损坏库，
 *    服务运行检测保留为警告级。
 *
 * 迁移内容: 事件流（位置/上下线/Avatar/状态/Bio）、好友列表、世界缓存、备注
 */
import Database from 'better-sqlite3';
import { existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 命令行参数解析（支持任意顺序）──
//   node migrate-vrcx0.mjs [VRCX数据库路径] [userId] [--db 目标库] [--force]
function parseArgs(argv) {
  const args = { force: false, db: null, positional: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--db') args.db = argv[++i];
    else args.positional.push(a);
  }
  return args;
}

// ── 检测监控服务是否在运行（探测 8799 端口）──
// better-sqlite3 WAL 模式下服务运行中迁移已安全，此检测降级为警告
async function isServiceRunning(port = 8799, timeoutMs = 800) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(false); });
  });
}

// ── 清理不再匹配的 WAL/SHM 残留 ──
// 仅历史遗留（旧版 sql.js 整文件重写产生的）需要清理；better-sqlite3 自身不会制造不匹配残留。
// 服务运行中绝不清理（会删掉活动连接正在用的 WAL 文件）。
function cleanupStaleWal(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    const p = dbPath + suffix;
    if (existsSync(p)) {
      rmSync(p);
      log(`   🧹 已清理不匹配的残留文件: ${path.basename(p)}`);
    }
  }
}

// ── 目标数据库路径（--db 可覆盖，默认项目根 vrc-monitor.sqlite3）──
const _args0 = parseArgs(process.argv);
const MONITOR_DB = _args0.db ? path.resolve(_args0.db) : path.join(__dirname, 'vrc-monitor.sqlite3');
const DDL_PATH = path.join(__dirname, 'core', 'init-db.sql');

// ── 数据库路径解析（优先级：命令行参数 > 新版默认 > 旧版兜底）──
function resolve_vrcx0_db(positional) {
  // 1. 命令行显式指定
  if (positional[0]) return positional[0];

  // 2. 新版 VRCX 默认路径
  const newPath = path.join(os.homedir(), 'AppData', 'Roaming', 'VRCX', 'VRCX.sqlite3');
  if (existsSync(newPath)) return newPath;

  // 3. 旧版 VRCX-0 兜底路径
  const oldPath = path.join(os.homedir(), 'AppData', 'Roaming', 'VRCX-0', 'VRCX-0.sqlite3');
  if (existsSync(oldPath)) return oldPath;

  // 4. 都找不到
  console.log('❌ 未找到 VRCX 数据库文件');
  console.log(`   已尝试: ${newPath}`);
  console.log(`            ${oldPath}`);
  console.log('   请提供正确的数据库路径: node migrate-vrcx0.mjs <VRCX数据库路径>');
  process.exit(1);
}

// ── 用户前缀解析（优先级：命令行参数 > 自动探测）──
function resolve_user_prefix(positional, vrcx0) {
  // 1. 命令行显式指定（去掉横线兼容 usr_xxx-xxx 格式）
  if (positional[1]) return positional[1].replace(/-/g, '');

  // 2. 自动探测：查询 _feed_gps 表名提取前缀
  try {
    const row = vrcx0.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_feed_gps' LIMIT 1"
    ).get();
    if (row && row.name) {
      return row.name.replace(/_feed_gps$/, '');
    }
  } catch (_) {
    // 探测失败继续走下面的错误提示
  }

  // 3. 探测不到
  console.log('❌ 无法从数据库自动识别用户表前缀');
  console.log('   请提供你的 VRChat userId: node migrate-vrcx0.mjs <数据库路径> <userId>');
  console.log('   (userId 可在 VRChat 官网个人资料页查看，格式如 usr_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)');
  process.exit(1);
}

// 统计
const stats = {
  feed_gps: 0,
  feed_online_offline: 0,
  feed_avatar: 0,
  feed_status: 0,
  feed_bio: 0,
  memos: 0,
  friend_log_current: 0,
  cache_world: 0,
  notifications: 0,
  skipped_gps_no_world: 0,
};

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── 世界名提取工具 ──
function worldIdFromLocation(location) {
  if (!location || location === 'offline' || location === 'private' || location === 'traveling') return '';
  const idx = location.indexOf(':');
  return idx > 0 ? location.slice(0, idx) : '';
}

// ── 事务化分批写入（better-sqlite3）──
// 每个批次一个事务提交；大表分批避免单事务过大。中断时已提交批次保留，不会留下半成品。
function insertInBatches(db, rows, batchSize, insertFn) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const tx = db.transaction(() => {
      for (const row of chunk) insertFn(row);
    });
    tx();
    inserted += chunk.length;
  }
  return inserted;
}

// ── 主函数 ──
async function main() {
  const args = parseArgs(process.argv);
  const VRCX0_DB = resolve_vrcx0_db(args.positional);

  console.log('══════════════════════════════════════════════');
  console.log('  VRCX 数据迁移工具 (better-sqlite3 引擎)');
  console.log('══════════════════════════════════════════════\n');

  // ═══════════════════════════════════════════
  // 0. 服务运行检测（警告级，不再阻断）
  // ═══════════════════════════════════════════
  log('🔍 检测监控服务状态 (127.0.0.1:8799)...');
  const serviceRunning = await isServiceRunning();
  if (serviceRunning) {
    log('⚠️  监控服务正在运行。better-sqlite3 WAL 模式下运行中迁移安全，');
    log('   但为避免与服务的实时写入交错，仍建议迁移前停止服务。');
    if (!args.force) {
      log('   如需继续，请加 --force 确认（风险自负）。');
      process.exit(1);
    }
    log('   --force 已指定，继续执行');
  } else {
    log('✅ 服务未运行');
  }

  // 1. 打开数据库
  log(`📂 打开数据库: ${VRCX0_DB}`);
  if (!existsSync(VRCX0_DB)) {
    log(`❌ 数据库不存在: ${VRCX0_DB}`);
    process.exit(1);
  }

  // 源库只读打开（better-sqlite3 原生连接，流式读取）
  const vrcx0 = new Database(VRCX0_DB, { readonly: true, fileMustExist: true });
  const USER_PREFIX = resolve_user_prefix(args.positional, vrcx0);

  // 目标库读写打开（不存在则创建）；复用主服务同款引擎与 pragma
  const monitorDb = new Database(MONITOR_DB);
  monitorDb.pragma('journal_mode = WAL');
  monitorDb.pragma('busy_timeout = 5000');
  if (monitorDb.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='events'").get().c === 0) {
    const { readFileSync } = await import('node:fs');
    const ddl = readFileSync(DDL_PATH, 'utf-8');
    monitorDb.exec(ddl);
    log('   ✅ 初始化表结构完成（新库）');
  } else {
    log('   ✅ 加载已有数据库');
  }

  // ═══════════════════════════════════════════
  // 2. cache_world → world_cache
  // ═══════════════════════════════════════════
  log('\n📦 迁移世界缓存...');
  let count = 0;
  try {
    const rows = vrcx0.prepare(`SELECT * FROM cache_world`).all();
    if (rows.length > 0) {
      const stmt = monitorDb.prepare(
        `INSERT OR REPLACE INTO world_cache
         (world_id, name, author_id, author_name, description, image_url,
          release_status, capacity, favorites, tags, updated_at)
         VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
          $releaseStatus, $capacity, $favorites, $tags, datetime('now'))`
      );
      const tx = monitorDb.transaction((items) => {
        for (const w of items) {
          stmt.run({
            worldId: w.id,
            name: w.name || '',
            authorId: w.author_id || '',
            authorName: w.author_name || '',
            description: w.description || '',
            imageUrl: w.image_url || '',
            releaseStatus: w.release_status || '',
            capacity: 0,
            favorites: 0,
            tags: '[]',
          });
        }
      });
      // 世界缓存一般不大，单事务提交
      tx(rows);
      count = rows.length;
      stats.cache_world = count;
    }
  } catch (err) {
    log(`   ⚠️ cache_world: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 个世界缓存`);

  // ═══════════════════════════════════════════
  // 3. memos → friends.memo
  // ═══════════════════════════════════════════
  log('\n📝 迁移好友备注...');
  count = 0;
  try {
    const rows = vrcx0.prepare(`SELECT * FROM memos`).all();
    if (rows.length > 0) {
      const selectExisting = monitorDb.prepare(`SELECT user_id FROM friends WHERE user_id = ?`);
      const updateMemo = monitorDb.prepare(
        `UPDATE friends SET memo = $memo, updated_at = datetime('now')
         WHERE user_id = $userId`
      );
      const insertFriend = monitorDb.prepare(
        `INSERT INTO friends (user_id, display_name, memo, created_at, updated_at)
         VALUES ($userId, $displayName, $memo, datetime('now'), datetime('now'))`
      );
      const tx = monitorDb.transaction((items) => {
        for (const row of items) {
          const userId = row.user_id;
          const memoText = row.memo || '';

          // 从备注文本提取昵称（格式："昵称：风风" 或直接文本）
          let displayName = '';
          let nickName = memoText;
          const nickMatch = memoText.match(/^昵称[：:]\s*(.+)/);
          if (nickMatch) {
            displayName = '';
            nickName = nickMatch[1].trim();
          }

          // 如果好友还不存在则插入，否则更新 memo
          const existing = selectExisting.get(userId);
          if (existing) {
            updateMemo.run({ memo: nickName, userId });
          } else {
            insertFriend.run({ userId, displayName: displayName || userId, memo: nickName });
          }
        }
      });
      tx(rows);
      count = rows.length;
      stats.memos = count;
    }
  } catch (err) {
    log(`   ⚠️ memos: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条备注`);

  // ═══════════════════════════════════════════
  // 4. friend_log_current → friends（信任等级等）
  // ═══════════════════════════════════════════
  log('\n👥 迁移好友列表...');
  count = 0;
  try {
    const rows = vrcx0.prepare(`SELECT * FROM ${USER_PREFIX}_friend_log_current`).all();
    if (rows.length > 0) {
      const selectExisting = monitorDb.prepare(`SELECT user_id FROM friends WHERE user_id = ?`);
      const updateFriend = monitorDb.prepare(
        `UPDATE friends SET display_name = $displayName, trust_level = $trustLevel,
         updated_at = datetime('now') WHERE user_id = $userId`
      );
      const insertFriend = monitorDb.prepare(
        `INSERT INTO friends (user_id, display_name, trust_level, created_at, updated_at)
         VALUES ($userId, $displayName, $trustLevel, datetime('now'), datetime('now'))`
      );
      const tx = monitorDb.transaction((items) => {
        for (const row of items) {
          const userId = row.user_id;
          const displayName = row.display_name || '';
          const trustLevel = row.trust_level || '';

          // 如果已存在（来自 memos 迁移），更新 display_name 和 trust_level
          const existing = selectExisting.get(userId);
          if (existing) {
            updateFriend.run({ displayName, trustLevel, userId });
          } else {
            insertFriend.run({ userId, displayName: displayName || userId, trustLevel });
          }
        }
      });
      tx(rows);
      count = rows.length;
      stats.friend_log_current = count;
    }
  } catch (err) {
    log(`   ⚠️ friend_log_current: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 个好友信息`);

  // ═══════════════════════════════════════════
  // 5. feed_gps → events（好友位置变更）
  // ═══════════════════════════════════════════
  log('\n📍 迁移位置变更历史 (feed_gps)...');
  count = 0;
  const BATCH_SIZE = 10000;
  try {
    const rows = vrcx0.prepare(
      `SELECT id, created_at, user_id, display_name, location, world_name, previous_location, time, group_name
       FROM ${USER_PREFIX}_feed_gps ORDER BY created_at ASC`
    ).all();
    if (rows.length > 0) {
      const stmt = monitorDb.prepare(
        `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
         VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
      );
      const insertFn = (row) => {
        const location = row.location || '';
        const worldName = row.world_name || '';
        const worldId = worldIdFromLocation(location);
        stmt.run({
          type: 'friend-location',
          userId: row.user_id || '',
          displayName: row.display_name || '',
          contentJson: JSON.stringify({
            userId: row.user_id || '',
            displayName: row.display_name || '',
            location,
            worldName,
            previousLocation: row.previous_location || '',
            time: row.time || 0,
          }),
          worldId,
          worldName,
          createdAt: row.created_at || '',
          source: 'migrate',
        });
      };
      count = insertInBatches(monitorDb, rows, BATCH_SIZE, insertFn);
      stats.feed_gps = count;
    }
  } catch (err) {
    log(`   ⚠️ feed_gps: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条位置变更`);

  // ═══════════════════════════════════════════
  // 6. feed_online_offline → events
  // ═══════════════════════════════════════════
  log('\n🔄 迁移上下线记录 (feed_online_offline)...');
  count = 0;
  try {
    const rows = vrcx0.prepare(
      `SELECT id, created_at, user_id, display_name, type, location, world_name, time, group_name
       FROM ${USER_PREFIX}_feed_online_offline ORDER BY created_at ASC`
    ).all();
    if (rows.length > 0) {
      const stmt = monitorDb.prepare(
        `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
         VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
      );
      const insertFn = (row) => {
        const eventType = row.type === 'Online' ? 'friend-online' : 'friend-offline';
        const location = row.location || '';
        const worldName = row.world_name || '';
        const worldId = worldIdFromLocation(location);
        stmt.run({
          type: eventType,
          userId: row.user_id || '',
          displayName: row.display_name || '',
          contentJson: JSON.stringify({
            userId: row.user_id || '',
            displayName: row.display_name || '',
            type: row.type,
            location,
            worldName,
            time: row.time || 0,
          }),
          worldId,
          worldName,
          createdAt: row.created_at || '',
          source: 'migrate',
        });
      };
      count = insertInBatches(monitorDb, rows, BATCH_SIZE, insertFn);
      stats.feed_online_offline = count;
    }
  } catch (err) {
    log(`   ⚠️ feed_online_offline: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条上下线记录`);

  // ═══════════════════════════════════════════
  // 7. feed_avatar → events
  // ═══════════════════════════════════════════
  log('\n🎭 迁移 Avatar 变更记录 (feed_avatar)...');
  count = 0;
  try {
    const rows = vrcx0.prepare(
      `SELECT id, created_at, user_id, display_name, owner_id, avatar_name,
              current_avatar_image_url, current_avatar_thumbnail_image_url,
              previous_current_avatar_image_url, previous_current_avatar_thumbnail_image_url
       FROM ${USER_PREFIX}_feed_avatar ORDER BY created_at ASC`
    ).all();
    if (rows.length > 0) {
      const stmt = monitorDb.prepare(
        `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
         VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
      );
      const insertFn = (row) => {
        stmt.run({
          type: 'friend-update',
          userId: row.user_id || '',
          displayName: row.display_name || '',
          contentJson: JSON.stringify({
            userId: row.user_id || '',
            displayName: row.display_name || '',
            type: 'avatar',
            avatarName: row.avatar_name || '',
            avatarImageUrl: row.current_avatar_image_url || '',
            avatarThumbnailUrl: row.current_avatar_thumbnail_image_url || '',
            previousAvatarImageUrl: row.previous_current_avatar_image_url || '',
            previousAvatarThumbnailUrl: row.previous_current_avatar_thumbnail_image_url || '',
          }),
          worldId: '',
          worldName: '',
          createdAt: row.created_at || '',
          source: 'migrate',
        });
      };
      count = insertInBatches(monitorDb, rows, BATCH_SIZE, insertFn);
      stats.feed_avatar = count;
    }
  } catch (err) {
    log(`   ⚠️ feed_avatar: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条 Avatar 变更`);

  // ═══════════════════════════════════════════
  // 8. feed_status → events
  // ═══════════════════════════════════════════
  log('\n📊 迁移状态变更记录 (feed_status)...');
  count = 0;
  try {
    const rows = vrcx0.prepare(
      `SELECT id, created_at, user_id, display_name, status, status_description,
              previous_status, previous_status_description
       FROM ${USER_PREFIX}_feed_status ORDER BY created_at ASC`
    ).all();
    if (rows.length > 0) {
      const stmt = monitorDb.prepare(
        `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
         VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
      );
      const insertFn = (row) => {
        stmt.run({
          type: 'friend-update',
          userId: row.user_id || '',
          displayName: row.display_name || '',
          contentJson: JSON.stringify({
            userId: row.user_id || '',
            displayName: row.display_name || '',
            type: 'status',
            status: row.status || '',
            statusDescription: row.status_description || '',
            previousStatus: row.previous_status || '',
            previousStatusDescription: row.previous_status_description || '',
          }),
          worldId: '',
          worldName: '',
          createdAt: row.created_at || '',
          source: 'migrate',
        });
      };
      count = insertInBatches(monitorDb, rows, BATCH_SIZE, insertFn);
      stats.feed_status = count;
    }
  } catch (err) {
    log(`   ⚠️ feed_status: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条状态变更`);

  // ═══════════════════════════════════════════
  // 9. feed_bio → events
  // ═══════════════════════════════════════════
  log('\n📝 迁移 Bio 变更记录 (feed_bio)...');
  count = 0;
  try {
    const rows = vrcx0.prepare(
      `SELECT id, created_at, user_id, display_name, bio, previous_bio
       FROM ${USER_PREFIX}_feed_bio ORDER BY created_at ASC`
    ).all();
    if (rows.length > 0) {
      const stmt = monitorDb.prepare(
        `INSERT INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
         VALUES ($type, $userId, $displayName, $contentJson, $worldId, $worldName, $createdAt, $source)`
      );
      const insertFn = (row) => {
        stmt.run({
          type: 'friend-update',
          userId: row.user_id || '',
          displayName: row.display_name || '',
          contentJson: JSON.stringify({
            userId: row.user_id || '',
            displayName: row.display_name || '',
            type: 'bio',
            bio: row.bio || '',
            previousBio: row.previous_bio || '',
          }),
          worldId: '',
          worldName: '',
          createdAt: row.created_at || '',
          source: 'migrate',
        });
      };
      count = insertInBatches(monitorDb, rows, BATCH_SIZE, insertFn);
      stats.feed_bio = count;
    }
  } catch (err) {
    log(`   ⚠️ feed_bio: ${err.message}`);
  }
  log(`   ✅ 迁移 ${count} 条 Bio 变更`);

  // ═══════════════════════════════════════════
  // 10. 关闭数据库并输出报告
  // ═══════════════════════════════════════════
  // better-sqlite3 正常 close() 即触发 WAL checkpoint 合并，无需 export()/writeFileSync
  monitorDb.pragma('wal_checkpoint(TRUNCATE)');
  vrcx0.close();
  monitorDb.close();

  // 服务未运行时清理历史遗留的 WAL/SHM 残留（better-sqlite3 迁移后正常不会产生）
  if (!serviceRunning) {
    cleanupStaleWal(MONITOR_DB);
  }

  // 验证
  log('\n══════════════════════════════════════════════');
  log('  迁移完成！验证结果：');
  log('══════════════════════════════════════════════\n');

  const verifyDb = new Database(MONITOR_DB, { readonly: true });
  try {
    const integrity = verifyDb.pragma('integrity_check', { simple: true });
    log(`  PRAGMA integrity_check  : ${integrity}`);

    for (const table of ['events', 'friends', 'world_cache']) {
      const { c } = verifyDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
      log(`  ${table.padEnd(20)} : ${Number(c).toLocaleString()} 行`);
    }

    log('\n  各类事件分布:');
    const types = verifyDb.prepare(
      `SELECT type, COUNT(*) as count FROM events GROUP BY type ORDER BY count DESC`
    ).all();
    for (const row of types) {
      log(`  ${String(row.type).padEnd(25)} : ${Number(row.count).toLocaleString()}`);
    }
  } finally {
    verifyDb.close();
  }

  log('\n  备注迁移:');
  log(`  memos（好友昵称）            : ${stats.memos} 条`);
  log(`  cache_world（世界缓存）       : ${stats.cache_world} 个`);

  log('\n✅ 数据迁移完成！');
  log(`   新数据库: ${MONITOR_DB}`);
  log(`   重启服务后即可使用: node start-monitor.js`);
}

// 仅作为主入口运行时执行（防止被 import 时意外触发迁移）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('\n❌ 迁移脚本异常:', err);
    process.exit(1);
  });
}
