import type { DB } from "../db/db.js";
import { sessionCwdOf } from "../process/supervisor.js";
import type { ChangedFile } from "./worktree.js";

/** 改动文件的前端形状（详情页用）。 */
export type ChangedFileDto = ChangedFile;

/**
 * Assignment 报告生成（P0-07「完成后生成 Markdown 报告（执行摘要、改动文件列表、用量）」）。
 *
 * 报告是**纯函数产物**：输入全部来自库（消息正文、事件、用量），
 * 不读进程状态、不依赖运行时 —— 这样失败/超时后仍能生成（PRD 要求保留已有产出）。
 *
 * 结构固定为四节，前端详情页按标题定位：
 *   ① 执行摘要  ② 改动文件  ③ 用量  ④（可选）最后 50 条事件
 *
 * 「改动文件」的行数来自 `git diff --numstat`；未跟踪文件记 `—` 而不是 0 ——
 * 编一个 0 会让用户以为那个文件没内容。
 */

export interface AssignmentReportInput {
  id: string;
  title: string;
  deliverable: string;
  botName: string;
  runtimeName: string | null;
  status: string;
  /** 执行位置（worktree 时是 worktree 路径，local 时是仓库路径）。 */
  executionPath: string | null;
  executionLocation: "local" | "worktree";
  startedAt: number | null;
  endedAt: number | null;
  /** 助手最终正文（执行摘要的原料）。 */
  summary: string;
  changed: { git: boolean; files: ChangedFile[]; message?: string };
  usage: { inputTokens: number | null; outputTokens: number | null; reported: boolean };
  /** 失败/超时时的事件尾部（最多 50 条，PRD 硬要求）。 */
  tailEvents: ReportEvent[];
  failReason: string | null;
  /** 会话里的消息数（卡片显示「N 条事件」的原料之一）。 */
  eventCount: number;
}

export interface ReportEvent {
  seq: number;
  type: string;
  createdAt: number;
  payload: unknown;
}

const TAIL_LIMIT = 50;

