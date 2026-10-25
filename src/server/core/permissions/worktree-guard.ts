/**
 * 「没有权限请求能力的运行时必须跑在 worktree」这条安全底线（用户裁定）。
 *
 * 背景：CLI 通道的运行时（ZCode / DSH）声明 `permission.channel: none` —— 它们
 * 不会向产品层发权限请求，边界判定与卡片拦截**根本没有机会发生**。M10 实测里
 * ZCode 直接改了仓库的 `package.json` 并新建了 `tsconfig.server.json`。
 *
 * 因此判定只有一条，且刻意做得极简：
 *
 *   运行时没有权限通道  →  执行位置必须是 worktree
 *
 * 本文件只放**纯判定与文案**，不读库、不碰进程：
 *   - 建 Bot / 改 Bot（http 层）用它决定默认值与二次确认；
 *   - Session 启动（process 层）用它做兜底强制（防历史数据与绕过）。
 *
 * 注意：这里不出现具体协议名（core 的分离铁律），只认 `channel` 这个值。
 */

/** 判定所需的最小形状：AdapterDeclaration 与 RuntimeRecord 都能结构化满足。 */
export interface RuntimePermissionShape {
  displayName?: string;
  permission?: { channel?: string } | null;
}

/** 没有权限请求通道 = 产品层无法拦截 = 必须 worktree。 */
export function requiresWorktree(runtime: RuntimePermissionShape | null | undefined): boolean {
  return runtime?.permission?.channel === "none";
}

/**
 * 二次确认用的风险文案（P0-13 / 用户裁定）。
 *
 * 要求具体：说清「谁」「为什么」「后果」，不用「可能存在风险」这种空话。
 */
export function worktreeRiskMessage(displayName: string): string {
  return `该运行时（${displayName}）不提供权限请求，无法拦截文件写入。选 local 时 Bot 可未经批准修改该目录下的任意文件。`;
}

/** 错误码：与 REST 契约一致（前端据此弹二次确认，而不是笼统 toast）。 */
export const RISK_CONFIRMATION_REQUIRED = "risk_confirmation_required";

/** 错误码：worktree 未就绪时阻止发送（P0-13 边界处理）。 */
export const WORKTREE_NOT_READY = "worktree_not_ready";
