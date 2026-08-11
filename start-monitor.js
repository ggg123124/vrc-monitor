/**
 * VRChat 好友监控系统 — 主入口
 * 
 * 独立 MCP 服务（不依赖 VRCX-0）
 * Phase 1: 基础设施 — 数据库 + 基础 MCP 工具
 * 
 * 启动: node start-monitor.js
 */
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Storage } from './core/storage.js';
import { RateLimiter } from './core/rate-limiter.js';
import { VrchatApiClient } from './vrchat-api.js';
import { openInstance } from './core/vrchat-launch.js';
import { WsManager } from './core/ws-manager.js';
import { EventPipeline } from './core/event-pipeline.js';
import { backupDatabase } from './core/backup.js';
import { FriendStateManager } from './core/friend-state.js';
import { isJunkWorld, worldScore, classifyWorlds, fetchFreshWorlds } from './core/new-worlds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');
const CRED_FILE = path.join(__dirname, 'credentials.json');
const DB_PATH = path.join(__dirname, 'vrc-monitor.sqlite3');
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每 24h 自动备份

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

// ── 全局状态 ──
let storage;
let api;
let rateLimiter;
let wsManager;
let eventPipeline;
let friendState;
let serverState = { started: null, authUser: null, friendCount: 0, needsOtp: false };

// ── Watchlist 内存缓存（避免每次 WS 事件查 DB）──
let _watchlistCache = [];       // 内存中的 watchlist 快照
let _watchlistDirty = false;    // 标记是否需要刷新

function _refreshWatchlistCache() {
  _watchlistCache = storage.getWatchlist();
  _watchlistDirty = false;
}

function _invalidateWatchlistCache() {
  _watchlistDirty = true;
}

// ── WebSocket 事件 → 好友状态更新 ──
async function _updateFriendState(event) {
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

// ── MCP 会话管理 ──
const sessions = new Map();

class McpSession {
  constructor() {
    this.id = randomUUID();
    this.initialized = false;
  }
}

function getOrCreateSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) {
    const s = new McpSession();
    sessions.set(s.id, s);
    return s;
  }
  return sessions.get(sessionId);
}

// ── SSE 响应辅助 ──
function sendSSE(res, events, sessionId) {
  if (res.headersSent) return;
  let body = '';
  for (const event of events) {
    body += `data: ${JSON.stringify(event)}\n\n`;
  }
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  res.writeHead(200, headers);
  res.end(body);
}

function sendError(res, id, message) {
  sendSSE(res, [{
    jsonrpc: '2.0', id,
    error: { code: -32603, message },
  }]);
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── MCP 工具定义 ──

const CUSTOM_TOOLS = [
  // ── 已有的写工具 ──
  {
    name: 'send_boop',
    description: '[write·vrchat] Send a boop to a user. Requires userId.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        emojiId: { type: 'string', description: 'Optional emoji ID' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_boop_emojis',
    description: '[query] List built-in boop emojis and their emojiId format.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'upload_emoji',
    description: '[write·vrchat] Upload a custom boop emoji (requires VRChat Plus). Returns fileId to use as emojiId in send_boop.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute path to the image file (e.g. D:/path/emoji.png)' },
        animated: { type: 'boolean', description: 'Upload as animated emoji', default: false },
        animationStyle: { type: 'string', description: 'Animation style (e.g. bounce/spin), only used when animated=true' },
      },
      required: ['imagePath'],
    },
  },
  {
    name: 'upload_print',
    description: '[write·vrchat] Upload a photo to your VRChat prints album (requires VRChat Plus).',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute path to the image file' },
        note: { type: 'string', description: 'Optional photo note' },
      },
      required: ['imagePath'],
    },
  },
  {
    name: 'upload_gallery_image',
    description: '[write·vrchat] Upload an image to your VRC+ gallery (requires VRChat Plus).',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute path to the image file' },
      },
      required: ['imagePath'],
    },
  },
  {
    name: 'get_prints',
    description: '[query] List your VRChat prints (VRChat Plus photo album).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 100, description: 'Max results (1-100, default 100)' },
        userId: { type: 'string', description: 'VRChat user id (usr_...). Defaults to current user.' },
      },
    },
  },
  {
    name: 'remove_print',
    description: '[write·vrchat] Remove a print from your VRChat prints album. Requires printId and confirm: true to execute (irreversible).',
    inputSchema: {
      type: 'object',
      properties: {
        printId: { type: 'string', description: 'Print ID (prnt_...)' },
        confirm: { type: 'boolean', description: 'Set true to actually remove the print (irreversible). Default false returns preview only.' },
      },
      required: ['printId'],
    },
  },
  {
    name: 'get_gallery_images',
    description: '[query] List your VRChat gallery images (VRChat Plus).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 100, description: 'Max results (1-100, default 100)' },
      },
    },
  },
  {
    name: 'remove_gallery_image',
    description: '[write·vrchat] Remove an image from your VRChat gallery. Requires fileId and confirm: true to execute (irreversible).',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File ID (file_...)' },
        confirm: { type: 'boolean', description: 'Set true to actually remove the gallery image (irreversible). Default false returns preview only.' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'download_print',
    description: '[query] Download a photo from your VRChat prints album to local disk. Returns local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        printId: { type: 'string', description: 'Print ID (prnt_...)' },
        outputDir: { type: 'string', description: 'Optional output directory. Defaults to <service>/downloads/' },
      },
      required: ['printId'],
    },
  },
  {
    name: 'download_gallery_image',
    description: '[query] Download an image from your VRC+ gallery to local disk. Returns local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File ID (file_...)' },
        outputDir: { type: 'string', description: 'Optional output directory. Defaults to <service>/downloads/' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'send_invite',
    description: '[write·vrchat] Send an invite to join your current instance.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        worldId: { type: 'string' },
        instanceId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['userId', 'worldId', 'instanceId'],
    },
  },
  {
    name: 'request_invite',
    description: '[write·vrchat] Request an invite from a user.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'create_instance',
    description: '[write·vrchat] Create a new instance (room) for a world. Returns instance location ready for invite_myself. Region defaults to jp.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World id (wrld_...)' },
        type: { type: 'string', description: 'Instance type: public/hidden/friends/private/group (default hidden)' },
        region: { type: 'string', description: 'Region: us/eu/jp (default jp)' },
        instanceId: { type: 'string', description: 'Optional: existing instance id (shortName or full) to join instead of creating fresh' },
        groupAccessType: { type: 'string', description: 'Required when type=group: members/plus/public' },
      },
      required: ['worldId'],
    },
  },
  {
    name: 'invite_myself',
    description: '[write·vrchat] Open an instance in the running VRChat client (same engine as open_world): named-pipe launch first (Windows, silent in-game join dialog), falls back to API self-invite (client teleports on accept) when pipe unavailable. Accepts location (worldId:instanceId) or worldId+instanceId separately.',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'Full location string, e.g. wrld_x:12345~hidden(usr_x)~region(jp). If provided, worldId/instanceId are ignored.' },
        worldId: { type: 'string', description: 'World id (wrld_...) — ignored if location is provided' },
        instanceId: { type: 'string', description: 'Instance id (full format with ~region etc.) — ignored if location is provided' },
        forceApi: { type: 'boolean', description: 'Skip pipe detection and force API self-invite (remote/test scenarios)' },
      },
    },
  },
  {
    name: 'open_world',
    description: '[write·vrchat] Open a world/instance in the running VRChat client. If only worldId given, creates a new instance first (hidden jp default), then: named-pipe launch (VRChatURLLaunchPipe → silent in-game join dialog, Windows, 1 step) with API self-invite fallback (invite notification) when pipe unavailable. Core: core/vrchat-launch.js openInstance.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World id (wrld_...) — creates a new instance (type/region) then opens it' },
        location: { type: 'string', description: 'Full instance location to open directly, e.g. wrld_x:12345~hidden(usr_x)~region(jp). If given, worldId/type/region are ignored.' },
        type: { type: 'string', description: 'Instance type when creating from worldId: public/hidden/friends/private/group (default hidden)' },
        region: { type: 'string', description: 'Region when creating from worldId: us/eu/jp (default jp)' },
        shortName: { type: 'string', description: 'Optional room short name shown in the launch menu' },
        forceApi: { type: 'boolean', description: 'Skip pipe detection and force API self-invite (remote/test scenarios)' },
      },
    },
  },

  {
    name: 'send_friend_request',
    description: '[write·vrchat] Send a friend request to a user. Supports userId or exact displayName match.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search and send friend request' },
      },
    },
  },
  {
    name: 'remove_friend',
    description: '[write·vrchat] Remove a friend. Requires userId or exact displayName match, plus confirm: true to execute (irreversible).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search and remove friend' },
        confirm: { type: 'boolean', description: 'Set true to actually remove the friend (irreversible). Default false returns preview only.' },
      },
    },
  },
  // ── Phase 1 新增的读工具 ──
  {
    name: 'get_online_friends',
    description: '[query] List currently online friends from VRChat API.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_friend_info',
    description: '[query] Get detailed info about a specific friend from API.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Or search by display name' },
      },
    },
  },
  {
    name: 'get_mutual_friends',
    description: '[query] List mutual friends between you and a user (userId or exact displayName). Includes local nicknames.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search' },
        limit: { type: 'number', default: 100, description: 'Max results (1-100, default 100)' },
      },
    },
  },
  {
    name: 'search_users',
    description: '[query] Search VRChat users by display name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_database_stats',
    description: '[system] Get local database statistics (event count, friend count, etc).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_server_status',
    description: '[system] Check server health and auth status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ── 新增 Phase 4 工具 ──
  {
    name: 'get_friend_events',
    description: '[query] Query a friend\'s event history from local database.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Friend ID (usr_...)' },
        limit: { type: 'number', default: 20 },
        offset: { type: 'number', default: 0 },
        types: { type: 'string', description: 'Comma-separated event types to filter' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_recent_events',
    description: '[query] Get the latest event stream from local database.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 30 },
        offset: { type: 'number', default: 0 },
        typeFilter: { type: 'string', description: 'Comma-separated event types to filter' },
        userIdFilter: { type: 'string', description: 'Filter by friend user ID' },
      },
    },
  },
  {
    name: 'get_world_name',
    description: '[query] Get world name by worldId. Checks local cache first, falls back to API.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World ID (wrld_...)' },
        forceRefresh: { type: 'boolean', description: 'Force refresh from API' },
      },
      required: ['worldId'],
    },
  },
  {
    name: 'set_world_note',
    description: '[manage] Set or update a user note for a world (stored locally, never overwritten by API refresh). Empty string clears the note.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World ID (wrld_...)' },
        note: { type: 'string', description: 'User note text; empty string clears' },
      },
      required: ['worldId', 'note'],
    },
  },
  {
    name: 'get_world_history',
    description: '[query] Get change history of a world\'s info (name, description, capacity, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World ID (wrld_...)' },
        limit: { type: 'number', default: 50, description: 'Max history entries' },
      },
      required: ['worldId'],
    },
  },
  {
    name: 'get_weekly_report',
    description: '[query] Generate a weekly gaming report for the authenticated user: active days, play time, worlds visited, companion friends (with nicknames), own online pattern, group activities and friend group calendar. Data from local events DB + cached group info.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', default: 7, description: 'Report window in days (default 7)' },
      },
    },
  },
  {
    name: 'scan_new_worlds',
    description: '[action] Scan VRChat for worlds created in the last N days, filter junk, write to the new_worlds table, and return a recommended list. dryRun=true only reports without writing.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', default: 7, description: 'Lookback window in days (1-30, default 7)' },
        dryRun: { type: 'boolean', default: false, description: 'Report only, do not write to DB' },
      },
    },
  },
  {
    name: 'get_new_worlds',
    description: '[query] Query tracked new worlds from the new_worlds table (read-only). Filter by visited, sort by heat, limit count.',
    inputSchema: {
      type: 'object',
      properties: {
        onlyUnvisited: { type: 'boolean', default: false, description: 'Only return worlds the user has not visited' },
        limit: { type: 'number', default: 10, description: 'Max rows (1-50, default 10)' },
        sortBy: { type: 'string', enum: ['favorites', 'occupants', 'popularity', 'created_at'], default: 'favorites', description: 'Sort field (descending)' },
      },
    },
  },
  {
    name: 'get_watchlist',
    description: '[manage] List all watched friends.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'add_to_watchlist',
    description: '[manage] Add a friend to watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user ID (usr_...)' },
        displayName: { type: 'string', description: 'Optional display name' },
        priority: { type: 'number', default: 1, description: 'Priority 0-5' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'remove_from_watchlist',
    description: '[manage] Remove a friend from watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user ID (usr_...)' },
      },
      required: ['userId'],
    },
  },
  // ── 新增：同屏好友查询 ──
  {
    name: 'get_companions',
    description: '[query] Find all friends who were in the same instances as you during a time range. Uses SQLite cross-reference by instanceId. Each companion has: userId/displayName/firstSeen/lastSeen/matchCount/worlds (worlds is a STRING array of world names or worldIds, NOT objects).',
    inputSchema: {
      type: 'object',
      properties: {
        startTime: { type: 'string', description: 'Start time (ISO 8601, UTC recommended, e.g. 2026-07-25T11:00:00Z)' },
        endTime: { type: 'string', description: 'End time (ISO 8601, UTC)' },
        userId: { type: 'string', description: 'Optional: override userId. Defaults to current user.' },
      },
      required: ['startTime', 'endTime'],
    },
  },
  // ── 新增：好友上线规律分析 ──
  {
    name: 'get_online_pattern',
    description: '[query] Analyze a friend\'s online activity pattern (hourly distribution and frequency in Beijing time).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        days: { type: 'number', default: 30, description: 'Analyze last N days (Beijing time natural days, default 30)' },
        startTime: { type: 'string', description: 'Optional exact start time (ISO 8601 UTC); if provided with endTime, overrides days' },
        endTime: { type: 'string', description: 'Optional exact end time (ISO 8601 UTC); if provided with startTime, overrides days' },
      },
      required: ['userId'],
    },
  },
  // ── 新增：昵称映射 ──
  {
    name: 'get_nicknames',
    description: '[manage] Query friend nickname mappings (exact by userId, fuzzy by nickname/displayName, or all).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        query: { type: 'string', description: 'Fuzzy search on display_name or nickname' },
      },
    },
  },
  {
    name: 'set_nickname',
    description: '[manage] Set or update a friend nickname mapping (upsert).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        nickname: { type: 'string', description: 'Nickname to store' },
        displayName: { type: 'string', description: 'Optional current display name' },
      },
      required: ['userId', 'nickname'],
    },
  },
  // ── 新增：group 查询工具 ──
  {
    name: 'get_user_groups',
    description: '[group] List groups a user has joined (default: current account). withDetails=true also fetches descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...); omit to use the authenticated account' },
        withDetails: { type: 'boolean', description: 'When true, also fetch each group\'s description (slower, ~1 req/group; failures skipped)' },
      },
    },
  },
  {
    name: 'get_group_info',
    description: '[group] Get a VRChat group\'s details (name, member count, description, verified status). includeAnnouncement=true also fetches the announcement.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        includeAnnouncement: { type: 'boolean', description: 'When true, also fetch the group announcement (null if none / not a member)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'get_group_instances',
    description: '[group] List a group\'s currently open group instances (rooms). Empty array = no rooms open.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'get_group_announcement',
    description: '[group] Get a group\'s announcement post (title/text/author/createdAt). null if none or not a member.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'search_groups',
    description: '[group] Search VRChat groups by name. Returns matching groups (query param; API requires query, NOT search).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Group name keyword (supports Chinese/Japanese/English)' },
        n: { type: 'number', description: 'Max results (default 30, max 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_worlds',
    description: '[query] Search VRChat worlds by name. English/Japanese search the live API; Chinese keywords fall back to local cache (API CJK search is unreliable).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'World name keyword (Chinese/English/Japanese)' },
        n: { type: 'number', description: 'Max API results (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'backup_database',
    description: '[system] Immediately back up the local database (WAL online backup, no restart needed). Keeps the 2 most recent backups in backups/.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'join_group',
    description: '[group] Join a group. Open groups join instantly; 400 already-member is returned as alreadyMember:true (no error).',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'leave_group',
    description: '[group] Leave a group (removes your membership). Requires confirm: true. 404 non-member returns notMember:true.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        confirm: { type: 'boolean', description: 'Must be true to actually leave; otherwise returns preview only' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'peek_group_announcement',
    description: '[group] Peek a group announcement: joins if joinState=open, reads announcement, then leaves. Non-open groups return peekable:false.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        confirm: { type: 'boolean', description: 'Must be true to auto-join (members see the join feed)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'get_favorite_friends_locations',
    description: '[query·好友收藏] 列出某个好友收藏夹（线上收藏分组）内所有好友的当前位置列表。可指定 groupName（如 "new"、"join" 等收藏夹名）或 favoriteGroupId；不指定则列出全部分组。返回按推荐度排序：在线且实例可加入的在前（public/friends/hidden=friend+/group 实例均可加入），仅 private 实例自动排除（看不到位置），按实例内玩家数/容量比 + 收藏热度综合评分。也可用 searchName 直接按名字在好友列表里查某人的位置（能看到具体位置即代表可加入，标记 joinable；纯 private 才进不去）。',
    inputSchema: {
      type: 'object',
      properties: {
        groupName: { type: 'string', description: '收藏夹名（displayName），如 "new"/"join"。不填则返回全部分组概览' },
        favoriteGroupId: { type: 'string', description: '收藏分组 id（fvgrp_...），与 groupName 二选一' },
        searchName: { type: 'string', description: '按名字（模糊匹配，不区分大小写）在好友列表里直接查某人位置，返回单人或多人结果。与 groupName/favoriteGroupId 互斥' },
      },
    },
  },
  {
    name: 'recommend_join',
    description: '[query·推荐加入] 查看全部在线好友在做什么，按推荐度排序给出可加入的推荐。综合评分：熟悉度（最近30天+历史一年共玩次数，来自本地 events 同屏统计）+ 收藏夹分组权重（可配置）+ 房间场景（睡觉图人少=电灯泡风险降权）+ 实例人数/容量比 + 实例类型（public/friends/friend+/group 可加入，private 排除）。返回 TopN 推荐及理由。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 10, description: '返回数量（默认 10）' },
        minScore: { type: 'number', default: 0, description: '最低推荐分过滤（默认 0，负分=电灯泡/联系人风险）' },
      },
    },
  },
  {
    name: 'set_join_preference',
    description: '[配置·推荐偏好] 用自然语言设置「推荐加入」的评分偏好，持久化到 config 表，下次推荐自动生效。例：「我不喜欢人太多」→ 爆满惩罚加重(80)、人数权重降低(×1.5)、冷清不罚；「喜欢热闹」→ 人数权重加强(×4)、爆满轻罚(20)；「恢复默认」→ 清除偏好。',
    inputSchema: {
      type: 'object',
      properties: {
        preference: { type: 'string', description: '自然语言偏好，如「我不喜欢人太多」「喜欢热闹」「恢复默认」' },
      },
      required: ['preference'],
    },
  },
  {
    name: 'get_join_preference',
    description: '[配置·推荐偏好] 查询当前「推荐加入」的评分偏好（含解析结果与设置时间）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'record_join_choice',
    description: '[配置·选择学习] 记录一次「从推荐列表中选择加入」的行为（用户选择谁/哪张图）。服务端自动从最近一次 recommend_join 的快照补全上下文（人数/类型/熟悉度/排名/列表基线），写入 join_choices 表；积累 ≥5 次后自动分析用户偏好（选人少→避人潮、总选熟人→熟悉度加权等）并应用到推荐权重。用法：先运行 recommend_join 拉列表，再从列表里选一个人记录：传 userId 或 displayName（模糊匹配）。',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '被选择好友的 userId（usr_...）' },
        displayName: { type: 'string', description: '被选择好友的显示名（模糊匹配，与 userId 二选一）' },
      },
    },
  },
  {
    name: 'get_join_learning',
    description: '[配置·选择学习] 查看推荐选择学习状态：累计选择数、自动分析出的偏好（人数倾向/熟悉度加权/安静图倾向）与生效中的权重调整。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── 工具处理器 ──

function parseLocation(loc) {
  if (!loc) return null;
  if (loc === 'offline') return { type: 'offline' };
  if (loc === 'traveling') return { type: 'traveling' };
  if (loc === 'private') return { type: 'private' };
  const sep = loc.indexOf(':');
  const worldId = sep >= 0 ? loc.slice(0, sep) : loc;
  const rest = sep >= 0 ? loc.slice(sep + 1) : '';
  const instMatch = rest.match(/^([^~]+)/);
  // 白名单匹配实例类型（~private/hidden/friends/group/public 带 owner 括号）；~region(jp) / ~groupAccessType(x) 是元字段
  const typeMatch = rest.match(/~(private|hidden|friends|group|public)\(([^)]+)\)/);
  // ~local 无括号（VRChat 本地实例格式 `~local`）
  const localMatch = rest.match(/~local\b/);
  const regionMatch = rest.match(/~region\(([^)]+)\)/);
  const gAccessMatch = rest.match(/~groupAccessType\(([^)]+)\)/);
  return {
    // 有 instanceId 但无类型标记 = VRChat 无房主公开实例 → 'public'
    type: typeMatch ? typeMatch[1] : (localMatch ? 'local' : (instMatch ? 'public' : null)),
    ownerId: typeMatch ? typeMatch[2] : null,
    worldId: worldId || null,
    instanceId: instMatch ? instMatch[1] : null,
    region: regionMatch ? regionMatch[1] : null,
    groupAccessType: gAccessMatch ? gAccessMatch[1] : null,
  };
}

