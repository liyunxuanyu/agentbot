import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent, EventType } from "../../src/shared/events.js";
import { EVENT_TYPES } from "../../src/shared/events.js";
import { createNativeDriver } from "../../src/server/adapters/channels/native/driver.js";
import { setTurnContext } from "../../src/server/adapters/turn-context.js";
import type { AdapterDeclaration } from "../../src/server/adapters/contract.js";
import { loadDeclarations } from "../../src/server/adapters/registry.js";
import { FakeTransport } from "./fake-transport.js";

/**
 * 原生通道（Codex app-server）契约测试（架构 §3.10）。
 *
 * 三条断言（PRD §7 的硬要求）：
 *   ① 事件序列深度相等（忽略 ts / durationMs）
 *   ② 产出类型 ⊆ 声明的 eventCapabilities（掩码落地）
 *   ③ 插入垃圾行后仍不抛错（变异测试）
 *
 * fixture 是**按真实协议形状手写的样本**：通知名、payload 字段与枚举值取自
 * 本机 codex-cli 0.163.0 的 `codex app-server generate-json-schema` 产物，
 * 以及真实 app-server 会话（initialize / thread/start / turn/start）的录制。
 * 真实账号下没有跑完一轮（本机未登录，见交付说明），所以事件流部分仍是手写。
 *
 * fixture 约定（与 ACP 一致）：
 *   第 1 行 = initialize 响应，第 2 行 = thread/start 响应，
 *   第 3 行 = turn/start 响应，其余都是服务端通知。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../fixtures/codex");

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fixture-native",
  displayName: "Fixture Native",
  protocol: "codex-app-server",
  launch: { command: "fixture-native", args: ["app-server"] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+\\.\\d+\\.\\d+)" },
  capabilities: {
    plan: "unknown",
    permissionRequest: true,
    resume: true,
    images: "unknown",
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: [
    "message_delta",
    "thought",
    "tool_call",
    "tool_result",
    "permission_request",
    "usage",
    "done",
    "error",
  ],
  permission: { channel: "jsonrpc-approval", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "native",
  executionLocations: ["local"],
};

const MESSAGE_ID = "msg_fixture_assistant";
const TURN_ID = "turn_fixture";
const CRASH_STDERR = "thread 'main' panicked at codex-core/src/lib.rs";

function readLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
}

interface ExpectedEvent {
  type: string;
  payload: Record<string, unknown>;
}

function readExpected(name: string): ExpectedEvent[] {
  const text = readFileSync(join(FIXTURES, name), "utf8")
    .replaceAll("$MESSAGE_ID", MESSAGE_ID)
    .replaceAll("$STDERR_TAIL", CRASH_STDERR);
  return JSON.parse(text) as ExpectedEvent[];
}

interface FixtureRun {
  events: CanonicalEvent[];
  transport: FakeTransport;
  driver: ReturnType<typeof createNativeDriver>;
  handle: Awaited<ReturnType<ReturnType<typeof createNativeDriver>["start"]>>;
}

async function runFixture(
  lines: string[],
  opts: { exitCode?: number | null; stderr?: string } = {},
): Promise<FixtureRun> {
  const transport = new FakeTransport();
  const driver = createNativeDriver({ transportFactory: () => transport });
  const events: CanonicalEvent[] = [];

  const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_native" });
  driver.onEvent(handle, (e) => events.push(e));

  // ① initialize：先拿 promise，再喂响应，最后 await
  const initPromise = driver.initialize(handle);
  transport.feedLines([lines[0] ?? "{}"]);
  const initResult = await initPromise;
  expect(initResult.healthStatus).toBe("healthy");

  // ② thread/start
  const newPromise = driver.newSession(handle, { cwd: process.cwd() });
  transport.feedLines([lines[1] ?? "{}"]);
  const created = await newPromise;
  expect(created.runtimeSessionId.length).toBeGreaterThan(0);

  // ③ prompt：先喂 turn/start 响应，再喂通知
  setTurnContext(handle, { turnId: TURN_ID, messageId: MESSAGE_ID, botId: "bot_fixture" });
  const promptPromise = driver.prompt(handle, { text: "跑一遍" });
  transport.feedLines([lines[2] ?? "{}"]);

  const middle = lines.slice(3);
  const crashed = opts.exitCode !== undefined && opts.exitCode !== 0;

  if (crashed) {
    transport.feedLines(middle);
    if (opts.stderr) transport.emitStderr(opts.stderr);
    transport.close(opts.exitCode ?? 1);
  } else {
    transport.feedLines(middle);
  }
  await promptPromise;

  return { events, transport, driver, handle };
}

function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "durationMs") continue;
    out[k] = v;
  }
  if (out["stopReason"] !== undefined) out["durationMs"] = 0;
  return out;
}

function comparable(events: CanonicalEvent[]): ExpectedEvent[] {
  return events.map((e) => ({
    type: e.type,
    payload: normalizePayload(e.payload as unknown as Record<string, unknown>),
  }));
}

describe("Codex 契约 · 正常流", () => {
  it("事件序列与期望深度相等（忽略 ts / durationMs）", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    expect(comparable(events)).toEqual(readExpected("normal.expected.json"));
  });

  it("产出类型 ⊆ 声明的 eventCapabilities", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    const produced = new Set(events.map((e) => e.type));
    expect(produced.size).toBeGreaterThan(0);
    for (const type of produced) {
      if (type === "meta") continue;
      expect(DECL.eventCapabilities).toContain(type as EventType);
    }
  });

  it("正文按 start → delta… → end 产出，messageId 来自编排层注入", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    const deltas = events.filter((e) => e.type === "message_delta");
    expect(deltas[0]?.payload).toMatchObject({ phase: "start" });
    expect(deltas[deltas.length - 1]?.payload).toMatchObject({ phase: "end" });
    for (const d of deltas) {
      expect((d.payload as { messageId: string }).messageId).toBe(MESSAGE_ID);
    }
  });

  it("done 在最后一条，usage 来自 tokenUsage.last（本轮而非累计）", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    expect(events[events.length - 1]?.type).toBe("done");
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.payload).toMatchObject({ inputTokens: 1234, outputTokens: 56, reported: true });
  });

  it("userMessage item 被丢弃（用户消息由产品层写入，不回显）", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    const deltas = events
      .filter((e) => e.type === "message_delta")
      .map((e) => (e.payload as { text: string }).text)
      .filter((t) => t.length > 0);
    // 助手正文里可以恰好包含用户原话的片段，但绝不能整段回显用户消息
    expect(deltas).not.toContain("把映射表补上");
    expect(deltas.join("")).not.toBe("把映射表补上");
  });

  it("prompt 等到 turn/completed 才返回（不会提前补 done）", async () => {
    const transport = new FakeTransport();
    const driver = createNativeDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_wait" });
    const events: CanonicalEvent[] = [];
    driver.onEvent(handle, (e) => events.push(e));

    const lines = readLines("normal.jsonl");
    const initPromise = driver.initialize(handle);
    transport.feedLines([lines[0] ?? "{}"]);
    await initPromise;
    const newPromise = driver.newSession(handle, { cwd: process.cwd() });
    transport.feedLines([lines[1] ?? "{}"]);
    await newPromise;

    const promptPromise = driver.prompt(handle, { text: "跑一遍" });
    transport.feedLines([lines[2] ?? "{}"]);
    let settled = false;
    void promptPromise.then(() => {
      settled = true;
    });
    // 只喂到一半：还没有 turn/completed，prompt 不能 resolve
    transport.feedLines(lines.slice(3, 10));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    transport.feedLines(lines.slice(10));
    await promptPromise;
    expect(settled).toBe(true);
    expect(events[events.length - 1]?.type).toBe("done");
  });
});

describe("Codex 契约 · 权限", () => {
  it("审批反向请求映射为 permission_request，且通道层不自行应答", async () => {
    const { events, transport } = await runFixture(readLines("permission.jsonl"));
    const perm = events.find((e) => e.type === "permission_request");
    expect(perm).toBeDefined();
    expect(perm?.payload).toMatchObject({
      requestId: "approval-1",
      action: "write",
      // 请求本身不带路径，用 item/started 记下的改动路径
      target: "D:\\work\\demo\\agentbot.config.json",
      boundaryVerdict: "pending",
    });
    // 通道层绝不替核心做决定：应答之前不应写出任何「无 method」的响应帧
    const responses = transport.peekOutbound().filter((m) => m["method"] === undefined);
    expect(responses).toEqual([]);
  });

  it("respondPermission 用运行时原 id 写响应；未知 requestId 明确报错", async () => {
    const { driver, handle, transport } = await runFixture(readLines("permission.jsonl"));

    transport.takeOutbound();
    await driver.respondPermission(handle, "approval-1", { kind: "approve", scope: "once" });
    const responses = transport.takeOutbound();
    expect(responses.length).toBe(1);
    expect(String(responses[0]?.["id"])).toBe("approval-1");
    // item/fileChange/requestApproval 的决定词是 accept / decline
    expect(responses[0]?.["result"]).toMatchObject({ decision: "accept" });

    await expect(
      driver.respondPermission(handle, "approval-1", { kind: "deny" }),
    ).rejects.toThrow(/不存在或已应答/);
  });

  it("onPermission 上报归一化的动作与目标（供核心边界判定）", async () => {
    const transport = new FakeTransport();
    const driver = createNativeDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_perm_cb" });
    const seen: { requestId: string; action: string; target: string }[] = [];
    driver.onPermission(handle, (req) => seen.push(req));

    const lines = readLines("permission.jsonl");
    const initPromise = driver.initialize(handle);
    transport.feedLines([lines[0] ?? "{}"]);
    await initPromise;
    const newPromise = driver.newSession(handle, { cwd: process.cwd() });
    transport.feedLines([lines[1] ?? "{}"]);
    await newPromise;

    const promptPromise = driver.prompt(handle, { text: "写入配置" });
    transport.feedLines([lines[2] ?? "{}"]);
    transport.feedLines(lines.slice(3));
    await promptPromise;

    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      requestId: "approval-1",
      action: "write",
      target: "D:\\work\\demo\\agentbot.config.json",
    });
  });

  it("没有活跃 Turn 时的审批请求直接回拒绝（不阻塞运行时）", async () => {
    const transport = new FakeTransport();
    const driver = createNativeDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_orphan_perm" });
    const seen: unknown[] = [];
    driver.onPermission(handle, (r) => seen.push(r));

    transport.feedLines([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "orphan-1",
        method: "item/fileChange/requestApproval",
        params: { threadId: "t", turnId: "t1", itemId: "i1", startedAtMs: 1 },
      }),
    ]);

    expect(seen.length).toBe(0);
    const out = transport.takeOutbound();
    expect(out.length).toBe(1);
    expect(String(out[0]?.["id"])).toBe("orphan-1");
    expect(out[0]?.["result"]).toMatchObject({ decision: "decline" });
  });

  it("不支持的反向请求回 -32601，让运行时自己降级", async () => {
    const transport = new FakeTransport();
    const driver = createNativeDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_unknown_req" });

    transport.feedLines([
      JSON.stringify({
        jsonrpc: "2.0",
        id: "q-1",
        method: "item/tool/requestUserInput",
        params: { threadId: "t", turnId: "t1", itemId: "i1", questions: [], isBlocking: true },
      }),
    ]);

    const out = transport.takeOutbound();
    expect(out.length).toBe(1);
    expect(String(out[0]?.["id"])).toBe("q-1");
    expect((out[0]?.["error"] as { code?: number } | undefined)?.code).toBe(-32601);
    // 未上报给权限层：它不是授权请求
    expect(driver).toBeDefined();
    void handle;
  });
});

describe("Codex 契约 · 崩溃", () => {
  it("进程非零退出时产出 fatal error，崩溃前的内容保留", async () => {
    const { events } = await runFixture(readLines("crash.jsonl"), {
      exitCode: 1,
      stderr: CRASH_STDERR,
    });
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.payload).toMatchObject({ fatal: true, code: "runtime_crashed" });
    expect(String((error?.payload as { message: string }).message)).toContain("exit 1");
    expect(String((error?.payload as { detail: string }).detail)).toContain("panicked");
    expect(events.some((e) => e.type === "message_delta")).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    // 崩溃不再补 done：fatal error 就是终态（与 ACP 通道一致）
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("进程退出后未决请求全部失败，不会永远挂住", async () => {
    const transport = new FakeTransport();
    const driver = createNativeDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_hang" });

    const pending = driver.newSession(handle, { cwd: process.cwd() });
    transport.close(1);
    await expect(pending).rejects.toThrow(/已退出/);
  });

  it("turn.status=failed 时产出 fatal error 并收口", async () => {
    const transport = new FakeTransport();
    const driver = createNativeDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_failed" });
    const events: CanonicalEvent[] = [];
    driver.onEvent(handle, (e) => events.push(e));

    const lines = readLines("crash.jsonl");
    const initPromise = driver.initialize(handle);
    transport.feedLines([lines[0] ?? "{}"]);
    await initPromise;
    const newPromise = driver.newSession(handle, { cwd: process.cwd() });
    transport.feedLines([lines[1] ?? "{}"]);
    await newPromise;

    const promptPromise = driver.prompt(handle, { text: "跑一遍" });
    transport.feedLines([lines[2] ?? "{}"]);
    transport.feedLines([
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "t",
          turn: {
            id: "t1",
            status: "failed",
            items: [],
            error: { message: "模型拒绝了这次请求", additionalDetails: "policy violation" },
          },
        },
      }),
    ]);
    await promptPromise;

    const error = events.find((e) => e.type === "error");
    expect(error?.payload).toMatchObject({
      code: "runtime_error",
      message: "模型拒绝了这次请求",
      detail: "policy violation",
      fatal: true,
    });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("运行时自报 willRetry 的 error 是非致命警告，不结束本轮", async () => {
    const transport = new FakeTransport();
    const driver = createNativeDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_retry" });
    const events: CanonicalEvent[] = [];
    driver.onEvent(handle, (e) => events.push(e));

    const lines = readLines("crash.jsonl");
    const initPromise = driver.initialize(handle);
    transport.feedLines([lines[0] ?? "{}"]);
    await initPromise;
    const newPromise = driver.newSession(handle, { cwd: process.cwd() });
    transport.feedLines([lines[1] ?? "{}"]);
    await newPromise;

    const promptPromise = driver.prompt(handle, { text: "跑一遍" });
    transport.feedLines([lines[2] ?? "{}"]);
    transport.feedLines([
      JSON.stringify({
        method: "error",
        params: {
          threadId: "t",
          turnId: "t1",
          willRetry: true,
          error: { message: "Reconnecting... 2/5", additionalDetails: "request timed out" },
        },
      }),
      JSON.stringify({
        method: "turn/completed",
        params: { threadId: "t", turn: { id: "t1", status: "completed", items: [], error: null } },
      }),
    ]);
    await promptPromise;

    const warning = events.find((e) => e.type === "error");
    expect(warning?.payload).toMatchObject({ code: "runtime_retrying", fatal: false });
    expect(events[events.length - 1]?.type).toBe("done");
  });
});

describe("Codex 契约 · 真实录制（未登录账号）", () => {
  /**
   * `real-session.jsonl` 是用本机 codex-cli 0.163.0 真实 app-server 录的原始行
   * （initialize → thread/start → turn/start → 重试错误）。本机未登录，所以
   * 这一轮没有模型输出、也没有 turn/completed —— 它恰好验证了「握手与开会话
   * 在真实进程上成立」以及「运行时自报重试时不能当致命错误」。
   *
   * 这段是**实测**，不是手写样本；手写的那三份覆盖渲染路径。
   */
  it("真实握手/开会话成立，重试错误非致命，进程退出后 prompt 收敛", async () => {
    const lines = readLines("real-session.jsonl");
    const transport = new FakeTransport();
    const driver = createNativeDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_real" });
    const events: CanonicalEvent[] = [];
    driver.onEvent(handle, (e) => events.push(e));

    const initPromise = driver.initialize(handle);
    transport.feedLines([lines[0] ?? "{}"]);
    const init = await initPromise;
    expect(init.healthStatus).toBe("healthy");
    expect(init.source).toBe("probed");

    const newPromise = driver.newSession(handle, { cwd: process.cwd() });
    transport.feedLines(lines.slice(1, 3));
    const created = await newPromise;
    // 真实 threadId 形如 01a16ea6-4db8-79d2-8df1-c6cc16fb8640
    expect(created.runtimeSessionId).toMatch(/^[0-9a-f-]{36}$/);

    setTurnContext(handle, { turnId: TURN_ID, messageId: MESSAGE_ID, botId: "bot_fixture" });
    const promptPromise = driver.prompt(handle, { text: "只回答两个字：你好" });
    transport.feedLines(lines.slice(3));
    // 真实录制里运行时自报「Reconnecting... 2/5」，willRetry=true → 非致命
    const retry = events.find((e) => e.type === "error");
    expect(retry?.payload).toMatchObject({ code: "runtime_retrying", fatal: false });

    // 进程退出：prompt 必须收敛（不能挂到超时）
    transport.close(1);
    await promptPromise;
    const crash = events.filter((e) => e.type === "error").at(-1);
    expect(crash?.payload).toMatchObject({ code: "runtime_crashed", fatal: true });
  });
});

