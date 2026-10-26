import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 「临时目录不是 git 仓库」这个前提，在某些机器上不成立 —— 本机就是：
 * `%TEMP%` 位于 `C:/Users/<用户>` 之下，而用户主目录本身被 git init 过，
 * 于是 `git status` 从临时目录往上找到了祖先仓库，`listChangedFiles` 会如实
 * 报告那个仓库的改动，而不是「不是 git 仓库」。
 *
 * 不能靠 `GIT_CEILING_DIRECTORIES` 修：同一个文件里「目录落在别的仓库里」那条
 * 测试正是**依赖**祖先仓库才能构造 `not_repo_root`，设了天花板它会退化成
 * `not_git_repo`。所以这里如实判定前提，前提不成立就跳过，不假装通过。
 */
const TEMP_INSIDE_REPO = (() => {
  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
})();

import { openDb, type DB } from "../../src/server/core/db/db.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import { createSessionLock } from "../../src/server/core/orchestrator/session-lock.js";
import { createTurnOrchestrator } from "../../src/server/core/orchestrator/turn.js";
import { createSupervisor } from "../../src/server/core/process/supervisor.js";
import {
  createAssignmentRunner,
  getAssignmentRow,
  queueRankOf,
  toAssignmentDto,
} from "../../src/server/core/assignment/runner.js";
import { renderReport } from "../../src/server/core/assignment/report.js";
import {
  ensureWorktreeForBot,
  listChangedFiles,
  validateRepoPath,
  worktreePathFor,
  type GitRunner,
} from "../../src/server/core/assignment/worktree.js";
import { getTurnContext } from "../../src/server/adapters/turn-context.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";

/**
 * Assignment（M11 / P0-07）与执行位置（P0-13）。
 *
 * 队列、超时、崩溃报告用**真编排器 + 假驱动**：这些断言要挡的是调度与收口逻辑。
 * worktree 用**真 git 仓库**（临时目录）：`git worktree add` 的失败模式
 * （非仓库 / 目录已存在 / 权限）用假实现验证不出来。
 */

const NOW = Date.now();
const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fake-asg",
  displayName: "Fake Asg",
  protocol: "cli-stdio",
  launch: { command: "fake", args: [] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+)" },
  capabilities: {
    plan: true,
    permissionRequest: false,
    resume: false,
    images: "unknown",
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: ["message_delta", "done", "error", "usage"],
  permission: { channel: "acp-reverse", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "none",
  executionLocations: ["local", "worktree"],
};

// ---------------------------------------------------------------------------
// 假驱动
// ---------------------------------------------------------------------------

interface ScriptedDriver extends ChannelDriver {
  calls: number;
  /** 每次 prompt 的输入文本（断言「任务 prompt 是任务说明」用）。 */
  prompts: string[];
  /** 手动结束挂住的 prompt。 */
  release(): void;
}

interface DriverOptions {
  mode: "done" | "fail" | "hang";
  text?: string;
  /** fail 模式下的 stderr 尾巴（模拟崩溃）。 */
  crashTail?: string;
}

function createScriptedDriver(opts: DriverOptions): ScriptedDriver {
  let eventCb: ((e: CanonicalEvent) => void) | null = null;
  let exitCb: ((i: { code: number | null; stderrTail: string }) => void) | null = null;
  let release: (() => void) | null = null;
  const handle: SessionHandle = { sessionId: "s", pid: null, runtimeSessionId: "rt" };

  const driver: ScriptedDriver = {
    protocol: "cli-stdio",
    calls: 0,
    prompts: [],
    async start() {
      return handle;
    },
    async initialize() {
      return {
        capabilities: DECL.capabilities,
        source: "probed" as const,
        version: "1.0.0",
        healthStatus: "healthy" as const,
      };
    },
    async newSession() {
      return { runtimeSessionId: "rt" };
    },
    async resumeSession() {
      return { ok: false, reason: "测试不支持" };
    },
    async prompt(h, input) {
      driver.calls += 1;
      driver.prompts.push(input.text);
      const ctx = getTurnContext(h);
      const turnId = ctx?.turnId ?? "turn_x";
      const messageId = ctx?.messageId ?? "msg_x";
      const emit = (e: CanonicalEvent): void => eventCb?.(e);

      if (opts.mode === "hang") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return;
      }

      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "start", text: "" },
      });
      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "delta", text: opts.text ?? "已按要求完成：新增了 3 个函数。" },
      });
      emit({
        type: "message_delta",
        turnId,
        ts: Date.now(),
        payload: { messageId, phase: "end", text: "" },
      });
      emit({
        type: "usage",
        turnId,
        ts: Date.now(),
        payload: { inputTokens: 1200, outputTokens: 480, reported: true },
      });

      if (opts.mode === "fail") {
        emit({
          type: "error",
          turnId,
          ts: Date.now(),
          payload: { code: "runtime_crashed", message: "运行时进程崩溃", detail: opts.crashTail ?? "", fatal: true },
        });
        exitCb?.({ code: 1, stderrTail: opts.crashTail ?? "boom" });
        return;
      }
      emit({ type: "done", turnId, ts: Date.now(), payload: { stopReason: "end", durationMs: 10 } });
    },
    async cancel() {
      release?.();
    },
    async respondPermission() {
      /* 不涉及 */
    },
    onEvent(_h, cb) {
      eventCb = cb;
    },
    onPermission() {
      /* 不涉及 */
    },
    onExit(_h, cb) {
      exitCb = cb;
    },
    async dispose() {
      release?.();
    },
    release() {
      release?.();
    },
  };
  return driver;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Fixture {
  db: DB;
  driver: ScriptedDriver;
  runner: ReturnType<typeof createAssignmentRunner>;
  supervisor: ReturnType<typeof createSupervisor>;
  channelId: string;
  botId: string;
  /** 原会话里该 Bot 的 Session（回贴目标）。 */
  sourceSessionId: string;
  close: () => void;
}

