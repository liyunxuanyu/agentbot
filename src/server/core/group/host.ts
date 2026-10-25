import type { DB } from "../db/db.js";
import type { TurnOrchestrator } from "../orchestrator/turn.js";

/**
 * 群聊主持人决策（M10 / P0-06）。
 *
 * 一次用户消息的完整链路：
 *
 *   用户消息 → 主持人 Bot 跑一轮 Turn（prompt 要求返回结构化 JSON）
 *            → 解析出 0–3 个发言人（@ 必被包含且优先）
 *            → 交给 dispatcher 依次执行
 *
 * 五条硬要求（PRD P0-06 + 03-decisions Q3）：
 *   ① **未被点名的 Bot 产生 0 次运行时调用**：本文件只决定「名单」，
 *      谁不在名单里就根本没有 Turn，没有 spawn、没有 prompt。
 *   ② **@ 必被包含且优先**：名单以 @ 为前缀，主持人无法用任何理由剔除被点名者。
 *   ③ **单条用户消息触发的发言人数 ≤3**：超出直接截断（不是报错）。
 *   ④ **不存在的 Bot 丢弃并记 warning**，剩余合法名单照常执行。
 *   ⑤ **主持人不可用/超时/非 JSON 都有明确降级**，不假装决策成功。
 *
 * 主持人这一轮 Turn 本身会出现在会话流里（UX F2 第 1 步：折叠为
 * 「主持人在决定发言人…」一行），它记录的用户消息正文是**用户原文**而不是
 * 主持人的内部 prompt —— 这是 `userMessageText` 存在的唯一理由。
 */

/** 主持人只关心渠道的这三项；不 import http/ 的 DTO（core 不依赖表现层）。 */
export interface ChannelRef {
  id: string;
  participantBotIds: readonly string[];
  hostBotId: string | null;
}

/** 发言人上限：PRD 硬要求 ≤3（含 @ 强制加入的名额）。 */
export const MAX_SPEAKERS = 3;

/** 主持人决策超时。PRD 写 5s，但真实 CLI 一轮 20s+，所以这里给可配置的宽限。 */
export const DEFAULT_DECISION_TIMEOUT_MS = 20_000;

export type DegradeReason =
  | "none"
  | "no_host"
  | "host_unavailable"
  | "host_error"
  | "timeout"
  | "non_json"
  | "empty_list";

export interface Speaker {
  botId: string;
  /** 主持人给的理由（原样展示，P1-06）；@ 强制加入的是「用户点名」。 */
  reason: string;
}

export interface ParsedReply {
  speakers: Speaker[];
  skipReason: string | null;
  /** 非结构化回复时置 true（调用方据此决定要不要标降级）。 */
  nonJson: boolean;
  warnings: string[];
}

export interface HostDecision {
  hostBotId: string | null;
  speakers: Speaker[];
  /** 空名单时给前端展示的原因（「本轮无 Bot 发言」下方那行）。 */
  skipReason: string | null;
  /** 本轮未发言 Bot 的排除说明（P1-06 展开用；本轮只收集不渲染）。 */
  warnings: string[];
  degraded: DegradeReason;
  /** 群内系统提示（主持人不可用 / 超时 / 丢弃了不存在的 Bot）。 */
  notice: string | null;
  /** 主持人自己的 Turn；null 表示没跑（不可用/没有主持人）。 */
  hostTurn: { turnId: string; sessionId: string; messageId: string } | null;
}

