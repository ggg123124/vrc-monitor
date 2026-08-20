/**
 * 登录状态主动通知中心 — 需人工介入/异常时提醒宿主用户（issue #69）
 *
 * 原则：只在「需要人工介入 / 异常」时通知，正常自动登录成功不通知（避免噪音）。
 * 多次失败聚合去抖：otpFailed / reauthFailed 连续失败达阈值且距上次同类型通知超间隔才发送。
 * 跨平台可插拔通道：desktop（notify-send / osascript / PowerShell toast）+ webhook（可选）。
 * 配置来自独立文件 notify-config.json（由 start-monitor.js 加载后注入）。
 */

import { log } from './server-context.js';

// 各事件类型的聚合/去抖参数（可被 notify-config.json 覆盖）
const DEFAULTS = {
  consecutiveFailThreshold: 3,   // otpFailed/reauthFailed 连续失败达此数才通知
  minIntervalSec: 300,           // 同类型通知最小间隔（秒），防刷屏
};

class AuthNotifier {
  constructor() {
    this.enabled = false;
    this.channels = [];
    this.config = { ...DEFAULTS };
    // 每种 kind 的去抖状态：{ count, lastSentAt, lastNotifiedMsg }
    this._state = {};
  }

  /** 由 start-monitor.js 注入配置并注册通道 */
  configure(config = {}) {
    this.config = {
      consecutiveFailThreshold: config.consecutive_fail_threshold ?? DEFAULTS.consecutiveFailThreshold,
      minIntervalSec: config.min_interval_sec ?? DEFAULTS.minIntervalSec,
    };
    this.enabled = !!config.enabled;
  }

  /** 注册通知通道（fn: (title, message) => void，失败静默，由调用方保证不抛） */
  registerChannel(fn) {
    if (typeof fn === 'function') this.channels.push(fn);
  }

  /** 清空通道（测试/重载用） */
  _resetChannels() {
    this.channels = [];
  }

  /**
   * 发送认证通知。kind ∈ { needsTotp, otpFailed, reauthFailed, recovered }。
   * 返回 { sent, reason } 便于排查与测试。
   */
  notifyAuth(kind, message) {
    if (!this.enabled) return { sent: false, reason: 'disabled' };

    const st = (this._state[kind] ??= { count: 0, lastSentAt: 0, lastNotifiedMsg: null });

    // 聚合型失败事件：先累计计数，未达阈值不通知
    if (kind === 'otpFailed' || kind === 'reauthFailed') {
      st.count += 1;
      const sinceLast = (Date.now() - st.lastSentAt) / 1000;
      const thresholdReached = st.count >= this.config.consecutiveFailThreshold;
      const intervalPassed = st.lastSentAt === 0 || sinceLast >= this.config.minIntervalSec;
      if (!(thresholdReached && intervalPassed)) {
        return { sent: false, reason: `aggregating (count=${st.count}, threshold=${this.config.consecutiveFailThreshold})` };
      }
      // 触发后重置计数，避免同一事件流无限刷屏
      st.count = 0;
    }

    // 状态跳变型事件（needsTotp / recovered）：同状态消息不重复通知；
    // 且受 min_interval_sec 限制——3 处接线（启动/WS/运行期 401）文案不同，
    // 同一故障流可能短时间触发多次不同文案，统一受间隔约束防刷屏（审核 🟡 建议）
    if (kind === 'needsTotp' || kind === 'recovered') {
      if (st.lastNotifiedMsg === message) {
        return { sent: false, reason: 'dedup (same state)' };
      }
      const sinceLast = (Date.now() - st.lastSentAt) / 1000;
      if (st.lastSentAt !== 0 && sinceLast < this.config.minIntervalSec) {
        return { sent: false, reason: `interval (${Math.round(sinceLast)}s < ${this.config.minIntervalSec}s)` };
      }
    }

    st.lastSentAt = Date.now();
    st.lastNotifiedMsg = message;
    this._dispatch(kind, message);
    return { sent: true, reason: 'sent' };
  }

  _dispatch(kind, message) {
    // 无论通道是否成功都保留日志，维持现有可观测性
    log(`🔔 [notify] ${kind}: ${message}`);
    for (const ch of this.channels) {
      try {
        const ret = ch(kind, message);
        // async 通道返回 Promise：同步 catch 捕获不到 rejection，必须挂 rejection 处理，
        // 否则 fetch/webhook 网络失败会 unhandled rejection → Node 15+ 默认 throw 终止进程
        // （审核实测复现，issue #69 阻断项；同步通道返回 undefined 不受影响）
        if (ret && typeof ret.catch === 'function') {
          ret.catch((err) => log(`⚠️ [notify] 异步通道发送失败: ${err?.message || err}`));
        }
      } catch (err) {
        log(`⚠️ [notify] 通道发送失败: ${err.message}`);
      }
    }
  }

  /** 供测试读取内部状态 */
  _getState(kind) {
    return this._state[kind] || null;
  }
}

export const notifier = new AuthNotifier();
