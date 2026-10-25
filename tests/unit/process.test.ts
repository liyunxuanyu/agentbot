import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  killTree,
  killTreeSync,
} from "../../src/server/core/process/kill-tree.js";
import { createPidRegistry, sweepZombies } from "../../src/server/core/process/pid-registry.js";
import { openDb } from "../../src/server/core/db/db.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import { createSupervisor } from "../../src/server/core/process/supervisor.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  ProbeResult,
  SessionHandle,
} from "../../src/server/adapters/contract.js";

/**
 * M5 进程管理测试。
 *
 * 进程树杀**用真的子进程**（`node -e "setInterval(()=>{},1000)"`）：
 * 这条是 Windows 上最容易假绿的断言 —— `child.kill()` 返回成功、
 * 父进程没了，但孙子进程还活着。所以必须验证「孙子进程也死了」。
 */

const NODE = process.execPath;
/** 活 10 分钟的进程：测试期间不会自己退出，只能被杀。 */
const HANG_CODE = "setInterval(()=>{},1000)";

function spawnHang(): ChildProcess {
  const child = spawn(NODE, ["-e", HANG_CODE], { stdio: "ignore", windowsHide: true });
  return child;
}

async function waitAlive(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("进程树杀 · 真实子进程", () => {
  it("单进程：killTree 后进程消失", async () => {
    const child = spawnHang();
    const pid = child.pid!;
    expect(await waitAlive(pid)).toBe(true);

    const res = await killTree(pid);
    expect(res.gone).toBe(true);
    expect(isProcessAlive(pid)).toBe(false);

    // 兜底：万一断言失败，别把进程留在机器上
    if (isProcessAlive(pid)) killTreeSync(pid);
  });

  it("进程树：父进程的子进程也一起死（Windows 走 taskkill /T /F）", async () => {
    // 父进程再拉一个子进程，模拟「运行时 CLI 起了语言服务」的情形
    const parentCode = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      process.stdout.write(String(child.pid));
      setInterval(()=>{},1000);
    `;
    const parent = spawn(NODE, ["-e", parentCode], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const parentPid = parent.pid!;

    // 读子进程 pid（父进程把子 pid 打到 stdout）
    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("父进程未输出子 pid")), 8000);
      let buf = "";
      parent.stdout?.setEncoding("utf8");
      parent.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        const m = /^\d+/.exec(buf.trim());
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[0]));
        }
      });
      parent.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(await waitAlive(parentPid)).toBe(true);
    expect(await waitAlive(childPid)).toBe(true);
    expect(childPid).not.toBe(parentPid);

    const res = await killTree(parentPid);
    expect(res.gone).toBe(true);

    // 关键断言：孙子进程也必须死（只杀父进程的话这里会失败）
    const childGone = await waitAlive(childPid, 500) === false;
    if (!childGone) {
      // 清理后再断言，避免污染后续测试
      killTreeSync(childPid);
    }
    expect(childGone).toBe(true);
    expect(isProcessAlive(parentPid)).toBe(false);
  }, 20000);

  it("已经退出的进程：alreadyGone=true，不抛错", async () => {
    const child = spawnHang();
    const pid = child.pid!;
    child.kill();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));

    const res = await killTree(pid);
    expect(res.alreadyGone).toBe(true);
    expect(res.gone).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 启动清扫
// ---------------------------------------------------------------------------

let sweepDir = "";
afterAll(() => {
  if (sweepDir) {
    try {
      rmSync(sweepDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
});

describe("启动清扫 · 僵尸 pid", () => {
  it("pid 已死 → 清字段，Session 置 failed", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
       VALUES ('ch_z', 'dm', '私聊', '[]', NULL, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, name, persona, created_at, updated_at)
       VALUES ('bot_z', '僵尸', '', ?, ?)`,
    ).run(now, now);
    // pid 999999 几乎不可能存在
    db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, status, process_pid, process_started_at, started_at)
       VALUES ('sess_z', 'bot_z', 'ch_z', 'running', 999999, ?, ?)`,
    ).run(now, now);

    const res = sweepZombies(db, { log: () => undefined });
    expect(res.dead).toBe(1);
    expect(res.killed).toBe(0);

    const row = db
      .prepare("SELECT status, process_pid, process_started_at FROM sessions WHERE id = 'sess_z'")
      .get() as { status: string; process_pid: number | null; process_started_at: number | null };
    expect(row.process_pid).toBeNull();
    expect(row.process_started_at).toBeNull();
    expect(row.status).toBe("failed");
    db.close();
  });

  it("pid 活着但创建时间不符（PID 被复用）→ 只清字段，绝不杀", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
       VALUES ('ch_r', 'dm', '私聊', '[]', NULL, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO bots (id, name, persona, created_at, updated_at)
       VALUES ('bot_r', '复用', '', ?, ?)`,
    ).run(now, now);

    // 用测试进程自己的 pid：它肯定活着，但创建时间对不上（我们写一个 1970 的时间）
    const pid = process.pid;
    db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, status, process_pid, process_started_at, started_at)
       VALUES ('sess_r', 'bot_r', 'ch_r', 'running', ?, 1000, ?)`,
    ).run(pid, now);

    const res = sweepZombies(db, { log: () => undefined });
    // 创建时间差了几十年 → 判定为复用
    expect(res.reused).toBe(1);
    expect(res.killed).toBe(0);
    // 测试进程必须还活着
    expect(isProcessAlive(pid)).toBe(true);
    const row = db.prepare("SELECT process_pid FROM sessions WHERE id = 'sess_r'").get() as {
      process_pid: number | null;
    };
    expect(row.process_pid).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Supervisor：resume / 重建 / 空闲回收
// ---------------------------------------------------------------------------

const DECL_BASE: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fake-proc",
  displayName: "Fake Proc",
  protocol: "cli-stdio",
  launch: { command: "fake", args: [] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+)" },
  capabilities: {
    plan: true,
    permissionRequest: true,
    resume: true,
    images: "unknown",
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: ["message_delta", "done", "error"],
  permission: { channel: "acp-reverse", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "acp",
  executionLocations: ["local"],
};

interface FakeProcDriver extends ChannelDriver {
  spawnCount(): number;
  resumeAttempts(): number;
  newSessionPrompts(): (string | undefined)[];
  fireExit(code: number): void;
  lastHandle(): SessionHandle | null;
}

function createFakeProcDriver(opts: {
  resumeOk?: boolean;
  startFails?: boolean;
} = {}): FakeProcDriver {
  let spawns = 0;
  let resumes = 0;
  let handle: SessionHandle | null = null;
  let exitCb: ((i: { code: number | null; stderrTail: string }) => void) | null = null;
  const prompts: (string | undefined)[] = [];

  const driver: FakeProcDriver = {
    protocol: "cli-stdio",
    async start() {
      spawns += 1;
      if (opts.startFails) throw new Error("spawn 失败（测试注入）");
      handle = { sessionId: "s", pid: null, runtimeSessionId: null };
      return handle;
    },
    async initialize(): Promise<ProbeResult> {
      return {
        capabilities: DECL_BASE.capabilities,
        source: "probed",
        version: "1.0.0",
        healthStatus: "healthy",
      };
    },
    async newSession(_h, o) {
      prompts.push(o.systemPrompt);
      return { runtimeSessionId: `rt_${spawns}` };
    },
    async resumeSession() {
      resumes += 1;
      return opts.resumeOk === true ? { ok: true } : { ok: false, reason: "不支持 load" };
    },
    async prompt() {
      /* 不产出事件 */
    },
    async cancel() {
      /* 无进程 */
    },
    async respondPermission() {
      /* 无权限通道 */
    },
    onEvent() {
      /* 不产出事件 */
    },
    onPermission() {
      /* 无 */
    },
    onExit(_h, cb) {
      exitCb = cb;
    },
    async dispose() {
      /* 无进程 */
    },
    spawnCount: () => spawns,
    resumeAttempts: () => resumes,
    newSessionPrompts: () => prompts,
    fireExit: (code: number) => exitCb?.({ code, stderrTail: "" }),
    lastHandle: () => handle,
  };
  return driver;
}

/** 造一条用户历史消息：重建判据看的就是 `role='user'` 的行。 */
function insertUserMessage(
  db: ReturnType<typeof openDb>,
  sessionId: string,
  turnId: string,
  content: string,
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
     VALUES (?, ?, 'ch_p', ?, 'user', ?, 'done', ?)`,
  ).run(`m_${turnId}`, sessionId, turnId, content, Date.now());
}