describe("Codex 契约 · 变异（垃圾行不崩）", () => {
  it("非 JSON 行、未知 item、孤儿结果都只降级，不抛错", async () => {
    const { events } = await runFixture(readLines("garbage.jsonl"));
    expect(comparable(events)).toEqual(readExpected("garbage.expected.json"));
  });

  it("未知 item/turn 落 meta.unknown_protocol，绝不产出未声明的可渲染类型", async () => {
    const { events } = await runFixture(readLines("garbage.jsonl"));
    const unknown = events.filter(
      (e) => e.type === "meta" && (e.payload as { kind: string }).kind === "unknown_protocol",
    );
    expect(unknown.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      if (e.type === "meta") continue;
      expect(EVENT_TYPES as readonly string[]).toContain(e.type);
    }
  });
});

describe("Codex 契约 · 声明文件一致性", () => {
  it("codex 声明的掩码只含驱动确实会产出的类型", () => {
    const { loaded, errors } = loadDeclarations();
    expect(errors).toEqual([]);
    const codex = loaded.find((l) => l.declaration.id === "codex");
    expect(codex).toBeDefined();
    expect(codex?.declaration.protocol).toBe("codex-app-server");
    expect(codex?.declaration.permission.channel).toBe("jsonrpc-approval");
    expect(codex?.declaration.resumeStrategy).toBe("native");
    // §3.6 的映射表能产出的类型（不含 plan：本通道不产出计划）
    expect([...(codex?.declaration.eventCapabilities ?? [])].sort()).toEqual(
      [
        "message_delta",
        "thought",
        "tool_call",
        "tool_result",
        "permission_request",
        "usage",
        "done",
        "error",
      ].sort(),
    );
    expect(codex?.declaration.eventCapabilities).not.toContain("plan");
  });

  it("5 个内置声明全部可加载且掩码非空", () => {
    const { loaded, errors } = loadDeclarations();
    expect(errors).toEqual([]);
    expect(loaded.map((l) => l.declaration.id).sort()).toEqual(
      ["claude-code", "codex", "dsh", "gemini-cli", "zcode"].sort(),
    );
    for (const { declaration } of loaded) {
      expect(declaration.eventCapabilities.length).toBeGreaterThan(0);
    }
  });
});
