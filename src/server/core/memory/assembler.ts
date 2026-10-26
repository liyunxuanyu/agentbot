import type { DB } from "../db/db.js";
import { config } from "../../config.js";
import { listInjected } from "../repo/memory.js";

/**
 * 记忆装配（M7，P0-10）：每轮注入「人格 + 标记注入的记忆」。
 *
 * 三条硬约束：
 *   ① **总字符 ≤ 6000**（`config.limits.memoryCharBudget`）。超了就按
 *      `updated_at` 倒序**保留最新的、丢最旧的**，并如实报告「已截断 N 条」。
 *   ② **记忆为空时不注入空段落**：不输出「## 记忆」这种只有标题的壳，
 *      也不输出「（无记忆）」占位 —— 那会让运行时以为存在一段空白记忆。
 *   ③ **人格也计入 6000**：PRD 写的是「人格 + 记忆」总字符 ≤6000。
 *      人格被截断是异常配置（PRD 限 4000），但仍要有确定行为：先保人格、
 *      再按倒序填记忆，人格自身超预算时硬截断并在 meta 里标出。
 *
 * 输出形状被 `orchestrator/context.ts` 直接消费（`systemPrompt` 片段 + 元信息）。
 */

export interface MemoryItemMeta {
  id: string;
  kind: "manual" | "summary";
  chars: number;
  updatedAt: number;
}

export interface AssembleMemoryResult {
  /** 可拼进系统提示的文本；人格与记忆都为空时为空串（调用方据此不加段落）。 */
  text: string;
  /** 实际注入的条目（按注入顺序，最新在前）。 */
  included: MemoryItemMeta[];
  /** 因预算被丢弃的条目数（PRD：「已截断 N 条」）。 */
  truncatedCount: number;
  /** 实际占用的字符数（含标题、分隔与截断提示；用于「本轮注入估算 x / 6000」）。 */
  usedChars: number;
  /** 预算值，方便前端显示分母。 */
  budget: number;
  /** 人格是否被硬截断（人格 > 预算时才会发生）。 */
  personaTruncated: boolean;
}

const PERSONA_HEADING = "## 人格";
const MEMORY_HEADING = "## 记忆";