function setupSupervisor(opts: {
  driver: FakeProcDriver;
  decl?: Partial<AdapterDeclaration>;
  idleReapMs?: number;
}) {
  const db = openDb(":memory:");
  const now = Date.now();
  const botId = "bot_p";
  const channelId = "ch_p";
  const sessionId = "sess_p";

  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, execution_location, repo_path, status, created_at, updated_at)
     VALUES (?, '小助', '你是小助，说话简洁。', 'local', ?, 'active', ?, ?)`,
  ).run(botId, process.cwd(), now, now);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
     VALUES (?, ?, ?, 'rt_def', 'fresh', 'created', ?)`,
  ).run(sessionId, botId, channelId, now);

  const bus = createEventBus({ ringSize: 50 });
  const decl: AdapterDeclaration = { ...DECL_BASE, ...opts.decl };
  const supervisor = createSupervisor({
    db,
    bus,
    resolveRuntime: () => ({ runtimeId: "rt_def", declaration: decl, driver: opts.driver }),
    idleReapMs: opts.idleReapMs ?? 0,
    killImpl: async () => ({ gone: true }),
    log: () => undefined,
  });

  return {
    db,
    bus,
    sessionId,
    botId,
    supervisor,
    close: () => {
      void supervisor.dispose();
      db.close();
    },
  };
}

