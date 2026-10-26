import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type DB } from "../../src/server/core/db/db.js";
import { createEventBus, type EventBus } from "../../src/server/core/events/bus.js";
import { createSessionLock } from "../../src/server/core/orchestrator/session-lock.js";
import { createTurnOrchestrator } from "../../src/server/core/orchestrator/turn.js";
import { createSupervisor, type Supervisor } from "../../src/server/core/process/supervisor.js";
import { isProcessAlive, killTreeSync } from "../../src/server/core/process/kill-tree.js";
import { createPermissionResolver } from "../../src/server/core/permissions/resolver.js";
import { toPermissionDto } from "../../src/server/http/routes/permissions.js";
import { getTurnContext } from "../../src/server/adapters/turn-context.js";
import type {
  AdapterDeclaration,
  ChannelDriver,
  PermissionDecision,
  ProbeResult,
  RuntimePermissionRequest,
  SessionHandle,
} from "../../src/server/adapters/contract.js";
import type { CanonicalEvent } from "../../src/shared/events.js";

/**
 * M5+M6 接线测试：Supervisor 与编排层、权限层之间的契约。
 *
 * 这里的驱动**真的 spawn 一个 node 子进程**，pid 是真的：
 * 「取消 → 1s 内进程消失」这条断言只有用真 pid 才有意义。
 */

const NODE = process.execPath;
const HANG = "setInterval(()=>{},1000)";
/** 边界外目标：Windows 用系统盘路径，POSIX 用 /etc/hosts（见 http-permissions 同名字段说明）。 */
const OUTSIDE_TARGET =
  process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";

let workDir = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "agentbot-life-"));
});

afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Windows 偶发句柄占用
  }
});

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "real-proc",
  displayName: "Real Proc",
  protocol: "cli-stdio",
  launch: { command: "node", args: [] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+)" },
  capabilities: {
    plan: true,
    permissionRequest: true,
    resume: true,
    images: "unknown",
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: ["message_delta", "done", "error", "permission_request"],
  permission: { channel: "acp-reverse", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "acp",
  executionLocations: ["local"],
};

interface RealDriver extends ChannelDriver {
  /** 让驱动在 prompt 期间抛出一个权限请求（模拟运行时请求授权）。 */
  emitPermission(req: RuntimePermissionRequest): void;
  /** 让驱动产出一条事件（模拟运行时上报 session/update）。 */
  emitEvent(e: CanonicalEvent): void;
  fireExit(code: number): void;
  pids: number[];
}

function createRealDriver(opts: { promptHangs?: boolean } = {}): RealDriver {
  let handle: SessionHandle | null = null;
  let exitCb: ((i: { code: number | null; stderrTail: string }) => void) | null = null;
  let permCb: ((r: RuntimePermissionRequest) => void) | null = null;
  let eventCb: ((e: CanonicalEvent) => void) | null = null;
  const pids: number[] = [];
  const children = new Map<number, ReturnType<typeof spawn>>();
  let release: (() => void) | null = null;
  let disposed = false;

  const driver: RealDriver = {
    protocol: "cli-stdio",
    async start() {
      const child = spawn(NODE, ["-e", HANG], { stdio: "ignore", windowsHide: true });
      const pid = child.pid ?? null;
      if (pid !== null) {
        pids.push(pid);
        children.set(pid, child);
      }
      handle = { sessionId: "s", pid, runtimeSessionId: null };
      child.on("close", (code) => {
        if (disposed) return;
        exitCb?.({ code, stderrTail: "" });
      });
      return handle;
    },
    async initialize(): Promise<ProbeResult> {
      return {
        capabilities: DECL.capabilities,
        source: "probed",
        version: "1.0.0",
        healthStatus: "healthy",
      };
    },
    async newSession() {
      return { runtimeSessionId: "rt_real" };
    },
    async resumeSession() {
      return { ok: false, reason: "测试：不支持" };
    },
    async prompt(h) {
      // 等取消或测试放行；期间可被 emitPermission 触发权限请求
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      void h;
    },
    async cancel() {
      // 运行时收到 cancel 后「不响应」——模拟卡死的 CLI，让编排层走 1s 树杀
      void 0;
    },
    async respondPermission() {
      /* 记录在测试里做 */
    },
    onEvent(_h, cb) {
      eventCb = cb;
    },
    onPermission(_h, cb) {
      permCb = cb;
    },
    onExit(_h, cb) {
      exitCb = cb;
    },
    async dispose() {
      disposed = true;
      release?.();
    },
    emitPermission(req) {
      permCb?.(req);
    },
    emitEvent(e) {
      eventCb?.(e);
    },
    fireExit(code) {
      exitCb?.({ code, stderrTail: "boom" });
    },
    pids,
  };
  void opts;
  return driver;
}

interface Fixture {
  db: DB;
  bus: EventBus;
  supervisor: Supervisor;
  orchestrator: ReturnType<typeof createTurnOrchestrator>;
  driver: RealDriver;
  sessionId: string;
  botId: string;
  channelId: string;
  close: () => void;
}

function setup(driver: RealDriver): Fixture {
  const db = openDb(":memory:");
  const now = Date.now();
  const botId = "bot_life";
  const channelId = "ch_life";

  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, execution_location, repo_path, status,
                       allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
     VALUES (?, '小助', '简洁。', 'local', ?, 'active', ?, 0, 0, 0, ?, ?)`,
  ).run(botId, workDir, JSON.stringify([workDir]), now, now);
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, runtime_id, resume_state, status, started_at)
     VALUES ('sess_life', ?, ?, 'rt_life', 'fresh', 'created', ?)`,
  ).run(botId, channelId, now);

  const bus = createEventBus({ ringSize: 100 });
  const supervisor = createSupervisor({
    db,
    bus,
    resolveRuntime: () => ({ runtimeId: "rt_life", declaration: DECL, driver }),
    idleReapMs: 0,
    log: () => undefined,
  });
  const orchestrator = createTurnOrchestrator({
    db,
    bus,
    lock: createSessionLock(),
    resolveRuntime: () => ({ runtimeId: "rt_life", declaration: DECL, driver }),
    supervisor,
  });

  return {
    db,
    bus,
    supervisor,
    orchestrator,
    driver,
    sessionId: "sess_life",
    botId,
    channelId,
    close: () => {
      void orchestrator.dispose();
      void supervisor.dispose();
      db.close();
    },
  };
}