function fmtTime(ts: number | null): string {
  if (ts === null) return "—";
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(startedAt: number | null, endedAt: number | null): string {
  if (startedAt === null) return "—";
  const end = endedAt ?? Date.now();
  const ms = Math.max(0, end - startedAt);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return `${min}m ${rest}s`;
  const hour = Math.floor(min / 60);
  return `${hour}h ${min % 60}m`;
}

function fmtTokens(n: number | null): string {
  // 未上报就是 —（P0-12 不估算）
  if (n === null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** 摘要取正文前 N 行/字符：报告要能扫读，不是把全文再贴一遍。 */
function summarize(text: string, maxLines = 6, maxChars = 700): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "（运行时没有返回正文）";
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const head = lines.slice(0, maxLines).join("\n");
  if (head.length > maxChars) return `${head.slice(0, maxChars)}…`;
  return lines.length > maxLines ? `${head}\n…（共 ${lines.length} 行，完整内容见会话）` : head;
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 事件 payload 的一行摘要（失败报告里要能看懂发生了什么）。 */
function eventLine(ev: ReportEvent): string {
  const p = (typeof ev.payload === "object" && ev.payload !== null ? ev.payload : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
  switch (ev.type) {
    case "message_delta": {
      const text = oneLine(str("text"), 120);
      return text.length > 0 ? `正文 +${str("text").length} 字符：${text}` : "正文分片（空）";
    }
    case "thought":
      return `思考：${oneLine(str("text"), 100)}`;
    case "tool_call":
      return `工具调用 ${str("name") || str("callId")} · ${str("status")}`;
    case "tool_result":
      return `工具结果 ${str("callId")} · ${str("status")}${typeof p["exitCode"] === "number" ? `（exit ${String(p["exitCode"])}）` : ""}`;
    case "permission_request":
      return `权限请求 ${str("action")} ${str("target")}`;
    case "usage":
      return `用量 in=${String(p["inputTokens"] ?? "—")} out=${String(p["outputTokens"] ?? "—")}`;
    case "done":
      return `结束 · ${str("stopReason")}`;
    case "error":
      return `错误 ${str("code")}：${oneLine(str("message"), 160)}`;
    case "plan":
      return "计划更新";
    default:
      return ev.type;
  }
}

/** 生成 Markdown 报告。失败/超时时自动附「最后 50 条事件」。 */
export function renderReport(input: AssignmentReportInput): string {
  const lines: string[] = [];
  const statusLabel =
    input.status === "done"
      ? "已完成"
      : input.status === "failed"
        ? "失败"
        : input.status === "timeout"
          ? "超时"
          : input.status === "cancelled"
            ? "已取消"
            : input.status;

  lines.push(`# ${input.title}`);
  lines.push("");
  lines.push(
    `> 状态 **${statusLabel}** · 执行 Bot **${input.botName}**${input.runtimeName ? `（${input.runtimeName}）` : ""} · ${input.executionLocation === "worktree" ? "git worktree" : "local"} · 耗时 ${fmtDuration(input.startedAt, input.endedAt)}`,
  );
  lines.push("");

  // ① 执行摘要
  lines.push("## 执行摘要");
  lines.push("");
  if (input.failReason) {
    lines.push(`失败原因：${input.failReason}`);
    lines.push("");
  }
  lines.push(`交付物：${oneLine(input.deliverable, 400)}`);
  lines.push("");
  lines.push(summarize(input.summary));
  lines.push("");

  // ② 改动文件
  lines.push("## 改动文件");
  lines.push("");
  if (!input.changed.git) {
    lines.push(`无法统计：${input.changed.message ?? "执行目录不是 git 仓库"}`);
  } else if (input.changed.files.length === 0) {
    lines.push("本轮没有文件改动。");
  } else {
    lines.push("| 文件 | 状态 | + | − |");
    lines.push("|---|---|---|---|");
    for (const f of input.changed.files) {
      const ins = f.insertions === null ? "—" : `+${f.insertions}`;
      const del = f.deletions === null ? "—" : `−${f.deletions}`;
      lines.push(`| \`${f.path}\` | \`${f.status.trim() || "M"}\` | ${ins} | ${del} |`);
    }
    const totalIns = input.changed.files.reduce((s, f) => s + (f.insertions ?? 0), 0);
    const totalDel = input.changed.files.reduce((s, f) => s + (f.deletions ?? 0), 0);
    lines.push("");
    lines.push(`合计 ${input.changed.files.length} 个文件，+${totalIns} / −${totalDel} 行。`);
  }
  lines.push("");

  // ③ 用量
  lines.push("## 用量");
  lines.push("");
  if (input.usage.reported) {
    lines.push(`- 输入：${fmtTokens(input.usage.inputTokens)} token`);
    lines.push(`- 输出：${fmtTokens(input.usage.outputTokens)} token`);
  } else {
    lines.push("- 运行时未上报用量（不估算，见 P0-12）");
  }
  lines.push(`- 事件数：${input.eventCount}`);
  lines.push(`- 执行位置：\`${input.executionPath ?? "（未配置）"}\``);
  lines.push("");

  // ④ 失败/超时的最后 50 条事件（PRD 边界处理硬要求）
  if (input.tailEvents.length > 0) {
    lines.push("## 最后 50 条事件");
    lines.push("");
    lines.push("```");
    for (const ev of input.tailEvents) {
      const time = new Date(ev.createdAt).toISOString().slice(11, 19);
      lines.push(`[${time}] #${ev.seq} ${eventLine(ev)}`);
    }
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 从库里取报告原料
// ---------------------------------------------------------------------------

interface AssignmentRow {
  id: string;
  title: string;
  deliverable: string;
  bot_id: string;
  source_channel_id: string | null;
  session_id: string | null;
  worktree_path: string | null;
  status: string;
  report: string | null;
  fail_reason: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

/** 报告原料的装配：一次查完，供 `POST`/`GET /report.md` 与 runner 复用。 */
export function collectReportInput(
  db: DB,
  assignmentId: string,
  changed: { git: boolean; files: ChangedFile[]; message?: string },
  tailLimit = TAIL_LIMIT,
): AssignmentReportInput | null {
  const row = db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignmentId) as
    | AssignmentRow
    | undefined;
  if (!row) return null;

  const bot = db
    .prepare(
      `SELECT b.name, b.execution_location, b.repo_path, b.worktree_path, r.display_name
         FROM bots b LEFT JOIN runtime_definitions r ON r.id = b.default_runtime_id
        WHERE b.id = ?`,
    )
    .get(row.bot_id) as
    | {
        name: string;
        execution_location: string;
        repo_path: string | null;
        worktree_path: string | null;
        display_name: string | null;
      }
    | undefined;

  let summary = "";
  let eventCount = 0;
  const tailEvents: ReportEvent[] = [];

  if (row.session_id) {
    const msg = db
      .prepare(
        `SELECT content FROM messages
          WHERE session_id = ? AND role = 'assistant'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.session_id) as { content: string } | undefined;
    summary = msg?.content ?? "";

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
      .get(row.session_id) as { n: number };
    eventCount = count.n;

    const rows = db
      .prepare(
        `SELECT seq, type, payload, created_at FROM events
          WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(row.session_id, tailLimit) as {
      seq: number;
      type: string;
      payload: string;
      created_at: number;
    }[];
    for (const r of rows.reverse()) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(r.payload) as unknown;
      } catch {
        payload = null;
      }
      tailEvents.push({ seq: r.seq, type: r.type, createdAt: r.created_at, payload });
    }
  }

  const usage = row.session_id
    ? (db
        .prepare(
          `SELECT SUM(CASE WHEN tokens_in IS NULL AND tokens_out IS NULL THEN 0 ELSE 1 END) AS reported,
                  SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout
             FROM messages WHERE session_id = ?`,
        )
        .get(row.session_id) as { reported: number; tin: number; tout: number })
    : { reported: 0, tin: 0, tout: 0 };

  const executionLocation = bot?.execution_location === "worktree" ? "worktree" : "local";
  // 路径按「实际生效」取：Bot 没配路径时就是服务进程 cwd（与 Supervisor spawn 的 cwd 一致），
  // 报告里写「未配置」会让用户以为任务没落地目录
  const executionPath =
    row.worktree_path ??
    (executionLocation === "worktree" ? (bot?.worktree_path ?? null) : (bot?.repo_path ?? null)) ??
    sessionCwdOf(db, row.bot_id);

  return {
    id: row.id,
    title: row.title,
    deliverable: row.deliverable,
    botName: bot?.name ?? "（已删除的 Bot）",
    runtimeName: bot?.display_name ?? null,
    status: row.status,
    executionPath,
    executionLocation,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary,
    changed,
    usage: {
      inputTokens: usage.reported > 0 ? usage.tin : null,
      outputTokens: usage.reported > 0 ? usage.tout : null,
      reported: usage.reported > 0,
    },
    // 只有失败/超时才附事件尾巴：成功的报告附 50 条事件是噪音
    tailEvents: row.status === "failed" || row.status === "timeout" ? tailEvents : [],
    failReason: row.fail_reason,
    eventCount,
  };
}

/** 报告里「最后 50 条事件」的条数上限（对外暴露给测试与 DTO）。 */
export const REPORT_TAIL_LIMIT = TAIL_LIMIT;

/**
 * 从已生成的报告里解析「改动文件」表。
 *
 * 为什么不在详情接口里重跑 `git status`：报告是那一刻的事实快照；
 * 之后用户又改了文件，重跑 git 会给出与报告不一致的数字。详情页要与报告一致。
 */
export function parseChangedFilesFromReport(markdown: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  const lines = markdown.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      inSection = line.trim() === "## 改动文件";
      continue;
    }
    if (!inSection) continue;
    // 形如：| `src/a.ts` | `M` | +12 | −3 |
    const m = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const path = m[1] ?? "";
    if (path.length === 0) continue;
    const status = m[2] ?? "";
    const plus = (m[3] ?? "").trim();
    const minus = (m[4] ?? "").trim();
    const num = (v: string): number | null => {
      if (v === "—" || v.length === 0) return null;
      const n = Number.parseInt(v.replace(/^[+−-]/, ""), 10);
      return Number.isFinite(n) ? n : null;
    };
    out.push({ path, status, insertions: num(plus), deletions: num(minus) });
  }
  return out;
}
