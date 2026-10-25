import { defineStore } from "pinia";
import { computed, ref } from "vue";

/**
 * 全局 UI 状态：主题、面包屑、右面板、Toast。
 *
 * 主题落 localStorage（刷新保持），写 `document.documentElement.dataset.theme`，
 * 与 tokens.css 的 `[data-theme="dark"]` 对齐（架构 §7 / UI §2 暗色为可选主题）。
 */

export type Theme = "light" | "dark";

const THEME_KEY = "agentbot.theme";

export interface Crumb {
  text: string;
  to?: string;
}

export interface ToastItem {
  id: number;
  text: string;
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // 隐私模式读不到 localStorage：跟随系统
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export const useUiStore = defineStore("ui", () => {
  const theme = ref<Theme>(initialTheme());
  const crumbs = ref<Crumb[]>([]);
  /** 右面板（≥1280 常驻列 / <1280 抽屉）。 */
  const asideCollapsed = ref(false);
  const asideOpen = ref(false);
  const toasts = ref<ToastItem[]>([]);
  let toastSeq = 0;

  function applyTheme(): void {
    document.documentElement.dataset.theme = theme.value;
  }

  function toggleTheme(): void {
    theme.value = theme.value === "light" ? "dark" : "light";
    applyTheme();
    try {
      localStorage.setItem(THEME_KEY, theme.value);
    } catch {
      // 存不了也不影响本次会话
    }
  }

  function setCrumb(next: Crumb[]): void {
    crumbs.value = next;
  }

  function toggleAside(): void {
    // ≥1280 是常驻列：收起/展开列；<1280 是抽屉：滑出/收回
    if (window.matchMedia("(min-width: 1280px)").matches) {
      asideCollapsed.value = !asideCollapsed.value;
      return;
    }
    asideOpen.value = !asideOpen.value;
  }

  function closeAside(): void {
    asideOpen.value = false;
  }

  function toast(text: string): void {
    const id = ++toastSeq;
    toasts.value = [...toasts.value, { id, text }];
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, 3000);
  }

  const isDark = computed(() => theme.value === "dark");

  return {
    theme,
    isDark,
    crumbs,
    asideCollapsed,
    asideOpen,
    toasts,
    applyTheme,
    toggleTheme,
    setCrumb,
    toggleAside,
    closeAside,
    toast,
  };
});
