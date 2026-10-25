import type { CSSProperties } from "vue";

/**
 * 身份色变量（原型 botVars()）。
 *
 * 原型在每处内联 `--bc / --bc-ink / --bc-tint / --c`，CSS 里的 .bc-name、.bubble--bot、
 * .turn-head::before 等再读这些变量。这里保持同一套变量名，样式表才能逐字照抄。
 */
export interface BotColorLike {
  colorIndex: number;
}

export function botVars(bot: BotColorLike): CSSProperties {
  const n = bot.colorIndex >= 1 && bot.colorIndex <= 8 ? bot.colorIndex : 8;
  return {
    "--bc": `var(--bot-${n})`,
    "--bc-ink": `var(--bot-${n}-ink)`,
    "--bc-tint": `var(--bot-${n}-tint)`,
    "--c": `var(--bot-${n})`,
  } as CSSProperties;
}

/** 头像首字：优先用显式 avatar，否则取名称首字符（中文取首字，英文取首字母）。 */
export function initialOf(name: string, avatar?: string | null): string {
  if (avatar && avatar.trim().length > 0) return avatar.trim().slice(0, 1);
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 1) : "?";
}

/** 六态中文（原型 STATE_WORD）。 */
export const STATE_WORD = {
  idle: "空闲",
  thinking: "思考中",
  working: "工作中",
  waiting: "等待中",
  blocked: "受阻",
  done: "完成",
} as const;