function trimmed(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * 逐条累加并在超预算时停下。
 *
 * 注意是 **break 而不是 continue**：条目按 updated_at 倒序，一旦某条放不下，
 * 后面的只会更旧 —— 跳过一条继续塞更旧的，会让「截断顺序按 updated_at 倒序」
 * 这句话变成假的。代价是可能浪费一点剩余空间（一条超长条目挡住后面若干短条目），
 * 但这正是 PRD 要的确定性：先保最新，再从旧端整段丢。
 */
function packMemory(
  rows: { id: string; content: string; kind: "manual" | "summary"; updatedAt: number }[],
  budget: number,
  noteReserve: (dropped: number) => number,
): { lines: string[]; included: MemoryItemMeta[]; dropped: number; used: number } {
  const lines: string[] = [];
  const included: MemoryItemMeta[] = [];
  let used = 0;
  let dropped = 0;

  for (const [index, row] of rows.entries()) {
    const text = trimmed(row.content);
    if (text.length === 0) {
      // 空内容不占位、也不算「截断」：它本来就没有可注入的东西
      continue;
    }
    const line = `- ${text}`;
    // 预留：换行 + 尾部「已省略 N 条」提示（提示长度随被丢条数增长，取最坏情况估算）
    const remaining = rows.length - index;
    const reserve = noteReserve(remaining);
    if (used + line.length + 1 + reserve > budget) {
      dropped = remaining;
      break;
    }
    lines.push(line);
    included.push({ id: row.id, kind: row.kind, chars: text.length, updatedAt: row.updatedAt });
    used += line.length + 1;
  }

  return { lines, included, dropped, used };
}

export interface AssembleMemoryOptions {
  /** 覆盖预算（测试与调用方微调用；默认取 config）。 */
  charBudget?: number;
  /** 当前会话：session 作用域记忆靠它命中（R3）。 */
  sessionId?: string | null;
  /** 当前渠道：channel 作用域记忆靠它命中（群聊共享）。 */
  channelId?: string | null;
}

/**
 * 装配一个 Bot 的记忆段。
 *
 * 只读库，无副作用 —— 每轮调用都是最新状态，因此「保存后 1s 内生效」
 * 自然成立（下一条消息重新装配）。
 */
export function assemble(db: DB, botId: string, opts: AssembleMemoryOptions = {}): AssembleMemoryResult {
  const budget = Math.max(0, Math.floor(opts.charBudget ?? config.limits.memoryCharBudget));

  const bot = db.prepare("SELECT persona FROM bots WHERE id = ?").get(botId) as
    | { persona: string }
    | undefined;
  const personaRaw = trimmed(bot?.persona);

  // ---- 人格先占预算 ----
  let persona = personaRaw;
  let personaTruncated = false;
  let personaUsed = 0;
  if (persona.length > 0) {
    const overhead = PERSONA_HEADING.length + 1; // 标题 + 换行
    if (overhead + persona.length > budget) {
      const room = Math.max(0, budget - overhead - 1); // 留一个换行位
      persona = room > 0 ? `${persona.slice(0, room)}…` : "";
      personaTruncated = persona.length > 0;
      if (persona.length === 0) {
        // 预算小到连人格标题都放不下：人格整体不注入（不输出空壳）
        persona = "";
        personaTruncated = true;
      }
    }
    if (persona.length > 0) personaUsed = overhead + persona.length + 2; // +2：与记忆段之间的空行
  }

  // ---- 记忆：按 updated_at 倒序填剩余预算 ----
  // 只注入与当前会话/渠道匹配的作用域（R3）：bot 全局 + 本渠道共享 + 本会话。
  const rows = listInjected(db, botId, {
    sessionId: opts.sessionId ?? null,
    channelId: opts.channelId ?? null,
  }).map((r) => ({
    id: r.id,
    content: r.content,
    kind: r.kind,
    updatedAt: r.updatedAt,
  }));

  const remainingBudget = Math.max(0, budget - personaUsed);
  const noteLen = (n: number): number => (n > 0 ? `\n（记忆超出预算，已省略 ${n} 条）`.length : 0);

  let packed = { lines: [] as string[], included: [] as MemoryItemMeta[], dropped: 0, used: 0 };
  if (rows.length > 0 && remainingBudget > 0) {
    // 标题也要算进去；标题都放不下就一条都不注入（不输出空壳）
    const headingCost = MEMORY_HEADING.length + 1;
    if (remainingBudget > headingCost) {
      packed = packMemory(rows, remainingBudget - headingCost, noteLen);
    } else {
      packed = { lines: [], included: [], dropped: rows.length, used: 0 };
    }
  } else if (rows.length > 0) {
    packed = { lines: [], included: [], dropped: rows.length, used: 0 };
  }

  // ---- 拼文本：空的段落一律不出现 ----
  const sections: string[] = [];
  if (persona.length > 0) sections.push(`${PERSONA_HEADING}\n${persona}`);
  if (packed.lines.length > 0) {
    const tail = packed.dropped > 0 ? `\n（记忆超出预算，已省略 ${packed.dropped} 条）` : "";
    sections.push(`${MEMORY_HEADING}\n${packed.lines.join("\n")}${tail}`);
  }
  const text = sections.join("\n\n");

  return {
    text,
    included: packed.included,
    truncatedCount: packed.dropped,
    usedChars: text.length,
    budget,
    personaTruncated,
  };
}

/**
 * 只算预算占用，不产生文本（记忆页「本轮注入估算 3,120 / 6,000 字符」用）。
 * 与 assemble 共用同一条计算路径，避免两处口径漂移。
 */
export function estimate(db: DB, botId: string, opts: AssembleMemoryOptions = {}): AssembleMemoryResult {
  return assemble(db, botId, opts);
}
