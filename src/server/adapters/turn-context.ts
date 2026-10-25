import type { SessionHandle } from "./contract.js";

/**
 * 一轮 Turn 的上下文（turnId + 助手 messageId）。
 *
 * 为什么单独放一个模块：`ChannelDriver` 契约已定稿（`prompt(h, {text})` 不接受 turnId），
 * 但 `message_delta` 必须带正确的 messageId 才能写进 `messages.content`。
 * 通道驱动不生成业务 id —— 业务 id 归编排层，所以编排层在 `prompt` 前 set 一次，
 * 驱动在产出事件时读它。
 *
 * 这个文件刻意不含任何协议名：core 需要 import 它，而 core 不得出现协议字符串。
 * 驱动侧只在 `prompt` 开始时读一次快照，之后本轮的 turnId 就固定了（会话锁保证串行）。
 */

export interface TurnContext {
  turnId: string;
  /** 本轮助手消息 id（`messages` 行已由编排层建好）。 */
  messageId: string;
  /** 本轮归属的 Bot（事件 payload 带 botId，群聊里靠它区分发言人）。 */
  botId: string;
}

const contexts = new WeakMap<SessionHandle, TurnContext>();

export function setTurnContext(h: SessionHandle, ctx: TurnContext): void {
  contexts.set(h, ctx);
}

export function getTurnContext(h: SessionHandle): TurnContext | null {
  return contexts.get(h) ?? null;
}

export function clearTurnContext(h: SessionHandle): void {
  contexts.delete(h);
}

/**
 * 给事件 payload 补 `botId`。
 *
 * 前端明确要求：群聊里主持人 ≠ 发言人，只靠主持人兜底会让 Turn 头写错名字。
 * 通道驱动不关心这条语义，统一在编排层补（这里只提供工具函数）。
 */
export function withBotId<T extends Record<string, unknown>>(payload: T, botId: string): T & { botId: string } {
  return { ...payload, botId };
}
