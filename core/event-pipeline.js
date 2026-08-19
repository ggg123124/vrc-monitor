/**
 * VRChat 好友监控系统 — 事件处理管道
 * 
 * 将 WebSocket 事件标准化并持久化到 SQLite
 */
export class EventPipeline {
  constructor(storage, worldCache) {
    this.storage = storage;
    this.worldCache = worldCache;
    this._eventCount = 0;
    this._lastSave = Date.now();
    this._flushTimer = null;         // 定时 flush 句柄
    this._flushInterval = 5000;      // 每 5 秒自动持久化
    this._startFlushTimer();
  }

  /** 启动定时 flush */
  _startFlushTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => {
      if (this._eventCount > 0 && (Date.now() - this._lastSave >= this._flushInterval)) {
        this.storage.save();
        this._lastSave = Date.now();
      }
    }, this._flushInterval);
    // 不让定时器阻止进程退出
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  /**
   * 处理一个 WebSocket 事件
   */
  async process(event) {
    this._eventCount++;

    switch (event.type) {
      case 'friend-online':
        return await this._handleOnline(event);
      case 'friend-offline':
        return await this._handleOffline(event);
      case 'friend-location':
        return await this._handleLocation(event);
      case 'user-location':
        // 自己的位置事件：content 无独立 worldId 字段（只有 location 字符串），需解析
        return await this._handleUserLocation(event);
      case 'friend-update':
        return await this._handleUpdate(event);
      case 'friend-active':
        return await this._handleActive(event);
      case 'friend-add':
        return await this._handleAdd(event);
      case 'friend-delete':
        return await this._handleDelete(event);
      case 'notification':
      case 'notification-v2':
        return await this._handleNotification(event);
      default:
        // 未知事件类型，仍然存到 events 表
        return this._storeEvent(event);
    }
  }

  /** 获取统计 */
  getStats() {
    return { processed: this._eventCount };
  }

  // ── 事件处理器 ──

  async _handleOnline(event) {
    const userId = event.userId;
    const displayName = event.displayName;
    const location = event.location || '';
    const worldId = event.worldId || '';
    const worldName = await this._resolveWorldName(worldId);

    // 更新好友状态
    this.storage.upsertFriend({
      userId,
      displayName,
      isOnline: true,
      location,
      worldId,
      worldName,
      platform: event.platform,
      status: 'active',
      lastSeen: event.receivedAt,
      lastOnline: event.receivedAt,
    });

    // 存储事件（带解析到的世界名）
    this._storeEvent(event, worldName);
  }

  async _handleOffline(event) {
    const userId = event.userId;

    this.storage.upsertFriend({
      userId,
      isOnline: false,
      location: 'offline',
      lastSeen: event.receivedAt,
      lastOffline: event.receivedAt,
    });

    this._storeEvent(event);
  }

  async _handleLocation(event) {
    const userId = event.userId;
    const displayName = event.displayName;
    const location = event.location || '';
    const worldId = event.worldId || '';
    const worldName = await this._resolveWorldName(worldId);

    this.storage.upsertFriend({
      userId,
      displayName,
      location,
      worldId,
      worldName,
      platform: event.platform,
      lastSeen: event.receivedAt,
    });

    // 世界名缓存由 handleGetWorldName 的 API fallback 维护（含 TTL 过期），
    // 这里不写回缓存——否则会把陈旧的缓存名字（如世界改名前的旧名）不断刷新，
    // 导致 updated_at 永远新鲜、TTL 失效。

    this._storeEvent(event, worldName);
  }

  async _handleUserLocation(event) {
    // 自己的位置变化：user-location 事件的 content 没有独立 worldId 字段，
    // 只有 location 字符串（如 "wrld_xxx:123~hidden(usr)~region(jp)"），
    // 从 location 解析 worldId 落库，便于查询自己的世界访问历史。
    const location = event.location || '';
    const worldId = location.startsWith('wrld_') ? location.split(':')[0] : '';
    const worldName = worldId ? await this._resolveWorldName(worldId) : '';
    // 仅存事件（不 upsertFriend——user-location 是自己的位置，不更新好友状态表）
    this._storeEvent({ ...event, worldId }, worldName);
    // 逛过的世界同步标记 world_kb.visited（2026-08-12 修复）：
    // 之前 visited 只在 scan_new_worlds 时更新，用户逛过但没再扫描的世界会一直标"未逛"，
    // 导致 get_new_worlds(onlyUnvisited) 把已逛的世界当新世界推荐。此处事件驱动回写，逛完即标记。
    if (worldId) {
      try {
        this.storage.db.prepare(
          `UPDATE world_kb SET visited = 1, visited_at = @visited_at
           WHERE world_id = @world_id AND visited = 0`
        ).run({ world_id: worldId, visited_at: event.receivedAt || new Date().toISOString() });
      } catch {
        // world_kb 表缺失（旧库）时静默跳过，不影响事件管道
      }
    }
  }

  async _handleUpdate(event) {
    const userId = event.userId;
    const displayName = event.displayName;

    // 好友资料变更追踪（2026-08-19）：friend-update 推送完整 user 对象
    // （currentAvatarImageUrl/bio/statusDescription/userIcon/pronouns 等），
    // 与 friends 表当前快照 diff，变化写入 events（type 与 VRCX 迁移脚本一致：
    // 顶层 friend-update + content_json.type=avatar/status/bio/user_icon/pronouns）。
    // 无历史快照（首次采集）或字段无基线值时只初始化，不误报变更。
    const userObj = event.content && event.content.user ? event.content.user : null;
    if (userObj) {
      const prev = this.storage.getFriend(userId);
      if (prev && prev.user_id) {
        const changes = [];
        const avatarChanged = prev.avatar_image_url
          && (prev.avatar_image_url || '') !== (userObj.currentAvatarImageUrl || '');
        if (avatarChanged) {
          changes.push({ type: 'avatar', payload: {
            avatarName: userObj.currentAvatarName || '',
            avatarImageUrl: userObj.currentAvatarImageUrl || '',
            avatarThumbnailUrl: userObj.currentAvatarThumbnailImageUrl || '',
            previousAvatarImageUrl: prev.avatar_image_url || '',
            previousAvatarThumbnailUrl: prev.avatar_image_url || '',
          }});
        }
        const bioChanged = prev.bio
          && (prev.bio || '') !== (userObj.bio || '');
        if (bioChanged) {
          changes.push({ type: 'bio', payload: { bio: userObj.bio || '', previousBio: prev.bio || '' } });
        }
        const statusChanged = (prev.status && (prev.status || '') !== (userObj.status || ''))
          || (prev.status_description && (prev.status_description || '') !== (userObj.statusDescription || ''));
        if (statusChanged) {
          changes.push({ type: 'status', payload: {
            status: userObj.status || '',
            statusDescription: userObj.statusDescription || '',
            previousStatus: prev.status || '',
            previousStatusDescription: prev.status_description || '',
          }});
        }
        const iconChanged = prev.user_icon
          && (prev.user_icon || '') !== (userObj.userIcon || '');
        if (iconChanged) {
          changes.push({ type: 'user_icon', payload: { userIcon: userObj.userIcon || '', previousUserIcon: prev.user_icon || '' } });
        }
        const pronounsChanged = prev.pronouns
          && (prev.pronouns || '') !== (userObj.pronouns || '');
        if (pronounsChanged) {
          changes.push({ type: 'pronouns', payload: { pronouns: userObj.pronouns || '', previousPronouns: prev.pronouns || '' } });
        }
        for (const c of changes) {
          this.storage.insertEvent({
            type: 'friend-update',
            userId,
            displayName,
            contentJson: { userId, displayName, type: c.type, ...c.payload },
            worldId: '',
            worldName: '',
            createdAt: event.receivedAt,
            source: 'websocket',
          });
        }
      }

      this.storage.upsertFriend({
        userId,
        displayName,
        status: userObj.status || '',
        statusDescription: userObj.statusDescription || '',
        avatarImageUrl: userObj.currentAvatarImageUrl || '',
        bio: userObj.bio || '',
        userIcon: userObj.userIcon || '',
        pronouns: userObj.pronouns || '',
        lastSeen: event.receivedAt,
      });
    } else {
      this.storage.upsertFriend({
        userId,
        displayName,
        lastSeen: event.receivedAt,
      });
    }

    this._storeEvent(event);
  }

  async _handleActive(event) {
    const userId = event.userId;

    this.storage.upsertFriend({
      userId,
      isOnline: true,
      lastSeen: event.receivedAt,
    });

    this._storeEvent(event);
  }

  async _handleAdd(event) {
    this._storeEvent(event);
  }

  async _handleDelete(event) {
    this._storeEvent(event);
  }

  async _handleNotification(event) {
    // 通知只存储，不更新好友状态
    this._storeEvent(event);
  }

  // ── 辅助方法 ──

  _storeEvent(event, worldName = '') {
    this.storage.insertEvent({
      type: event.type,
      userId: event.userId || '',
      displayName: event.displayName || '',
      contentJson: event.content || {},
      worldId: event.worldId || '',
      worldName: worldName || '',
      createdAt: event.receivedAt,
      source: 'websocket',
    });

    // 每 100 个事件持久化一次
    if (this._eventCount % 100 === 0) {
      this.storage.save();
    }
  }

  async _resolveWorldName(worldId) {
    if (!worldId || worldId === 'private') return '';
    
    // 查缓存
    const cached = this.storage.getWorldName(worldId);
    if (cached) return cached.name;

    return '';  // 名字通过外部 API 按需查
  }

  /** 保存到磁盘 */
  flush() {
    this.storage.save();
  }
}
