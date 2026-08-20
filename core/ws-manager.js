/**
 * VRChat 好友监控系统 — WebSocket 连接管理器
 * 
 * 核心能力：
 * 1. WebSocket 连接生命周期管理
 * 2. 指数退避自动重连（1s→2s→4s→8s→16s→30s→60s 封顶）
 * 3. 每次重连前刷新 token（永不 AuthExpired）
 * 4. 心跳保活（30 秒 ping）
 * 5. 连接状态事件通知
 * 6. 事件消息回调
 */
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ctx } from './server-context.js';
import { notifier } from './notifier.js';

// WS 代理地址：优先 VRC_MONITOR_WS_PROXY，其次标准 HTTPS_PROXY/HTTP_PROXY，最后内置默认（兼容旧部署）
// 注意：代理可能含凭据，日志中不要打印完整 URL
const DEFAULT_WS_PROXY = 'http://127.0.0.1:7892';
const WS_PROXY = process.env.VRC_MONITOR_WS_PROXY
  || process.env.HTTPS_PROXY || process.env.http_proxy
  || process.env.HTTP_PROXY || process.env.http_proxy
  || DEFAULT_WS_PROXY;

// 重连延迟（秒），指数退避
const RECONNECT_DELAYS = [1, 2, 4, 8, 16, 30, 60];
const HEARTBEAT_INTERVAL = 30_000;  // 30 秒 ping
const HEARTBEAT_TIMEOUT = 10_000;   // 10 秒等 pong
const MAX_RECONNECT_ATTEMPTS = 0;   // 0 = 无限重试

export class WsManager {
  constructor({ apiClient, onEvent, onStatusChange, otpFetcher }) {
    this.api = apiClient;          // VrchatApiClient 实例
    this.onEvent = onEvent;        // 收到事件回调 (event) => void
    this.onStatusChange = onStatusChange; // 状态变化回调 (status) => void
    this.otpFetcher = otpFetcher;  // 可选：OTP 自动获取函数，用于重连时自动完成 2FA

    this.ws = null;
    this.heartbeatTimer = null;
    this.heartbeatTimeout = null;
    this.reconnectTimer = null;
    this.shouldReconnect = true;

    this.attempt = 0;
    this.lastToken = null;
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.status = 'idle';          // idle | connecting | connected | reconnecting | error
    this.eventLog = [];            // 最近 100 条事件（debug）
    this._reconnectScheduled = false;  // 防止重复调度重连
    this.authCooldownUntil = 0;       // 认证冷却截止时间戳

    this._pongReceived = false;
  }

  /** 获取当前状态 */
  getState() {
    return {
      status: this.status,
      attempt: this.attempt,
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
      uptime: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0,
      lastToken: this.lastToken ? `***${this.lastToken.slice(-6)}` : null,
    };
  }

  /** 启动连接 */
  async start() {
    this.shouldReconnect = true;
    this.attempt = 0;
    this._setStatus('connecting');
    await this._connect();
  }

