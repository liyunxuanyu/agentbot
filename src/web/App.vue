<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import { storeToRefs } from "pinia";
import AppIcon from "./components/common/AppIcon.vue";
import type { IconName } from "./lib/icons";
import Toast from "./components/common/Toast.vue";
import { useUiStore } from "./stores/ui";
import { useBotsStore } from "./stores/bots";
import { useSetupStore } from "./stores/setup";
import { botVars } from "./lib/botVars";
import { api, redirectToLogin } from "./net/client";

/**
 * 应用壳（原型 shell()）。
 *
 * 三栏结构：240 侧栏 | 弹性主区（顶栏 + 页面）；右面板属于页面自己（只有 /chat 有），
 * 所以壳里不预留右列 —— 这与原型一致（原型把 .chat 的两列网格放在 viewChat 内）。
 *
 * 布局令牌全部来自 tokens.css：--nav-width / --nav-width-rail / --aside-width。
 * 1024–1280 侧栏折成 64px 图标栏并悬停展开、<768 变底部导航，
 * 这些断点行为由 base.css 承担，壳只负责给对 DOM 结构与 class。
 */
const ui = useUiStore();
const bots = useBotsStore();
const setup = useSetupStore();
const { crumbs, isDark, toasts } = storeToRefs(ui);

const route = useRoute();
const router = useRouter();

/**
 * 首启判定（N1）：服务端 `/api/setup/state` 说必需项没齐、且当前不在引导页 →
 * 跳过去一次。只跳一次（`setup.needsSetup` 在用户点「稍后再说」后变 false），
 * 避免用户在工作台里做别的事时被反复拽回。
 *
 * 不放在路由守卫里：守卫会阻塞首屏，而 `/api/setup/state` 要等 pinia 就绪；
 * 这里挂载后再判断，页面先照常渲染 —— 网络慢时用户看到的不是白屏。
 */
const setupRemaining = computed(() => setup.total - setup.completed);
const showSetupHint = computed(
  () => setup.state !== null && setupRemaining.value > 0 && route.name !== "setup",
);

onMounted(async () => {
  await setup.load();
  if (setup.needsSetup && route.name !== "setup") {
    void router.replace("/setup");
  }
});

// 从引导页回到工作台后刷新一次：用户在向导里建了 Bot / 配了供应商。
// 只在「离开 /setup」时刷新，不在每次导航都发请求。
watch(
  () => route.name,
  (name, previous) => {
    if (previous === "setup" && name !== "setup" && setup.state !== null) void setup.refresh();
  },
);

interface NavItem {
  key: string;
  label: string;
  to: string;
  icon: IconName;
}

const NAV: NavItem[] = [
  { key: "bots", label: "Bot", to: "/bots", icon: "bots" },
  { key: "chats", label: "会话", to: "/chats", icon: "chats" },
  { key: "assignments", label: "任务", to: "/assignments", icon: "tasks" },
  { key: "schedules", label: "定时", to: "/schedules", icon: "clock" },
  { key: "usage", label: "用量", to: "/usage", icon: "chart" },
  { key: "settings", label: "设置", to: "/settings", icon: "gear" },
];

/** 当前高亮的一级导航：/chat/:id 属于「会话」，/bots/:id 属于「Bot」。 */
const activeKey = computed(() => {
  const name = route.name?.toString() ?? "";
  if (name === "bot-detail") return "bots";
  if (name === "chat") return "chats";
  if (name === "assignment-detail") return "assignments";
  return name;
});

/** 导航计数：会话未读、执行中任务（原型 NAV.count）。 */
const chatCount = computed(() => 0);
const runningTasks = computed(() => 0);
const pendingTotal = computed(() => bots.pendingCount);
const workingBots = computed(() => bots.workingCount);

/** 侧栏底部的身份色点阵（原型 .foot-roster）：一眼看出工作区里有谁。 */
const roster = computed(() =>
  bots.bots.map((b) => ({
    id: b.id,
    name: b.name,
    vars: botVars(b),
  })),
);