interface SetupOptions extends DriverOptions {
  timeoutMs?: number;
  queueLimit?: number;
  concurrent?: number;
  executionLocation?: "local" | "worktree";
  repoPath?: string | null;
  gitRun?: GitRunner;
  botName?: string;
}

function setup(opts: SetupOptions): Fixture {
  const db = openDb(":memory:");
  const bus = createEventBus({ ringSize: 50 });
  const channelId = "ch_dm";
  const botId = "bot_asg";
  const sourceSessionId = "sess_source";

  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), NOW);
  db.prepare(
    `INSERT INTO bots (id, name, persona, execution_location, repo_path, worktree_path, status,
                       allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
     VALUES (?, ?, '干活', ?, ?, NULL, 'active', '[]', 0, 0, 0, ?, ?)`,
  ).run(botId, opts.botName ?? "实现助手", opts.executionLocation ?? "local", opts.repoPath ?? null, NOW, NOW);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
     VALUES (?, ?, ?, 'rt', 'fresh', 'idle', ?)`,
  ).run(sourceSessionId, botId, channelId, NOW);
  // 原会话里先有一条用户消息（派活的来源）
  db.prepare(
    `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, content_version, status, created_at)
     VALUES ('msg_src', ?, ?, 'turn_src', 'user', '把 README 补一下', 0, 'done', ?)`,
  ).run(sourceSessionId, channelId, NOW);

  const driver = createScriptedDriver(opts);
  const resolveRuntime = () => ({ runtimeId: "rt", declaration: DECL, driver });
  const supervisor = createSupervisor({
    db,
    bus,
    resolveRuntime,
    idleReapMs: 0,
    killImpl: async () => ({ gone: true }),
    log: () => undefined,
  });
  const orchestrator = createTurnOrchestrator({
    db,
    bus,
    lock: createSessionLock(),
    resolveRuntime,
    supervisor,
  });

  const runner = createAssignmentRunner({
    db,
    orchestrator,
    isRuntimeAvailable: () => true,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.queueLimit === undefined ? {} : { queueLimit: opts.queueLimit }),
    ...(opts.concurrent === undefined ? {} : { concurrent: opts.concurrent }),
    ...(opts.gitRun === undefined ? {} : { gitRun: opts.gitRun }),
    log: () => undefined,
  });

  return {
    db,
    driver,
    runner,
    supervisor,
    channelId,
    botId,
    sourceSessionId,
    close: () => {
      runner.stop();
      void orchestrator.dispose();
      void supervisor.dispose();
      db.close();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 15));
  }
}

function statusOf(db: DB, id: string): string {
  return getAssignmentRow(db, id)?.status ?? "missing";
}

function systemMessages(db: DB, channelId: string): { content: string; role: string }[] {
  return db
    .prepare("SELECT content, role FROM messages WHERE channel_id = ? AND role = 'system' ORDER BY created_at ASC")
    .all(channelId) as { content: string; role: string }[];
}

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

describe("Assignment 队列（P0-07 边界处理）", () => {
  it("创建后立刻排队，状态卡片写进原会话（role=system，不产生 Turn）", async () => {
    const f = setup({ mode: "hang", concurrent: 1 });
    const created = f.runner.create({
      channelId: f.channelId,
      title: "补 README",
      deliverable: "补全 README 的安装与启动章节",
      botId: f.botId,
      sourceMessageId: "msg_src",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const cards = systemMessages(f.db, f.channelId);
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards[0]?.content).toContain("已排队");
    expect(cards[0]?.content).toContain("补 README");

    // 系统消息不是 Turn：它不会出现在 turnOrder（前端按 role 过滤）
    const assistantTurns = f.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND role = 'assistant'")
      .get(f.channelId) as { n: number };
    expect(assistantTurns.n).toBe(0);

    f.driver.release();
    f.close();
  });

  it("同一 Bot 已有 1 个执行：第二个排队（位次 1，「等待前序任务」）", async () => {
    const f = setup({ mode: "hang", queueLimit: 5 });
    const make = (n: number) =>
      f.runner.create({
        channelId: f.channelId,
        title: `任务 ${n}`,
        deliverable: `交付物 ${n}`,
        botId: f.botId,
      });

    const a = make(1);
    const b = make(2);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // 第一个开跑，第二个仍在排队（PRD：第二个排队显示「等待前序任务」）
    await waitFor(() => statusOf(f.db, a.assignment.id) === "running");
    expect(statusOf(f.db, b.assignment.id)).toBe("queued");

    const second = getAssignmentRow(f.db, b.assignment.id)!;
    expect(queueRankOf(f.db, second)).toBe(1);

    const dto = toAssignmentDto(f.db, second);
    expect(dto.queuePosition).toBe(1);
    expect(dto.queueLimit).toBe(5);

    // 状态卡片里写明了等待原因
    const cards = systemMessages(f.db, f.channelId);
    expect(cards.some((c) => c.content.includes("等待前序任务"))).toBe(true);

    f.driver.release();
    f.close();
  });

  it("队列上限 5：执行中的不占名额，第 6 个排队的被拒绝（queue_full）", async () => {
    const f = setup({ mode: "hang", queueLimit: 5 });

    // 第一个先开跑（占执行名额，不占队列名额）
    const first = f.runner.create({
      channelId: f.channelId,
      title: "任务 0",
      deliverable: "先跑",
      botId: f.botId,
    });
    expect(first.ok).toBe(true);
    await waitFor(() => {
      const rows = f.db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE status = 'running'").get() as {
        n: number;
      };
      return rows.n === 1;
    });

    // 队列塞满 5 个
    const queued: { ok: boolean; code?: string }[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const r = f.runner.create({
        channelId: f.channelId,
        title: `任务 ${i}`,
        deliverable: `交付物 ${i}`,
        botId: f.botId,
      });
      queued.push(r.ok ? { ok: true } : { ok: false, code: r.code });
    }
    expect(queued.every((r) => r.ok)).toBe(true);

    // 第 6 个排队的被拒
    const overflow = f.runner.create({
      channelId: f.channelId,
      title: "任务 6",
      deliverable: "溢出",
      botId: f.botId,
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe("queue_full");

    f.driver.release();
    f.close();
  });

  it("前一个完成后自动放行排队的下一个（依次执行）", async () => {
    const f = setup({ mode: "done", concurrent: 1 });
    const a = f.runner.create({
      channelId: f.channelId,
      title: "第一个",
      deliverable: "先做这个",
      botId: f.botId,
    });
    const b = f.runner.create({
      channelId: f.channelId,
      title: "第二个",
      deliverable: "再做这个",
      botId: f.botId,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await waitFor(() => statusOf(f.db, b.assignment.id) === "done");
    expect(statusOf(f.db, a.assignment.id)).toBe("done");
    expect(f.driver.calls).toBe(2);
    f.close();
  });
});

// ---------------------------------------------------------------------------
// 执行、报告、超时、崩溃
// ---------------------------------------------------------------------------

describe("Assignment 执行与报告", () => {
  it("独立线程执行：用 task 渠道，不占用原会话的 Session", async () => {
    const f = setup({ mode: "done" });
    const created = f.runner.create({
      channelId: f.channelId,
      title: "写单元测试",
      deliverable: "为 worktree 模块补 3 个单测",
      botId: f.botId,
      sourceMessageId: "msg_src",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await waitFor(() => statusOf(f.db, created.assignment.id) === "done");
    const row = getAssignmentRow(f.db, created.assignment.id)!;

    // 独立 Session，且它的渠道是 task 类型
    expect(row.session_id).not.toBe(f.sourceSessionId);
    const channel = f.db
      .prepare("SELECT type FROM channels WHERE id = (SELECT channel_id FROM sessions WHERE id = ?)")
      .get(row.session_id) as { type: string };
    expect(channel.type).toBe("task");

    // 执行 prompt 是任务说明（含交付物），用户消息记录的是交付物描述
    expect(f.driver.prompts[0]).toContain("写单元测试");
    expect(f.driver.prompts[0]).toContain("为 worktree 模块补 3 个单测");

    // 原会话的 Session 状态没被任务影响
    const sourceStatus = f.db.prepare("SELECT status FROM sessions WHERE id = ?").get(f.sourceSessionId) as {
      status: string;
    };
    expect(sourceStatus.status).toBe("idle");
    f.close();
  });

  it("报告 Markdown 结构完整：四节标题 + 用量 + 改动文件", async () => {
    const f = setup({ mode: "done" });
    const created = f.runner.create({
      channelId: f.channelId,
      title: "补 README 的安装章节",
      deliverable: "在 README 里加安装与启动两步",
      botId: f.botId,
      sourceMessageId: "msg_src",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await waitFor(() => statusOf(f.db, created.assignment.id) === "done");
    const row = getAssignmentRow(f.db, created.assignment.id)!;
    const report = row.report ?? "";

    expect(report).toContain("# 补 README 的安装章节");
    expect(report).toContain("## 执行摘要");
    expect(report).toContain("## 改动文件");
    expect(report).toContain("## 用量");
    // 用量：驱动上报了 1200 / 480
    expect(report).toContain("1.2k");
    expect(report).toContain("480");
    // 执行摘要来自助手正文
    expect(report).toContain("已按要求完成");

    // 报告回贴原会话
    const cards = systemMessages(f.db, f.channelId);
    const posted = cards.find((c) => c.content.includes("任务完成"));
    expect(posted).toBeTruthy();
    expect(posted?.content).toContain("## 执行摘要");
    expect(posted?.content).toContain("## 改动文件");
    f.close();
  });

  it("权限走 hold 档：Turn 的 source 是 assignment（不是 interactive）", async () => {
    const f = setup({ mode: "hang" });
    const created = f.runner.create({
      channelId: f.channelId,
      title: "长时间任务",
      deliverable: "慢慢来",
      botId: f.botId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await waitFor(() => statusOf(f.db, created.assignment.id) === "running");
    const row = getAssignmentRow(f.db, created.assignment.id)!;
    expect(row.session_id).toBeTruthy();

    // supervisor 的活跃 Turn 是权限层读 source 的唯一来源：
    // 这里断言的就是「权限卡片会走 hold」的证据
    const turn = f.supervisor.activeTurn(row.session_id!);
    expect(turn).not.toBeNull();
    expect(turn?.source).toBe("assignment");

    f.driver.release();
    f.close();
  });

  it("30 分钟无结束事件 → 标超时并保留已有产出", async () => {
    // 用 120ms 的「30 分钟」替身；驱动先吐正文再挂住
    const f = setup({ mode: "hang", timeoutMs: 120 });
    const created = f.runner.create({
      channelId: f.channelId,
      title: "会超时的任务",
      deliverable: "这个任务不会结束",
      botId: f.botId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await waitFor(() => statusOf(f.db, created.assignment.id) === "timeout", 8000);
    const row = getAssignmentRow(f.db, created.assignment.id)!;
    expect(row.status).toBe("timeout");
    expect(row.fail_reason).toContain("超时");
    expect(row.report).toContain("超时");
    // 已有产出保留：助手消息行仍在（内容可能为空，但行不能丢）
    const assistant = f.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant'")
      .get(row.session_id) as { n: number };
    expect(assistant.n).toBe(1);

    f.driver.release();
    f.close();
  }, 15000);

  it("运行时崩溃 → 标失败，报告附最后 50 条事件（且不超过 50 条）", async () => {
    const f = setup({ mode: "fail", crashTail: "FATAL: out of memory" });
    const created = f.runner.create({
      channelId: f.channelId,
      title: "会崩的任务",
      deliverable: "跑到一半就挂",
      botId: f.botId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await waitFor(() => statusOf(f.db, created.assignment.id) === "failed");
    const row = getAssignmentRow(f.db, created.assignment.id)!;
    expect(row.status).toBe("failed");
    expect(row.report).toContain("## 最后 50 条事件");
    expect(row.report).toContain("runtime_crashed");

    // 事件行数不超过 50（这里实际只有几条，断言上限而不是「正好 50」）
    const eventLines = (row.report ?? "").split("\n").filter((l) => /^\[\d\d:\d\d:\d\d\] #/.test(l));
    expect(eventLines.length).toBeGreaterThan(0);
    expect(eventLines.length).toBeLessThanOrEqual(50);
    f.close();
  });

  it("崩溃报告只取最后 50 条（造 120 条事件验证截断）", async () => {
    const f = setup({ mode: "fail" });
    const created = f.runner.create({
      channelId: f.channelId,
      title: "事件很多的任务",
      deliverable: "产生大量事件",
      botId: f.botId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await waitFor(() => statusOf(f.db, created.assignment.id) === "failed");

    // 手工往该 Session 塞 120 条事件，再重新生成报告（模拟长任务崩溃）
    const row = getAssignmentRow(f.db, created.assignment.id)!;
    const insert = f.db.prepare(
      `INSERT INTO events (session_id, message_id, turn_id, type, seq, payload, raw, created_at)
       VALUES (?, NULL, 'turn_bulk', 'thought', ?, '{"phase":"delta","text":"步骤"}', NULL, ?)`,
    );
    for (let i = 0; i < 120; i += 1) insert.run(row.session_id, 9000 + i, Date.now() + i);

    // 直接调报告生成（与 runner 收口时同一条路径）
    const { collectReportInput } = await import("../../src/server/core/assignment/report.js");
    const input = collectReportInput(f.db, row.id, { git: false, files: [], message: "非 git" });
    expect(input).not.toBeNull();
    const md = renderReport(input!);
    const lines = md.split("\n").filter((l) => /^\[\d\d:\d\d:\d\d\] #/.test(l));
    expect(lines).toHaveLength(50);
    f.close();
  });

  it.skipIf(TEMP_INSIDE_REPO)("报告里「改动文件」不是 git 仓库时如实写无法统计（不编 0）", async () => {
    const f = setup({ mode: "done" });
    const created = f.runner.create({
      channelId: f.channelId,
      title: "非 git 目录任务",
      deliverable: "在非 git 目录里干活",
      botId: f.botId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await waitFor(() => statusOf(f.db, created.assignment.id) === "done");
    const row = getAssignmentRow(f.db, created.assignment.id)!;
    expect(row.report).toContain("无法统计");
    f.close();
  });
});

// ---------------------------------------------------------------------------
// 启动恢复
// ---------------------------------------------------------------------------

describe("Assignment 启动恢复", () => {
  it("重启前 running 的任务标失败（不假装还在跑），排队按 queue_pos 恢复", async () => {
    const f = setup({ mode: "done" });
    // 手工造两条：一条 running（模拟崩溃残留）、一条 queued
    f.db.prepare(
      `INSERT INTO assignments (id, title, deliverable, bot_id, source_channel_id, status, queue_pos, created_at)
       VALUES ('asg_stale', '残留任务', 'x', ?, ?, 'running', 1, ?)`,
    ).run(f.botId, f.channelId, NOW);
    f.db.prepare(
      `INSERT INTO assignments (id, title, deliverable, bot_id, source_channel_id, status, queue_pos, created_at)
       VALUES ('asg_waiting', '排队任务', 'y', ?, ?, 'queued', 2, ?)`,
    ).run(f.botId, f.channelId, NOW + 1);

    f.runner.recover();

    expect(statusOf(f.db, "asg_stale")).toBe("failed");
    expect(getAssignmentRow(f.db, "asg_stale")?.fail_reason).toContain("服务重启");

    // 排队的那条会被放出去执行
    await waitFor(() => statusOf(f.db, "asg_waiting") === "done");
    f.close();
  });
});

// ---------------------------------------------------------------------------
// worktree（P0-13）
// ---------------------------------------------------------------------------

describe("执行位置 worktree（P0-13）", () => {
  let root = "";
  let repo = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "agentbot-wt-"));
    repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    if (HAS_GIT) {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
      writeFileSync(join(repo, "README.md"), "# demo\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
    }
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 偶发句柄占用
    }
  });

  it("非 git 仓库 → 保存校验失败（not_git_repo）", () => {
    if (!HAS_GIT) return;
    // 真实 git 的「不在任何仓库里」在开发机上不稳定（用户家目录本身可能是仓库），
    // 所以这条用假 git 精确构造 git 的失败输出；真实 git 的路径在下面两条覆盖。
    const failing: GitRunner = () => ({
      ok: false,
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git",
      code: 128,
    });
    const plain = join(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    const result = validateRepoPath(plain, failing);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_git_repo");
    expect(result.message).toContain("不是 git 仓库");
  });

  it("目录不存在 → not_found；相对路径 → not_absolute", () => {
    expect(validateRepoPath(join(root, "ghost")).code).toBe("not_found");
    expect(validateRepoPath("relative/dir").code).toBe("not_absolute");
  });

  it("目录落在别的仓库里（不是根）→ not_repo_root，并给出真实根", () => {
    if (!HAS_GIT) return;
    // 临时目录通常位于某个父级仓库内（实测：用户家目录本身是 git 仓库）
    const nested = join(root, "nested-plain");
    mkdirSync(nested, { recursive: true });
    const result = validateRepoPath(nested);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_repo_root");
    expect(result.repoRoot).toBeTruthy();
    expect(result.message).toContain("仓库根路径");
  });

  it("合法 git 仓库根 → 通过", () => {
    if (!HAS_GIT) return;
    const result = validateRepoPath(repo);
    expect(result.ok).toBe(true);
    expect(result.repoRoot).toBeTruthy();
  });

  it("同一 Bot 复用同一 worktree（第二次调用不重新创建）", () => {
    if (!HAS_GIT) return;
    const f = setup({ mode: "done", executionLocation: "worktree", repoPath: repo, botName: "复用测试" });
    const first = ensureWorktreeForBot(f.db, f.botId, { root: join(root, "wt") });
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(first.path).toBeTruthy();

    const second = ensureWorktreeForBot(f.db, f.botId, { root: join(root, "wt") });
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);

    // Bot 详情读到的是同一个实际路径
    const row = f.db
      .prepare("SELECT worktree_path, worktree_state FROM bots WHERE id = ?")
      .get(f.botId) as { worktree_path: string; worktree_state: string };
    expect(row.worktree_path).toBe(first.path);
    expect(row.worktree_state).toBe("ready");
    f.close();
  });

  it("两个 Bot 指向同一仓库：允许，各自独立 worktree", () => {
    if (!HAS_GIT) return;
    const f = setup({ mode: "done", executionLocation: "worktree", repoPath: repo, botName: "甲" });
    // 第二个 Bot 指向同一仓库
    f.db
      .prepare(
        `INSERT INTO bots (id, name, persona, execution_location, repo_path, status, created_at, updated_at)
         VALUES ('bot_second', '乙', 'p', 'worktree', ?, 'active', ?, ?)`,
      )
      .run(repo, NOW, NOW);

    const a = ensureWorktreeForBot(f.db, f.botId, { root: join(root, "wt2") });
    const b = ensureWorktreeForBot(f.db, "bot_second", { root: join(root, "wt2") });
    expect(a.ok && b.ok).toBe(true);
    expect(a.path).not.toBe(b.path);
    // 路径由 botId 决定，稳定可预测
    expect(a.path).toBe(worktreePathFor(f.botId, "甲", join(root, "wt2")));
    f.close();
  });

  it("worktree 创建失败（磁盘满/权限）→ Bot 可保存但标「未就绪」，发送时阻止", async () => {
    const failing: GitRunner = (args) => {
      if (args[0] === "rev-parse") {
        // 校验通过（假装就是该仓库根），但 worktree add 失败
        return { ok: true, stdout: `${repo}\n`, stderr: "", code: 0 };
      }
      return { ok: false, stdout: "", stderr: "fatal: cannot create worktree (permission denied)", code: 128 };
    };

    const f = setup({
      mode: "done",
      executionLocation: "worktree",
      repoPath: repo,
      gitRun: failing,
      botName: "创建失败",
    });

    const result = ensureWorktreeForBot(f.db, f.botId, { run: failing, root: join(root, "wt3") });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("create_failed");

    // Bot 记录仍在（可保存），但状态是 failed、路径为空
    const row = f.db
      .prepare("SELECT worktree_path, worktree_state FROM bots WHERE id = ?")
      .get(f.botId) as { worktree_path: string | null; worktree_state: string | null };
    expect(row.worktree_state).toBe("failed");
    expect(row.worktree_path).toBeNull();

    // 发送时被阻止：Assignment 被标失败并写明原因（不会真的跑起来）
    const created = f.runner.create({
      channelId: f.channelId,
      title: "不该跑起来的任务",
      deliverable: "x",
      botId: f.botId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await waitFor(() => statusOf(f.db, created.assignment.id) === "failed");
    const asg = getAssignmentRow(f.db, created.assignment.id)!;
    expect(asg.fail_reason).toContain("worktree 未就绪");
    expect(f.driver.calls).toBe(0);
    f.close();
  });

  it("worktree 目录被删掉 → 下次 ensure 重建（不是报错）", () => {
    if (!HAS_GIT) return;
    const f = setup({ mode: "done", executionLocation: "worktree", repoPath: repo, botName: "重建" });
    const rootDir = join(root, "wt4");
    const first = ensureWorktreeForBot(f.db, f.botId, { root: rootDir });
    expect(first.ok).toBe(true);
    if (!first.path) return;

    rmSync(first.path, { recursive: true, force: true });
    const again = ensureWorktreeForBot(f.db, f.botId, { root: rootDir });
    expect(again.ok).toBe(true);
    expect(again.created).toBe(true);
    f.close();
  });

  it("目录还在但 worktree_path 被清空（改成 local 再切回）→ 认领已有 worktree，不报 already exists", () => {
    if (!HAS_GIT) return;
    // 真实场景：Bot 曾配 worktree，改成 local 时 worktree_path 被清空（目录留在磁盘），
    // 之后运行时换成无权限通道的 → 安全兜底又要求 worktree。若不复用，
    // `git worktree add` 会永久报 already exists，Bot 再也发不出消息。
    const f = setup({ mode: "done", executionLocation: "worktree", repoPath: repo, botName: "认领" });
    const rootDir = join(root, "wt5");
    const first = ensureWorktreeForBot(f.db, f.botId, { root: rootDir });
    expect(first.ok).toBe(true);
    if (!first.path) return;

    // 模拟「改成 local」：清 worktree_path（目录保留）
    f.db
      .prepare("UPDATE bots SET worktree_path = NULL, worktree_state = NULL WHERE id = ?")
      .run(f.botId);

    const again = ensureWorktreeForBot(f.db, f.botId, { root: rootDir });
    expect(again.ok).toBe(true);
    expect(again.reused).toBe(true);
    expect(again.path).toBe(first.path);
    expect(again.created).toBe(false);
    f.close();
  });

  it("残留目录属于别的仓库 → 不复用（不误认领用户目录）", () => {
    if (!HAS_GIT) return;
    const f = setup({ mode: "done", executionLocation: "worktree", repoPath: repo, botName: "冲突" });
    const rootDir = join(root, "wt6");
    // 在目标路径上放一个「另一个仓库」的 worktree
    const other = join(root, "other-repo");
    mkdirSync(other, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: other });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: other });
    execFileSync("git", ["config", "user.name", "T"], { cwd: other });
    writeFileSync(join(other, "x.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: other });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: other });
    mkdirSync(rootDir, { recursive: true });
    const target = worktreePathFor(f.botId, "冲突", rootDir);
    execFileSync("git", ["worktree", "add", target, "--detach"], { cwd: other });

    const result = ensureWorktreeForBot(f.db, f.botId, { root: rootDir });
    // 不复用别的仓库的 worktree：如实报失败，让用户看到原因
    expect(result.ok).toBe(false);
    expect(result.code).toBe("create_failed");
    f.close();
  });

  it("listChangedFiles：能统计到新增/修改文件与 +/- 行数", () => {
    if (!HAS_GIT) return;
    const work = join(root, "diff-repo");
    mkdirSync(work, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: work });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: work });
    execFileSync("git", ["config", "user.name", "T"], { cwd: work });
    writeFileSync(join(work, "a.txt"), "one\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: work });

    writeFileSync(join(work, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(work, "b.txt"), "new file\n");

    const changed = listChangedFiles(work);
    expect(changed.git).toBe(true);
    const a = changed.files.find((f) => f.path === "a.txt");
    expect(a).toBeTruthy();
    expect(a?.insertions).toBe(2);
    expect(a?.deletions).toBe(0);
    // 未跟踪文件不在 diff 里 → 行数记 null（不编 0）
    const b = changed.files.find((f) => f.path === "b.txt");
    expect(b).toBeTruthy();
    expect(b?.insertions).toBeNull();
    expect(b?.status).toContain("?");
  });
});

// ---------------------------------------------------------------------------
// 报告渲染（纯函数）
// ---------------------------------------------------------------------------

describe("报告 Markdown（renderReport）", () => {
  it("结构固定：标题 / 执行摘要 / 改动文件 / 用量", () => {
    const md = renderReport({
      id: "asg_1",
      title: "重构权限模块",
      deliverable: "把边界判定拆成纯函数",
      botName: "实现助手",
      runtimeName: "Codex",
      status: "done",
      executionPath: "/repo",
      executionLocation: "local",
      startedAt: NOW,
      endedAt: NOW + 72_000,
      summary: "拆出了 checkBoundary。\n补了 4 个单测。",
      changed: {
        git: true,
        files: [
          { path: "src/permissions/boundary.ts", insertions: 42, deletions: 7, status: " M" },
          { path: "tests/boundary.test.ts", insertions: 88, deletions: 0, status: "A " },
        ],
      },
      usage: { inputTokens: 12400, outputTokens: 3100, reported: true },
      tailEvents: [],
      failReason: null,
      eventCount: 37,
    });

    expect(md).toContain("# 重构权限模块");
    expect(md).toContain("## 执行摘要");
    expect(md).toContain("拆出了 checkBoundary");
    expect(md).toContain("## 改动文件");
    expect(md).toContain("| `src/permissions/boundary.ts` | `M` | +42 | −7 |");
    expect(md).toContain("合计 2 个文件，+130 / −7 行");
    expect(md).toContain("## 用量");
    expect(md).toContain("12.4k");
    expect(md).toContain("3.1k");
    expect(md).toContain("事件数：37");
    // 成功的报告不附事件尾巴
    expect(md).not.toContain("## 最后 50 条事件");
  });

  it("未上报用量：写「未上报」而不是 0", () => {
    const md = renderReport({
      id: "asg_2",
      title: "t",
      deliverable: "d",
      botName: "b",
      runtimeName: null,
      status: "done",
      executionPath: null,
      executionLocation: "local",
      startedAt: NOW,
      endedAt: NOW + 1000,
      summary: "ok",
      changed: { git: false, files: [], message: "不是 git 目录" },
      usage: { inputTokens: null, outputTokens: null, reported: false },
      tailEvents: [],
      failReason: null,
      eventCount: 0,
    });
    expect(md).toContain("运行时未上报用量");
    expect(md).toContain("无法统计");
  });
});
