/**
 * 安全模式 — 自动移除破坏性 MCP 工具
 *
 * 当配置开启（VRC_MONITOR_SAFE_MODE=true，.env 或环境变量）时：
 *   - tools/list 不再对外暴露「删除/移除/退出/拒绝」类破坏性工具（客户端拿不到 = 调用不了）；
 *   - tools/call 对破坏性工具直接拦截报错（纵深防御：即使客户端持有旧工具清单也执行不了）。
 *
 * 破坏性工具判定口径：工具的主作用是**不可逆地删除 / 移除 / 退出 / 清除**数据或关系
 * （删除好友、删除相册照片、退出群组、拒绝好友请求等）。新增写工具时若符合该口径，
 * 请同步加入 DESTRUCTIVE_TOOLS，否则安全模式会漏拦。
 *
 * 配置读取走 process.env（start-monitor.js 启动时已把 .env 的 VRC_MONITOR_* 加载进来），
 * 每次调用实时求值，无状态、无缓存，开关只在进程启动时生效。
 */

// ── 破坏性工具清单（安全模式下被移除/拦截）──
export const DESTRUCTIVE_TOOLS = [
  'remove_friend',            // 删除好友（不可逆）
  'remove_print',             // 删除相册照片（不可逆）
  'remove_gallery_image',     // 删除画廊图片（不可逆）
  'unfavorite_friend',        // 从收藏分组移除好友
  'leave_group',              // 退出群组（移除成员身份）
  'decline_friend_request',   // 拒绝好友请求（清除通知，不可逆）
  'hide_notification',        // 隐藏/清除通知（旧 v1 hide 即删除）
  'remove_from_backlog',      // 移出待逛列表（本地）
  'remove_from_watchlist',    // 移出关注名单（本地）
  'x_remove_creator',         // 移除追踪的 X 博主（本地配置）
];

// ── 开关判定：true / 1 / yes / on（大小写不敏感）→ 启用 ──
export function isSafeModeEnabled() {
  const v = String(process.env.VRC_MONITOR_SAFE_MODE || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

// ── 工具列表过滤（tools/list 用）：开启时剔除破坏性工具，关闭时原样返回 ──
export function filterTools(tools) {
  if (!isSafeModeEnabled()) return tools;
  return tools.filter(t => !DESTRUCTIVE_TOOLS.includes(t.name));
}

// ── 调用拦截（tools/call 用）：开启时对破坏性工具抛错，关闭时放行 ──
export function assertToolAllowed(name) {
  if (isSafeModeEnabled() && DESTRUCTIVE_TOOLS.includes(name)) {
    const err = new Error(
      `🔒 安全模式已启用：${name} 属于破坏性工具（删除/移除类），已被禁用。` +
      `如需使用，请在 .env 设置 VRC_MONITOR_SAFE_MODE=false 后重启服务。`
    );
    err.safeModeBlocked = true;
    throw err;
  }
}
