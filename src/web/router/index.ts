import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { useUiStore } from "../stores/ui";

/**
 * 10 条路由（UX §2.1 页面树）。
 *
 * **选 history 模式**（原型用 hash），理由：
 *   ① 生产后端已对非 /api 的未知路径回落到 index.html（`http/server.ts` 的
 *      `serveStatic`），history 不需要服务端额外配置就能直达深层链接；
 *   ② URL 更干净：`/chat/g1` 而不是 `#/chat/g1`。本地工作台地址常被复制进笔记或
 *      issue，`#` 在多数 Markdown 渲染里会被截断成锚点；
 *   ③ 原型的 hash 只是为了能在 `file://` 下双击打开，而我们是真正的 HTTP 服务。
 *   代价：开发态依赖 Vite 的 SPA fallback（`appType` 默认 `spa`，已具备）。
 *
 * `/` 重定向 `/bots`：与原型一致。「无 Bot → /setup」的判断放在 BotsPage 的空态里，
 * 不在路由守卫里做 —— 守卫阻塞首屏会让冷启动多一次串行请求。
 */

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/bots" },
  { path: "/setup", name: "setup", component: () => import("../pages/SetupPage.vue") },
  { path: "/bots", name: "bots", component: () => import("../pages/BotsPage.vue") },
  {
    path: "/bots/:id",
    name: "bot-detail",
    component: () => import("../pages/BotDetailPage.vue"),
    props: true,
  },
  { path: "/chats", name: "chats", component: () => import("../pages/ChatsPage.vue") },
  {
    path: "/chat/:channelId",
    name: "chat",
    component: () => import("../pages/ChatPage.vue"),
    props: true,
    // 会话视图占满视口高度，不吃 .page 的内边距（原型 .page--flush）
    meta: { flush: true },
  },
  {
    path: "/assignments",
    name: "assignments",
    component: () => import("../pages/AssignmentsPage.vue"),
  },
  {
    path: "/assignments/:id",
    name: "assignment-detail",
    component: () => import("../pages/AssignmentDetailPage.vue"),
    props: true,
  },
  { path: "/schedules", name: "schedules", component: () => import("../pages/SchedulesPage.vue") },
  { path: "/usage", name: "usage", component: () => import("../pages/UsagePage.vue") },
  { path: "/settings", name: "settings", component: () => import("../pages/SettingsPage.vue") },
  // 未知路径回 /bots，而不是空白页
  { path: "/:pathMatch(.*)*", redirect: "/bots" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(_to, _from, saved) {
    // 返回时恢复滚动位置（原型：从任务详情回会话「停在原位」）
    return saved ?? { top: 0 };
  },
});

/** 一级导航文案与落点；页面只补自己的第二级（它才知道名字）。 */
const NAV_CRUMB: Record<string, { text: string; to: string }> = {
  setup: { text: "首次启动", to: "/setup" },
  bots: { text: "Bot", to: "/bots" },
  "bot-detail": { text: "Bot", to: "/bots" },
  chats: { text: "会话", to: "/chats" },
  chat: { text: "会话", to: "/chats" },
  assignments: { text: "任务", to: "/assignments" },
  "assignment-detail": { text: "任务", to: "/assignments" },
  schedules: { text: "定时", to: "/schedules" },
  usage: { text: "用量", to: "/usage" },
  settings: { text: "设置", to: "/settings" },
};

router.afterEach((to) => {
  const name = to.name?.toString() ?? "";
  const crumb = NAV_CRUMB[name];
  if (!crumb) return;
  // afterEach 在 app.use(pinia) 之后才会跑，此时 store 可用
  useUiStore().setCrumb([crumb]);
});
