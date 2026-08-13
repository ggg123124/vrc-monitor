/**
 * RPC 路由 — MCP tools/call 分发
 *
 * handleRpc 接收 JSON-RPC 请求，分发到对应 handler。
 * 3 个内联 case（send_boop / send_invite / request_invite）直接访问 ctx.api + ctx.rateLimiter。
 */

import { ctx, log } from './server-context.js';
import { CUSTOM_TOOLS } from './mcp-definitions.js';
import { sendSSE, sendError } from './http-server.js';

// Handler imports
import {
  handleGetFavoriteFriendsLocations,
  handleRecommendJoin,
  handleSetJoinPreference,
  handleGetJoinPreference,
  handleRecordJoinChoice,
  handleGetJoinLearning,
} from './handlers/recommend.js';

import {
  handleGetOnlineFriends,
  handleGetFriendInfo,
  handleSearchUsers,
  handleGetMutualFriends,
  handleSendFriendRequest,
  handleRemoveFriend,
} from './handlers/friends.js';

import {
  handleCreateInstance,
  handleInviteMyself,
  handleOpenWorld,
} from './handlers/instance.js';

import {
  handleGetFriendEvents,
  handleGetRecentEvents,
  handleGetWorldName,
  handleSetWorldNote,
  handleGetWorldHistory,
  handleGetWeeklyReport,
} from './handlers/events.js';

import {
  handleGetUserGroups,
  handleGetGroupInfo,
  handleGetGroupInstances,
  handleGetGroupAnnouncement,
  handleGetGroupHeat,
  handleSearchGroups,
  handleSearchWorlds,
  handleJoinGroup,
  handleLeaveGroup,
  handlePeekGroupAnnouncement,
} from './handlers/groups.js';

import {
  handleGetBoopEmojis,
  handleUploadEmoji,
  handleUploadPrint,
  handleUploadGalleryImage,
  handleGetPrints,
  handleRemovePrint,
  handleGetGalleryImages,
  handleRemoveGalleryImage,
  handleDownloadPrint,
  handleDownloadGalleryImage,
} from './handlers/media.js';

import {
  handleGetDatabaseStats,
  handleGetServerStatus,
  handleScanNewWorlds,
  handleGetNewWorlds,
  handleGetWatchlist,
  handleAddToWatchlist,
  handleRemoveFromWatchlist,
  handleGetCompanions,
  handleGetOnlinePattern,
  handleGetNicknames,
  handleSetNickname,
  handleBackupDatabase,
} from './handlers/misc.js';

export async function handleRpc(rpc, session, res) {
  const { id, method, params } = rpc;
  const { api, rateLimiter } = ctx;

  switch (method) {
    case 'initialize': {
      session.initialized = true;
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'vrc-monitor', version: '1.14.0' },
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
          // 事件历史与相关工具
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
          case 'get_group_heat':
            result = await rateLimiter.execute(() => handleGetGroupHeat(args));
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
