/**
 * MCP 工具定义 — name + description + inputSchema
 *
 * 纯数据模块，无运行时依赖。
 * start-monitor.js 导入后在 tools/list 和启动校验中使用。
 */

export const CUSTOM_TOOLS = [
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
        excludeTheme: { type: 'string', description: 'Comma-separated theme keywords to exclude (matched against author tags, e.g. "game,horror,dance")' },
      },
    },
  },
{
    name: 'rate_world',
    description: '[action] Rate a world as good/junk for recommendation feedback (Issue #19). rating=1 good (weighted up), -1 junk (weighted down/excluded), 0 clear.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'VRChat world ID (wrld_...)' },
        rating: { type: 'number', enum: [-1, 0, 1], description: '-1=junk, 0=clear, 1=good' },
      },
      required: ['worldId', 'rating'],
    },
  },
{
    name: 'mark_world_visited',
    description: '[action] Explicitly mark a world as visited (Issue #19: event-driven visited can miss). Useful to close the recommend-open-browse loop.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'VRChat world ID (wrld_...)' },
      },
      required: ['worldId'],
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
    name: 'search_planet_worlds',
    description: '[query·地图] Search VRChat worlds on PlanetVRC (planetvrchat.net, Japanese world directory) by keyword. Returns world name, wrld_id (when enriched), platform, categories, favorites/visitors counts. Useful for finding worlds by Japanese/English keywords that the VRChat API search may miss.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword (supports Japanese/English)' },
        limit: { type: 'number', default: 5, description: 'Max results (default 5, max 8; each result fetches its detail page for wrld_id/stats)' },
      },
      required: ['query'],
    },
  },
{
    name: 'recommend_planet_worlds',
    description: '[query·推荐] PlanetVRC world rankings (planetvrchat.net): popular (most visited), new (recently published), or updated. Returns worlds with wrld_id, maxPlayers, visitors, favorites, publishedAt.',
    inputSchema: {
      type: 'object',
      properties: {
        sort: { type: 'string', default: 'popular', description: 'popular | new | updated' },
        limit: { type: 'number', default: 5, description: 'Max results (default 5, max 8)' },
      },
    },
  },
{
    name: 'recommend_worlds',
    description: '[query·推荐] Multi-source world recommendation: fuses local new_worlds + PlanetVRC popularity ranking + official theme search, scored by heat × user feedback × freshness × theme match × author affinity. Returns scored candidates with explainable reasons and canOpen flag (planet cards are resolved to wrld_ ids via official name lookup).',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['sleep', 'chat', 'onsen', 'game', 'default'], default: 'default', description: 'Theme to boost (sleep boosts sleep_ok worlds strongly; other themes boost keyword matches)' },
        excludeTheme: { type: 'string', description: 'Comma-separated themes to exclude (matched against author_tag_* and name/description keywords, e.g. "game,horror")' },
        limit: { type: 'number', default: 5, description: 'Max results (1-10, default 5)' },
        sources: { type: 'string', default: 'local,planet', description: 'Comma-separated sources: local (new_worlds table), planet (PlanetVRC ranking), official (theme keyword search)' },
        excludeVisited: { type: 'boolean', default: true, description: 'Skip worlds already visited' },
        detail: { type: 'boolean', default: true, description: 'Enrich description/imageUrl/note from world_cache' },
      },
    },
  },
{
    name: 'get_group_heat',
    description: '[query·热度] Group activity heat: rank groups by how much your friends/you were in their group rooms (activityCount, friendCount, worldCount, trendPct vs previous equal window) + day-of-week×hour Beijing-time heatmap for top groups. Data from local event history (supports grp_/gmem_ ids).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', default: 7, description: 'Analyze last N days (Beijing natural days, default 7, max 30)' },
        startTime: { type: 'string', description: 'ISO 8601 start (optional, overrides days)' },
        endTime: { type: 'string', description: 'ISO 8601 end (optional, must pair with startTime)' },
        topK: { type: 'number', default: 5, description: 'Number of top groups to include a heatmap for (default 5, max 10)' },
      },
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
{
    name: 'favorite_world',
    description: '[action·写操作] 把世界加入你的 VRChat 云端收藏夹（POST /favorites，云端写入，调用前请与用户确认）。tag 为收藏分组（worlds0/worlds1/worlds2/worlds3/worlds4，默认 worlds0）。成功后本地 world_cache 标记 favorited=1（供推荐加权）。API 拒绝（如重复收藏）时返回 favorited:false + error，不抛错。',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'VRChat world id (wrld_...)' },
        tag: { type: 'string', description: '收藏夹分组 tag（worlds0/worlds1/worlds2/worlds3/worlds4，默认 worlds0）' },
      },
      required: ['worldId'],
    },
  },
{
    name: 'search_booth_items',
    description: '[query·素材] Search BOOTH (booth.pm, pixiv digital-goods marketplace) for VRChat assets (avatars/clothes/3D models/accessories) by keyword. Returns items with name, price, wishlistCount (收藏数=热度), shop/seller, tags, isSoldOut, images (array of {original, resized, caption} objects — use images[0].original as the cover URL), url. NOTE: download/sales counts are NOT publicly visible on BOOTH (always 0 anonymously). Use wishlistCount as the popularity signal. Detail fetch is rate-limited to 400ms/item.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword (supports Japanese/English, e.g. avatar, VRChat, 衣装, 3Dモデル)' },
        limit: { type: 'number', default: 5, description: 'Max results (default 5, max 10)' },
        detail: { type: 'boolean', default: true, description: 'Enrich each result with detail JSON (wishlistCount/shop/tags) — rate-limited ~400ms/item; set false for fast list-only mode' },
      },
      required: ['query'],
    },
  },
{
    name: 'get_booth_item',
    description: '[query·素材] Get a single BOOTH item detail by item id (booth.pm/ja/items/{id}). Returns name, price, description, tags, images (array of {original, resized, caption} objects — use images[0].original as the cover URL), shop/seller, publishedAt, isSoldOut, wishlistCount (收藏数), variations, url. NOTE: purchase/download counts are not publicly visible (0 anonymously). Results are cached locally (booth_items table): cached:true returns the snapshot without hitting BOOTH; forceRefresh:true bypasses the cache.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'BOOTH item id (numeric, from item URL /ja/items/{id})' },
        forceRefresh: { type: 'boolean', default: false, description: 'Bypass local cache and fetch fresh data from BOOTH' },
      },
      required: ['itemId'],
    },
  },
{
    name: 'get_booth_history',
    description: '[query·素材] List BOOTH items previously queried (local booth_items snapshot cache). Sorted by wishlistCount (热度) or updatedAt; supports minWishlist filter for trend tracking (which items are gaining popularity).',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: { type: 'string', default: 'wishlist', description: 'wishlist (by wishlistCount desc) | updated (by last queried)' },
        limit: { type: 'number', default: 20, description: 'Max results (1-100, default 20)' },
        minWishlist: { type: 'number', default: 0, description: 'Only items with wishlistCount >= this value' },
      },
    },
  },
{
    name: 'get_booth_searches',
    description: '[query·素材] List recent BOOTH search history (query, result item ids, result count, timestamp).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 10, description: 'Max results (1-50, default 10)' },
      },
    },
  },

  // ── X 博主世界推荐（x_world_digest） ──
  {
    name: 'x_world_digest',
    description: '[查询·X推荐] 聚合指定 X 博主近 1/3/7/15/30 天推荐的世界，按收藏数排序输出；收藏/浏览比 ≥ 1/5 的标注为 ⭐重点。可选 refresh=true 先抓取最新推文再查询。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '时间窗口天数：1/3/7/15/30，默认 7', default: 7 },
        highlightRatio: { type: 'number', description: '收藏/浏览比标注阈值，默认 0.2（五分之一）', default: 0.2 },
        limit: { type: 'number', description: '返回条数上限，默认 50', default: 50 },
        creator: { type: 'string', description: '只显示某博主（screen_name）推荐的世界，省略=全部' },
        refresh: { type: 'boolean', description: '是否先抓取博主最新推文再查询，默认 false', default: false },
      },
    },
  },
  {
    name: 'x_scan_creators',
    description: '[查询·X推荐] 立即抓取所有已配置博主的最新推文，提取推荐的世界并查询收藏/浏览数据入库。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'x_creators',
    description: '[查询·X推荐] 列出当前配置的 X 博主清单。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'x_add_creator',
    description: '[配置·X推荐] 添加要追踪的 X 博主（VRChat 世界推荐博主）。screen_name 是 X 用户名（不带 @）。',
    inputSchema: {
      type: 'object',
      properties: {
        screen_name: { type: 'string', description: 'X 用户名，如 fox_yata9（必填）' },
        name: { type: 'string', description: '博主显示名（可选）' },
      },
      required: ['screen_name'],
    },
  },
  {
    name: 'x_remove_creator',
    description: '[配置·X推荐] 移除追踪的 X 博主。',
    inputSchema: {
      type: 'object',
      properties: {
        screen_name: { type: 'string', description: 'X 用户名（不带 @）' },
      },
      required: ['screen_name'],
    },
  },
  {
    name: 'x_worlds',
    description: '[查询·X推荐] 查看已收录的推荐世界列表（调试用）。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数上限，默认 50', default: 50 },
      },
    },
  },
  // ── 我的收藏世界分析 ──
  {
    name: 'get_my_favorite_worlds',
    description: '[查询·收藏] 拉取当前账号收藏的全部世界，按标签分类（Avatar/恐怖/游戏/音乐/社交/拍照/休闲/风景/其他），返回世界名/作者/收藏/浏览/简介/分类。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '每类返回条数上限，默认 500' },
        sortBy: { type: 'string', enum: ['favorites', 'visits', 'name'], description: '排序方式，默认 favorites' },
      },
    },
  },
  {
    name: 'get_my_favorite_groups',
    description: '[查询·收藏] 列出当前账号的世界收藏分组（收藏夹名）。',
    inputSchema: { type: 'object', properties: {} },
  },
];