export interface HostDeps {
  db: DB;
  orchestrator: TurnOrchestrator;
  /** 运行时是否可用；不可用时降级为「@ 谁谁回」。 */
  isRuntimeAvailable(botId: string): boolean;
  decisionTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Participant {
  id: string;
  name: string;
  persona: string;
}

function participantsOf(db: DB, ids: readonly string[]): Participant[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, name, persona FROM bots WHERE id IN (${placeholders})`)
    .all(...ids) as Participant[];
  // 保持渠道里的顺序（前端 @ 选择器也按这个顺序）
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is Participant => r !== undefined);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 从自由文本里抠出第一个 JSON 对象（主持人常带 ```json 围栏或前后寒暄）。 */
function extractJsonObject(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * 解析主持人回复（纯函数，单测直接覆盖 0/1/3/5 个发言人、不存在的 Bot、非 JSON）。
 *
 * 结构化形态：`{ "speakers": [{ "botId": "...", "reason": "..." }], "skipReason": "..." }`
 * 也接受 `speakers: ["botId"]` 这种偷懒写法（LLM 常见）。
 */
export function parseHostReply(
  text: string,
  participants: readonly Participant[],
  hostBotId: string | null,
  maxSpeakers = MAX_SPEAKERS,
): ParsedReply {
  const valid = new Set(participants.map((p) => p.id));
  const warnings: string[] = [];

  const normalize = (raw: unknown): Speaker[] => {
    if (!Array.isArray(raw)) return [];
    const out: Speaker[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      let botId = "";
      let reason = "";
      if (typeof item === "string") {
        botId = item.trim();
      } else if (isRecord(item)) {
        const id = item["botId"] ?? item["bot_id"] ?? item["id"];
        const r = item["reason"] ?? item["why"];
        botId = typeof id === "string" ? id.trim() : "";
        reason = typeof r === "string" ? r.trim() : "";
      }
      if (botId.length === 0) continue;
      if (!valid.has(botId)) {
        // ① 不存在的 Bot：丢弃这一项，其余照常（PRD 边界处理）
        warnings.push(`主持人点名了不存在的 Bot：${botId}（已忽略）`);
        continue;
      }
      if (seen.has(botId)) continue;
      seen.add(botId);
      out.push({ botId, reason });
    }
    return out;
  };

  const parsed = extractJsonObject(text);
  if (isRecord(parsed)) {
    const speakers = normalize(parsed["speakers"] ?? parsed["list"]);
    const skipRaw = parsed["skipReason"] ?? parsed["skip_reason"];
    const skipReason = typeof skipRaw === "string" && skipRaw.trim().length > 0 ? skipRaw.trim() : null;

    // 超过上限：截断而不是报错（PRD「总数 ≤3」）
    if (speakers.length > maxSpeakers) {
      warnings.push(`主持人返回 ${speakers.length} 个发言人，已截断到 ${maxSpeakers} 个`);
    }
    return {
      speakers: speakers.slice(0, maxSpeakers),
      skipReason,
      nonJson: false,
      warnings,
    };
  }

  // ---- 非 JSON 降级：先按名字/ID 在文本里找，找不到取第一个参与者 ----
  warnings.push("主持人回复不是结构化 JSON，已按文本匹配降级");
  const matched: Speaker[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    if (seen.has(p.id)) continue;
    // 名字要够长才匹配，避免「助手」这种常见词误命中
    const byName = p.name.trim().length >= 2 && text.includes(p.name);
    if (!byName && !text.includes(p.id)) continue;
    seen.add(p.id);
    matched.push({ botId: p.id, reason: "主持人文本中提到" });
    if (matched.length >= maxSpeakers) break;
  }
  if (matched.length > 0) {
    return { speakers: matched, skipReason: null, nonJson: true, warnings };
  }

  const fallback = participants.find((p) => p.id !== hostBotId) ?? participants[0];
  if (!fallback) {
    return { speakers: [], skipReason: "群内没有可用参与者", nonJson: true, warnings };
  }
  warnings.push(`无法从回复里识别发言人，已默认取 ${fallback.name}`);
  return {
    speakers: [{ botId: fallback.id, reason: "主持人回复无法解析，按默认顺序取第一位" }],
    skipReason: null,
    nonJson: true,
    warnings,
  };
}

/**
 * @ 优先规则（P0-06「用户 @ 某 Bot 时该 Bot 必被包含且优先」）。
 *
 * 被点名的 Bot 排在名单最前，主持人名单里重复的去掉，总数仍受 ≤3 约束。
 * 点名了不在群里的 Bot：忽略并记 warning（不能把群外的 Bot 拉进来）。
 */
export function applyMentions(
  speakers: readonly Speaker[],
  mentionBotIds: readonly string[],
  participants: readonly Participant[],
  maxSpeakers = MAX_SPEAKERS,
): { speakers: Speaker[]; warnings: string[] } {
  const warnings: string[] = [];
  const valid = new Set(participants.map((p) => p.id));

  const mentioned: Speaker[] = [];
  const seen = new Set<string>();
  for (const raw of mentionBotIds) {
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    if (!valid.has(id)) {
      warnings.push(`@ 了不在群里的 Bot：${id}（已忽略）`);
      continue;
    }
    seen.add(id);
    mentioned.push({ botId: id, reason: "用户点名" });
  }
  if (mentioned.length === 0) {
    return { speakers: speakers.slice(0, maxSpeakers), warnings };
  }
  if (mentioned.length > maxSpeakers) {
    warnings.push(`用户点名 ${mentioned.length} 个 Bot，超出单轮上限，只保留前 ${maxSpeakers} 个`);
  }

  const out = [...mentioned.slice(0, maxSpeakers)];
  for (const s of speakers) {
    if (out.length >= maxSpeakers) break;
    if (out.some((x) => x.botId === s.botId)) continue;
    out.push(s);
  }
  return { speakers: out, warnings };
}

function buildHostPrompt(
  text: string,
  participants: readonly Participant[],
  mentions: readonly string[],
  maxSpeakers: number,
): string {
  const lines = participants.map((p) => {
    const persona = p.persona.trim().replace(/\s+/g, " ").slice(0, 120);
    return `- ${p.name}（botId: ${p.id}）${persona.length > 0 ? `：${persona}` : ""}`;
  });
  const mentioned = mentions.filter((m) => participants.some((p) => p.id === m));
  const mentionText =
    mentioned.length === 0
      ? "无"
      : mentioned
          .map((id) => participants.find((p) => p.id === id)?.name ?? id)
          .join("、");

  return [
    "你是这个群聊的主持人。请根据用户消息决定本轮由哪些 Bot 发言。",
    "",
    "群成员：",
    ...lines,
    "",
    `用户消息：`,
    '"""',
    text,
    '"""',
    "",
    `用户点名：${mentionText}`,
    "",
    "只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码围栏：",
    '{"speakers":[{"botId":"成员的 botId","reason":"一句话理由"}],"skipReason":""}',
    "",
    "规则：",
    `1. speakers 最多 ${maxSpeakers} 个，按发言顺序排列。`,
    "2. 用户点名的人必须排在最前。",
    "3. botId 必须来自上面的成员列表，不要编造。",
    "4. 没有合适的发言人选时给空数组，并在 skipReason 里写清原因。",
  ].join("\n");
}

interface WaitResult {
  status: "done" | "failed" | "interrupted" | "timeout";
  content: string;
}

/**
 * 等一轮 Turn 收口（主持人决策与 dispatcher 的顺序派发共用）。
 *
 * 为什么轮询 `messages.status` 而不是订阅事件总线：正文的权威副本就是
 * `messages.content`（P0-04/P0-15），状态从 streaming 变终态即代表这一轮结束；
 * 事件总线在「订阅晚于收口」时会漏帧，轮询没有这个竞态。
 */
export async function waitTurnDone(
  db: DB,
  turnId: string,
  timeoutMs: number,
  pollMs = 50,
): Promise<WaitResult> {
  const stmt = db.prepare(
    "SELECT content, status FROM messages WHERE turn_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = stmt.get(turnId) as { content: string; status: string } | undefined;
    if (row && row.status !== "streaming") {
      const status: WaitResult["status"] =
        row.status === "done" ? "done" : row.status === "interrupted" ? "interrupted" : "failed";
      return { status, content: row.content };
    }
    if (Date.now() >= deadline) {
      return { status: "timeout", content: row?.content ?? "" };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * 主持人决策入口。
 *
 * 返回的 `speakers` 已经是「可执行名单」：合法、去重、≤3、@ 优先。
 * 调用方（dispatcher）不得再增删，只能照单执行 —— 否则「未点名 0 调用」会被破坏。
 */
export async function decideSpeakers(
  deps: HostDeps,
  channel: ChannelRef,
  text: string,
  mentionBotIds: readonly string[],
): Promise<HostDecision> {
  const log = deps.log ?? ((m: string) => console.warn(`[group] ${m}`));
  const timeoutMs = deps.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const participants = participantsOf(deps.db, channel.participantBotIds);

  // 没有主持人（或主持人不在群里）：降级为「@ 谁谁回」
  const hostId =
    channel.hostBotId && channel.participantBotIds.includes(channel.hostBotId)
      ? channel.hostBotId
      : null;

  if (!hostId) {
    const merged = applyMentions([], mentionBotIds, participants);
    return {
      hostBotId: null,
      speakers: merged.speakers,
      skipReason: merged.speakers.length === 0 ? "本群没有设置主持人" : null,
      warnings: merged.warnings,
      degraded: "no_host",
      notice:
        merged.speakers.length === 0
          ? "本群没有设置主持人，本轮改为 @ 谁谁回"
          : "本群没有设置主持人，本轮只回复被 @ 的 Bot",
      hostTurn: null,
    };
  }

  // 主持人运行时不可用：不发起任何调用，直接降级（P0-06 边界处理）
  if (!deps.isRuntimeAvailable(hostId)) {
    const merged = applyMentions([], mentionBotIds, participants);
    return {
      hostBotId: hostId,
      speakers: merged.speakers,
      skipReason: merged.speakers.length === 0 ? "主持人不可用" : null,
      warnings: merged.warnings,
      degraded: "host_unavailable",
      notice: "主持人不可用，本轮改为 @ 谁谁回",
      hostTurn: null,
    };
  }

  const prompt = buildHostPrompt(text, participants, mentionBotIds, MAX_SPEAKERS);

  let hostTurn: HostDecision["hostTurn"] = null;
  let reply = "";
  let waitStatus: WaitResult["status"] = "failed";

  try {
    const info = await deps.orchestrator.start({
      channelId: channel.id,
      botId: hostId,
      text: prompt,
      // 主持人这一轮记录的用户消息是**用户原文**，不是内部 prompt
      userMessageText: text,
      source: "interactive",
    });
    hostTurn = { turnId: info.turnId, sessionId: info.sessionId, messageId: info.messageId };
    const waited = await waitTurnDone(deps.db, info.turnId, timeoutMs);
    reply = waited.content;
    waitStatus = waited.status;
  } catch (err) {
    log(`主持人 Turn 启动失败：${err instanceof Error ? err.message : String(err)}`);
    waitStatus = "failed";
  }

  if (waitStatus === "timeout" || waitStatus === "failed") {
    // 超时/失败：不猜名单，按「@ 谁谁回」降级（与主持人不可用同一语义）
    const merged = applyMentions([], mentionBotIds, participants);
    return {
      hostBotId: hostId,
      speakers: merged.speakers,
      skipReason: merged.speakers.length === 0 ? "主持人没有给出名单" : null,
      warnings: merged.warnings,
      degraded: waitStatus === "timeout" ? "timeout" : "host_error",
      notice:
        waitStatus === "timeout"
          ? `主持人 ${Math.round(timeoutMs / 1000)}s 内没有给出名单，本轮改为 @ 谁谁回`
          : "主持人这一轮失败了，本轮改为 @ 谁谁回",
      hostTurn,
    };
  }

  const parsed = parseHostReply(reply, participants, hostId);
  const merged = applyMentions(parsed.speakers, mentionBotIds, participants);
  const warnings = [...parsed.warnings, ...merged.warnings];

  if (merged.speakers.length === 0) {
    return {
      hostBotId: hostId,
      speakers: [],
      skipReason: parsed.skipReason ?? "主持人判断本轮无需发言",
      warnings,
      degraded: parsed.nonJson ? "non_json" : "empty_list",
      notice: warnings.find((w) => w.includes("不存在")) ?? null,
      hostTurn,
    };
  }

  return {
    hostBotId: hostId,
    speakers: merged.speakers,
    skipReason: null,
    warnings,
    degraded: parsed.nonJson ? "non_json" : "none",
    notice: warnings.find((w) => w.includes("不存在")) ?? null,
    hostTurn,
  };
}