function msgStatus(db: DB, id: string): string {
  const row = db.prepare("SELECT status FROM messages WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  return row?.status ?? "missing";
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("取消 → 1s 内进程消失（M4 cancel + M5 树杀）", () => {
  it("运行时无视 cancel 时，编排层在 1s 内树杀进程并把这一轮标 interrupted", async () => {
    const driver = createRealDriver();
    const f = setup(driver);

    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "跑个长任务",
    });
    await waitFor(() => f.supervisor.isAlive(info.sessionId));
    const pid = f.driver.pids[0]!;
    expect(isProcessAlive(pid)).toBe(true);

    const started = Date.now();
    const ok = await f.orchestrator.cancel(info.sessionId, info.turnId);
    const elapsed = Date.now() - started;

    expect(ok).toBe(true);
    // 1s 等待 + 树杀 + 收口，给 2.5s 余量（Windows taskkill 启动本身要几十 ms）
    expect(elapsed).toBeLessThan(2500);
    expect(isProcessAlive(pid)).toBe(false);
    expect(msgStatus(f.db, info.messageId)).toBe("interrupted");
    expect(f.supervisor.isAlive(info.sessionId)).toBe(false);

    // 兜底清理
    if (isProcessAlive(pid)) killTreeSync(pid);
    f.close();
  }, 20000);
});

describe("崩溃 → Turn 标失败（M5 onExit 唯一回调点）", () => {
  it("进程非预期退出 → 消息 failed，Session crashed", async () => {
    const driver = createRealDriver();
    const f = setup(driver);

    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "跑一下",
    });
    await waitFor(() => f.supervisor.isAlive(info.sessionId));

    f.driver.fireExit(3);
    await waitFor(() => msgStatus(f.db, info.messageId) === "failed");

    const session = f.db.prepare("SELECT status FROM sessions WHERE id = ?").get(info.sessionId) as {
      status: string;
    };
    expect(session.status).toBe("crashed");

    // 事件里有一条 fatal error（前端显示「失败：运行时退出」）
    const errors = f.db
      .prepare("SELECT payload FROM events WHERE session_id = ? AND type = 'error'")
      .all(info.sessionId) as { payload: string }[];
    expect(errors.length).toBeGreaterThan(0);
    const payload = JSON.parse(errors.at(-1)!.payload) as { fatal: boolean; message: string };
    expect(payload.fatal).toBe(true);
    expect(payload.message).toContain("运行时进程已退出");

    for (const pid of driver.pids) if (isProcessAlive(pid)) killTreeSync(pid);
    f.close();
  }, 20000);
});

