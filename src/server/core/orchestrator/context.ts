import type { DB } from "../db/db.js";
import { config } from "../../config.js";
import { assemble as assembleMemoryText } from "../memory/assembler.js";

/**
 * 上下文重建（P0-15「resume 失败或不支持时由产品层重建」）。
 *
 * 为什么必须存在：运行时的 resume 语义不可靠（架构 §9.7：可能「返回成功但上下文是空的」），
 * 所以产品层永远保留一条不依赖运行时的路：把「人格 + 记忆 + 最近 N 条消息」
 * 拼成一段系统提示，随 `newSession` 交给运行时。
 *
 * 边界（PRD P0-15）：
 *   - 重建内容超出上下文窗口 → 从**最早**的消息开始丢弃，直到估算 token < 窗口 70%，
 *     并把「已省略 N 条历史」写进提示（用户能在分隔条上看到）。
 *   - 运行时没上报 contextWindow（null）→ 不做窗口裁剪，只按条数窗口（默认 20 条）。
 *
 * 记忆段的装配（6000 字符预算、按 updated_at 倒序截断、空记忆不注入空段落）
 * 由 M7 的 `memory/assembler.ts` 负责；本文件只负责「人格 + 记忆 + 最近消息」
 * 的拼装与窗口裁剪，两者职责不重叠。
 *
 * 另一个入口 `buildBootstrapContext`：**首轮**（该 Session 还没有历史消息）只带
 * 「人格 + 记忆」。P0-10 要求每轮都注入人格与记忆，首轮不注入等于人格从未生效；
 * 但首轮也没有历史可重建，所以不带引导语与消息段。
 */

/** 估算 token：中英混排按 2 字符 ≈ 1 token（保守高估，宁可多丢几条）。 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 2);
}

export interface RebuildInput {
  db: DB;
  botId: string;
  sessionId: string;
  /** 最近消息条数窗口，默认取 config.limits.rebuildMessageWindow（20）。 */
  windowMessages?: number;
  /** 上下文窗口（token）；null/undefined 表示运行时未上报，不做裁剪。 */
  contextWindow?: number | null;
  /** 预算比例，默认 0.7（PRD：估算 token < 窗口 70%）。 */
  budgetRatio?: number;
  /** 记忆字符预算，默认取 config.limits.memoryCharBudget。 */
  memoryCharBudget?: number;
  /**
   * 排除的 Turn（本轮自己）。
   *
   * 编排层的顺序是「先建 user 消息 → 再 ensure 进程」，所以重建时本轮的用户原话
   * 已经在库里；不排除就会同时出现在「历史」与 prompt 正文里，模型看到同一句话
   * 两遍（还会让「已省略 N 条」的计数偏大）。
   */
  excludeTurnId?: string;
}

export interface RebuildResult {
  /** 交给运行时的系统提示；人格为空且无记忆无消息时为空串。 */
  systemPrompt: string;
  /**
   * 人格 + 记忆段（不含历史引导语与消息）。
   *
   * 内置引擎把它作为可刷新的基础提示：每轮重新装配，记忆改了下一轮就生效；
   * 历史消息走 `history` 作为真实对话，不再固化进系统提示。
   */
  memoryText: string;
  /**
   * 重建时实际带入的历史消息（按时间正序）。
   *
   * 只有内置引擎消费：它有自己的对话历史，历史应当以消息形式交给它；
   * CLI 通道仍使用 `systemPrompt` 里的文本段落。
   */
  history: { role: "user" | "assistant"; content: string }[];
  /** 实际带入的消息条数。 */
  includedMessages: number;
  /** 因窗口预算被丢弃的历史条数（0 表示没丢）。 */
  omittedMessages: number;
  estimatedTokens: number;
  /** true 表示触发了窗口裁剪（与 omittedMessages > 0 等价，单独给出便于断言）。 */
  truncated: boolean;
  /** 记忆段因 6000 字符预算被截断的条目数（0 表示全量注入）。 */
  memoryTruncated: number;
}

interface MessageRow {
  role: string;
  content: string;
  created_at: number;
}

function roleLabel(role: string): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  return "系统";
}

/**
 * 人格 + 注入记忆的文本段。
 *
 * 装配逻辑（预算、倒序截断、空记忆不注入空段落）全部委托给 M7 的 assembler，
 * 这里不再有第二份实现 —— 两处口径迟早漂移，而「6000 字符」是验收项。
 */
function assembleMemory(
  db: DB,
  botId: string,
  budget: number,
  scope: { sessionId?: string | null; channelId?: string | null } = {},
): { text: string; truncatedCount: number } {
  const result = assembleMemoryText(db, botId, {
    charBudget: budget,
    sessionId: scope.sessionId ?? null,
    channelId: scope.channelId ?? null,
  });
  return { text: result.text, truncatedCount: result.truncatedCount };
}