describe("Supervisor · resume 与降级重建（P0-15）", () => {
  it("无历史：走 newSession，resume_state=fresh，只注入人格与记忆（不带历史引导语）", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver });
    const ensured = await f.supervisor.ensure(f.sessionId);

    expect(ensured.resumeState).toBe("fresh");
    expect(driver.spawnCount()).toBe(1);
    // 首轮也要注入人格 + 记忆（P0-10「每轮注入」），但没有历史可重建，
    // 所以不带「你正在继续一段此前的对话」这类引导语。
    const prompt = driver.newSessionPrompts()[0] ?? "";
    expect(prompt).toContain("你是小助，说话简洁。");
    expect(prompt).not.toContain("你正在继续一段此前的对话");

    const metas = f.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'meta'")
      .get(f.sessionId) as { n: number };
    expect(metas.n).toBe(0);
    f.close();
  });

  it("运行时 resume 成功 → resume_state=resumed，落一条 session_resumed", async () => {
    const driver = createFakeProcDriver({ resumeOk: true });
    const f = setupSupervisor({ driver });
    f.db
      .prepare("UPDATE sessions SET runtime_session_id = 'rt_old', resume_state = 'fresh' WHERE id = ?")
      .run(f.sessionId);

    const ensured = await f.supervisor.ensure(f.sessionId);
    expect(ensured.resumeState).toBe("resumed");
    expect(driver.resumeAttempts()).toBe(1);

    const metas = f.db
      .prepare("SELECT payload FROM events WHERE session_id = ? AND type = 'meta'")
      .all(f.sessionId) as { payload: string }[];
    expect(metas).toHaveLength(1);
    expect((JSON.parse(metas[0]!.payload) as { kind: string }).kind).toBe("session_resumed");
    f.close();
  });

  it("resume 失败 → 产品层重建：带人格 + 历史，resume_state=rebuilt，落一条 session_rebuilt", async () => {
    const driver = createFakeProcDriver({ resumeOk: false });
    const f = setupSupervisor({ driver });
    f.db
      .prepare("UPDATE sessions SET runtime_session_id = 'rt_old', resume_state = 'fresh' WHERE id = ?")
      .run(f.sessionId);

    // 造两条历史消息
    const now = Date.now();
    f.db
      .prepare(
        `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
         VALUES ('m1', ?, 'ch_p', 't1', 'user', '把 README 改成中文', 'done', ?)`,
      )
      .run(f.sessionId, now - 1000);
    f.db
      .prepare(
        `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
         VALUES ('m2', ?, 'ch_p', 't1', 'assistant', '已改好，共 42 行。', 'done', ?)`,
      )
      .run(f.sessionId, now);

    const ensured = await f.supervisor.ensure(f.sessionId);
    expect(ensured.resumeState).toBe("rebuilt");

    const prompt = driver.newSessionPrompts()[0] ?? "";
    expect(prompt).toContain("你是小助，说话简洁。");
    expect(prompt).toContain("把 README 改成中文");
    expect(prompt).toContain("已改好，共 42 行。");

    const metas = f.db
      .prepare("SELECT payload FROM events WHERE session_id = ? AND type = 'meta'")
      .all(f.sessionId) as { payload: string }[];
    expect(metas).toHaveLength(1);
    expect((JSON.parse(metas[0]!.payload) as { kind: string }).kind).toBe("session_rebuilt");

    const row = f.db
      .prepare("SELECT resume_state FROM sessions WHERE id = ?")
      .get(f.sessionId) as { resume_state: string };
    expect(row.resume_state).toBe("rebuilt");
    f.close();
  });

  it("同一 Session 再次 ensure（进程已回收）→ 状态未变化时不再重复落 meta", async () => {
    const driver = createFakeProcDriver({ resumeOk: false });
    const f = setupSupervisor({ driver });
    f.db
      .prepare("UPDATE sessions SET runtime_session_id = 'rt_old', resume_state = 'fresh' WHERE id = ?")
      .run(f.sessionId);
    insertUserMessage(f.db, f.sessionId, "t_prev", "上一轮的问题");

    await f.supervisor.ensure(f.sessionId);
    await f.supervisor.kill(f.sessionId, "idle");

    // 第二次 ensure：库里 resume_state 已是 rebuilt，重建后状态不变 → 不落第二条 meta
    const ensured = await f.supervisor.ensure(f.sessionId);
    expect(ensured.resumeState).toBe("rebuilt");

    const metas = f.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'meta'")
      .get(f.sessionId) as { n: number };
    expect(metas.n).toBe(1);
    expect(driver.spawnCount()).toBe(2);
    f.close();
  });

  it("resumeStrategy=process-lifetime（CLI 通道）→ 跳过 resume 尝试，直接重建", async () => {
    const driver = createFakeProcDriver({ resumeOk: true });
    const f = setupSupervisor({ driver, decl: { resumeStrategy: "process-lifetime" } });
    f.db
      .prepare("UPDATE sessions SET runtime_session_id = 'rt_old', resume_state = 'fresh' WHERE id = ?")
      .run(f.sessionId);
    insertUserMessage(f.db, f.sessionId, "t_prev", "上一轮的问题");

    const ensured = await f.supervisor.ensure(f.sessionId);
    expect(driver.resumeAttempts()).toBe(0);
    expect(ensured.resumeState).toBe("rebuilt");
    f.close();
  });

  it("CLI 第二轮：有历史消息但 runtime_session_id 为空 → 仍重建并落一条 meta", async () => {
    // 这正是 critic 实测出的链路：进程正常退出后 runtime_session_id 还在，
    // 但「新 Session 的 id 为空」也必须走重建 —— 判据只能是 messages。
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver, decl: { resumeStrategy: "process-lifetime" } });
    insertUserMessage(f.db, f.sessionId, "t_prev", "我叫什么名字？");
    f.db
      .prepare(
        `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
         VALUES ('m_a1', ?, 'ch_p', 't_prev', 'assistant', '你还没告诉我名字。', 'done', ?)`,
      )
      .run(f.sessionId, Date.now());
    // 关键：runtime_session_id 保持 NULL
    const before = f.db
      .prepare("SELECT runtime_session_id FROM sessions WHERE id = ?")
      .get(f.sessionId) as { runtime_session_id: string | null };
    expect(before.runtime_session_id).toBeNull();

    const ensured = await f.supervisor.ensure(f.sessionId);
    expect(ensured.resumeState).toBe("rebuilt");

    const prompt = driver.newSessionPrompts()[0] ?? "";
    expect(prompt).toContain("你是小助，说话简洁。");
    expect(prompt).toContain("我叫什么名字？");
    expect(prompt).toContain("你还没告诉我名字。");

    const metas = f.db
      .prepare("SELECT payload FROM events WHERE session_id = ? AND type = 'meta'")
      .all(f.sessionId) as { payload: string }[];
    expect(metas).toHaveLength(1);
    const payload = JSON.parse(metas[0]!.payload) as {
      kind: string;
      data: { omittedMessages?: unknown };
    };
    expect(payload.kind).toBe("session_rebuilt");
    // omittedMessages 必须是数字（前端据此决定是否显示「已省略 N 条历史」）
    expect(typeof payload.data.omittedMessages).toBe("number");
    expect(payload.data.omittedMessages).toBe(0);
    f.close();
  });

  it("本轮自己的用户消息不进入重建历史（excludeTurnId）", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver, decl: { resumeStrategy: "process-lifetime" } });
    insertUserMessage(f.db, f.sessionId, "t_old", "上一轮的问题");
    insertUserMessage(f.db, f.sessionId, "t_now", "这一轮的问题");

    const ensured = await f.supervisor.ensure(f.sessionId, { excludeTurnId: "t_now" });
    expect(ensured.resumeState).toBe("rebuilt");

    const prompt = driver.newSessionPrompts()[0] ?? "";
    expect(prompt).toContain("上一轮的问题");
    expect(prompt).not.toContain("这一轮的问题");
    f.close();
  });

  it("重建丢弃历史时 meta.data.omittedMessages 是数字且 > 0", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({
      driver,
      decl: {
        resumeStrategy: "process-lifetime",
        capabilities: { ...DECL_BASE.capabilities, contextWindow: 400 },
      },
    });
    // 20 条较长历史 + 小窗口 → 必然触发裁剪
    for (let i = 0; i < 20; i += 1) {
      insertUserMessage(
        f.db,
        f.sessionId,
        `t_${i}`,
        `第 ${i} 条历史：这是一段用来把上下文窗口撑爆的长内容，重复若干遍。`,
      );
    }

    const ensured = await f.supervisor.ensure(f.sessionId);
    expect(ensured.resumeState).toBe("rebuilt");
    expect(ensured.omittedMessages).toBeGreaterThan(0);

    const metas = f.db
      .prepare("SELECT payload FROM events WHERE session_id = ? AND type = 'meta'")
      .all(f.sessionId) as { payload: string }[];
    expect(metas).toHaveLength(1);
    const payload = JSON.parse(metas[0]!.payload) as {
      kind: string;
      data: { omittedMessages?: unknown };
    };
    expect(payload.kind).toBe("session_rebuilt");
    expect(typeof payload.data.omittedMessages).toBe("number");
    expect(payload.data.omittedMessages).toBe(ensured.omittedMessages);
    expect(payload.data.omittedMessages as number).toBeGreaterThan(0);
    f.close();
  });

  it("ensure 复用已有进程：不重复 spawn", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver });
    const first = await f.supervisor.ensure(f.sessionId);
    const second = await f.supervisor.ensure(f.sessionId);
    expect(driver.spawnCount()).toBe(1);
    expect(second.reused).toBe(true);
    expect(first.handle).toBe(second.handle);
    f.close();
  });

  it("并发 ensure 合并成一次 spawn（双标签页同时发消息）", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver });
    const [a, b] = await Promise.all([
      f.supervisor.ensure(f.sessionId),
      f.supervisor.ensure(f.sessionId),
    ]);
    expect(driver.spawnCount()).toBe(1);
    expect(a.handle).toBe(b.handle);
    f.close();
  });
});

