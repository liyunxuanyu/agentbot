import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CanonicalEvent, EventType } from "../../src/shared/events.js";
import { createCliDriver } from "../../src/server/adapters/channels/cli/driver.js";
import { setTurnContext } from "../../src/server/adapters/turn-context.js";
import type { AdapterDeclaration } from "../../src/server/adapters/contract.js";
import { loadDeclarations } from "../../src/server/adapters/registry.js";
import { FakeTransport } from "./fake-transport.js";

/**
 * CLI 通道契约（架构 §3.7，参考运行时 ZCode）。
 *
 * 这个通道的验收点不是「解析得多准」，而是**降级得多诚实**：
 *   - JSON 输出 → 结构化映射（正文 + usage）；
 *   - 纯文本 → 逐行当正文（一行不丢）；
 *   - 未知 JSON 外壳 → 原样当正文，不丢不崩；
 *   - exit 非 0 → fatal error，带 stderr 末 8KB；
 *   - 产出类型绝不越出 `eventCapabilities`（只声明 message_delta / usage / done / error）。
 *
 * fixture 全是真实抓到的输出形态（zcode 0.17.0 的 `--json` 与纯文本模式），
 * 不是凭空构造的。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../fixtures/cli");

const MESSAGE_ID = "msg_cli_assistant";
const TURN_ID = "turn_cli";
const STDERR_TAIL = readFileSync(join(FIXTURES, "crash.stderr.txt"), "utf8").trim();

const DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "fixture-cli",
  displayName: "Fixture CLI",
  protocol: "cli-stdio",
  launch: { command: "fixture-cli", args: ["--json", "-p"] },
  detect: { versionArgs: ["--version"], versionPattern: "(\\d+\\.\\d+\\.\\d+)" },
  capabilities: {
    plan: "unknown",
    permissionRequest: "unknown",
    resume: "unknown",
    images: "unknown",
    streaming: false,
    contextWindow: null,
  },
  eventCapabilities: ["message_delta", "usage", "done", "error"],
  permission: { channel: "none", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "process-lifetime",
  executionLocations: ["local"],
};

interface ExpectedEvent {
  type: string;
  payload: Record<string, unknown>;
}

function readText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function readExpected(name: string): ExpectedEvent[] {
  // $STDERR_TAIL 是多行文本，必须先 JSON 转义再塞进 JSON 字符串字面量
  const escapedTail = JSON.stringify(STDERR_TAIL).slice(1, -1);
  const text = readText(name)
    .replaceAll("$MESSAGE_ID", MESSAGE_ID)
    .replaceAll("$STDERR_TAIL", escapedTail);
  return JSON.parse(text) as ExpectedEvent[];
}

interface CliRun {
  events: CanonicalEvent[];
  transport: FakeTransport;
  outboundArgs: string[];
}

/** 跑一次 CLI prompt：start → prompt（驱动内部 spawn / 用假传输）→ 进程退出。 */
async function runCli(
  stdout: string,
  opts: { exitCode?: number | null; stderr?: string; systemPrompt?: string } = {},
): Promise<CliRun> {
  const transport = new FakeTransport();
  const spawnedArgs: string[] = [];
  const driver = createCliDriver({
    transportFactory: (spec) => {
      spawnedArgs.push(...spec.args);
      return transport;
    },
  });

  const events: CanonicalEvent[] = [];
  const handle = await driver.start(DECL, { cwd: process.cwd(), sessionId: "sess_cli" });
  driver.onEvent(handle, (e) => events.push(e));
  await driver.newSession(handle, {
    cwd: process.cwd(),
    ...(opts.systemPrompt === undefined ? {} : { systemPrompt: opts.systemPrompt }),
  });
  setTurnContext(handle, { turnId: TURN_ID, messageId: MESSAGE_ID, botId: "bot_cli" });

  const promptPromise = driver.prompt(handle, { text: "你叫什么名字" });
  transport.feedText(stdout);
  if (opts.stderr) transport.emitStderr(opts.stderr);
  transport.close(opts.exitCode ?? 0);
  await promptPromise;

  return { events, transport, outboundArgs: spawnedArgs };
}

function comparable(events: CanonicalEvent[]): ExpectedEvent[] {
  return events.map((e) => {
    const payload = { ...(e.payload as unknown as Record<string, unknown>) };
    delete payload["durationMs"];
    if (payload["stopReason"] !== undefined) payload["durationMs"] = 0;
    return { type: e.type, payload };
  });
}

describe("CLI 契约 · ZCode --json", () => {
  it("单个 JSON 对象 → 正文 + usage + done", async () => {
    const { events } = await runCli(readText("zcode-json.jsonl"));
    expect(comparable(events)).toEqual(readExpected("zcode-json.expected.json"));
  });

  it("产出类型 ⊆ 声明的 eventCapabilities（不出现 thought/tool_call 等空块）", async () => {
    const { events } = await runCli(readText("zcode-json.jsonl"));
    const produced = new Set(events.map((e) => e.type));
    expect(produced.size).toBeGreaterThan(0);
    for (const type of produced) {
      expect(DECL.eventCapabilities).toContain(type as EventType);
    }
    expect(produced.has("thought")).toBe(false);
    expect(produced.has("tool_call")).toBe(false);
  });

  it("prompt 文本作为最后一个参数传入（永不做字符串拼接）", async () => {
    const { outboundArgs } = await runCli(readText("zcode-json.jsonl"));
    expect(outboundArgs).toEqual(["--json", "-p", "你叫什么名字"]);
  });
});