  /** 停止连接 */
  stop() {
    this.shouldReconnect = false;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, 'Manual stop'); } catch {}
      this.ws = null;
    }
    this._setStatus('idle');
  }

  /** 强制断开后重连（用于测试） */
  async forceReconnect() {
    this.stop();
    await this.start();
  }

  // ── 内部连接逻辑 ──

  async _connect() {
    if (!this.shouldReconnect) return;
    this._reconnectScheduled = false;  // 重置，允许后续重连调度

    // 认证冷却检查：避免高频 Basic auth 触发 VRChat 登录限流
    if (Date.now() < this.authCooldownUntil) {
      const remaining = Math.ceil((this.authCooldownUntil - Date.now()) / 1000);
      console.log(`[WS] ⏳ 认证冷却中，${remaining} 秒后重试...`);
      this._scheduleReconnect();
      return;
    }

    try {
      // 1. 确保认证有效（需要 OTP 时自动获取）
      try {
        await this.api.ensureAuth();
      } catch (authErr) {
        // 自动 2FA 通道：邮箱 OTP（otpFetcher）或 TOTP（api.totpFetcher，配置 totp_secret 后启用）
        if (authErr.needsOtp && (this.otpFetcher || this.api.totpFetcher)) {
          console.log('[WS] ⚠️ 认证需要 2FA，尝试自动获取...');
          try {
            await this.api.ensureAuthWithAutoOtp(this.otpFetcher);
          } catch (otpErr) {
            if (otpErr.needsTotp) {
              ctx.serverState.needsTotp = true;
              console.log('[WS] 🔑 账号需要 TOTP 验证码：自动登录未成功，可调用 MCP 工具 submit_totp 提交');
              notifier.notifyAuth('needsTotp', '账号需要 TOTP 验证码，服务暂停——请调用 submit_totp 提交当前验证码');
            } else {
              notifier.notifyAuth('reauthFailed', `WS 重连自动认证失败：${otpErr.message}`);
            }
            this._setAuthCooldown(otpErr);
            throw otpErr;
          }
        } else {
          notifier.notifyAuth('reauthFailed', `WS 重连认证失败：${authErr.message}`);
          this._setAuthCooldown(authErr);
          throw authErr;
        }
      }

      // 认证成功，重置冷却
      this.authCooldownUntil = 0;
      if (ctx.serverState.needsTotp) {
        ctx.serverState.needsTotp = false;
        notifier.notifyAuth('recovered', 'TOTP 认证完成，服务已恢复正常');
      }

      // 2. 获取 WebSocket token
      const authResp = await this.api._request('GET', '/auth');
      if (!authResp.data?.ok || !authResp.data?.token) {
        throw new Error('Failed to get WebSocket token');
      }
      this.lastToken = authResp.data.token;

      // 3. 构建 WebSocket URL
      const wsUrl = `wss://pipeline.vrchat.cloud/?auth=${encodeURIComponent(this.lastToken)}`;

      // 4. 连接（直连优先，超时后回退到代理）
      this._setStatus('connecting');
      const options = {
        headers: {
          'User-Agent': 'VRChatMonitor/1.0 Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'http://localhost:9000',
        },
        handshakeTimeout: 8000,
      };

      // 先尝试直连
      let connectedDirectly = false;
      try {
        this.ws = new WebSocket(wsUrl, options);
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('connect timeout')), 6000);
          this.ws.once('open', () => { clearTimeout(timeout); resolve(); });
          this.ws.once('error', (err) => { clearTimeout(timeout); reject(err); });
        });
        connectedDirectly = true;
      } catch {
        // 直连失败
      }

      if (!connectedDirectly) {
        // 直连失败，通过代理重试
        console.log('[WS] 直连超时，尝试代理...');
        if (this.ws) { try { this.ws.close(); } catch {} }
        options.agent = new HttpsProxyAgent(WS_PROXY);
        options.handshakeTimeout = 15000;
        this.ws = new WebSocket(wsUrl, options);
      }

      // 设置事件处理器（如果是直连成功，open 事件已被 inline listener 消费，需要标记）
      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', (data) => this._onMessage(data));
      this.ws.on('close', (code, reason) => this._onClose(code, reason));
      this.ws.on('error', (err) => this._onError(err));

      // 如果直连已成功但 open 事件已被消费，手动触发 _onOpen
      if (connectedDirectly && this.ws.readyState === WebSocket.OPEN) {
        this._onOpen();
      }

    } catch (err) {
      console.error(`[WS] 连接失败: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    this.attempt = 0;
    this.connectedAt = new Date();
    this._setStatus('connected');
    console.log(`[WS] ✅ 已连接 (${this.connectedAt.toISOString().slice(11, 19)})`);
    
    // 启动心跳
    this._startHeartbeat();
  }

  _onMessage(data) {
    const raw = data.toString();
    
    // 记录到事件日志（最近 100 条）
    this.eventLog.push({ time: new Date().toISOString(), raw: raw.slice(0, 200) });
    if (this.eventLog.length > 100) this.eventLog.shift();

    try {
      const parsed = JSON.parse(raw);
      const type = parsed.type || 'unknown';
      let content = parsed.content || {};

      // 解析嵌套 JSON content
      if (typeof content === 'string') {
        try { content = JSON.parse(content); } catch {}
      }

      // 提取核心字段
      const event = {
        type,
        userId: content.userId || content.user?.id || content.id || '',
        displayName: content.displayName || content.user?.displayName || '',
        location: content.location || '',
        worldId: content.worldId || '',
        instanceId: content.instanceId || '',
        travelingToLocation: content.travelingToLocation || '',
        platform: content.platform || '',
        content,
        raw,
        receivedAt: new Date().toISOString(),
      };

      // 回调
      if (this.onEvent) {
        this.onEvent(event);
      }
    } catch (err) {
      console.error(`[WS] 解析消息失败: ${err.message}`);
    }
  }

  _onClose(code, reason) {
    this.disconnectedAt = new Date();
    const reasonStr = reason ? reason.toString() : '无';
    console.log(`[WS] ⚠️ 断开: code=${code}, reason=${reasonStr}`);

    this._clearTimers();
    this._setStatus('disconnected');

    // 自动重连
    if (this.shouldReconnect) {
      this._scheduleReconnect();
    }
  }

  _onError(err) {
    console.error(`[WS] ❌ 错误: ${err.message}`);
  }

  // ── 心跳 ──

  _startHeartbeat() {
    this._clearHeartbeat();
    this._pongReceived = true;

    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this._pongReceived = false;
        this.ws.ping();

        // 设置 pong 超时
        this.heartbeatTimeout = setTimeout(() => {
          if (!this._pongReceived) {
            console.log('[WS] ⚠️ 心跳超时，主动断开');
            try { this.ws.terminate(); } catch {}
          }
        }, HEARTBEAT_TIMEOUT);
      }
    }, HEARTBEAT_INTERVAL);

    // 监听 pong
    if (this.ws) {
      this.ws.on('pong', () => {
        this._pongReceived = true;
        if (this.heartbeatTimeout) {
          clearTimeout(this.heartbeatTimeout);
          this.heartbeatTimeout = null;
        }
      });
    }
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  _clearTimers() {
    this._clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── 重连 ──

  _setAuthCooldown(err) {
    const isRateLimited = !!(err && err.isRateLimited);
    const cooldownMs = isRateLimited ? 300_000 : 120_000;
    this.authCooldownUntil = Date.now() + cooldownMs;
    const secs = Math.round(cooldownMs / 1000);
    console.log(`[WS] 🔒 认证失败，冷却 ${secs} 秒后重试${isRateLimited ? ' (限流)' : ''}`);
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect || this._reconnectScheduled) return;
    if (MAX_RECONNECT_ATTEMPTS > 0 && this.attempt >= MAX_RECONNECT_ATTEMPTS) {
      console.log('[WS] 已达到最大重试次数，停止重连');
      this._setStatus('error');
      return;
    }

    this._reconnectScheduled = true;
    this.attempt++;
    const delay = RECONNECT_DELAYS[Math.min(this.attempt - 1, RECONNECT_DELAYS.length - 1)];
    this._setStatus('reconnecting');

    console.log(`[WS] 🔄 将在 ${delay} 秒后重连 (第 ${this.attempt} 次)...`);
    
    this.reconnectTimer = setTimeout(() => {
      this._connect();
    }, delay * 1000);
  }

  _setStatus(status) {
    this.status = status;
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }
}