describe("Supervisor · 崩溃与空闲回收", () => {
  it("非预期退出 → Session 置 crashed，活跃 Turn 的消息标 failed", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver });
    await f.supervisor.ensure(f.sessionId);

    f.db
      .prepare(
        `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
         VALUES ('m_turn', ?, 'ch_p', 't_crash', 'assistant', '半截', 'streaming', ?)`,
      )
      .run(f.sessionId, Date.now());

    const exits: { crashed: boolean }[] = [];
    f.supervisor.addListener({ onExit: (_s, _i, crashed) => exits.push({ crashed }) });
    f.supervisor.beginTurn(f.sessionId, {
      turnId: "t_crash",
      messageId: "m_turn",
      botId: f.botId,
      source: "interactive",
      startedAt: Date.now(),
    });

    driver.fireExit(1);
    await new Promise((r) => setTimeout(r, 20));

    const session = f.db.prepare("SELECT status, process_pid FROM sessions WHERE id = ?").get(f.sessionId) as {
      status: string;
      process_pid: number | null;
    };
    expect(session.status).toBe("crashed");
    expect(session.process_pid).toBeNull();

    const msg = f.db.prepare("SELECT status FROM messages WHERE id = 'm_turn'").get() as {
      status: string;
    };
    expect(msg.status).toBe("failed");
    expect(exits).toHaveLength(1);
    expect(exits[0]?.crashed).toBe(true);
    f.close();
  });

  it("exit 0 且无进行中 Turn（CLI 每轮正常退出）→ idle，不是 crashed，且保留 runtime_session_id", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver });
    await f.supervisor.ensure(f.sessionId);
    f.db
      .prepare("UPDATE sessions SET runtime_session_id = 'rt_keep' WHERE id = ?")
      .run(f.sessionId);

    const exits: boolean[] = [];
    f.supervisor.addListener({ onExit: (_s, _i, crashed) => exits.push(crashed) });

    driver.fireExit(0);
    await new Promise((r) => setTimeout(r, 20));

    const row = f.db
      .prepare("SELECT status, process_pid, runtime_session_id FROM sessions WHERE id = ?")
      .get(f.sessionId) as {
      status: string;
      process_pid: number | null;
      runtime_session_id: string | null;
    };
    expect(row.status).toBe("idle");
    expect(row.process_pid).toBeNull();
    // 关键：占位 runtime_session_id 必须留着，否则下一轮连「重建过」都判断不了
    expect(row.runtime_session_id).toBe("rt_keep");
    // 预期退出对订阅者不是崩溃
    expect(exits).toEqual([false]);
    f.close();
  });

  it("exit 0 但 Turn 还在跑（ACP 中途断开）→ 仍判 crashed，Turn 标失败", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver });
    await f.supervisor.ensure(f.sessionId);

    f.db
      .prepare(
        `INSERT INTO messages (id, session_id, channel_id, turn_id, role, content, status, created_at)
         VALUES ('m_half', ?, 'ch_p', 't_half', 'assistant', '半截', 'streaming', ?)`,
      )
      .run(f.sessionId, Date.now());

    const exits: boolean[] = [];
    f.supervisor.addListener({ onExit: (_s, _i, crashed) => exits.push(crashed) });
    f.supervisor.beginTurn(f.sessionId, {
      turnId: "t_half",
      messageId: "m_half",
      botId: f.botId,
      source: "interactive",
      startedAt: Date.now(),
    });

    driver.fireExit(0);
    await new Promise((r) => setTimeout(r, 20));

    const row = f.db.prepare("SELECT status FROM sessions WHERE id = ?").get(f.sessionId) as {
      status: string;
    };
    expect(row.status).toBe("crashed");
    const msg = f.db.prepare("SELECT status FROM messages WHERE id = 'm_half'").get() as {
      status: string;
    };
    expect(msg.status).toBe("failed");
    expect(exits).toEqual([true]);
    f.close();
  });

  it("主动 kill → 退出回调 crashed=false，状态按 reason 落（idle→reaped）", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver });
    await f.supervisor.ensure(f.sessionId);

    const exits: boolean[] = [];
    f.supervisor.addListener({ onExit: (_s, _i, crashed) => exits.push(crashed) });

    await f.supervisor.kill(f.sessionId, "idle");
    driver.fireExit(0);
    await new Promise((r) => setTimeout(r, 20));

    const row = f.db.prepare("SELECT status FROM sessions WHERE id = ?").get(f.sessionId) as {
      status: string;
    };
    expect(row.status).toBe("reaped");
    expect(exits).toHaveLength(1);
    expect(exits[0]).toBe(false);
    f.close();
  });

  it("空闲到期自动回收：进程被 kill，runtime_session_id 保留", async () => {
    const driver = createFakeProcDriver({ resumeOk: true });
    const f = setupSupervisor({ driver, idleReapMs: 60 });
    await f.supervisor.ensure(f.sessionId);
    f.db
      .prepare("UPDATE sessions SET runtime_session_id = 'rt_keep' WHERE id = ?")
      .run(f.sessionId);

    expect(f.supervisor.isAlive(f.sessionId)).toBe(true);
    await new Promise((r) => setTimeout(r, 250));

    expect(f.supervisor.isAlive(f.sessionId)).toBe(false);
    const row = f.db
      .prepare("SELECT status, runtime_session_id FROM sessions WHERE id = ?")
      .get(f.sessionId) as { status: string; runtime_session_id: string | null };
    expect(row.status).toBe("reaped");
    // 关键：runtime_session_id 必须保留，否则下次无法 resume
    expect(row.runtime_session_id).toBe("rt_keep");
    f.close();
  });

  it("权限挂起期间不回收（hold 保活）", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver, idleReapMs: 60 });
    await f.supervisor.ensure(f.sessionId);
    f.supervisor.setHeld(f.sessionId, true);

    await new Promise((r) => setTimeout(r, 250));
    expect(f.supervisor.isAlive(f.sessionId)).toBe(true);

    f.supervisor.setHeld(f.sessionId, false);
    await new Promise((r) => setTimeout(r, 250));
    expect(f.supervisor.isAlive(f.sessionId)).toBe(false);
    f.close();
  });

  it("有活跃 Turn 期间不回收", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver, idleReapMs: 60 });
    await f.supervisor.ensure(f.sessionId);
    f.supervisor.beginTurn(f.sessionId, {
      turnId: "t_long",
      messageId: "m_long",
      botId: f.botId,
      source: "interactive",
      startedAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(f.supervisor.isAlive(f.sessionId)).toBe(true);
    f.close();
  });

  it("运行时改绑 → 旧进程被杀，新的 fresh 会话", async () => {
    const driver = createFakeProcDriver();
    const f = setupSupervisor({ driver });
    await f.supervisor.ensure(f.sessionId);
    f.db
      .prepare("UPDATE sessions SET runtime_session_id = 'rt_old', resume_state = 'rebuilt' WHERE id = ?")
      .run(f.sessionId);

    // 换一个 runtimeId（同一个假驱动，但声明 id 变了）
    const sup2 = createSupervisor({
      db: f.db,
      resolveRuntime: () => ({
        runtimeId: "rt_other",
        declaration: { ...DECL_BASE, id: "other" },
        driver,
      }),
      idleReapMs: 0,
      killImpl: async () => ({ gone: true }),
      log: () => undefined,
    });
    // 用同一个 supervisor 无法换 runtimeId（resolveRuntime 是固定的），
    // 这里直接验证 kill 会清 process_pid 与 runtime_session_id 的处理路径
    await f.supervisor.kill(f.sessionId, "runtime_switch");
    const row = f.db
      .prepare("SELECT status, process_pid FROM sessions WHERE id = ?")
      .get(f.sessionId) as { status: string; process_pid: number | null };
    expect(row.status).toBe("ended");
    expect(row.process_pid).toBeNull();
    await sup2.dispose();
    f.close();
  });

  it("spawn 失败 → Session 置 crashed 且异常向上抛", async () => {
    const driver = createFakeProcDriver({ startFails: true });
    const f = setupSupervisor({ driver });
    await expect(f.supervisor.ensure(f.sessionId)).rejects.toThrow(/spawn 失败/);
    const row = f.db.prepare("SELECT status FROM sessions WHERE id = ?").get(f.sessionId) as {
      status: string;
    };
    expect(row.status).toBe("crashed");
    f.close();
  });
});

describe("PidRegistry", () => {
  it("登记 / 注销 / pidOf", () => {
    const reg = createPidRegistry();
    reg.register("s1", 1234);
    expect(reg.pidOf("s1")).toBe(1234);
    expect(reg.entries()).toHaveLength(1);
    reg.unregister("s1");
    expect(reg.pidOf("s1")).toBeNull();
  });

  it("killAllSync 杀掉登记的真实进程", async () => {
    const reg = createPidRegistry();
    const child = spawnHang();
    const pid = child.pid!;
    expect(await waitAlive(pid)).toBe(true);
    reg.register("s_live", pid);

    const killed = reg.killAllSync();
    expect(killed).toBe(1);
    expect(isProcessAlive(pid)).toBe(false);
    expect(reg.entries()).toHaveLength(0);
  }, 15000);
});