async function handleGetOnlineFriends() {
  const r = await api._request('GET', '/auth/user/friends?offline=false');
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const friends = Array.isArray(r.data) ? r.data : [];
  const online = friends.filter(f => f.location && f.location !== 'offline');

  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  return {
    online: online.length,
    total: friends.length,
    friends: online.map(f => ({
      userId: f.id,
      displayName: f.displayName,
      location: f.location || 'private',
      status: f.status,
      statusDescription: f.statusDescription,
      platform: f.platform,
      avatarImageUrl: f.currentAvatarThumbnailImageUrl,
      nickname: nicknameMap.get(f.id) || null,
      locationParsed: parseLocation(f.location || 'private'),
    })),
  };
}

/**
 * 好友收藏夹位置列表
 * 1. 拉取全部好友收藏分组（/favorite/groups?type=friend）
 * 2. 指定分组：拉组内好友（/favorites?type=friend&groupId=xxx），逐个查 /users/{id} 拿在线状态与位置
 * 3. 推荐度排序：在线 + 实例可加入（public/friends/group，排除 private）在前，
 *    按实例玩家数/容量比 + 好友收藏热度综合评分
 */
// ── 共享评分系统（recommend_join 与 get_favorite_friends_locations 共用同一套）──
// 两个工具只是从不同集合选人（全部在线好友 / 收藏夹成员），评分逻辑完全一致

function buildScoreContext() {
  // 权重来源：显式偏好(join_prefs) > 自动学习(join_learning) > 默认
  let joinPrefs = { crowd: 'normal' };
  try {
    const rawPref = storage.getConfig('join_prefs');
    if (rawPref) joinPrefs = { ...joinPrefs, ...JSON.parse(rawPref) };
  } catch (e) { /* 偏好解析失败按默认 */ }
  let learning = null;
  if (!joinPrefs.crowd || joinPrefs.crowd === 'normal') {
    try {
      const rawLearn = storage.getConfig('join_learning');
      if (rawLearn) { const l = JSON.parse(rawLearn); if (l && l.enabled) learning = l; }
    } catch (e) { /* 学习结果解析失败按默认 */ }
  }
  const isExplicitPref = joinPrefs.crowd && joinPrefs.crowd !== 'normal';
  const CROWD = joinPrefs.crowd || (learning && learning.crowd) || 'normal';
  // 动态调整保持均衡（成对系数，比例受控 0.72~1.55）：人数权重降 ↔ 熟悉度反向升
  const famAdjust = CROWD === 'avoid' ? 1.15 : (CROWD === 'love' ? 0.9 : 1);
  const famMult = Math.min((isExplicitPref ? 1 : (learning ? learning.familiarityMult : 1)) * famAdjust, 1.3);
  const crowdMult = CROWD === 'avoid' ? 0.75 : (CROWD === 'love' ? 1.25 : 1);
  const fullPenalty = CROWD === 'avoid' ? 60 : (CROWD === 'love' ? 30 : 50);
  const coldPenalty = CROWD === 'avoid' ? 0 : (CROWD === 'love' ? 15 : 10);
  const prefTag = CROWD === 'normal' ? '' : (isExplicitPref ? `偏好[${CROWD === 'avoid' ? '避人潮' : '爱热闹'}]` : `学习[${CROWD === 'avoid' ? '避人潮' : '爱热闹'}]`);
  // 睡觉图集合（new_worlds.sleep_ok=1）+ 安静图名字判定
  const sleepWorlds = new Set();
  try {
    const sw = storage._query('SELECT world_id FROM new_worlds WHERE sleep_ok=1');
    for (const r of sw) sleepWorlds.add(r.world_id);
  } catch (e) { /* 表不存在/无数据按空处理 */ }
  const QUIET_RE = /(寝|眠|睡眠|睡觉|睡|sleep|quiet|静か|静寂|calm|relax|リラックス|ゆったり|安らぎ|癒し|冥想|meditation)/i;
  const isQuietWorldName = (name) => typeof name === 'string' && QUIET_RE.test(name);
  return { joinPrefs, learning, isExplicitPref, CROWD, famMult, crowdMult, fullPenalty, coldPenalty, prefTag, sleepWorlds, isQuietWorldName };
}

async function buildFamiliarityScorer() {
  // 同屏统计（现成 storage.findCompanions，30天 + 一年各一次，带缓存）
  const SELF = api.currentUser?.id || (await api._request('GET', '/auth/user')).data?.id || '';
  const NOW_MS = Date.now();
  const DAY = 86400000;
  const companionsCache = {};
  async function getCompanionsMap(startMs, endMs) {
    const key = `${startMs}|${endMs}`;
    if (companionsCache[key]) return companionsCache[key];
    const r = storage.findCompanions(SELF, new Date(startMs).toISOString(), new Date(endMs).toISOString());
    const map = new Map((r.companions || []).map(c => [c.userId, c.matchCount || 0]));
    companionsCache[key] = map;
    return map;
  }
  async function familiarityScore(userId) {
    const recentMap = await getCompanionsMap(NOW_MS - 30 * DAY, NOW_MS);
    const histMap = await getCompanionsMap(NOW_MS - 365 * DAY, NOW_MS);
    const recent = recentMap.get(userId) || 0;
    const hist = histMap.get(userId) || 0;
    const recentScore = Math.min(recent * 2, 60) + (recent > 0 ? 10 : 0);
    const histScore = Math.min(hist * 0.5, 30) * 0.6;
    return { score: Math.round(recentScore + histScore), recentMatchCount: recent, histMatchCount: hist };
  }
  return { familiarityScore };
}

async function buildGroupMap() {
  // 收藏夹分组（熟悉度补充信号，权重配置化：VRC_MONITOR_GROUP_WEIGHTS / VRC_MONITOR_CONTACT_GROUPS）
  let groupWeights = {};
  const contactGroups = new Set();
  try {
    if (process.env.VRC_MONITOR_GROUP_WEIGHTS) groupWeights = JSON.parse(process.env.VRC_MONITOR_GROUP_WEIGHTS);
  } catch (e) { /* 解析失败按默认 */ }
  if (process.env.VRC_MONITOR_CONTACT_GROUPS) {
    for (const g of process.env.VRC_MONITOR_CONTACT_GROUPS.split(',')) contactGroups.add(g.trim());
  }
  const groupMap = new Map();
  try {
    const groupsR = await rateLimiter.execute(() => api._request('GET', '/favorite/groups?type=friend&n=100'));
    const favsR = await rateLimiter.execute(() => api._request('GET', '/favorites?type=friend&n=100'));
    const groups = (groupsR.status === 200 && Array.isArray(groupsR.data)) ? groupsR.data : [];
    const favs = (favsR.status === 200 && Array.isArray(favsR.data)) ? favsR.data : [];
    for (const g of groups) {
      const isContact = contactGroups.has(g.displayName || g.name);
      const weight = groupWeights[g.displayName || g.name] !== undefined ? groupWeights[g.displayName || g.name] : (isContact ? -40 : 5);
      const memberIds = new Set(favs.filter(f => (f.tags || [])[0] === g.name).map(f => f.favoriteId));
      groupMap.set(g.displayName || g.name, { memberIds, weight, isContact });
    }
  } catch (e) { /* 收藏夹失败不阻断 */ }
  return groupMap;
}