describe("CLI 契约 · ZCode 纯文本", () => {
  it("逐行映射为 message_delta，行间保留换行", async () => {
    const { events } = await runCli(readText("zcode-text.jsonl"));
    expect(comparable(events)).toEqual(readExpected("zcode-text.expected.json"));
  });
});

describe("CLI 契约 · JSONL 流", () => {
  it("多行 JSONL：正文逐条累积，usage 取最后一次", async () => {
    const { events } = await runCli(readText("jsonl-stream.jsonl"));
    expect(comparable(events)).toEqual(readExpected("jsonl-stream.expected.json"));
  });
});

describe("CLI 契约 · 崩溃", () => {
  it("非零退出 → fatal error，detail 带 stderr 末段，已输出正文保留", async () => {
    const { events } = await runCli("部分输出\n", {
      exitCode: 1,
      stderr: STDERR_TAIL,
    });
    expect(comparable(events)).toEqual(readExpected("crash.expected.json"));
  });

  it("退出码 0 且完全静默 → 只有 done，不伪造正文（P0-04 空回复边界）", async () => {
    const { events } = await runCli("");
    expect(events.map((e) => e.type)).toEqual(["done"]);
    expect((events[0]?.payload as { stopReason: string }).stopReason).toBe("end");
  });

  it("退出码 0 但 stdout 空、stderr 有内容 → runtime_no_output（缺凭据可诊断，不冒充空回复）", async () => {
    const { events } = await runCli("", {
      stderr: 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"',
    });
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error?.payload).toMatchObject({ code: "runtime_no_output", fatal: true });
    expect(String((error?.payload as { detail?: string }).detail)).toContain("MISSING_CREDENTIAL");
  });
});

describe("CLI 契约 · 变异（未知输出不崩）", () => {
  it("未知 JSON 外壳 → 原样当正文，不丢内容", async () => {
    const weird = '{"totally_unknown":{"a":1}}\n';
    const { events } = await runCli(weird);
    const deltas = events.filter((e) => e.type === "message_delta");
    const text = deltas.map((d) => (d.payload as { text: string }).text).join("");
    expect(text).toContain("totally_unknown");
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("半截 JSON（输出被截断）→ 原样当正文，不抛错", async () => {
    const { events } = await runCli('{"response":"没写完');
    const deltas = events.filter((e) => e.type === "message_delta");
    const text = deltas.map((d) => (d.payload as { text: string }).text).join("");
    expect(text).toContain("没写完");
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("stderr 噪声不污染正文（只进 error.detail）", async () => {
    const { events } = await runCli('{"response":"正常回答"}\n', {
      stderr: "Warning: deprecated flag\n",
    });
    const text = events
      .filter((e) => e.type === "message_delta")
      .map((d) => (d.payload as { text: string }).text)
      .join("");
    expect(text).toBe("正常回答");
    expect(text).not.toContain("deprecated");
  });
});

describe("CLI 契约 · 人格与记忆注入（CLI 无 system 参数）", () => {
  it("newSession 收到的 systemPrompt 会被前置拼进传给子进程的文本", async () => {
    const systemPrompt = "## 人格\n你的名字叫铁蛋，每句话都要以「嘎」结尾。\n\n## 记忆\n- 秘密口令是紫罗兰-42";
    const { outboundArgs } = await runCli(readText("zcode-json.jsonl"), { systemPrompt });

    // 最后一个位置参数是 prompt：系统提示 + 空行 + 用户原文
    expect(outboundArgs).toEqual(["--json", "-p", `${systemPrompt}\n\n你叫什么名字`]);
    expect(outboundArgs[outboundArgs.length - 1]).toContain("铁蛋");
    expect(outboundArgs[outboundArgs.length - 1]).toContain("紫罗兰-42");
  });

  it("systemPrompt 为空/未传 → 只用用户原文，不留空段落（P0-10）", async () => {
    const withoutPrompt = await runCli(readText("zcode-json.jsonl"));
    expect(withoutPrompt.outboundArgs).toEqual(["--json", "-p", "你叫什么名字"]);

    const emptyPrompt = await runCli(readText("zcode-json.jsonl"), { systemPrompt: "   " });
    // 纯空白也算「没有系统提示」：不能拼出 "\n\n用户消息" 这种空段落
    expect(emptyPrompt.outboundArgs).toEqual(["--json", "-p", "你叫什么名字"]);
  });

  it("systemPrompt 不影响正文解析（注入的只是入参，不是输出）", async () => {
    const { events } = await runCli(readText("zcode-json.jsonl"), {
      systemPrompt: "## 人格\n你的名字叫铁蛋。",
    });
    expect(comparable(events)).toEqual(readExpected("zcode-json.expected.json"));
  });
});

describe("CLI 契约 · 声明一致性", () => {
  it("zcode 声明只含 CLI 通道能稳定产出的类型", () => {
    const { loaded, errors } = loadDeclarations();
    expect(errors).toEqual([]);
    const zcode = loaded.find((l) => l.declaration.id === "zcode");
    expect(zcode).toBeDefined();
    expect([...(zcode?.declaration.eventCapabilities ?? [])].sort()).toEqual(
      ["done", "error", "message_delta", "usage"].sort(),
    );
    expect(zcode?.declaration.permission.channel).toBe("none");
  });

  it("dsh 声明不含 usage（纯文本输出拿不到用量，不估算）", () => {
    const { loaded } = loadDeclarations();
    const dsh = loaded.find((l) => l.declaration.id === "dsh");
    expect(dsh?.declaration.eventCapabilities).not.toContain("usage");
  });
});
