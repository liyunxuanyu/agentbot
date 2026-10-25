import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent, EventType } from "../../src/shared/events.js";
import { EVENT_TYPES } from "../../src/shared/events.js";
import { createAcpDriver } from "../../src/server/adapters/channels/acp/driver.js";
import { setTurnContext } from "../../src/server/adapters/turn-context.js";
import type { AdapterDeclaration } from "../../src/server/adapters/contract.js";
import { loadDeclarations } from "../../src/server/adapters/registry.js";
import { FakeTransport } from "./fake-transport.js";

/**
 * ACP 通道契约测试（架构 §3.10）。
 *
 * 三条断言（PRD §7 的硬要求）：
 *   ① 事件序列深度相等（忽略 ts）
 *   ② 产出类型 ⊆ 声明的 eventCapabilities（掩码落地）
 *   ③ 插入垃圾行后仍不抛错（变异测试）
 *
 * fixture 是**手写的协议样本**（按 §3.5 映射表构造）：没有真实 Gemini CLI 时，
 * 这就是协议本身。录制脚本落地后替换成真实样本，断言不用改。
 *
 * 关键点：`peer.request()` 是「发出后 await」，所以喂响应必须与 await 交错，
 * 不能先 await 再喂（会死锁）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../fixtures/acp");

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fixture-acp",
  displayName: "Fixture ACP",
  protocol: "acp",
  launch: { command: "fixture-acp", args: [] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+\\.\\d+\\.\\d+)" },
  capabilities: {
    plan: true,
    permissionRequest: true,
    resume: true,
    images: "unknown",
    streaming: true,
    contextWindow: null,
  },
  // 全 9 类：本 fixture 用于验证映射表本身能产出哪些类型
  eventCapabilities: [...EVENT_TYPES],
  permission: { channel: "acp-reverse", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "acp",
  executionLocations: ["local"],
};

const MESSAGE_ID = "msg_fixture_assistant";
const TURN_ID = "turn_fixture";
const CRASH_STDERR = "Error: ENOENT spawn failed";

function readLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
}

interface ExpectedEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * 读期望序列并替换占位符。
 *
 * `$MESSAGE_ID` / `$STDERR_TAIL` 让 fixture 与「编排层注入的 id」「运行期 stderr」
 * 解耦 —— 期望文件里写死一个具体 id 会把断言绑死在测试常量上。
 */
function readExpected(name: string): ExpectedEvent[] {
  const text = readFileSync(join(FIXTURES, name), "utf8")
    .replaceAll("$MESSAGE_ID", MESSAGE_ID)
    .replaceAll("$STDERR_TAIL", CRASH_STDERR);
  return JSON.parse(text) as ExpectedEvent[];
}

interface FixtureRun {
  events: CanonicalEvent[];
  transport: FakeTransport;
  driver: ReturnType<typeof createAcpDriver>;
  handle: Awaited<ReturnType<ReturnType<typeof createAcpDriver>["start"]>>;
}

/**
 * 按「驱动发请求 → 我们喂对应响应 → 喂中间通知」的顺序跑完一个 fixture。
 *
 * fixture 约定：第 1 行 = initialize 响应，第 2 行 = session/new 响应，
 * 最后 1 行 = session/prompt 响应，中间都是 session/update 通知。
 */
async function runFixture(
  lines: string[],
  opts: { exitCode?: number | null; stderr?: string } = {},
): Promise<FixtureRun> {
  const transport = new FakeTransport();
  const driver = createAcpDriver({ transportFactory: () => transport });
  const events: CanonicalEvent[] = [];

  const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_fixture" });
  driver.onEvent(handle, (e) => events.push(e));

  // ① initialize：先拿 promise，再喂响应，最后 await
  const initPromise = driver.initialize(handle);
  transport.feedLines([lines[0] ?? "{}"]);
  const initResult = await initPromise;
  expect(initResult.healthStatus).toBe("healthy");

  // ② session/new
  const newPromise = driver.newSession(handle, { cwd: process.cwd() });
  transport.feedLines([lines[1] ?? "{}"]);
  const created = await newPromise;
  expect(created.runtimeSessionId.length).toBeGreaterThan(0);

  // ③ prompt：中间是通知，末尾是响应
  setTurnContext(handle, { turnId: TURN_ID, messageId: MESSAGE_ID, botId: "bot_fixture" });
  const promptPromise = driver.prompt(handle, { text: "跑一遍" });

  const middle = lines.slice(2);
  const crashed = opts.exitCode !== undefined && opts.exitCode !== 0;

  if (crashed) {
    // 崩溃场景：fixture 里没有 prompt 响应，全是通知；喂完直接模拟进程退出
    transport.feedLines(middle);
    if (opts.stderr) transport.emitStderr(opts.stderr);
    transport.close(opts.exitCode ?? 1);
  } else {
    // 正常场景：最后一行是 prompt 的响应，先喂其余再喂它，保证 done 在最后
    transport.feedLines(middle.slice(0, -1));
    if (opts.stderr) transport.emitStderr(opts.stderr);
    transport.feedLines(middle.slice(-1));
  }
  await promptPromise;

  return { events, transport, driver, handle };
}

/** 去掉时间与运行期才确定的字段，只留可断言的语义部分。 */
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