function computeEntryScore(ctx, entry) {
  // 统一评分：熟悉度 + 收藏夹权重 + 安静图场景 + 实例人数/类型 + 偏好/学习调节
  const { CROWD, famMult, crowdMult, fullPenalty, coldPenalty, prefTag, sleepWorlds, isQuietWorldName, learning } = ctx;
  const { loc, worldName, worldTags, instanceUsers, fillRatio, status, groupName, groupWeight, isContact, familiarity } = entry;
  let score = 0;
  const reasons = [];
  if (isContact) { score -= 40; reasons.push('活动联系人-40'); }
  else {
    // 熟悉度（×1.5，上限 132）与地图属性（人数×1+黄金区30 等）同量级——均衡，互不碾压
    const famScore = famMult !== 1 ? Math.min(Math.round(familiarity.score * famMult * 1.5), 132) : Math.min(familiarity.score * 1.5, 132);
    score += famScore;
    reasons.push(`熟悉度${famScore}${famMult !== 1 ? `(加权×${Math.round(famMult*10)/10})` : ''}(30天${familiarity.recentMatchCount}次)`);
    if (groupName) {
      const bonus = Math.min(groupWeight, 10);
      if (bonus !== 0) { score += bonus; reasons.push(`[${groupName}]+${bonus}`); }
    }
  }
  const isSleepWorld = loc.worldId && sleepWorlds.has(loc.worldId);
  const isQuietWorld = isSleepWorld || isQuietWorldName(worldName);
  if (instanceUsers !== undefined) {
    if (isQuietWorld) {
      // 安静图：人少是理想状态，人多反而打扰（破坏氛围/电灯泡）
      const quietBonus = learning && learning.quietBias ? 25 : 15;
      if (instanceUsers === 0) { reasons.push('安静图空房可进'); }
      else if (instanceUsers <= 3) { score += quietBonus; reasons.push(`安静图${instanceUsers}人正合适+${quietBonus}`); }
      else if (instanceUsers <= 6) { score += 0; reasons.push(`安静图${instanceUsers}人适中`); }
      else { score -= 50; reasons.push(`安静图${instanceUsers}人太多-50`); }
    } else {
      // 热闹图：人多正向，黄金区最理想（人数权重/爆满/冷清受偏好调节）
      if (instanceUsers < 3 && instanceUsers > 0) { score -= 15; reasons.push(`人少${instanceUsers}人可能私聊-15`); }
      // 个性化黄金区：学习到人数舒适区时按绝对人数判断，否则用固定填充率 30-80%
      const comfy = learning && learning.preferredCrowdRange;
      let inComfort = false;
      if (comfy) {
        // 兼容「4-8人」和「61+人」两种格式（61+ 无连字符）
        const m = comfy.match(/^(\d+)(?:-(\d+))?\+?人?$/);
        if (m) {
          const lo = parseInt(m[1], 10), hi = m[2] ? parseInt(m[2], 10) : Infinity;
          inComfort = instanceUsers >= lo && instanceUsers <= hi;
        }
      }
      if (comfy && inComfort) { score += 30; reasons.push(`舒适区${comfy}+30`); }
      else if (comfy) { score -= 10; reasons.push(`舒适区${comfy}外-10`); }
      else if (fillRatio >= 0.3 && fillRatio <= 0.8) { score += 30; reasons.push(`黄金区${Math.round(fillRatio*100)}%+30`); }
      if (fillRatio > 0.9) { score -= fullPenalty; reasons.push(`${prefTag}爆满-${fullPenalty}`); }
      else if (fillRatio < 0.1) { score -= coldPenalty; reasons.push(`${prefTag}冷清-${coldPenalty}`); }
      score += Math.round(instanceUsers * crowdMult); reasons.push(`人数${instanceUsers}${CROWD === 'normal' ? '' : `×${crowdMult}`}`);
    }
  }
  // 类型偏好：学习到的 author_tag 命中 → 加分（安静图类型由 quietBias 单独处理）
  if (learning && learning.worldType) {
    const tagHit = Array.isArray(worldTags) && worldTags.includes('author_tag_' + learning.worldType);
    if (tagHit) { score += 15; reasons.push(`类型[${learning.worldType}]+15`); }
  }
  if (loc.type === 'public') { score += 10; reasons.push('public+10'); }
  else if (loc.type === 'friends' || loc.type === 'hidden') { score += 5; reasons.push(loc.type === 'hidden' ? 'friend++5' : 'friends+5'); }
  else if (loc.type === 'group') { score += 3; reasons.push('group+3'); }
  if (status === 'active') { score += 5; reasons.push('active+5'); }
  return { score: Math.round(score), reasons, isQuietWorld, isSleepWorld };
}

async function handleGetFavoriteFriendsLocations({ groupName, favoriteGroupId, searchName }) {
  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  // 0. searchName 模式：直接在好友列表（含离线=false）里按名字查位置
  if (searchName) {
    const kw = searchName.toLowerCase();
    const friendsR = await rateLimiter.execute(() => api._request('GET', '/auth/user/friends?offline=false'));
    if (friendsR.status !== 200) throw new Error(`API error: ${friendsR.status}`);
    const onlineFriends = Array.isArray(friendsR.data) ? friendsR.data : [];
    // 模糊匹配（在线好友里找；找不到再提示）
    const matched = onlineFriends.filter(f =>
      f.displayName.toLowerCase().includes(kw) ||
      (f.id || '').toLowerCase() === kw);
    if (matched.length === 0) {
      // 查离线好友列表确认是否好友
      const allR = await rateLimiter.execute(() => api._request('GET', '/auth/user/friends?offline=true'));
      const allFriends = (allR.status === 200 && Array.isArray(allR.data)) ? allR.data : [];
      const matchedAll = allFriends.filter(f => f.displayName.toLowerCase().includes(kw));
      if (matchedAll.length === 0) {
        throw new Error(`好友列表中没有找到「${searchName}」。`);
      }
      return {
        mode: 'search',
        query: searchName,
        offline: matchedAll.map(f => ({ userId: f.id, displayName: f.displayName, online: false })),
        message: '好友当前离线',
      };
    }
    // 在线：逐个解析位置（复用下方逻辑，但保留 private/hidden 并标记 joinable）
    const results = [];
    const worldCache = new Map();
    const instanceInfo = new Map();
    async function getWorldNameSafe(worldId) {
      if (worldCache.has(worldId)) return worldCache.get(worldId);
      let name = worldId;
      const cached = storage.getWorldName(worldId);
      if (cached && cached.name) {
        name = cached.name;
      } else {
        const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${worldId}`));
        if (r.status === 200 && r.data && r.data.name) {
          name = r.data.name;
          try { storage.upsertWorld({ worldId, name, authorId: r.data.authorId || '', authorName: r.data.authorName || '' }); } catch (e) {}
        }
      }
      worldCache.set(worldId, name);
      return name;
    }
    for (const f of matched) {
      const loc = parseLocation(f.location || 'private');
      if (!loc) continue;
      const isJoinable = loc.type === 'public' || loc.type === 'friends' || loc.type === 'group' || loc.type === 'hidden';
      const worldName = loc.worldId ? await getWorldNameSafe(loc.worldId) : null;
      const entry = {
        userId: f.id,
        displayName: f.displayName,
        online: true,
        joinable: isJoinable,
        instanceTypeDisplay: loc.type === 'hidden' ? 'friend+（好友+）' : (loc.type || 'unknown'),
        location: f.location || 'private',
        worldId: loc.worldId || null,
        worldName,
        instanceType: loc.type || 'unknown',
        instanceId: loc.instanceId || '',
        region: loc.region || '',
        status: f.status,
        statusDescription: f.statusDescription,
        platform: f.platform,
        nickname: nicknameMap.get(f.id) || null,
        avatarImageUrl: f.currentAvatarThumbnailImageUrl,
      };
      // 可加入的才查实例玩家数（private 查了也进不去）
      if (isJoinable && loc.instanceId && f.location && !f.location.includes('~private')) {
        const instKey = f.location;
        if (!instanceInfo.has(instKey)) {
          try {
            const r = await rateLimiter.execute(() => api._request('GET', `/instances/${instKey}`));
            if (r.status === 200 && r.data) {
              instanceInfo.set(instKey, { nUsers: r.data.n_users || 0, capacity: r.data.capacity || 0 });
            } else {
              instanceInfo.set(instKey, null);
            }
          } catch (e) {
            instanceInfo.set(instKey, null);
          }
        }
        const inst = instanceInfo.get(instKey);
        if (inst) {
          entry.instanceUsers = inst.nUsers;
          entry.instanceCapacity = inst.capacity;
          entry.fillRatio = inst.capacity > 0 ? +(inst.nUsers / inst.capacity).toFixed(2) : 0;
        }
      }
      results.push(entry);
    }
    return { mode: 'search', query: searchName, friends: results };
  }

  // 1. 全部好友收藏分组
  const groupsR = await rateLimiter.execute(() => api._request('GET', '/favorite/groups?type=friend&n=100'));
  if (groupsR.status !== 200) throw new Error(`API error: ${groupsR.status}`);
  const groups = Array.isArray(groupsR.data) ? groupsR.data : [];

  if (!groupName && !favoriteGroupId) {
    // 概览模式：返回全部分组 + 成员数（用分组的 name=group_N 匹配 tags）
    const favsAllR = await rateLimiter.execute(() => api._request('GET', '/favorites?type=friend&n=100'));
    const favsAll = (favsAllR.status === 200 && Array.isArray(favsAllR.data)) ? favsAllR.data : [];
    // 按 tags[0]（group_N）分组统计
    const byGroupTag = new Map();
    for (const f of favsAll) {
      const tag = (f.tags || [])[0] || '';
      byGroupTag.set(tag, (byGroupTag.get(tag) || 0) + 1);
    }
    const overview = groups.map(g => ({
      groupId: g.id,
      groupName: g.displayName || g.id,
      groupTag: g.name || '',
      memberCount: byGroupTag.get(g.name) || 0,
    }));
    return { mode: 'overview', groups: overview };
  }

  // 2. 定位分组
  let group = null;
  if (favoriteGroupId) {
    group = groups.find(g => g.id === favoriteGroupId) || null;
  } else if (groupName) {
    group = groups.find(g => (g.displayName || '') === groupName) ||
            groups.find(g => (g.displayName || '').toLowerCase() === groupName.toLowerCase()) || null;
  }
  if (!group) {
    const available = groups.map(g => g.displayName || g.id);
    throw new Error(`找不到收藏夹「${groupName || favoriteGroupId}」。可用分组: ${available.join(' / ')}`);
  }

  // 3. 组内好友：API 的 groupId 参数被忽略（永远返回全部），改用分组的 name=group_N 匹配 tags[0]
  const groupTag = group.name || '';
  const favsR = await rateLimiter.execute(() => api._request('GET', '/favorites?type=friend&n=100'));
  if (favsR.status !== 200) throw new Error(`API error: ${favsR.status}`);
  const allFavs = Array.isArray(favsR.data) ? favsR.data : [];
  const favs = groupTag
    ? allFavs.filter(f => (f.tags || [])[0] === groupTag)
    : allFavs;

  // 4. 逐个查好友位置（复用在线好友列表更快：一次请求拿到全部在线好友位置）
  //    先用 /auth/user/friends?offline=false 拿在线好友，再对组内好友查详情
  const onlineR = await rateLimiter.execute(() => api._request('GET', '/auth/user/friends?offline=false'));
  const onlineFriends = (onlineR.status === 200 && Array.isArray(onlineR.data)) ? onlineR.data : [];
  const onlineMap = new Map(onlineFriends.map(f => [f.id, f]));

  // 组内每个好友：在线直接取位置；离线标记
  const members = [];
  const onlineIds = [];
  for (const f of favs) {
    const uid = f.favoriteId;
    const online = onlineMap.get(uid);
    if (online) {
      members.push({ favoriteId: f.id, userId: uid, displayName: online.displayName, online: true, location: online.location || 'private', status: online.status, platform: online.platform, avatarImageUrl: online.currentAvatarThumbnailImageUrl });
      onlineIds.push(uid);
    } else {
      members.push({ favoriteId: f.id, userId: uid, displayName: null, online: false });
    }
  }

  // 5. 在线好友：补世界名 + 实例信息（玩家数/容量/类型），算推荐度
  //    共享评分系统：熟悉度 + 收藏夹权重 + 安静图场景 + 偏好/学习（与 recommend_join 同一套）
  const ctx = buildScoreContext();
  const { familiarityScore } = await buildFamiliarityScorer();
  const groupMap = await buildGroupMap();
  const worldCache = new Map();
  const instanceInfo = new Map();
  //    位置解析 + 世界名缓存；实例详情批量查（限流）
  async function getWorldNameSafe(worldId) {
    if (worldCache.has(worldId)) return worldCache.get(worldId);
    let name = worldId;
    let tags = [];
    const cached = storage.getWorldName(worldId);
    if (cached && cached.name) {
      name = cached.name;
      tags = Array.isArray(cached.tags) ? cached.tags : (typeof cached.tags === 'string' && cached.tags ? JSON.parse(cached.tags) : []);
    } else {
      const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${worldId}`));
      if (r.status === 200 && r.data && r.data.name) {
        name = r.data.name;
        tags = Array.isArray(r.data.tags) ? r.data.tags.filter(t => t.startsWith('author_tag_')) : [];
        try { storage.upsertWorld({ worldId, name, authorId: r.data.authorId || '', authorName: r.data.authorName || '', tags: JSON.stringify(tags) }); } catch (e) {}
      }
    }
    worldCache.set(worldId, { name, tags });
    return { name, tags };
  }

  const detailed = [];
  for (const m of members) {
    if (!m.online) continue;
    const loc = parseLocation(m.location || 'private');
    // private 实例自动排除（Invite：仅被邀请者本人可进）
    // 注意：hidden 实例 = 游戏里的 friend+(好友+)实例，好友及好友的好友可进，不排除！
    if (!loc || loc.type === 'private' ||
        m.location === 'private' || m.location === 'offline' || m.location === 'traveling') {
      continue;
    }
    // traveling 也跳过（不在具体世界）
    if (loc.type === 'traveling') continue;

    const wInfo = await getWorldNameSafe(loc.worldId);
    const worldName = wInfo.name;
    const worldTags = wInfo.tags;
    const entry = {
      userId: m.userId,
      displayName: m.displayName,
      location: m.location,
      worldId: loc.worldId,
      worldName,
      worldTags,
      instanceType: loc.type,
      instanceId: loc.instanceId || '',
      region: loc.region || '',
      status: m.status,
      platform: m.platform,
      nickname: nicknameMap.get(m.userId) || null,
      avatarImageUrl: m.avatarImageUrl,
    };

    // 实例详情：玩家数/容量（限流；失败不阻断）
    // VRChat 实例查询 key 是完整 location 且不能 URL 编码（编码 :()~ 会 400 malformed url）
    if (loc.instanceId) {
      const instKey = m.location;   // 完整 location 字符串
      if (!instanceInfo.has(instKey)) {
        try {
          const r = await rateLimiter.execute(() => api._request('GET', `/instances/${instKey}`));
          if (r.status === 200 && r.data) {
            instanceInfo.set(instKey, {
              nUsers: r.data.n_users || 0,
              capacity: r.data.capacity || 0,
              recommendedCapacity: r.data.recommendedCapacity || 0,
              type: r.data.type || '',
            });
          } else {
            instanceInfo.set(instKey, null);
          }
        } catch (e) {
          instanceInfo.set(instKey, null);
        }
      }
      const inst = instanceInfo.get(instKey);
      if (inst) {
        entry.instanceUsers = inst.nUsers;
        entry.instanceCapacity = inst.capacity;
        entry.fillRatio = inst.capacity > 0 ? +(inst.nUsers / inst.capacity).toFixed(2) : 0;
      }
    }

    // 收藏夹分组 + 熟悉度（同一套评分：熟悉度 + 收藏夹权重 + 安静图 + 偏好/学习）
    let groupName = null, groupWeight = 0, isContact = false;
    for (const [gn, info] of groupMap) {
      if (info.memberIds.has(m.userId)) {
        groupName = gn; groupWeight = info.weight; isContact = info.isContact;
        break;
      }
    }
    const fam = await familiarityScore(m.userId);
    const scored = computeEntryScore(ctx, {
      loc, worldName: entry.worldName, worldTags: entry.worldTags, instanceUsers: entry.instanceUsers,
      fillRatio: entry.fillRatio, status: m.status,
      groupName, groupWeight, isContact, familiarity: fam,
    });
    entry.familiarity = fam;
    entry.isQuietWorld = scored.isQuietWorld;
    entry.relation = { group: groupName, isContact, note: isContact ? '活动联系人(非好友)' : (groupName ? `收藏夹[${groupName}]` : '普通好友') };
    entry.recommendScore = scored.score;
    entry.reasons = scored.reasons;
    detailed.push(entry);
  }

  // 排序：推荐度降序
  detailed.sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0));

  const onlineCount = members.filter(m => m.online).length;
  const joinableCount = detailed.length;

  return {
    mode: 'list',
    groupName: group.displayName || group.id,
    groupId: group.id,
    memberCount: members.length,
    onlineCount,
    joinableCount,
    excludedPrivate: onlineCount - joinableCount,
    friends: detailed,
    offline: members.filter(m => !m.online).map(m => ({ userId: m.userId })),
  };
}

