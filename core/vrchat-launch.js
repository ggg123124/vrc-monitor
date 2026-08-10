/**
 * VRChat 打开/加入实例统一入口（core 模块，平台增强版）
 *
 * 功能：打开指定实例（worldId:instanceId 完整 location）的**统一入口**：
 *   1. 本机增强（仅 Windows）：探测 VRChat 命名管道 `\\.\pipe\VRChatURLLaunchPipe`，
 *      存在则通过管道直发 `vrchat://launch` URL——已运行的 VRChat 客户端在游戏内
 *      直接弹出「加入房间」确认菜单，**一步直达、不新开进程**（VRCX VRCIPC 同款协议）。
 *   2. 跨平台回退（所有平台）：探测失败 / 非 Windows / 超时时，**静默回退**为 API 邀请
 *      （`POST /invite/myself/to/{worldId}:{instanceId}`）——客户端收到 invite 通知，
 *      接受后传送。功能不缺失，仅体验降级（邀请需手动接受）。
 *
 * 设计约束（对齐 DEVELOPMENT.md §2-12 / §3.1）：
 *   - 平台门控：非 win32 不加载管道路径，直接走 API；
 *   - 静默回退：管道失败快速回退 API，调用方无感知、不增加失败率；
 *   - 依赖注入：API 客户端由调用方传入（CLI 与服务 MCP handler 共用本模块）；
 *   - 无个人环境硬编码；不读 VRChat 安装目录；不依赖 GUI/桌面环境；
 *   - 探测与发送带超时保护（默认 1.5s），失败不影响服务本身。
 *
 * 适用平台：管道增强仅 Windows（VRChat 客户端 + 命名管道）；API 回退全平台。
 *
 * 用法：
 *   import { openInstance } from './vrchat-launch.js';
 *   const res = await openInstance({ location, shortName, api });
 *   // res = { method: 'pipe' | 'api', success: true, ... }
 */

import net from 'node:net';

/** VRChat 运行时监听的命名管道（VRCX VRCIPC.cs 同款常量） */
export const LAUNCH_PIPE = '\\\\.\\pipe\\VRChatURLLaunchPipe';

/** 平台门控：管道增强仅 Windows 可用 */
export function isPipeSupported() {
  return process.platform === 'win32';
}

/**
 * 构建 vrchat://launch URL。
 * 注意：id 必须是**完整 location**（wrld_xxx:01277~region(jp)，含实例号），
 * 只传 worldId 时 IPC 成功但游戏内无反应（2026-08-09 实测）。
 * id 参数**不编码**（`:` `~` `(` `)` 原样），与 VRCX src/stores/launch.js 一致；
 * 编码后 VRChat 客户端解析失败（实测坑）。
 */
export function buildLaunchUrl(location, shortName) {
  if (!location || typeof location !== 'string') {
    throw new Error('location 必填（完整实例 location，如 wrld_xxx:01277~region(jp)）');
  }
  const base = `vrchat://launch?ref=vrcx.app&id=${location}`;
  return shortName ? `${base}&shortName=${encodeURIComponent(shortName)}` : base;
}

/**
 * 通过命名管道直发 launch URL 到运行中的 VRChat。
 * 协议：连接管道 → 写 UTF-8 URL → 读 1 字节响应（1=成功）。
 * @returns {Promise<{success: true, method: 'pipe'}>}
 * @throws {Error} 管道不存在 / 连接超时 / 写入失败（调用方应静默回退）
 */
export function launchViaPipe(location, shortName, { timeoutMs = 1500 } = {}) {
  if (!isPipeSupported()) {
    return Promise.reject(new Error('非 Windows 平台，命名管道不可用'));
  }
  const url = buildLaunchUrl(location, shortName);
  return new Promise((resolve, reject) => {
    const client = net.createConnection(LAUNCH_PIPE);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('IPC 连接超时（VRChat 未运行或未监听管道）'));
    }, timeoutMs);
    client.on('connect', () => {
      client.write(Buffer.from(url, 'utf-8'));
    });
    client.on('data', (buf) => {
      clearTimeout(timer);
      client.end();
      if (buf[0] === 1) resolve({ success: true, method: 'pipe' });
      else reject(new Error(`IPC 响应异常（buf[0]=${buf[0]}，预期 1）`));
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`IPC 连接失败: ${err.message}`));
    });
  });
}