function navCount(key: string): number {
  if (key === "chats") return chatCount.value;
  if (key === "assignments") return runningTasks.value;
  return 0;
}

function onToggleTheme(): void {
  ui.toggleTheme();
}

/**
 * 退出登录：让服务端清掉 HttpOnly cookie，然后整页去登录页。
 *
 * 为什么不是纯前端「清 sessionStorage」：登录态的唯一权威是 cookie（HttpOnly，
 * JS 读不到也删不掉）。只清本地副本的话，刷新后 cookie 仍在，用户会「退不出去」。
 * 请求失败也照样跳：登录页会清掉本地副本，至少不会卡在当前页。
 */
async function onLogout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    // 网络错误/已过期都无所谓，下面的跳转才是目的
  }
  // force：即使之前因「重置 token」关掉过自动跳转，退出也必须离开
  redirectToLogin(true);
}

void toasts;
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
        <span class="brand-text">
          <span class="brand-name">AgentBot</span>
          <span class="brand-sub">本地工作台</span>
        </span>
      </div>

      <nav class="nav" aria-label="主导航">
        <RouterLink
          v-for="item in NAV"
          :key="item.key"
          class="nav-item"
          :class="{ 'is-active': activeKey === item.key }"
          :to="item.to"
          :aria-current="activeKey === item.key ? 'page' : undefined"
          :title="item.label"
        >
          <AppIcon :name="item.icon" />
          <span class="nav-label">{{ item.label }}</span>
          <span
            v-if="navCount(item.key) > 0"
            class="nav-count"
            :class="{ 'is-alert': item.key === 'assignments' }"
          >{{ navCount(item.key) }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <div class="foot-roster" aria-hidden="true">
          <span
            v-for="dot in roster"
            :key="dot.id"
            class="roster-dot"
            :style="dot.vars"
            :title="dot.name"
          />
        </div>
        <div class="foot-card">
          <span class="live-dot" />
          <b>{{ pendingTotal }}</b><span>条待批权限</span>
        </div>
        <div class="foot-card">
          <span class="state-dot" :style="{ '--s': 'var(--state-working)' }" />
          <b>{{ workingBots }}</b><span>个在干活</span>
        </div>
        <!-- N1：初始化未完成时的轻提示，点回去继续（不阻断） -->
        <RouterLink
          v-if="showSetupHint"
          class="foot-card foot-card--link"
          to="/setup"
          :title="`初始化还有 ${setupRemaining} 步未完成，点这里继续`"
        >
          <span class="state-dot" :style="{ '--s': 'var(--color-warning)' }" />
          <b>{{ setupRemaining }}</b><span>初始化待完成</span>
        </RouterLink>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="crumb">
          <template v-for="(c, i) in crumbs" :key="`${c.text}-${i}`">
            <span v-if="i > 0" class="sep">/</span>
            <RouterLink v-if="c.to" :to="c.to">{{ c.text }}</RouterLink>
            <b v-else>{{ c.text }}</b>
          </template>
        </div>
        <div class="spacer" />
        <button class="chip-pending" @click="$router.push('/chats')">
          <span class="live-dot" />待批 {{ pendingTotal }}
        </button>
        <button
          class="icon-btn"
          :aria-label="isDark ? '切换到亮色主题' : '切换到暗色主题'"
          :title="isDark ? '切换到亮色主题' : '切换到暗色主题'"
          @click="onToggleTheme"
        >
          <AppIcon :name="isDark ? 'sun' : 'moon'" :size="16" />
        </button>
        <button class="icon-btn" aria-label="退出登录" title="退出登录" @click="onLogout">
          <AppIcon name="logout" :size="16" />
        </button>
      </header>

      <main class="page" :class="{ 'page--flush': route.meta['flush'] === true }">
        <RouterView />
      </main>
    </div>

    <Toast />
  </div>
</template>