// ── 推荐偏好：自然语言 → 权重调整（持久化到 config 表 join_prefs）──
function parseJoinPreference(text) {
  const t = String(text || '').trim();
  if (!t) return { error: 'preference 不能为空' };
  // 重置
  if (/(恢复|取消|重置|默认|清空|不要偏好)/.test(t)) {
    return { reset: true, message: '已恢复默认（无偏好）' };
  }
  let crowd = 'normal';
  // 爱热闹（优先匹配，避免「喜欢人多」被误判为避人潮）
  if (/(喜欢|爱|希望|想).*(热闹|人多|扎堆)|人越多越好|热闹一点|人多热闹/.test(t)) crowd = 'love';
  // 避人潮
  else if (/(不喜欢|讨厌|怕|不想|别).*(人多|热闹|挤|扎堆)|人.*太多|太挤|人少.*好|避开.*人群|清净/.test(t)) crowd = 'avoid';
  if (crowd === 'normal' && !/(热闹|人多|爆满|挤|人群)/.test(t)) {
    return { error: `未能识别偏好「${t}」——可试试「我不喜欢人太多」「喜欢热闹」「恢复默认」` };
  }
  const labels = { avoid: '避人潮（爆满重罚-80、人数权重×1.5、冷清不罚）', love: '爱热闹（人数权重×4、爆满轻罚-20）', normal: '默认' };
  return { crowd, label: labels[crowd] };
}

async function handleSetJoinPreference({ preference } = {}) {
  const parsed = parseJoinPreference(preference);
  if (parsed.error) throw new Error(parsed.error);
  if (parsed.reset) {
    storage.setConfig('join_prefs', '');
    return { success: true, reset: true, message: parsed.message };
  }
  const prefs = { crowd: parsed.crowd, label: parsed.label, updatedAt: new Date().toISOString() };
  storage.setConfig('join_prefs', JSON.stringify(prefs));
  return { success: true, ...prefs, message: `已保存：${parsed.label}` };
}

async function handleGetJoinPreference() {
  try {
    const raw = storage.getConfig('join_prefs');
    if (!raw) return { preference: null, message: '当前无偏好（默认：人数×3、爆满-40、冷清-10）' };
    return { preference: JSON.parse(raw) };
  } catch (e) {
    return { preference: null, error: `读取失败: ${e.message}` };
  }
}

// ── 推荐选择学习：记录用户从推荐列表的选择，积累后自动分析偏好调整权重 ──
let lastRecommendSnapshot = null; // 最近一次推荐列表快照（record_join_choice 补全上下文用）

function computeListBaseline(top) {
  const rows = top.filter(f => f.instanceUsers !== undefined && f.instanceUsers !== null);
  if (rows.length === 0) return { list_count: top.length, list_avg_users: 0, list_avg_fill: 0, list_quiet_ratio: 0 };
  const avgUsers = rows.reduce((s, f) => s + (f.instanceUsers || 0), 0) / rows.length;
  const avgFill = rows.reduce((s, f) => s + (f.fillRatio || 0), 0) / rows.length;
  const quietRatio = rows.filter(f => f.isQuietWorld).length / rows.length;
  return {
    list_count: top.length,
    list_avg_users: Math.round(avgUsers * 10) / 10,
    list_avg_fill: Math.round(avgFill * 100) / 100,
    list_quiet_ratio: Math.round(quietRatio * 100) / 100,
  };
}

function analyzeJoinLearning() {
  const MIN_SAMPLES = 5;
  const rows = storage._query('SELECT * FROM join_choices ORDER BY id DESC LIMIT 20');
  if (rows.length < MIN_SAMPLES) {
    return { enabled: false, samples: rows.length, minSamples: MIN_SAMPLES, crowd: null, familiarityMult: 1, quietBias: false, preferredCrowdRange: null, worldType: null };
  }
  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const avgChosenUsers = avg(rows.map(r => r.instance_users));
  const avgListUsers = avg(rows.map(r => r.list_avg_users));
  const avgFam = avg(rows.map(r => r.familiarity_score));
  const quietRatio = rows.filter(r => r.is_quiet_world).length / rows.length;

  // ── 维度1 重复选同一人：同一 userId 占比 ≥60% → 强熟人信号（不依赖熟悉度绝对值）──
  const userCounts = {};
  for (const r of rows) userCounts[r.user_id] = (userCounts[r.user_id] || 0) + 1;
  const topUser = Object.entries(userCounts).sort((a, b) => b[1] - a[1])[0] || null;
  const repeatRatio = topUser ? topUser[1] / rows.length : 0;
  const repeatPrefer = repeatRatio >= 0.6;

  // ── 维度2 熟悉度偏好：60% 以上选择熟悉度>=15 的好友（辅助，重复选择已覆盖）──
  const famPrefer = !repeatPrefer && avgFam >= 15 && rows.filter(r => r.familiarity_score >= 15).length >= Math.ceil(rows.length * 0.6);

  // ── 维度3 人数舒适区：选择人数分桶 ≥60% 集中 → 个性化黄金区 ──
  const CROWD_BUCKETS = [
    { label: '0-3人', min: 0, max: 3 },
    { label: '4-8人', min: 4, max: 8 },
    { label: '9-15人', min: 9, max: 15 },
    { label: '16-30人', min: 16, max: 30 },
    { label: '31-60人', min: 31, max: 60 },
    { label: '61+人', min: 61, max: Infinity },
  ];
  let preferredCrowdRange = null;
  const chosenUsersArr = rows.map(r => r.instance_users).filter(n => n > 0);
  if (chosenUsersArr.length >= Math.ceil(rows.length * 0.6)) {
    for (const b of CROWD_BUCKETS) {
      const ratio = chosenUsersArr.filter(n => n >= b.min && n <= b.max).length / chosenUsersArr.length;
      if (ratio >= 0.6) { preferredCrowdRange = b.label; break; }
    }
  }

  // ── 维度4 人数倾向（舒适区细化为 avoid/love，舒适区未命中时用旧逻辑）──
  let crowd = null;
  if (preferredCrowdRange) {
    if (preferredCrowdRange === '0-3人' || preferredCrowdRange === '4-8人') crowd = 'avoid';
    else if (preferredCrowdRange === '31-60人' || preferredCrowdRange === '61+人') crowd = 'love';
  }
  if (!crowd && avgListUsers > 3 && avgChosenUsers < avgListUsers * 0.6) crowd = 'avoid';
  else if (!crowd && avgListUsers > 3 && avgChosenUsers > avgListUsers * 1.3) crowd = 'love';

  // ── 维度5 类型偏好：某 author_tag 出现在 ≥60% 的选择行中 → 类型加分 ──
  // 按选择行数占比判定（世界通常带多个标签，按标签次数占比过严会被稀释）
  let worldType = null;
  const tagCounts = {};
  for (const r of rows) {
    let tags = [];
    try { tags = r.world_tags ? JSON.parse(r.world_tags) : []; } catch (e) {}
    for (const t of tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  const topTag = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])[0] || null;
  if (topTag && topTag[1] / rows.length >= 0.6) {
    worldType = topTag[0].replace('author_tag_', '');
  }

  // ── 安静图倾向：50% 以上选择安静图（并入类型体系，保留独立信号）──
  const quietBias = quietRatio >= 0.5;

  const learning = {
    enabled: true,
    samples: rows.length,
    crowd,
    // 重复选同一人 → 1.3（最强信号）；熟悉度偏好 → 1.2；否则 1
    familiarityMult: repeatPrefer ? 1.3 : (famPrefer ? 1.2 : 1),
    quietBias,
    preferredCrowdRange,
    worldType,
    stats: {
      avgChosenUsers: Math.round(avgChosenUsers * 10) / 10,
      avgListUsers: Math.round(avgListUsers * 10) / 10,
      avgFamiliarity: Math.round(avgFam * 10) / 10,
      quietRatio: Math.round(quietRatio * 100) / 100,
      repeatRatio: Math.round(repeatRatio * 100) / 100,
      repeatUser: repeatPrefer ? (topUser ? topUser[0].slice(0, 12) : null) : null,
      topTag: worldType ? 'author_tag_' + worldType : null,
    },
    updatedAt: new Date().toISOString(),
  };
  storage.setConfig('join_learning', JSON.stringify(learning));
  return learning;
}

async function handleRecordJoinChoice({ userId, displayName } = {}) {
  if (!lastRecommendSnapshot) throw new Error('还没有推荐列表——请先运行 recommend_join 再记录选择');
  const top = lastRecommendSnapshot.top || [];
  if (top.length === 0) throw new Error('最近一次推荐列表为空，无法记录');
  let hit = null;
  if (userId) hit = top.find(f => f.userId === userId);
  if (!hit && displayName) {
    const dn = String(displayName).toLowerCase();
    hit = top.find(f => (f.displayName || '').toLowerCase().includes(dn));
  }
  if (!hit) throw new Error(`推荐列表中没有找到「${displayName || userId}」——请先运行 recommend_join 并从中选择`);
  const rank = top.indexOf(hit) + 1;
  const baseline = lastRecommendSnapshot.baseline;
  storage._run(
    `INSERT INTO join_choices (user_id, display_name, world_id, world_name, instance_type, instance_users, instance_capacity, fill_ratio, familiarity_score, is_quiet_world, recommend_score, rank_in_list, list_count, list_avg_users, list_avg_fill, list_quiet_ratio, world_tags)
     VALUES ($userId, $displayName, $worldId, $worldName, $instanceType, $instanceUsers, $instanceCapacity, $fillRatio, $familiarityScore, $isQuietWorld, $recommendScore, $rank, $listCount, $listAvgUsers, $listAvgFill, $listQuietRatio, $worldTags)`,
    {
      $userId: hit.userId, $displayName: hit.displayName, $worldId: hit.worldId || '',
      $worldName: hit.worldName || '', $instanceType: hit.instanceType || '',
      $instanceUsers: hit.instanceUsers || 0, $instanceCapacity: hit.instanceCapacity || 0,
      $fillRatio: hit.fillRatio || 0, $familiarityScore: (hit.familiarity && hit.familiarity.score) || 0,
      $isQuietWorld: hit.isQuietWorld ? 1 : 0, $recommendScore: hit.recommendScore || 0,
      $rank: rank, $listCount: baseline.list_count, $listAvgUsers: baseline.list_avg_users,
      $listAvgFill: baseline.list_avg_fill, $listQuietRatio: baseline.list_quiet_ratio,
      $worldTags: Array.isArray(hit.worldTags) ? JSON.stringify(hit.worldTags) : '',
    },
  );
  const learning = analyzeJoinLearning();
  return {
    success: true,
    recorded: { userId: hit.userId, displayName: hit.displayName, worldName: hit.worldName, rank },
    learning,
  };
}

async function handleGetJoinLearning() {
  try {
    const raw = storage.getConfig('join_learning');
    // 旧缓存可能缺 preferredCrowdRange/worldType 字段——缺则重新分析
    const cached = raw ? JSON.parse(raw) : null;
    const learning = (cached && 'preferredCrowdRange' in cached && 'worldType' in cached) ? cached : analyzeJoinLearning();
  } catch (e) {
    return { error: `读取失败: ${e.message}` };
  }
}