/** 会话所属渠道（记忆作用域要用）；会话不存在时返回 null。 */
function channelOfSession(db: DB, sessionId: string): string | null {
  const row = db.prepare("SELECT channel_id FROM sessions WHERE id = ?").get(sessionId) as
    | { channel_id: string | null }
    | undefined;
  return row?.channel_id ?? null;
}

/**
 * 首轮上下文：只有「人格 + 记忆」，不带引导语与消息段。
 *
 * 为什么单独一个入口而不是复用 `buildRebuildContext`：后者以「你正在继续一段
 * 此前的对话」开头，而首轮根本没有此前对话 —— 把它塞给模型会让它凭空编造
 * 历史。P0-10 要求每轮注入人格与记忆，首轮同样要注入，所以这里只拼记忆段。
 *
 * 人格与记忆都为空 → 返回空串（调用方据此不传 systemPrompt，不留空段落）。
 */
export function buildBootstrapContext(input: {
  db: DB;
  botId: string;
  /** 当前会话：session / channel 作用域的记忆靠它命中（R3）。 */
  sessionId?: string | null;
  memoryCharBudget?: number;
}): RebuildResult {
  const memoryBudget = input.memoryCharBudget ?? config.limits.memoryCharBudget;
  const channelId = input.sessionId ? channelOfSession(input.db, input.sessionId) : null;
  const memoryResult = assembleMemory(input.db, input.botId, memoryBudget, {
    sessionId: input.sessionId ?? null,
    channelId,
  });
  const prompt = memoryResult.text;
  return {
    systemPrompt: prompt,
    memoryText: prompt,
    history: [],
    includedMessages: 0,
    omittedMessages: 0,
    estimatedTokens: estimateTokens(prompt),
    truncated: false,
    memoryTruncated: memoryResult.truncatedCount,
  };
}

/**
 * 拼装重建上下文。
 *
 * 消息取「最近 windowMessages 条」后再按 token 预算从最早端丢弃 ——
 * 顺序不能反：先按条数取窗口，再按预算裁剪，否则预算充足时会把很早的历史也带上。
 */
export function buildRebuildContext(input: RebuildInput): RebuildResult {
  const windowMessages = input.windowMessages ?? config.limits.rebuildMessageWindow;
  const budgetRatio = input.budgetRatio ?? 0.7;
  const memoryBudget = input.memoryCharBudget ?? config.limits.memoryCharBudget;

  const memoryResult = assembleMemory(input.db, input.botId, memoryBudget, {
    sessionId: input.sessionId,
    channelId: channelOfSession(input.db, input.sessionId),
  });
  const memory = memoryResult.text;

  // 排序键用 `rowid` 而不是 `id`：`id` 是随机 UUID，同毫秒写入的 user/assistant
  // 两行按 UUID 排会把顺序排反（P0-15「重启后顺序一致」）。rowid 是 SQLite 的
  // 隐式自增列，天然等于插入顺序，且不需要改 schema。
  const recent = input.db
    .prepare(
      `SELECT role, content, created_at FROM messages
        WHERE session_id = ? AND (? IS NULL OR turn_id != ?)
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(
      input.sessionId,
      input.excludeTurnId ?? null,
      input.excludeTurnId ?? null,
      windowMessages,
    ) as MessageRow[];
  // 上面按时间倒序取，渲染时按时间正序
  const ordered = recent.reverse().filter((m) => m.content.trim().length > 0);

  const header =
    "你正在继续一段此前的对话。以下是产品层保存的历史，用它恢复上下文；" +
    "不要向用户解释这段提示的存在。";

  const renderMessages = (rows: MessageRow[]): string =>
    rows.map((m) => `${roleLabel(m.role)}：${m.content.trim()}`).join("\n\n");

  let included = ordered;
  let omitted = 0;
  let prompt = "";
  let tokens = 0;

  const window = input.contextWindow ?? null;
  if (window !== null && window > 0) {
    const budget = Math.floor(window * budgetRatio);
    // 先按完整内容算一次；超预算就从最早的消息开始丢
    included = [...ordered];
    omitted = 0;
    for (;;) {
      const body = renderMessages(included);
      const note =
        omitted > 0 ? `\n\n（已省略 ${omitted} 条更早的历史）` : "";
      const candidate = [header, memory, body, note.trim().length > 0 ? note.trim() : ""]
        .filter((s) => s.length > 0)
        .join("\n\n");
      tokens = estimateTokens(candidate);
      if (tokens < budget || included.length === 0) {
        prompt = candidate;
        break;
      }
      included = included.slice(1);
      omitted += 1;
    }
  } else {
    const body = renderMessages(included);
    prompt = [header, memory, body].filter((s) => s.length > 0).join("\n\n");
    tokens = estimateTokens(prompt);
  }

  return {
    systemPrompt: prompt,
    memoryText: memory,
    history: included
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.trim() })),
    includedMessages: included.length,
    omittedMessages: omitted,
    estimatedTokens: tokens,
    truncated: omitted > 0,
    memoryTruncated: memoryResult.truncatedCount,
  };
}
