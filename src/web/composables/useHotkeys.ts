import { onBeforeUnmount, onMounted } from "vue";

/**
 * 全局快捷键（UX §8）。
 *
 * 三条硬要求：
 *   ① 在输入框里打字时**不**触发（`input/textarea/select/contenteditable` 一律让路）；
 *   ② 权限卡片的 A / R / Shift+A / Ctrl+Shift+A 只在有阻断型卡片时生效；
 *   ③ F6 跳到权限卡片，Esc 收起详情/弹层。
 *
 * 组合键判定用 `event.key.toLowerCase()` 而不是 `keyCode`（后者已废弃）。
 */

export type HotkeyHandler = (e: KeyboardEvent) => boolean | void;

export interface HotkeyMap {
  /** 单键（小写），如 "a"、"r"。 */
  [combo: string]: HotkeyHandler;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return target.isContentEditable;
}

/** 把事件归一成 `ctrl+shift+a` 这样的串。 */
function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(e.key.toLowerCase());
  return parts.join("+");
}

export function useHotkeys(handlers: HotkeyMap, options: { allowInInput?: string[] } = {}) {
  const allowInInput = new Set(options.allowInInput ?? []);

  function onKeydown(e: KeyboardEvent): void {
    const combo = comboOf(e);
    // Esc / F6 在输入框里也要生效（收起弹层、跳卡片）
    const globalAllowed = combo === "escape" || combo === "f6";
    if (!globalAllowed && isTypingTarget(e.target) && !allowInInput.has(combo)) return;

    const handler = handlers[combo];
    if (!handler) return;
    if (handler(e) !== false) e.preventDefault();
  }

  onMounted(() => window.addEventListener("keydown", onKeydown));
  onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
}