describe("权限接线：驱动上报 → 裁决 → 卡片 DTO", () => {
  it("边界内写 → pending 卡片，GET 的 DTO 字段齐全（前端倒计时靠它）", async () => {
    const driver = createRealDriver();
    const f = setup(driver);

    const responded: { id: string; decision: PermissionDecision }[] = [];
    // 与 main.ts 相同的接线方式
    const permissions = createPermissionResolver({
      db: f.db,
      bus: f.bus,
      isSessionAlive: (sid) => f.supervisor.isAlive(sid),
      sessionCwdOf: () => workDir,
      respond: async (sid, id, decision) => {
        responded.push({ id, decision });
        return f.supervisor.respondPermission(sid, id, decision);
      },
      setHeld: (sid, held) => f.supervisor.setHeld(sid, held),
      setSessionStatus: (sid, status) => f.supervisor.setStatus(sid, status),
      log: () => undefined,
    });

    f.supervisor.addListener({
      onPermission: (sid, req) => {
        const turn = f.supervisor.activeTurn(sid);
        void permissions.handle({
          sessionId: sid,
          botId: turn?.botId ?? f.botId,
          turnId: turn?.turnId ?? "turn_x",
          request: req,
          source: turn?.source ?? "interactive",
        });
      },
    });

    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "改一下 README",
    });
    await waitFor(() => f.supervisor.isAlive(info.sessionId));
    // 等 beginTurn 登记完（真实运行时只在 prompt 期间请求授权，测试里要等到同一时点）
    await waitFor(() => f.supervisor.activeTurn(info.sessionId) !== null);

    const target = join(workDir, "README.md");
    driver.emitPermission({ requestId: "perm_live", action: "write", target });
    await waitFor(() => permissions.get("perm_live") !== null);

    const row = permissions.get("perm_live")!;
    const dto = toPermissionDto(row);
    // 前端倒计时与挂起态需要的字段一个都不能少
    expect(dto.timeoutPolicy).toBe("reject");
    expect(dto.status).toBe("pending");
    expect(dto.boundaryVerdict).toBe("allowed");
    expect(dto.expiresAt).not.toBeNull();
    expect(dto.heldSince).toBeNull();
    expect(dto.decidedAt).toBeNull();
    expect(dto.sessionId).toBe(info.sessionId);
    expect(dto.turnId).toBe(info.turnId);

    // 会话进入 waiting_permission（前端 Bot 状态显示「等待批准」）
    const session = f.db.prepare("SELECT status FROM sessions WHERE id = ?").get(info.sessionId) as {
      status: string;
    };
    expect(session.status).toBe("waiting_permission");

    // 决策后解锁：回传 approve，卡片转 decided
    await permissions.decide("perm_live", "approve");
    expect(permissions.get("perm_live")?.status).toBe("decided");
    expect(responded).toHaveLength(1);
    expect(responded[0]?.decision.kind).toBe("approve");

    permissions.dispose();
    await f.orchestrator.cancel(info.sessionId, info.turnId);
    for (const pid of driver.pids) if (isProcessAlive(pid)) killTreeSync(pid);
    f.close();
  }, 20000);

  it("越界写 → 卡片标 denied_boundary，且不经过 respondPermission 之外任何转发", async () => {
    const driver = createRealDriver();
    const f = setup(driver);

    const responded: PermissionDecision[] = [];
    const permissions = createPermissionResolver({
      db: f.db,
      bus: f.bus,
      isSessionAlive: (sid) => f.supervisor.isAlive(sid),
      sessionCwdOf: () => workDir,
      respond: async (_sid, _id, decision) => {
        responded.push(decision);
        return true;
      },
      setHeld: () => undefined,
      setSessionStatus: () => undefined,
      log: () => undefined,
    });

    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "写到系统目录",
    });
    await waitFor(() => f.supervisor.isAlive(info.sessionId));

    await permissions.handle({
      sessionId: info.sessionId,
      botId: f.botId,
      turnId: info.turnId,
      source: "interactive",
      request: { requestId: "perm_boundary", action: "write", target: OUTSIDE_TARGET },
    });

    const row = permissions.get("perm_boundary")!;
    expect(row.status).toBe("denied_boundary");
    expect(row.boundaryVerdict).toBe("denied");
    expect(row.expiresAt).toBeNull();
    // 唯一一次回传是 deny（直接拒绝，不弹卡）
    expect(responded).toHaveLength(1);
    expect(responded[0]?.kind).toBe("deny");

    permissions.dispose();
    await f.orchestrator.cancel(info.sessionId, info.turnId);
    for (const pid of driver.pids) if (isProcessAlive(pid)) killTreeSync(pid);
    f.close();
  }, 20000);
});

describe("事件接线：Supervisor 把驱动事件转给编排层", () => {
  it("驱动事件经 Supervisor 转发后落库（turnId/messageId 由 turn-context 提供）", async () => {
    const driver = createRealDriver();
    const f = setup(driver);

    // 让 prompt 立刻产出一条 message_delta：turnId/messageId 从 turn-context 取
    const origPrompt = driver.prompt.bind(driver);
    let emitted = false;
    driver.prompt = async (h, input) => {
      const ctx = getTurnContext(h);
      if (ctx && !emitted) {
        emitted = true;
        driver.emitEvent({
          type: "message_delta",
          turnId: ctx.turnId,
          ts: Date.now(),
          payload: { messageId: ctx.messageId, phase: "delta", text: "收到。" },
        });
      }
      await origPrompt(h, input);
    };

    const info = await f.orchestrator.start({
      channelId: f.channelId,
      botId: f.botId,
      text: "在吗",
    });
    await waitFor(
      () =>
        (
          f.db
            .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'message_delta'")
            .get(info.sessionId) as { n: number }
        ).n > 0,
    );

    const msg = f.db.prepare("SELECT content FROM messages WHERE id = ?").get(info.messageId) as {
      content: string;
    };
    expect(msg.content).toBe("收到。");

    await f.orchestrator.cancel(info.sessionId, info.turnId);
    for (const pid of driver.pids) if (isProcessAlive(pid)) killTreeSync(pid);
    f.close();
  }, 20000);
});
