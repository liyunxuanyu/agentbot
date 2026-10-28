/**
 * 图标路径数据 —— 逐字照抄原型 index.html 的 ICONS 与 stateIcon()。
 * 单独放 .ts 而不是 .vue，是为了让 App.vue 能 import 类型（`<script setup>` 不能导出）。
 */

export type IconName =
  | "bots"
  | "chats"
  | "tasks"
  | "clock"
  | "chart"
  | "gear"
  | "sun"
  | "moon"
  | "logout"
  | "plus"
  | "send"
  | "stop"
  | "at"
  | "close"
  | "chev";

/** 18×18 视口（viewBox 20）的导航图标。 */
export const NAV_PATHS: Partial<Record<IconName, string>> = {
  bots: '<rect x="3" y="6" width="14" height="11" rx="4"/><path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h3A1.5 1.5 0 0 1 13 4.5V6"/><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="11" r="1" fill="currentColor" stroke="none"/><path d="M10 15v1.5"/>',
  chats:
    '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v6a2.5 2.5 0 0 1-2.5 2.5H9l-4 3v-3H5.5A2.5 2.5 0 0 1 3 11.5z"/>',
  tasks: '<rect x="3" y="3" width="14" height="14" rx="4"/><path d="M6.5 8h7M6.5 11.5h7M6.5 15h4"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.3l2.8 1.7"/>',
  chart: '<path d="M3 17h14"/><path d="M5.5 14V9M9.5 14V5M13.5 14v-3.5M17 14v-6"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>',
  sun: '<circle cx="10" cy="10" r="3.6"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.4 4.4l1.4 1.4M14.2 14.2l1.4 1.4M15.6 4.4l-1.4 1.4M5.8 14.2l-1.4 1.4"/>',
};

/** 小尺寸动作图标（各自 viewBox 不同）。 */
export const SMALL_PATHS: Partial<Record<IconName, { box: number; body: string }>> = {
  plus: { box: 16, body: '<path d="M8 3v10M3 8h10"/>' },
  send: { box: 16, body: '<path d="M8 13V3M4 7l4-4 4 4"/>' },
  close: { box: 16, body: '<path d="M4 4l8 8M12 4l-8 8"/>' },
  at: {
    box: 20,
    body: '<circle cx="10" cy="10" r="3.4"/><path d="M13.4 10v1.6a2.2 2.2 0 0 0 4.4 0V10a7.8 7.8 0 1 0-3 6.2"/>',
  },
};

/** 月亮：原型没有（它用同一个太阳图标表示「切换」），按同一线性语言补一个。 */
export const MOON_PATH = '<path d="M16.5 11.5A6.8 6.8 0 0 1 8.5 3.5a6.8 6.8 0 1 0 8 8z"/>';

/** 退出登录：门框 + 向右的箭头（顶栏图标，viewBox 20）。 */
export const LOGOUT_PATH =
  '<path d="M8 3H5.5A1.5 1.5 0 0 0 4 4.5v11A1.5 1.5 0 0 0 5.5 17H8"/><path d="M12.5 6.5 16 10l-3.5 3.5"/><path d="M16 10H8"/>';