/**
 * API 邀请回退：POST /invite/myself/to/{worldId}:{instanceId}。
 * 客户端收到 invite 通知，接受后传送（跨平台路径，功能不缺失）。
 * @param {object} api VrchatApiClient 实例（由调用方注入）
 * @returns {Promise<{success: true, method: 'api', notificationId?: string}>}
 * @throws {Error} 参数不合法 / API 失败
 */
export async function inviteSelfViaApi(api, location) {
  if (!api || typeof api._request !== 'function') {
    throw new Error('缺少 api 客户端（inviteSelfViaApi 需要注入 VrchatApiClient）');
  }
  if (!location || typeof location !== 'string') {
    throw new Error('location 必填（如 wrld_x:12345~hidden(usr_x)~region(jp)）');
  }
  const idx = location.indexOf(':');
  if (idx <= 0) throw new Error('location 格式应为 worldId:instanceId');
  const wId = location.slice(0, idx);
  const iId = location.slice(idx + 1);
  if (!String(wId).startsWith('wrld_')) throw new Error('worldId 必须是 wrld_ 开头');
  if (!iId) throw new Error('instanceId 不能为空');
  const r = await api._request('POST', `/invite/myself/to/${wId}:${iId}`);
  if (r.status >= 400) {
    throw new Error(`邀请自己失败 API ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}（404=实例无效或不是合法参与者）`);
  }
  const d = r.data || {};
  return { success: true, method: 'api', notificationId: d.id || null };
}

/**
 * 统一入口：打开/加入指定实例。
 * 管道可用（Windows + VRChat 运行中）→ 管道直发一步直达；否则静默回退 API 邀请。
 * 不抛「管道不可用」类错误——任何管道失败都转为 API 回退；仅当 API 也失败才抛错。
 *
 * @param {object} opts
 * @param {string} opts.location 完整实例 location（wrld_xxx:01277~region(jp)）
 * @param {string} [opts.shortName] 房间短名（可选，管道 URL 携带，菜单显示更友好）
 * @param {object} opts.api VrchatApiClient 实例（API 回退必需；注入方负责认证）
 * @param {boolean} [opts.forceApi=false] 强制走 API（跳过管道探测，测试/远程场景用）
 * @param {number} [opts.timeoutMs=1500] 管道探测/发送超时
 * @returns {Promise<{success: boolean, method: 'pipe'|'api', notificationId?: string, error?: string}>}
 */
export async function openInstance({ location, shortName, api, forceApi = false, timeoutMs = 1500 }) {
  // 1) 本机增强：Windows 且未强制 API 时，尝试管道直发
  if (!forceApi && isPipeSupported()) {
    try {
      const res = await launchViaPipe(location, shortName, { timeoutMs });
      return { ...res, detail: '管道直发：游戏内已弹出加入菜单' };
    } catch (e) {
      // 静默回退：不抛管道错误，转入 API 路径
    }
  }
  // 2) 跨平台回退：API 邀请自己传送
  if (!api) {
    return { success: false, method: 'api', error: '管道不可用且未注入 api 客户端，无法回退' };
  }
  try {
    const res = await inviteSelfViaApi(api, location);
    return { ...res, detail: 'API 邀请：客户端收到邀请通知，接受后传送' };
  } catch (e) {
    return { success: false, method: 'api', error: e.message };
  }
}

export default { openInstance, launchViaPipe, inviteSelfViaApi, buildLaunchUrl, isPipeSupported, LAUNCH_PIPE };