describe("ACP 契约 · 正常流", () => {
  it("事件序列与期望深度相等（忽略 ts / durationMs）", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    expect(comparable(events)).toEqual(readExpected("normal.expected.json"));
  });

  it("产出类型 ⊆ 声明的 eventCapabilities", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    const produced = new Set(events.map((e) => e.type));
    expect(produced.size).toBeGreaterThan(0);
    for (const type of produced) {
      expect(DECL.eventCapabilities).toContain(type as EventType);
    }
  });

  it("正文按 start → delta… → end 的顺序产出，首帧为 start、末帧为 end", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    const deltas = events.filter((e) => e.type === "message_delta");
    expect(deltas[0]?.payload).toMatchObject({ phase: "start" });
    expect(deltas[deltas.length - 1]?.payload).toMatchObject({ phase: "end" });
    // messageId 必须来自编排层注入的上下文，而不是驱动自己编的
    for (const d of deltas) {
      expect((d.payload as { messageId: string }).messageId).toBe(MESSAGE_ID);
    }
  });

  it("done 在最后一条，且带 usage（运行时上报了用量）", async () => {
    const { events } = await runFixture(readLines("normal.jsonl"));
    expect(events[events.length - 1]?.type).toBe("done");
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.payload).toMatchObject({ inputTokens: 1234, outputTokens: 56, reported: true });
  });
});

describe("ACP 契约 · 权限", () => {
  it("反向请求映射为 permission_request，且通道层不自行应答", async () => {
    const { events, transport } = await runFixture(readLines("permission.jsonl"));
    const perm = events.find((e) => e.type === "permission_request");
    expect(perm).toBeDefined();
    expect(perm?.payload).toMatchObject({
      requestId: "perm-1",
      action: "write",
      boundaryVerdict: "pending",
    });
    // 通道层绝不替核心做决定：应答之前不应写出任何「无 method」的响应帧
    const responses = transport.peekOutbound().filter((m) => m["method"] === undefined);
    expect(responses).toEqual([]);
  });

  it("respondPermission 写出运行时原 id 的响应；未知 requestId 明确报错", async () => {
    const { driver, handle, transport } = await runFixture(readLines("permission.jsonl"));

    // 先清掉已有的出站帧（prompt 请求本身）
    transport.takeOutbound();
    await driver.respondPermission(handle, "perm-1", { kind: "approve", scope: "once" });
    const responses = transport.takeOutbound();
    expect(responses.length).toBe(1);
    expect(String(responses[0]?.["id"])).toBe("perm-1");
    expect(responses[0]?.["result"]).toMatchObject({ outcome: { outcome: "selected" } });

    // 同一 requestId 不能应答两次（否则运行时会收到重复响应）
    await expect(
      driver.respondPermission(handle, "perm-1", { kind: "deny" }),
    ).rejects.toThrow(/不存在或已应答/);
  });
});

describe("ACP 契约 · 崩溃", () => {
  it("进程非零退出时产出 fatal error，且崩溃前的内容保留", async () => {
    const { events } = await runFixture(readLines("crash.jsonl"), {
      exitCode: 1,
      stderr: CRASH_STDERR,
    });
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.payload).toMatchObject({ fatal: true });
    expect(String((error?.payload as { message: string }).message)).toContain("exit 1");
    expect(events.some((e) => e.type === "message_delta")).toBe(true);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
  });

  it("进程退出后未决请求全部失败，不会永远挂住", async () => {
    const transport = new FakeTransport();
    const driver = createAcpDriver({ transportFactory: () => transport });
    const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_hang" });

    const pending = driver.newSession(handle, { cwd: process.cwd() });
    transport.close(1);
    await expect(pending).rejects.toThrow(/已退出/);
  });
});

describe("ACP 契约 · 变异（垃圾行不崩）", () => {
  it("非 JSON 行、未知 update、缺字段、孤儿结果都只降级，不抛错", async () => {
    const { events } = await runFixture(readLines("garbage.jsonl"));
    expect(comparable(events)).toEqual(readExpected("garbage.expected.json"));
  });

  it("未知 update 落 meta.unknown_protocol，绝不产出未声明的可渲染类型", async () => {
    const { events } = await runFixture(readLines("garbage.jsonl"));
    const unknown = events.filter(
      (e) => e.type === "meta" && (e.payload as { kind: string }).kind === "unknown_protocol",
    );
    expect(unknown.length).toBeGreaterThanOrEqual(2);
    // 可渲染类型必须都在 9 类之内；meta 是内部状态，不参与掩码
    for (const e of events) {
      if (e.type === "meta") continue;
      expect(EVENT_TYPES as readonly string[]).toContain(e.type);
    }
  });
});

describe("ACP 契约 · 声明文件一致性", () => {
  it("gemini-cli 声明的 eventCapabilities 覆盖映射表能产出的全部类型", () => {
    const { loaded, errors } = loadDeclarations();
    expect(errors).toEqual([]);
    const gemini = loaded.find((l) => l.declaration.id === "gemini-cli");
    expect(gemini).toBeDefined();
    expect([...(gemini?.declaration.eventCapabilities ?? [])].sort()).toEqual(
      [...EVENT_TYPES].sort(),
    );
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