async function handleRecommendJoin({ limit = 10, minScore = 0 } = {}) {
  // 0. 评分上下文（显式偏好 > 自动学习 > 默认，含安静图集合）
  const ctx = buildScoreContext();
  const { CROWD, isExplicitPref, joinPrefs, learning } = ctx;

  // 1. 全部在线好友
  const onlineR = await rateLimiter.execute(() => api._request('GET', '/auth/user/friends?offline=false'));
  if (onlineR.status !== 200) throw new Error(`API error: ${onlineR.status}`);
  const onlineFriends = Array.isArray(onlineR.data) ? onlineR.data : [];

  // 2. 收藏夹分组（权重配置化，共享构建）
  const groupMap = await buildGroupMap();

  // 3. 熟悉度：同屏统计（现成 storage.findCompanions，共享构建）
  const { familiarityScore } = await buildFamiliarityScorer();

  // 4. 逐个好友：世界名 + 实例 + 综合评分
  const worldCache = new Map();
  const instanceInfo = new Map();

  const detailed = [];
  for (const f of onlineFriends) {
    const loc = parseLocation(f.location || 'private');
    if (!loc || loc.type === 'private' || loc.type === 'traveling' ||
        f.location === 'private' || f.location === 'offline' || f.location === 'traveling') continue;

    // 世界名 + 标签（类型偏好学习用）
    let worldName = f.worldId || loc.worldId || '';
    let worldTags = [];
    if (loc.worldId) {
      if (worldCache.has(loc.worldId)) {
        const c = worldCache.get(loc.worldId);
        worldName = c.name; worldTags = c.tags;
      } else {
        const cached = storage.getWorldName(loc.worldId);
        if (cached && cached.name) {
          worldName = cached.name;
          worldTags = Array.isArray(cached.tags) ? cached.tags : (typeof cached.tags === 'string' && cached.tags ? JSON.parse(cached.tags) : []);
        } else {
          const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${loc.worldId}`));
          if (r.status === 200 && r.data && r.data.name) {
            worldName = r.data.name;
            worldTags = Array.isArray(r.data.tags) ? r.data.tags.filter(t => t.startsWith('author_tag_')) : [];
            try { storage.upsertWorld({ worldId: loc.worldId, name: r.data.name, authorId: r.data.authorId || '', authorName: r.data.authorName || '', tags: JSON.stringify(worldTags) }); } catch (e) {}
          }
        }
        worldCache.set(loc.worldId, { name: worldName, tags: worldTags });
      }
    }

    // 实例详情
    let instanceUsers, instanceCapacity, fillRatio;
    if (loc.instanceId && f.location && !f.location.includes('~private')) {
      const instKey = f.location;
      if (!instanceInfo.has(instKey)) {
        try {
          const r = await rateLimiter.execute(() => api._request('GET', `/instances/${instKey}`));
          if (r.status === 200 && r.data) instanceInfo.set(instKey, { nUsers: r.data.n_users || 0, capacity: r.data.capacity || 0 });
          else instanceInfo.set(instKey, null);
        } catch (e) { instanceInfo.set(instKey, null); }
      }
      const inst = instanceInfo.get(instKey);
      if (inst) {
        instanceUsers = inst.nUsers;
        instanceCapacity = inst.capacity;
        fillRatio = inst.capacity > 0 ? +(inst.nUsers / inst.capacity).toFixed(2) : 0;
      }
    }

    // 收藏夹分组 + 熟悉度
    let groupName = null, groupWeight = 0, isContact = false;
    for (const [gn, info] of groupMap) {
      if (info.memberIds.has(f.id)) {
        groupName = gn; groupWeight = info.weight; isContact = info.isContact;
        break;
      }
    }
    const fam = await familiarityScore(f.id);

    // 综合评分（共享评分系统：熟悉度 + 收藏夹权重 + 安静图场景 + 实例 + 偏好/学习）
    const scored = computeEntryScore(ctx, {
      loc, worldName, worldTags, instanceUsers, fillRatio, status: f.status,
      groupName, groupWeight, isContact, familiarity: fam,
    });
    const { score, reasons, isQuietWorld } = scored;

    detailed.push({
      userId: f.id,
      displayName: f.displayName,
      worldId: loc.worldId,
      worldName,
      worldTags,
      instanceType: loc.type,
      instanceTypeDisplay: loc.type === 'hidden' ? 'friend+' : loc.type,
      instanceUsers, instanceCapacity, fillRatio,
      region: loc.region || '',
      status: f.status,
      isSleepWorld: scored.isSleepWorld,
      isQuietWorld,
      familiarity: fam,
      relation: { group: groupName, isContact, note: isContact ? '活动联系人(非好友)' : (groupName ? `收藏夹[${groupName}]` : '普通好友') },
      recommendScore: score,
      reasons,
    });
  }

  detailed.sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0));
  const filtered = minScore > 0 ? detailed.filter(d => d.recommendScore >= minScore) : detailed;
  // 存推荐快照（record_join_choice 用它补全选择上下文）
  const baseline = computeListBaseline(filtered.slice(0, limit));
  lastRecommendSnapshot = { at: Date.now(), top: filtered.slice(0, limit), baseline };
  return {
    totalOnline: onlineFriends.length,
    joinable: detailed.length,
    top: filtered.slice(0, limit),
    method: 'familiarity+group+scene+instance',
    preference: isExplicitPref ? { crowd: CROWD, label: joinPrefs.label || '' } : null,
    learning: (!isExplicitPref && learning) ? { crowd: learning.crowd, familiarityMult: learning.familiarityMult, quietBias: learning.quietBias, samples: learning.samples } : null,
  };
}

async function handleGetFriendInfo({ userId, displayName }) {
  let targetId = userId;
  if (!targetId && displayName) {
    // 搜索用户
    const r = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=5`);
    if (r.status !== 200) throw new Error(`API error: ${r.status}`);
    const users = Array.isArray(r.data) ? r.data : [];
    if (users.length === 0) return { error: 'User not found' };
    targetId = users[0].id;
  }
  if (!targetId) throw new Error('Provide userId or displayName');

  const r = await api._request('GET', `/users/${targetId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const u = r.data;
  return {
    userId: u.id,
    displayName: u.displayName,
    bio: u.bio,
    status: u.status,
    statusDescription: u.statusDescription,
    state: u.state,
    location: u.location,
    worldId: u.worldId,
    platform: u.platform,
    avatarImageUrl: u.currentAvatarImageUrl,
    avatarThumbnail: u.currentAvatarThumbnailImageUrl,
    tags: u.tags,
    developerType: u.developerType,
    isFriend: u.isFriend,
    lastLogin: u.last_login,
    pastDisplayNames: u.pastDisplayNames,
    dateJoined: u.date_joined,
    ageVerification: u.ageVerificationStatus,
  };
}

async function handleSearchUsers({ query, limit = 10 }) {
  const r = await api._request('GET', `/users?search=${encodeURIComponent(query)}&n=${limit}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  return {
    query,
    results: (Array.isArray(r.data) ? r.data : []).map(u => ({
      userId: u.id,
      displayName: u.displayName,
      bio: (u.bio || '').slice(0, 100),
      status: u.status,
      isFriend: u.isFriend,
    })),
  };
}

async function handleGetMutualFriends({ userId, displayName, limit = 100 }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  let targetId = userId;
  let targetDisplayName = null;

  if (!targetId) {
    const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
    if (search.status !== 200) throw new Error(`API error: ${search.status}`);
    const users = Array.isArray(search.data) ? search.data : [];
    const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

    targetId = matches[0].id;
    targetDisplayName = matches[0].displayName;
  }

  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/users/${targetId}/mutuals/friends?n=${n}&offset=0`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  const mutuals = Array.isArray(r.data) ? r.data : [];
  const mutualFriends = mutuals.map(u => ({
    userId: u.id,
    displayName: u.displayName,
    nickname: nicknameMap.get(u.id) || null,
    isFriend: u.isFriend !== undefined ? u.isFriend : true,
  }));

  return {
    userId: targetId,
    displayName: targetDisplayName,
    total: mutualFriends.length,
    mutualFriends,
  };
}

async function handleSendFriendRequest({ userId, displayName }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  if (userId) {
    const r = await api.sendFriendRequest(userId);
    if (r.status >= 400) throw new Error(`API error ${r.status}`);
    return { userId, displayName: null, method: 'userId', ok: true };
  }

  const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
  if (search.status !== 200) throw new Error(`API error: ${search.status}`);
  const users = Array.isArray(search.data) ? search.data : [];
  const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

  if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
  if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

  const target = matches[0];
  if (target.isFriend) throw new Error(`"${displayName}" 已经是你的好友，无需重复添加`);
  const r = await api.sendFriendRequest(target.id);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { userId: target.id, displayName, method: 'displayName', ok: true };
}


async function handleCreateInstance({ worldId, type, region, instanceId, groupAccessType }) {
  if (!worldId || !String(worldId).startsWith('wrld_')) {
    throw new Error('worldId 必须是 wrld_ 开头（如 wrld_xxxx）');
  }
  const instType = type || 'hidden';
  const body = {
    worldId,
    type: instType,
    region: region || 'jp',
  };
  if (instanceId) body.instanceId = instanceId;
  if (groupAccessType) body.groupAccessType = groupAccessType;
  // 非 public 实例必须显式带 ownerId（=当前用户），否则 API 400 "Invalid owner ID"（2026-08-09 实测）
  if (instType !== 'public') {
    await api.ensureAuth();
    const me = (api.currentUser && api.currentUser.id) || null;
    if (!me) throw new Error('无法获取当前用户 ID，不能创建非公开实例');
    body.ownerId = me;
  }
  const r = await api._request('POST', '/instances', body);
  if (r.status >= 400) {
    throw new Error(`创建实例失败 API ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const d = r.data || {};
  return {
    success: true,
    worldId: d.worldId || worldId,
    type: d.type || body.type,
    region: d.region || body.region,
    instanceId: d.instanceId || d.id || null,
    location: d.location || null,
    shortName: d.shortName || null,
    capacity: d.capacity || null,
  };
}

async function handleInviteMyself({ location, worldId, instanceId, forceApi }) {
  // 统一入口（与 open_world 同一套）：管道直发优先（游戏内静默弹加入菜单），
  // 管道不可用/非 Windows 时静默回退 API 自我邀请（客户端收到通知接受后传送）
  let loc = location;
  if (loc && typeof loc === 'string') {
    const idx = loc.indexOf(':');
    if (idx <= 0) throw new Error('location 格式应为 worldId:instanceId（如 wrld_x:12345~hidden(usr_x)~region(jp)）');
    if (!String(loc).startsWith('wrld_')) throw new Error('location 必须是 wrld_ 开头的完整实例串');
  } else {
    if (!worldId || !String(worldId).startsWith('wrld_')) throw new Error('worldId 必须是 wrld_ 开头');
    if (!instanceId) throw new Error('instanceId 不能为空（可用 create_instance 返回的 location）');
    loc = `${worldId}:${instanceId}`;
  }
  const res = await openInstance({ location: loc, api, forceApi: !!forceApi });
  if (!res.success) throw new Error(res.error || '邀请自己失败');
  const wId = loc.slice(0, loc.indexOf(':'));
  const iId = loc.slice(loc.indexOf(':') + 1);
  return {
    success: true,
    method: res.method,
    worldId: wId,
    instanceId: iId,
    notificationId: res.notificationId || null,
    notificationType: null,
    detail: res.detail || null,
  };
}

async function handleOpenWorld({ worldId, location, type, region, shortName, forceApi }) {
  // 1) 定位目标实例：直接给 location 就用它；只给 worldId 就先建实例（复用 handleCreateInstance）
  let loc = location;
  let sn = shortName || null;
  if (!loc || typeof loc !== 'string') {
    if (!worldId || !String(worldId).startsWith('wrld_')) {
      throw new Error('需要 worldId（wrld_ 开头，自动建实例后打开）或 location（完整实例串直接打开）');
    }
    const inst = await handleCreateInstance({ worldId, type, region });
    if (!inst.location) throw new Error('创建实例成功但未返回 location，无法打开');
    loc = inst.location;
    sn = sn || inst.shortName || null;
  } else if (!String(loc).startsWith('wrld_')) {
    throw new Error('location 必须是 wrld_ 开头的完整实例串（如 wrld_x:12345~hidden(usr_x)~region(jp)）');
  }
  // 2) 统一入口：管道直发（静默弹窗）→ 探测失败静默回退 API 自我邀请
  const res = await openInstance({ location: loc, shortName: sn, api, forceApi: !!forceApi });
  if (!res.success) throw new Error(res.error || '打开实例失败');
  return {
    success: true,
    method: res.method,
    location: loc,
    shortName: sn,
    notificationId: res.notificationId || null,
    detail: res.detail || null,
  };
}


async function handleRemoveFriend({ userId, displayName, confirm }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  let target = { userId, displayName };
  if (!userId) {
    const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
    if (search.status !== 200) throw new Error(`API error: ${search.status}`);
    const users = Array.isArray(search.data) ? search.data : [];
    const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

    const found = matches[0];
    if (found.isFriend === false) throw new Error(`"${displayName}" 不是你的好友，无需删除`);
    target = { userId: found.id, displayName };
  }

  if (!confirm) {
    return { userId: target.userId, displayName: target.displayName, confirmRequired: true, message: '删除好友不可逆，请传 confirm: true 确认执行' };
  }

  const r = await api.removeFriend(target.userId);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { userId: target.userId, displayName: target.displayName, ok: true };
}

function handleGetDatabaseStats() {
  return {
    ...storage.getStats(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

function handleGetServerStatus() {
  return {
    status: 'running',
    startedAt: serverState.started,
    authenticated: !!serverState.authUser,
    user: serverState.authUser,
    dbEvents: storage.getStats().events,
    dbFriends: storage.getStats().friends,
    ws: wsManager?.getState(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

// ── Phase 4 新增处理器 ──

async function handleGetFriendEvents({ userId, limit = 20, offset = 0, types }) {
  // 单类型查询
  if (types && !types.includes(',')) {
    const events = storage.getEventsByUser(userId, { limit, offset, type: types.trim() });
    return { userId, total: events.length, events };
  }
  // 多类型/无类型过滤
  const events = storage.getEventsByUser(userId, { limit, offset });
  if (types) {
    const typeSet = new Set(types.split(',').map(t => t.trim()));
    const filtered = events.filter(e => typeSet.has(e.type));
    return { userId, total: filtered.length, events: filtered };
  }
  return { userId, total: events.length, events };
}

function handleGetRecentEvents({ limit = 30, offset = 0, typeFilter, userIdFilter }) {
  let events;
  if (userIdFilter) {
    events = storage.getEventsByUser(userIdFilter, { limit, offset });
  } else {
    events = storage.getRecentEvents({ limit: limit + offset });
    if (offset > 0) events = events.slice(offset);
  }
  if (typeFilter) {
    const typeSet = new Set(typeFilter.split(',').map(t => t.trim()));
    events = events.filter(e => typeSet.has(e.type));
  }
  return { total: events.length, events };
}

async function handleGetWorldName({ worldId, forceRefresh }) {
  // 懒刷新：缓存命中直接返回，只有 forceRefresh 或缓存不存在时才走 API
  if (!forceRefresh) {
    const cached = storage.getWorldName(worldId);
    if (cached) {
      return { worldId, name: cached.name, source: 'cache', ...cached };
    }
  }
  // 调 API
  const prev = storage.getWorldName(worldId);
  const r = await api._request('GET', `/worlds/${worldId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const w = r.data;
  const result = {
    worldId: w.id,
    name: w.name,
    authorName: w.authorName,
    capacity: w.capacity,
    occupants: w.occupants,
    releaseStatus: w.releaseStatus,
    tags: w.tags,
    description: (w.description || '').slice(0, 200),
    imageUrl: w.imageUrl,
    favorites: w.favorites,
    note: prev?.note ?? null,
    source: 'api',
  };
  // 写入缓存（不覆盖 note）
  storage.upsertWorld({
    worldId: w.id, name: w.name, authorName: w.authorName,
    capacity: w.capacity, favorites: w.favorites,
    releaseStatus: w.releaseStatus, tags: w.tags || [],
    description: w.description || '', imageUrl: w.imageUrl || '',
  });
  return result;
}

function handleSetWorldNote({ worldId, note }) {
  if (!worldId) throw new Error('worldId is required');
  if (note === undefined || note === null) throw new Error('note is required (empty string clears)');
  const result = storage.setWorldNote({ worldId, note });
  storage.save();
  return result;
}

function handleGetWorldHistory({ worldId, limit = 50 }) {
  if (!worldId) throw new Error('worldId is required');
  return { worldId, history: storage.getWorldHistory(worldId, limit) };
}

async function handleGetWeeklyReport({ days = 7 }) {
  if (!days || days < 1 || days > 90) days = 7;
  // 北京时间窗口（UTC - 8h）
  const endUtc = new Date(Date.now() - 8 * 3600 * 1000);  // 北京当前时刻转 UTC
  const startMs = endUtc.getTime() - days * 86400000;
  const startUtc = new Date(startMs);
  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();

  const userId = serverState.authUser?.id;
  if (!userId) throw new Error('Not authenticated');

  // 1. 会话切分 → 世界停留统计
  const sessions = storage.getOwnWorldSessions(startIso, endIso);
  const worldMinutes = new Map();  // worldId -> {minutes, visits}
  const dayWorlds = new Map();     // MM-DD -> Set<worldId>
  for (const s of sessions) {
    if (!worldMinutes.has(s.worldId)) worldMinutes.set(s.worldId, { minutes: 0, visits: 0 });
    const w = worldMinutes.get(s.worldId); w.minutes += s.minutes; w.visits++;
    const dayLabel = new Date(Date.parse(s.start) + 8 * 3600 * 1000).toISOString().slice(5, 10);
    if (!dayWorlds.has(dayLabel)) dayWorlds.set(dayLabel, new Set());
    dayWorlds.get(dayLabel).add(s.worldId);
  }

  // 2. 同屏合并
  const companions = storage.getWeeklyCompanions(userId, startIso, endIso);

  // 3. 自己的上线规律（复用 getOnlinePattern，window = 30 天）
  const pattern = storage.getOnlinePattern(userId, { days: Math.max(days, 30) });

  // 4. 世界名解析（缓存优先，缺失批量 API 查询并写 world_cache——懒刷新，无 TTL 自动过期）
  const allWorldIds = new Set([...worldMinutes.keys(), ...(function(){ const s=new Set(); for (const d of dayWorlds.values()) for (const w of d) s.add(w); return s; })()]);
  const worldNameMap = {};
  const missingWorlds = [];
  for (const wid of allWorldIds) {
    const cached = storage.getWorldName(wid);
    if (cached && cached.name) worldNameMap[wid] = cached.name;
    else missingWorlds.push(wid);
  }
  // 批量 API 查缺失世界名（串行，rateLimiter 在 RPC case 外层已包）
  for (const wid of missingWorlds) {
    try {
      const r = await api._request('GET', `/worlds/${wid}`);
      if (r.status === 200 && r.data) {
        const w = r.data;
        worldNameMap[wid] = w.name || wid;
        storage.upsertWorld({ worldId: w.id, name: w.name, authorName: w.authorName, capacity: w.capacity, favorites: w.favorites, releaseStatus: w.releaseStatus, tags: w.tags || [], description: w.description || '', imageUrl: w.imageUrl || '' });
      } else worldNameMap[wid] = wid;
    } catch { worldNameMap[wid] = wid; }
  }

  // 5. 群组活动（自己进过的群组房）——从 sessions 对应的事件里找 ~group(grp_xxx)
  //    直接查 user-location 事件的 groupId
  const myGroupRows = storage._query(
    `SELECT content_json, created_at FROM events WHERE type='user-location' AND created_at >= $s AND created_at <= $e AND content_json LIKE '%~group(grp_%' ORDER BY created_at`,
    { $s: startIso, $e: endIso }
  );
  const groupActivities = [];
  const groupIds = new Set();
  for (const row of myGroupRows) {
    try {
      const c = JSON.parse(row.content_json);
      const loc = c.location || '';
      const m = loc.match(/~group\((grp_[a-f0-9-]+)\)/);
      if (m) {
        groupIds.add(m[1]);
        const wid = loc.split(':')[0];
        groupActivities.push({ time: row.created_at, worldId: wid, worldName: worldNameMap[wid] || wid, groupId: m[1] });
        // 群组房可能停留 <3min 未进 worldMinutes，这里补入世界名解析集合
        if (!worldNameMap[wid] && !missingWorlds.includes(wid)) missingWorlds.push(wid);
      }
    } catch {}
  }
  // 补充解析群组房的世界名（第 4 步未覆盖的）
  for (const wid of missingWorlds) {
    if (worldNameMap[wid]) continue;
    try {
      const r = await api._request('GET', `/worlds/${wid}`);
      if (r.status === 200 && r.data) {
        const w = r.data;
        worldNameMap[wid] = w.name || wid;
        storage.upsertWorld({ worldId: w.id, name: w.name, authorName: w.authorName, capacity: w.capacity, favorites: w.favorites, releaseStatus: w.releaseStatus, tags: w.tags || [], description: w.description || '', imageUrl: w.imageUrl || '' });
      } else worldNameMap[wid] = wid;
    } catch { worldNameMap[wid] = wid; }
  }
  // 回填 groupActivities 的世界名
  for (const a of groupActivities) {
    if (worldNameMap[a.worldId]) a.worldName = worldNameMap[a.worldId];
  }

  // 6. 圈内活动日历（好友群组房统计）
  const friendGroups = storage.getFriendGroupStats(startIso, endIso);
  for (const gid of friendGroups.keys()) groupIds.add(gid);

  // 7. 群组信息（group_cache 优先，缺失查 API 并缓存；TTL 7 天）
  const groupInfoMap = {};
  const missingGroups = [];
  for (const gid of groupIds) {
    const cached = storage.getGroupCached(gid);
    if (cached && cached.name && (Date.now() - Date.parse(cached.updated_at.replace(' ', 'T') + 'Z')) < 7 * 86400000) {
      groupInfoMap[gid] = { groupId: gid, name: cached.name, description: cached.description, memberCount: cached.member_count };
    } else missingGroups.push(gid);
  }
  let groupCacheUpdated = false;
  for (const gid of missingGroups) {
    try {
      const r = await api._request('GET', `/groups/${gid}`);
      if (r.status === 200 && r.data) {
        const d = r.data;
        groupInfoMap[gid] = { groupId: gid, name: d.name || gid, description: d.description || '', memberCount: d.memberCount || 0 };
        storage.upsertGroupCache({ groupId: gid, name: d.name || '', description: d.description || '', memberCount: d.memberCount || 0 });
        groupCacheUpdated = true;
      } else groupInfoMap[gid] = { groupId: gid, name: gid, description: '', memberCount: 0 };
    } catch { groupInfoMap[gid] = { groupId: gid, name: gid, description: '', memberCount: 0 }; }
  }
  if (groupCacheUpdated) storage.save();

  // 8. 昵称映射（带昵称展示）
  const nicknames = storage.getNicknames({});
  const nickMap = {};
  for (const n of nicknames) nickMap[n.userId] = n.nickname || n.displayName;

  // 组装结果
  const topWorlds = [...worldMinutes.entries()]
    .map(([wid, v]) => ({ worldId: wid, name: worldNameMap[wid] || wid, minutes: Math.round(v.minutes), visits: v.visits }))
    .sort((a, b) => b.minutes - a.minutes);

  const topCompanions = [...companions.entries()]
    .map(([uid, v]) => ({ userId: uid, displayName: v.displayName, nickname: nickMap[uid] || null, matchCount: v.matchCount, days: v.days.size, dayList: [...v.days].sort() }))
    .sort((a, b) => b.days - a.days || b.matchCount - a.matchCount);

  const friendGroupCalendar = [...friendGroups.entries()]
    .map(([gid, v]) => ({ groupId: gid, groupName: groupInfoMap[gid]?.name || gid, friendCount: v.users.size, eventCount: v.count, worldCount: v.worlds.size, memberCount: groupInfoMap[gid]?.memberCount || 0 }))
    .sort((a, b) => b.friendCount - a.friendCount || b.eventCount - a.eventCount);

  return {
    period: { start: startIso, end: endIso, days, tz: 'UTC' },
    overview: {
      activeDays: dayWorlds.size,
      totalMinutes: Math.round(sessions.reduce((a, s) => a + s.minutes, 0)),
      worldsVisited: worldMinutes.size,
      companionUsers: companions.size,
      topCompanion: topCompanions[0] ? { userId: topCompanions[0].userId, displayName: topCompanions[0].displayName, nickname: topCompanions[0].nickname, days: topCompanions[0].days, matchCount: topCompanions[0].matchCount } : null,
    },
    daily: [...dayWorlds.entries()].sort().map(([day, worlds]) => ({ day, worlds: [...worlds].map(w => ({ worldId: w, name: worldNameMap[w] || w })) })),
    topWorlds,
    ownPattern: {
      activeDays30: pattern.activeDates?.length || 0,
      hourly: pattern.hourly?.location || {},
      peakHour: pattern.peak?.activePeakHour ?? null,
      avgGapDays: pattern.frequency?.avgGapDays ?? null,
      longestGapDays: pattern.frequency?.longestGapDays ?? null,
    },
    topCompanions,
    groupActivities: groupActivities.map(a => ({ ...a, groupName: groupInfoMap[a.groupId]?.name || a.groupId, memberCount: groupInfoMap[a.groupId]?.memberCount || 0 })),
    friendGroupCalendar,
  };
}

async function handleScanNewWorlds({ days = 7, dryRun = false }) {
  if (!days || days < 1 || days > 30) days = 7;
  const selfUserId = serverState.authUser?.id;
  if (!selfUserId) throw new Error('Not authenticated');

  const { fresh } = await fetchFreshWorlds(api, rateLimiter, { days, maxFetch: 200 });

  const visitedRows = storage._query(
    `SELECT DISTINCT world_id FROM events
     WHERE world_id IS NOT NULL AND world_id != ''
       AND (
         type = 'user-location'
         OR (type = 'friend-location' AND user_id = @selfUserId)
       )`,
    { $selfUserId: selfUserId }
  );
  const visited = new Set(visitedRows.map(r => r.world_id));

  const trackedRows = storage._query('SELECT world_id FROM new_worlds');
  const tracked = new Set(trackedRows.map(r => r.world_id));

  const { unvisited, visitedFresh, toAdd, alreadyTracked } = classifyWorlds(fresh, visited, tracked);

  let written = 0;
  let updated = 0;
  const now = new Date().toISOString();

  if (!dryRun) {
    const upsert = storage.db.prepare(
      `INSERT INTO new_worlds (world_id, world_name, author_name, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at, tags, description)
       VALUES (@world_id, @world_name, @author_name, @created_at, @first_seen_at, @favorites, @occupants, @popularity, @visited, @visited_at, @tags, @description)
       ON CONFLICT(world_id) DO UPDATE SET
         world_name = excluded.world_name,
         favorites = excluded.favorites,
         occupants = excluded.occupants,
         popularity = excluded.popularity,
         visited = excluded.visited,
         visited_at = excluded.visited_at,
         tags = excluded.tags,
         description = excluded.description`
    );
    const markVisited = storage.db.prepare(
      `UPDATE new_worlds SET visited = 1, visited_at = @visited_at
       WHERE world_id = @world_id AND visited = 0`
    );

    const tx = storage.db.transaction(() => {
      for (const w of toAdd) {
        upsert.run({
          world_id: w.id,
          world_name: w.name || '',
          author_name: w.authorName || '',
          created_at: w.created_at || null,
          first_seen_at: now,
          favorites: w.favorites || 0,
          occupants: w.occupants || 0,
          popularity: w.popularity || 0,
          visited: visited.has(w.id) ? 1 : 0,
          visited_at: visited.has(w.id) ? now : null,
          tags: Array.isArray(w.tags) ? JSON.stringify(w.tags) : '',
          description: w.description || '',
        });
        written++;
      }
      for (const w of fresh) {
        if (visited.has(w.id)) {
          const r = markVisited.run({ world_id: w.id, visited_at: now });
          if (r.changes > 0) updated++;
        }
      }
    });

    tx();
  }

  const recommended = [...unvisited]
    .sort((a, b) => worldScore(b) - worldScore(a))
    .slice(0, 10)
    .map(w => ({
      name: w.name,
      id: w.id,
      created: (w.created_at || '').slice(0, 10),
      favorites: w.favorites || 0,
      occupants: w.occupants || 0,
      popularity: w.popularity || 0,
      author: w.authorName,
      tags: (w.tags || []).filter(t => t.startsWith('author_tag_')).map(t => t.replace('author_tag_', '')),
    }));

  return {
    days,
    dryRun,
    collected: fresh.length,
    unvisited: unvisited.map(w => w.name),
    visited: visitedFresh.map(w => w.name),
    newlyTracked: toAdd.map(w => w.name),
    alreadyTracked: alreadyTracked.map(w => w.name),
    recommended,
  };
}

function handleGetNewWorlds({ onlyUnvisited = false, limit = 10, sortBy = 'favorites' }) {
  if (!['favorites', 'occupants', 'popularity', 'created_at'].includes(sortBy)) sortBy = 'favorites';
  limit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

  const total = storage._query(
    `SELECT COUNT(*) AS cnt FROM new_worlds${onlyUnvisited ? ' WHERE visited = 0' : ''}`
  )[0].cnt;

  const rows = storage._query(
    `SELECT world_id, world_name, author_name, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at
     FROM new_worlds
     ${onlyUnvisited ? 'WHERE visited = 0' : ''}
     ORDER BY ${sortBy} DESC
     LIMIT ${limit}`
  );

  const worlds = rows.map(r => ({
    worldId: r.world_id,
    worldName: r.world_name,
    authorName: r.author_name,
    created: r.created_at,
    firstSeen: r.first_seen_at,
    favorites: r.favorites,
    occupants: r.occupants,
    popularity: r.popularity,
    visited: r.visited === 1,
    visitedAt: r.visited_at,
  }));

  return { total, worlds };
}

function handleGetWatchlist() {
  return { watchlist: storage.getWatchlist() };
}

function handleAddToWatchlist({ userId, displayName, priority = 1 }) {
  storage.addToWatchlist(userId, displayName, priority);
  storage.save();
  _invalidateWatchlistCache();
  return { success: true, userId, priority };
}

function handleRemoveFromWatchlist({ userId }) {
  storage.removeFromWatchlist(userId);
  storage.save();
  _invalidateWatchlistCache();
  return { success: true, userId };
}

// ── 新增：同屏好友查询 ──

function handleGetCompanions({ startTime, endTime, userId }) {
  const targetUserId = userId || serverState.authUser?.id;
  if (!targetUserId) throw new Error('No userId provided and not authenticated');
  return storage.findCompanions(targetUserId, startTime, endTime);
}

// ── 新增：好友上线规律分析 ──

function handleGetOnlinePattern({ userId, days, startTime, endTime }) {
  if (!userId) throw new Error('userId is required');
  const opts = {};
  if (startTime && endTime) {
    opts.startTime = startTime;
    opts.endTime = endTime;
  } else if (days !== undefined && days !== null) {
    opts.days = days;
  }
  return storage.getOnlinePattern(userId, opts);
}

// ── 新增：昵称映射 ──

function handleGetNicknames({ userId, query }) {
  return { nicknames: storage.getNicknames({ userId, query }) };
}

function handleSetNickname({ userId, nickname, displayName }) {
  if (!userId) throw new Error('userId is required');
  if (!nickname) throw new Error('nickname is required');
  const result = storage.setNickname({ userId, nickname, displayName });
  storage.save();
  return result;
}

// ── 新增：group 查询工具 ──

async function handleGetUserGroups({ userId, withDetails }) {
  let targetId = userId;
  if (!targetId) {
    targetId = serverState.authUser?.id;
    if (!targetId) {
      const r = await api._request('GET', '/auth/user');
      if (r.status !== 200) throw new Error(`API error: ${r.status}`);
      targetId = r.data?.id;
    }
  }
  if (!targetId) throw new Error('Unable to determine target user id');
  const r = await api._request('GET', `/users/${targetId}/groups`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const groups = (r.data || []).map((g) => {
    const item = {};
    if (g.groupId !== undefined && g.groupId !== null) item.groupId = g.groupId;
    if (g.name !== undefined && g.name !== null) item.name = g.name;
    if (g.shortCode !== undefined && g.shortCode !== null) item.shortCode = g.shortCode;
    if (g.memberCount !== undefined && g.memberCount !== null) item.memberCount = g.memberCount;
    if (g.isVerified !== undefined && g.isVerified !== null) item.isVerified = g.isVerified;
    if (g.myRank !== undefined && g.myRank !== null) {
      item.myRank = typeof g.myRank === 'object' ? (g.myRank.id || null) : g.myRank;
    }
    return item;
  });
  if (withDetails && groups.length > 0) {
    const CONCURRENCY = 5;
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, groups.length) }, async () => {
      while (idx < groups.length) {
        const i = idx++;
        const g = groups[i];
        try {
          const d = await api._request('GET', `/groups/${g.groupId}`);
          if (d.status === 200 && d.data) {
            if (d.data.description) g.description = d.data.description;
            if (d.data.isVerified !== undefined && d.data.isVerified !== null) g.isVerified = d.data.isVerified;
          }
        } catch (e) { /* 单群失败忽略 */ }
      }
    });
    await Promise.all(workers);
  }
  return { userId: targetId, count: groups.length, groups };
}

async function handleGetGroupInfo({ groupId, includeAnnouncement }) {
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const d = r.data;
  const result = { groupId: d.id };
  if (d.name !== undefined && d.name !== null) result.name = d.name;
  if (d.shortCode !== undefined && d.shortCode !== null) result.shortCode = d.shortCode;
  if (d.memberCount !== undefined && d.memberCount !== null) result.memberCount = d.memberCount;
  if (d.isVerified !== undefined && d.isVerified !== null) result.isVerified = d.isVerified;
  if (d.description !== undefined && d.description !== null) result.description = d.description;
  if (d.discordId !== undefined && d.discordId !== null) result.discordId = d.discordId;
  if (d.bannerId !== undefined && d.bannerId !== null) result.bannerId = d.bannerId;
  if (d.tags !== undefined && d.tags !== null) result.tags = d.tags;
  if (d.joinState !== undefined && d.joinState !== null) result.joinState = d.joinState;
  if (d.allowGroupJoinPrompt !== undefined && d.allowGroupJoinPrompt !== null) result.allowGroupJoinPrompt = d.allowGroupJoinPrompt;
  if (includeAnnouncement) {
    try {
      const a = await api._request('GET', `/groups/${groupId}/announcement`);
      if (a.status === 200 && a.data && typeof a.data === 'object' && a.data.text) {
        result.announcement = {
          id: a.data.id, title: a.data.title, text: a.data.text,
          authorId: a.data.authorId, createdAt: a.data.createdAt,
          updatedAt: a.data.updatedAt, visibility: a.data.visibility,
        };
      } else {
        result.announcement = null;
      }
    } catch (e) {
      result.announcement = null;
    }
  }
  return result;
}

async function handleGetGroupInstances({ groupId }) {
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}/instances`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const instances = (r.data || []).map((inst) => ({
    instanceId: inst.instanceId,
    location: inst.location,
    memberCount: inst.memberCount,
    worldId: inst.world?.id || null,
    worldName: inst.world?.name || null,
    worldAuthor: inst.world?.authorName || null,
    worldCapacity: inst.world?.capacity || null,
    worldImageUrl: inst.world?.imageUrl || null,
  }));
  return { groupId, count: instances.length, instances };
}

async function handleGetGroupAnnouncement({ groupId }) {
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}/announcement`);
  if (r.status !== 200) {
    if (r.status === 403 || r.status === 404) return { groupId, announcement: null };
    throw new Error(`API error: ${r.status}`);
  }
  const d = r.data;
  if (!d || typeof d !== 'object' || !d.text) {
    return { groupId, announcement: null };
  }
  return {
    groupId,
    announcement: {
      id: d.id,
      title: d.title,
      text: d.text,
      authorId: d.authorId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      visibility: d.visibility,
      imageUrl: d.imageUrl,
    },
  };
}

async function handleSearchGroups({ query, n }) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const limit = Math.min(Math.max(parseInt(n, 10) || 30, 1), 100);
  const r = await api._request('GET', `/groups?query=${encodeURIComponent(query)}&n=${limit}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const groups = (r.data || []).map((g) => {
    const item = {};
    if (g.id !== undefined && g.id !== null) item.groupId = g.id;
    if (g.name !== undefined && g.name !== null) item.name = g.name;
    if (g.shortCode !== undefined && g.shortCode !== null) item.shortCode = g.shortCode;
    if (g.memberCount !== undefined && g.memberCount !== null) item.memberCount = g.memberCount;
    if (g.isVerified !== undefined && g.isVerified !== null) item.isVerified = g.isVerified;
    if (g.description !== undefined && g.description !== null) item.description = g.description;
    return item;
  });
  return { query, count: groups.length, groups };
}

async function handleSearchWorlds({ query, n }) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const limit = Math.min(Math.max(parseInt(n, 10) || 10, 1), 30);
  const apiWorlds = [];
  try {
    const r = await api._request('GET', `/worlds?search=${encodeURIComponent(query)}&n=${limit}`);
    if (r.status === 200) {
      for (const w of (r.data || [])) {
        apiWorlds.push({
          worldId: w.id,
          name: w.name,
          authorName: w.authorName,
          capacity: w.capacity,
          imageUrl: w.imageUrl,
          description: (w.description || '').slice(0, 200),
        });
      }
    }
  } catch (e) { /* API 失败时仅用本地结果 */ }

  const local = storage.searchWorldsByName(query);

  // 合并：API 结果优先（完整信息），本地补充（可能命中 API 搜不到的）
  const seen = new Set(apiWorlds.map(w => w.worldId));
  const merged = [...apiWorlds];
  for (const lw of local) {
    if (!seen.has(lw.worldId)) {
      seen.add(lw.worldId);
      merged.push({ worldId: lw.worldId, name: lw.name });
    }
  }
  return { query, apiCount: apiWorlds.length, localCount: local.length, count: merged.length, worlds: merged };
}

async function handleBackupDatabase() {
  try {
    const result = await backupDatabase(storage.db, BACKUP_DIR);
    log(`💾 手动备份完成: ${result.path} (${result.size} bytes)`);
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function handleJoinGroup({ groupId }) {
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('POST', `/groups/${groupId}/join`);
  if (r.status === 200 && r.data) {
    return { groupId, joined: true, membership: r.data.membershipId ? { membershipId: r.data.membershipId } : undefined };
  }
  if (r.status === 400 && typeof r.data?.error?.message === 'string' && r.data.error.message.includes('already a member')) {
    return { groupId, joined: false, alreadyMember: true };
  }
  throw new Error(`API error: ${r.status}`);
}

async function handleLeaveGroup({ groupId, confirm }) {
  if (!groupId) throw new Error('groupId is required');
  if (confirm !== true) {
    return { groupId, confirmRequired: true, message: 'Leaving a group removes you from it. Pass confirm: true to actually leave.' };
  }
  // 自己退出用 POST /groups/{id}/leave；DELETE /members/{userId} 是管理员移除成员（普通成员 403，实测 2026-08-09）
  const r = await api._request('POST', `/groups/${groupId}/leave`);
  if (r.status === 200) return { groupId, left: true };
  // 403 = 不是成员/群不存在（实测：POST leave 对无效群返回 403 而非 404）
  if (r.status === 403 || r.status === 404 || r.status === 400) return { groupId, left: false, notMember: true };
  throw new Error(`API error: ${r.status}`);
}

async function handlePeekGroupAnnouncement({ groupId, confirm }) {
  if (!groupId) throw new Error('groupId is required');
  if (confirm !== true) {
    return { groupId, confirmRequired: true, message: 'This auto-joins the group, reads its announcement, then leaves (members see the join feed). Pass confirm: true to proceed.' };
  }
  const g = await api._request('GET', `/groups/${groupId}`);
  if (g.status !== 200) throw new Error(`API error: ${g.status}`);
  const joinState = g.data?.joinState;
  if (joinState !== 'open') {
    return { groupId, joinState: joinState || 'unknown', peekable: false,
             message: joinState === 'request' ? 'Group requires request/approval - cannot auto-join.' :
                      joinState === 'invite' ? 'Group is invite-only - cannot auto-join.' : 'Group join state unknown.' };
  }
  let joinedNow = false;
  const j = await api._request('POST', `/groups/${groupId}/join`);
  if (j.status === 200) joinedNow = true;
  else if (!(j.status === 400 && typeof j.data?.error?.message === 'string' && j.data.error.message.includes('already a member'))) {
    throw new Error(`join failed: ${j.status}`);
  }
  try {
    const a = await api._request('GET', `/groups/${groupId}/announcement`);
    let announcement = null;
    if (a.status === 200 && a.data && typeof a.data === 'object' && a.data.text) {
      announcement = {
        id: a.data.id, title: a.data.title, text: a.data.text,
        authorId: a.data.authorId, createdAt: a.data.createdAt,
        updatedAt: a.data.updatedAt, visibility: a.data.visibility,
      };
    }
    return { groupId, joinState, peekable: true, joinedNow, announcement };
  } finally {
    // 4. 无论公告读取成功与否，刚加入就退出（POST leave，2026-08-09 实测正确端点）
    if (joinedNow) {
      try { await api._request('POST', `/groups/${groupId}/leave`); } catch (e) { /* 退出失败忽略 */ }
    }
  }
}

// ── 新增：boop emoji 工具 ──

function handleGetBoopEmojis() {
  const categories = [
    {
      name: '表情',
      names: ['Angry', 'Blushing', 'Crying', 'Frown', 'Hand Wave', 'Hang Ten', 'In Love', 'Jack O Lantern', 'Kiss', 'Laugh', 'Skull', 'Smile', 'Spooky Ghost', 'Stoic', 'Sunglasses', 'Thinking', 'Thumbs Down', 'Thumbs Up', 'Tongue Out', 'Wow'],
    },
    {
      name: '指令',
      names: ['Arrow Point', "Can't see", 'Hourglass', 'Keyboard', 'No Headphones', 'No Mic', 'Portal', 'Shush'],
    },
    {
      name: '季节/装饰',
      names: ['Bats', 'Cloud', 'Fire', 'Snow Fall', 'Snowball', 'Splash', 'Web', 'Beer', 'Candy', 'Candy Cane', 'Candy Corn', 'Champagne', 'Drink', 'Gingerbread', 'Ice Cream', 'Pineapple', 'Pizza', 'Tomato', 'Beachball', 'Coal', 'Confetti', 'Gift', 'Gifts', 'Life Ring', 'Mistletoe', 'Money', 'Neon Shades', 'Sun Lotion'],
    },
    {
      name: '通用',
      names: ['Boo', 'Broken Heart', 'Exclamation', 'Go', 'Heart', 'Music Note', 'Question', 'Stop', 'Zzz'],
    },
  ];

  const emojis = [];
  for (const category of categories) {
    for (const name of category.names) {
      emojis.push({
        name,
        emojiId: `default_${name.replace(/ /g, '_').toLowerCase()}`,
        category: category.name,
      });
    }
  }

  return {
    builtinCount: emojis.length,
    format: 'default_<name_lowercase_underscores> (e.g. "Hand Wave" -> default_hand_wave)',
    emojis,
    custom: {
      endpoint: 'POST /file/image (tag: emoji)',
      requiresVRCPlus: true,
      note: '自定义 emoji 用 upload_emoji 工具上传，返回 fileId 用作 emojiId',
    },
  };
}

async function handleUploadEmoji({ imagePath, animated = false, animationStyle }) {
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const tag = animated ? 'emojianimated' : 'emoji';
  const params = { tag, maskTag: 'square', animationStyle: (animationStyle || 'stop').toLowerCase() };

  const r = await api.uploadImageFile(fileBuffer, imagePath, params);
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const fileId = r.data?.id;
  if (!fileId) {
    throw new Error(`API 未返回 fileId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, fileId, emojiId: fileId, tag, requiresVRCPlus: true };
}

async function handleUploadPrint({ imagePath, note }) {
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const timestamp = new Date().toISOString().slice(0, 19);
  const r = await api.uploadPrint(fileBuffer, imagePath, { note, timestamp });
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const printId = r.data?.id;
  if (!printId) {
    throw new Error(`API 未返回 printId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, printId, note, timestamp };
}

async function handleUploadGalleryImage({ imagePath }) {
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const r = await api.uploadGalleryImage(fileBuffer, imagePath);
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const fileId = r.data?.id;
  if (!fileId) {
    throw new Error(`API 未返回 fileId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, fileId, tag: 'gallery' };
}

// ── 新增：prints / gallery 列表与删除工具 ──

async function handleGetPrints({ limit = 100, userId }) {
  let targetId = userId;
  if (!targetId) {
    const r = await api._request('GET', '/auth/user');
    if (r.status !== 200) throw new Error(`API error: ${r.status}`);
    targetId = r.data?.id;
  }
  if (!targetId) throw new Error('Unable to determine current user');

  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/prints/user/${targetId}?n=${n}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const prints = Array.isArray(r.data) ? r.data : [];
  return {
    userId: targetId,
    total: prints.length,
    prints: prints.map(p => ({
      printId: p.id,
      note: p.note,
      createdAt: p.createdAt,
      downloadUrl: p.files?.image,
      timestamp: p.timestamp,
      worldId: p.worldId,
      worldName: p.worldName,
      authorName: p.authorName,
    })),
  };
}

async function handleRemovePrint({ printId, confirm }) {
  if (!printId) throw new Error('printId is required');
  if (!confirm) {
    return { printId, confirmRequired: true, message: '删除相册照片不可逆，请传 confirm: true 确认执行' };
  }
  const r = await api._request('DELETE', `/prints/${printId}`);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { printId, ok: true };
}

async function handleGetGalleryImages({ limit = 100 }) {
  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/files?tag=gallery&n=${n}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const images = Array.isArray(r.data) ? r.data : [];
  return {
    total: images.length,
    images: images.map(img => {
      const lastVersion = img.versions?.[img.versions.length - 1];
      return {
        fileId: img.id,
        name: img.name,
        extension: img.extension,
        mimeType: img.mimeType,
        downloadUrl: lastVersion?.file?.url,
      };
    }),
  };
}

async function handleRemoveGalleryImage({ fileId, confirm }) {
  if (!fileId) throw new Error('fileId is required');
  if (!confirm) {
    return { fileId, confirmRequired: true, message: '删除图库图片不可逆，请传 confirm: true 确认执行' };
  }
  const r = await api._request('DELETE', `/file/${fileId}`);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { fileId, ok: true };
}

// ── 新增：下载 prints / gallery 图片 ──

function _extFromContentType(contentType, url) {
  if (contentType) {
    if (contentType.includes('image/png')) return 'png';
    if (contentType.includes('image/jpeg')) return 'jpg';
    if (contentType.includes('image/jpg')) return 'jpg';
    if (contentType.includes('image/gif')) return 'gif';
    if (contentType.includes('image/webp')) return 'webp';
    if (contentType.includes('image/bmp')) return 'bmp';
  }
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (match) return match[1].toLowerCase();
  } catch {}
  return 'png';
}

async function handleDownloadPrint({ printId, outputDir }) {
  if (!printId) throw new Error('printId is required');

  const user = await api.ensureAuth();
  const userId = user?.id;
  if (!userId) throw new Error('Unable to determine current user');

  const r = await api._request('GET', `/prints/user/${userId}?n=100`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const prints = Array.isArray(r.data) ? r.data : [];
  const print = prints.find(p => p.id === printId);
  if (!print) throw new Error(`未找到 printId: ${printId}`);

  const url = print.files?.image;
  if (!url) throw new Error(`未找到 printId: ${printId} 的图片 URL`);

  const buffer = await api.downloadFile(url);

  const ext = _extFromContentType(buffer.contentType, url);
  const dir = outputDir || path.join(__dirname, 'downloads');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `print_${printId}.${ext}`);
  writeFileSync(filePath, buffer);

  return { ok: true, printId, path: filePath, sizeBytes: buffer.length, url };
}

async function handleDownloadGalleryImage({ fileId, outputDir }) {
  if (!fileId) throw new Error('fileId is required');

  const r = await api._request('GET', `/files?tag=gallery&n=100`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const images = Array.isArray(r.data) ? r.data : [];
  const image = images.find(img => img.id === fileId);
  if (!image) throw new Error(`未找到 fileId: ${fileId}`);

  const lastVersion = image.versions?.[image.versions.length - 1];
  const url = lastVersion?.file?.url;
  if (!url) throw new Error(`未找到 fileId: ${fileId} 的图片 URL`);

  const buffer = await api.downloadFile(url);

  const ext = _extFromContentType(buffer.contentType, url);
  const dir = outputDir || path.join(__dirname, 'downloads');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `gallery_${fileId}.${ext}`);
  writeFileSync(filePath, buffer);

  return { ok: true, fileId, path: filePath, sizeBytes: buffer.length, url };
}

// ── RPC 处理 ──

async function handleRpc(rpc, session, res) {
  const { id, method, params } = rpc;

  switch (method) {
    case 'initialize': {
      session.initialized = true;
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'vrc-monitor', version: '1.0.0' },
        },
      }], session.id);
      break;
    }

    case 'notifications/initialized':
      sendSSE(res, [], session.id);
      break;

    case 'tools/list': {
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: { tools: CUSTOM_TOOLS },
      }], session.id);
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        let result;

        switch (name) {
          // 写工具（依赖 api client，经限流器）
          case 'send_boop': {
            const r = await rateLimiter.execute(() => api.sendBoop(args.userId, args.emojiId || ''));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, booped: true };
            break;
          }
          case 'get_boop_emojis': {
            result = await rateLimiter.execute(() => handleGetBoopEmojis());
            break;
          }
          case 'upload_emoji': {
            result = await rateLimiter.execute(() => handleUploadEmoji(args));
            break;
          }
          case 'upload_print': {
            result = await rateLimiter.execute(() => handleUploadPrint(args));
            break;
          }
          case 'upload_gallery_image': {
            result = await rateLimiter.execute(() => handleUploadGalleryImage(args));
            break;
          }
          case 'get_prints': {
            result = await rateLimiter.execute(() => handleGetPrints(args));
            break;
          }
          case 'remove_print': {
            result = await rateLimiter.execute(() => handleRemovePrint(args));
            break;
          }
          case 'get_gallery_images': {
            result = await rateLimiter.execute(() => handleGetGalleryImages(args));
            break;
          }
          case 'remove_gallery_image': {
            result = await rateLimiter.execute(() => handleRemoveGalleryImage(args));
            break;
          }
          case 'download_print': {
            result = await rateLimiter.execute(() => handleDownloadPrint(args));
            break;
          }
          case 'download_gallery_image': {
            result = await rateLimiter.execute(() => handleDownloadGalleryImage(args));
            break;
          }
          case 'send_invite': {
            await rateLimiter.execute(() => api.ensureAuth());
            const body = { instanceId: `${args.worldId}:${args.instanceId}` };
            if (args.message) body.message = args.message;
            const r = await rateLimiter.execute(() => api._request('POST', `/invite/${args.userId}`, body));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, invited: true };
            break;
          }
          case 'request_invite': {
            await rateLimiter.execute(() => api.ensureAuth());
            const r = await rateLimiter.execute(() => api._request('POST', `/requestInvite/${args.userId}`, {
              message: args.message || 'Can I join you?',
              platform: 'standalonewindows',
            }));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, requestSent: true };
            break;
          }
          case 'create_instance': {
            result = await rateLimiter.execute(() => handleCreateInstance(args));
            break;
          }
          case 'invite_myself': {
            result = await rateLimiter.execute(() => handleInviteMyself(args));
            break;
          }
          case 'open_world': {
            result = await rateLimiter.execute(() => handleOpenWorld(args));
            break;
          }
          case 'send_friend_request': {
            result = await rateLimiter.execute(() => handleSendFriendRequest(args));
            break;
          }
          case 'remove_friend': {
            result = await rateLimiter.execute(() => handleRemoveFriend(args));
            break;
          }
          // 读工具
          case 'get_online_friends':
            result = await rateLimiter.execute(handleGetOnlineFriends);
            break;
          case 'get_friend_info':
            result = await rateLimiter.execute(() => handleGetFriendInfo(args));
            break;
          case 'get_mutual_friends':
            result = await rateLimiter.execute(() => handleGetMutualFriends(args));
            break;
          case 'search_users':
            result = await rateLimiter.execute(() => handleSearchUsers(args));
            break;
          case 'get_database_stats':
            result = handleGetDatabaseStats();
            break;
          case 'get_server_status':
            result = handleGetServerStatus();
            break;
          // Phase 4 新工具
          case 'get_friend_events':
            result = await handleGetFriendEvents(args);
            break;
          case 'get_recent_events':
            result = handleGetRecentEvents(args);
            break;
          case 'get_world_name':
            result = await rateLimiter.execute(() => handleGetWorldName(args));
            break;
          case 'set_world_note':
            result = handleSetWorldNote(args);
            break;
          case 'get_world_history':
            result = handleGetWorldHistory(args);
            break;
          case 'get_weekly_report':
            result = await rateLimiter.execute(() => handleGetWeeklyReport(args));
            break;
          case 'scan_new_worlds':
            // 不包 rateLimiter：handleScanNewWorlds 内部 fetchFreshWorlds 已逐请求限流
            // （再包一层会嵌套死锁：外层占队列时内层 _processQueue 不执行）
            result = await handleScanNewWorlds(args);
            break;
          case 'get_new_worlds':
            result = handleGetNewWorlds(args);
            break;
          case 'get_watchlist':
            result = handleGetWatchlist();
            break;
          case 'add_to_watchlist':
            result = handleAddToWatchlist(args);
            break;
          case 'remove_from_watchlist':
            result = handleRemoveFromWatchlist(args);
            break;
          case 'get_companions':
            result = handleGetCompanions(args);
            break;
          case 'get_online_pattern':
            result = handleGetOnlinePattern(args);
            break;
          case 'get_nicknames':
            result = handleGetNicknames(args);
            break;
          case 'set_nickname':
            result = handleSetNickname(args);
            break;
          case 'get_user_groups':
            result = await rateLimiter.execute(() => handleGetUserGroups(args));
            break;
          case 'get_group_info':
            result = await rateLimiter.execute(() => handleGetGroupInfo(args));
            break;
          case 'get_group_instances':
            result = await rateLimiter.execute(() => handleGetGroupInstances(args));
            break;
          case 'get_group_announcement':
            result = await rateLimiter.execute(() => handleGetGroupAnnouncement(args));
            break;
          case 'search_groups':
            result = await rateLimiter.execute(() => handleSearchGroups(args));
            break;
          case 'search_worlds':
            result = await rateLimiter.execute(() => handleSearchWorlds(args));
            break;
          case 'backup_database':
            result = await handleBackupDatabase();
            break;
          case 'join_group':
            result = await rateLimiter.execute(() => handleJoinGroup(args));
            break;
          case 'leave_group':
            result = await rateLimiter.execute(() => handleLeaveGroup(args));
            break;
          case 'peek_group_announcement':
            result = await rateLimiter.execute(() => handlePeekGroupAnnouncement(args));
            break;
          case 'get_favorite_friends_locations':
            result = await handleGetFavoriteFriendsLocations(args);
            break;
          case 'recommend_join':
            result = await handleRecommendJoin(args);
            break;
          case 'set_join_preference':
            result = await handleSetJoinPreference(args);
            break;
          case 'get_join_preference':
            result = await handleGetJoinPreference();
            break;
          case 'record_join_choice':
            result = await handleRecordJoinChoice(args);
            break;
          case 'get_join_learning':
            result = await handleGetJoinLearning();
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        sendSSE(res, [{
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        }]);
      } catch (err) {
        log(`❌ ${name} failed: ${err.message}`);
        sendError(res, id, err.message);
      }
      break;
    }

    default:
      sendSSE(res, [], session.id);
  }
}

// ── HTTP 服务 ──

function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      log(`❌ Unhandled: ${err.message}`);
      if (!res.headersSent) {
        try { res.writeHead(502); res.end(err.message); } catch {}
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    }
  });

  // 端口冲突不直接 crash
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`❌ 端口 ${PORT} 已被占用，请检查是否有旧进程残留`);
    } else {
      log(`❌ 服务器错误: ${err.message}`);
    }
  });

  return server;
}

async function handleRequest(req, res) {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    const uptime = serverState.started ? Math.floor((Date.now() - serverState.started) / 1000) : 0;
    const status = {
      ok: true,
      auth: serverState.authUser
        ? { authenticated: true, user: serverState.authUser }
        : { authenticated: false, needsOtp: serverState.needsOtp },
      db: storage.getStats(),
      rateLimiter: rateLimiter.getStats(),
      ws: wsManager?.getState(),
      friendState: friendState?.getStats(),
      eventPipeline: eventPipeline?.getStats(),
      uptime,
    };
    const body = JSON.stringify(status, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // MCP endpoint probe
  if (req.method === 'GET' && req.url === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Content-Length': 0 });
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', async () => {
    try {
      const rpc = JSON.parse(body);
      const sessionId = req.headers['mcp-session-id'];
      const session = getOrCreateSession(sessionId);
      log(`MCP ${rpc.method || '?'} ${body.slice(0, 60)}...`);
      await handleRpc(rpc, session, res);
    } catch (err) {
      log(`Parse error: ${err.message}`);
      sendError(res, null, 'Parse error: ' + err.message);
    }
  });
}

// ── OTP 邮箱获取 ──

async function fetchOtpFromEmail() {
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

// ── 启动 ──

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  VRChat 好友监控系统 v1.0');
  console.log('  Phase 1 — 基础设施');
  console.log('══════════════════════════════════════════════\n');

  serverState.started = new Date().toISOString();

  // 1. 初始化数据库
  log('📦 初始化数据库...');
  storage = new Storage();
  await storage.init(DB_PATH);
  const stats = storage.getStats();
  log(`   ✅ 数据库就绪: ${DB_PATH}`);
  log(`   📊 事件: ${stats.events} 条 | 好友: ${stats.friends} 位 | 世界缓存: ${stats.world_cache} 个`);
  _refreshWatchlistCache();  // 初始化 watchlist 内存缓存

  // 2. 初始化 API 客户端
  log('\n🔑 初始化 API 客户端...');
  if (!existsSync(CRED_FILE)) {
    console.error('\n❌ 未找到 credentials.json — 无法登录 VRChat');
    console.error('');
    console.error('   请先完成配置：');
    console.error(`   1. 复制 credentials.example.json 为 credentials.json`);
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
  api = new VrchatApiClient(creds.email, creds.password);
  api.loadCookieFromFile(COOKIE_FILE);
  try {
    const user = await api.ensureAuthWithAutoOtp(fetchOtpFromEmail);
    serverState.authUser = { id: user.id, displayName: user.displayName };
    serverState.needsOtp = false;
    log(`   ✅ 已登录: ${user.displayName} (${user.id})`);
    api.saveCookieToFile(COOKIE_FILE);
  } catch (err) {
    serverState.needsOtp = false;
    log(`   ❌ 登录失败: ${err.message}`);
    // 不退出进程，让 MCP/WS 服务启动以便后续重试
  }

  // 3. 初始化限流器
  rateLimiter = new RateLimiter({ minInterval: 2600 });
  log(`\n⏱  限流器: 间隔 ${rateLimiter.minInterval}ms`);

  // 4. 初始化好友状态管理器
  friendState = new FriendStateManager();
  log(`\n👥 好友状态管理器就绪`);

  // 5. 初始化事件处理管道
  eventPipeline = new EventPipeline(storage, null);
  log(`📨 事件处理管道就绪`);

  // 6. 启动 WebSocket
  log('\n🔌 启动 WebSocket 连接...');
  wsManager = new WsManager({
    apiClient: api,
    otpFetcher: fetchOtpFromEmail,
    onEvent: async (event) => {
      try {
        await eventPipeline.process(event);
        await _updateFriendState(event);
        
        // 核心关注好友活动日志（从内存缓存读取，不查 DB）
        if (_watchlistDirty) _refreshWatchlistCache();
        const isWatched = _watchlistCache.some(w => w.user_id === event.userId);
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
        api.checkAuth().then((res) => {
          if (res.valid) {
            serverState.authUser = { id: res.user.id, displayName: res.displayName };
          }
        }).catch((err) => {
          log(`⚠️ 认证复查失败: ${err.message}`);
        });
      }
    },
  });
  wsManager.start();

  // 7b. 数据库自动备份：启动时立即做一次 + 每 24h 一次（保留最近 2 份）
  const runAutoBackup = async () => {
    try {
      const r = await backupDatabase(storage.db, BACKUP_DIR);
      log(`💾 自动备份完成: ${r.path} (${r.size} bytes)`);
    } catch (e) {
      log(`⚠️ 自动备份失败: ${e.message}`);
    }
  };
  runAutoBackup();
  setInterval(runAutoBackup, BACKUP_INTERVAL_MS);

  // 7. 启动 MCP 服务
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
  if (eventPipeline) eventPipeline.flush();
  if (storage) storage.save();
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
