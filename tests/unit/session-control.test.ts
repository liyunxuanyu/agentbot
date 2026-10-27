import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "../../src/server/core/db/db.js";
import { openDb } from "../../src/server/core/db/db.js";
import {
  resolveSessionCwd,
  resolveWorkspace,
  validateWorkspacePath,
} from "../../src/server/core/process/session-cwd.js";
import * as memoryRepo from "../../src/server/core/repo/memory.js";
import { assemble } from "../../src/server/core/memory/assembler.js";
import { createBuiltinDriver } from "../../src/server/adapters/channels/builtin/driver.js";
import { clearTurnContext, setTurnContext } from "../../src/server/adapters/turn-context.js";
import { config } from "../../src/server/config.js";
import type { AdapterDeclaration } from "../../src/server/adapters/contract.js";
import type {
  ProviderClient,
  ProviderCompletion,
  ProviderConfig,
  ProviderDelta,
  ProviderRequest,
} from "../../src/server/core/agent/provider.js";
import type { CanonicalEvent } from "../../src/shared/events.js";

/**
 * M1 / R2 / R3 / R7：工作区回退链、记忆作用域隔离、上下文压缩。
 *
 * 全部用真实临时目录与真实内存 SQLite：这三块的风险都在「路径实际长什么样」
 * 与「SQL 过滤条件是否漏了某一路」，mock 掉就测不到。
 */

const NOW = Date.now();
let root = "";
let dirA = "";
let dirB = "";

/** config 是 `as const` 只读；测试里临时调阈值需要可写别名。 */
const limits = config.limits as unknown as {
  compactionRatio: number;
  compactionKeepRecent: number;
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agentbot-sc-"));
  dirA = join(root, "ws-a");
  dirB = join(root, "ws-b");
  mkdirSync(dirA);
  mkdirSync(dirB);
  writeFileSync(join(root, "not-a-dir.txt"), "x");
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 句柄偶发未释放
  }
});

// ---------------------------------------------------------------------------
// 工作区回退链
// ---------------------------------------------------------------------------

describe("工作区回退链（R2）", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
    db.prepare(
      `INSERT INTO bots (id, name, persona, repo_path, created_at, updated_at)
       VALUES ('b1', '小助', '', ?, ?, ?)`,
    ).run(dirB, NOW, NOW);
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, workspace_path, created_at)
       VALUES ('ch1', 'group', '群聊', '["b1"]', ?, ?)`,
    ).run(dirA, NOW);
    db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
       VALUES ('s1', 'b1', 'ch1', 'ready', ?)`,
    ).run(NOW);
  });

  afterEach(() => {
    db.close();
  });

  it("优先级：会话 → 渠道 → Bot 默认 → 服务进程 cwd", () => {
    // 渠道已配 dirA，Bot 默认 dirB → 渠道优先
    expect(resolveWorkspace(db, { botId: "b1", sessionId: "s1" })).toEqual({
      path: dirA,
      source: "channel",
    });

    db.prepare("UPDATE channels SET workspace_path = NULL WHERE id = 'ch1'").run();
    expect(resolveWorkspace(db, { botId: "b1", sessionId: "s1" })).toEqual({
      path: dirB,
      source: "bot",
    });

    db.prepare("UPDATE sessions SET workspace_path = ? WHERE id = 's1'").run(dirB);
    expect(resolveWorkspace(db, { botId: "b1", sessionId: "s1" })).toEqual({
      path: dirB,
      source: "session",
    });

    db.prepare("UPDATE sessions SET workspace_path = NULL WHERE id = 's1'").run();
    db.prepare("UPDATE bots SET repo_path = NULL WHERE id = 'b1'").run();
    expect(resolveWorkspace(db, { botId: "b1", sessionId: "s1" })).toEqual({
      path: process.cwd(),
      source: "process",
    });
  });

  it("清空会话工作区（空串）→ 回退到渠道，不把空串当路径", () => {
    db.prepare("UPDATE sessions SET workspace_path = '   ' WHERE id = 's1'").run();
    expect(resolveWorkspace(db, { botId: "b1", sessionId: "s1" }).source).toBe("channel");
  });

  it("群聊内所有 Bot 共用渠道工作区（Bot 自己的默认工作区被渠道覆盖）", () => {
    db.prepare(
      `INSERT INTO bots (id, name, persona, repo_path, created_at, updated_at)
       VALUES ('b2', '另一位', '', ?, ?, ?)`,
    ).run(dirB, NOW, NOW);
    const first = resolveWorkspace(db, { botId: "b1", channelId: "ch1" });
    const second = resolveWorkspace(db, { botId: "b2", channelId: "ch1" });
    expect(first).toEqual({ path: dirA, source: "channel" });
    expect(second).toEqual({ path: dirA, source: "channel" });
  });

  it("内置引擎按回退链取 cwd；其它运行时仍走 Bot 自己的路径", () => {
    const builtin: AdapterDeclaration = {
      schemaVersion: 1,
      id: "builtin",
      displayName: "内置引擎",
      protocol: "builtin",
      launch: { command: "x", args: [] },
      detect: { versionArgs: [], versionPattern: "x" },
      capabilities: {
        plan: true,
        permissionRequest: true,
        resume: true,
        images: false,
        streaming: true,
        contextWindow: null,
      },
      eventCapabilities: [],
      permission: { channel: "internal", defaultTimeoutPolicy: "reject" },
      resumeStrategy: "native",
      executionLocations: ["local"],
    };
    db.prepare("UPDATE sessions SET workspace_path = ? WHERE id = 's1'").run(dirB);
    const resolved = resolveSessionCwd(db, "b1", builtin, { sessionId: "s1", channelId: "ch1" });
    expect(resolved.cwd).toBe(dirB);
    expect(resolved.workspaceSource).toBe("session");
    expect(resolved.forcedWorktree).toBe(false);
  });
});

describe("工作区校验（R2 / G8）", () => {
  it("接受存在且可写的普通目录（不要求是 git 仓库）", () => {
    const result = validateWorkspacePath(dirA);
    expect(result.ok).toBe(true);
    expect(result.path).toBeTruthy();
  });

  it("不存在的路径 / 文件 / 相对路径 → 明确原因", () => {
    expect(validateWorkspacePath(join(root, "nope"))).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(validateWorkspacePath(join(root, "not-a-dir.txt"))).toMatchObject({
      ok: false,
      code: "not_directory",
    });
    expect(validateWorkspacePath("relative/path")).toMatchObject({
      ok: false,
      code: "not_absolute",
    });
  });
});

// ---------------------------------------------------------------------------
// 记忆作用域隔离
// ---------------------------------------------------------------------------

describe("记忆按会话隔离（R3 / G1）", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
    db.prepare(
      `INSERT INTO bots (id, name, persona, created_at, updated_at)
       VALUES ('b1', '小助', '', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
       VALUES ('ch1', 'group', '群聊 A', '["b1"]', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
       VALUES ('ch2', 'group', '群聊 B', '["b1"]', ?)`,
    ).run(NOW);
    for (const id of ["s1", "s2", "s3"]) {
      db.prepare(
        `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
         VALUES (?, 'b1', ?, 'ready', ?)`,
      ).run(id, id === "s3" ? "ch2" : "ch1", NOW);
    }

    memoryRepo.create(db, { id: "m_bot", botId: "b1", content: "全局记忆" });
    memoryRepo.create(db, {
      id: "m_s1",
      botId: "b1",
      content: "会话一的记忆",
      scope: "session",
      sourceSessionId: "s1",
    });
    memoryRepo.create(db, {
      id: "m_ch1",
      botId: "b1",
      content: "群聊 A 的记忆",
      scope: "channel",
      channelId: "ch1",
    });
  });

  afterEach(() => {
    db.close();
  });

  it("同一 Bot 在会话 A 的记忆不出现在会话 B（核心验收）", () => {
    const a = memoryRepo.listInjected(db, "b1", { sessionId: "s1", channelId: "ch1" });
    const b = memoryRepo.listInjected(db, "b1", { sessionId: "s2", channelId: "ch1" });
    const otherChannel = memoryRepo.listInjected(db, "b1", { sessionId: "s3", channelId: "ch2" });

    expect(a.map((m) => m.id).sort()).toEqual(["m_bot", "m_ch1", "m_s1"]);
    // 会话二能看到全局与群聊 A，但看不到会话一的私有记忆
    expect(b.map((m) => m.id).sort()).toEqual(["m_bot", "m_ch1"]);
    // 另一个群聊看不到群聊 A 的记忆
    expect(otherChannel.map((m) => m.id).sort()).toEqual(["m_bot"]);
  });

  it("不传会话上下文时只注入 bot 全局记忆（宁少注入、不串记忆）", () => {
    const rows = memoryRepo.listInjected(db, "b1");
    expect(rows.map((m) => m.id)).toEqual(["m_bot"]);
  });

  it("装配器按作用域过滤：会话 A 的提示里没有会话 B 的内容", () => {
    const a = assemble(db, "b1", { sessionId: "s1", channelId: "ch1" }).text;
    const b = assemble(db, "b1", { sessionId: "s2", channelId: "ch1" }).text;
    expect(a).toContain("会话一的记忆");
    expect(b).not.toContain("会话一的记忆");
    expect(b).toContain("群聊 A 的记忆");
  });
});

// ---------------------------------------------------------------------------
// 上下文压缩
// ---------------------------------------------------------------------------

const PROVIDER: ProviderConfig = {
  id: "p1",
  name: "测试",
  protocol: "openai-chat",
  baseUrl: "http://127.0.0.1:1",
  apiKey: "k",
  model: "m",
  contextWindow: null,
  supportsTools: true,
  supportsStreaming: true,
};

class CapturingProvider implements ProviderClient {
  readonly protocol = "openai-chat" as const;
  readonly requests: ProviderRequest[] = [];
  async *stream(req: ProviderRequest): AsyncGenerator<ProviderDelta> {
    this.requests.push(req);
    yield { kind: "text", text: "好的" };
    yield { kind: "finish", reason: "stop" };
  }
  async complete(req: ProviderRequest): Promise<ProviderCompletion> {
    // 摘要请求（带「对话压缩器」系统提示）返回固定摘要；其它请求不支持降级
    const isSummary = req.messages.some((m) => m.content.includes("对话压缩器"));
    if (!isSummary) throw new Error("测试不支持降级");
    return {
      text: "用户先后发了几条消息，助手都回答了「好的」。",
      reasoning: "",
      toolCalls: [],
      usage: null,
      finish: "stop",
    };
  }
}

const BUILTIN_DECL: AdapterDeclaration = {
  schemaVersion: 1,
  id: "builtin",
  displayName: "内置引擎",
  protocol: "builtin",
  launch: { command: "x", args: [] },
  detect: { versionArgs: [], versionPattern: "x" },
  capabilities: {
    plan: true,
    permissionRequest: true,
    resume: true,
    images: false,
    streaming: true,
    contextWindow: null,
  },
  eventCapabilities: [],
  permission: { channel: "internal", defaultTimeoutPolicy: "reject" },
  resumeStrategy: "native",
  executionLocations: ["local"],
};

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbot-compact-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
});

interface CompactFixture {
  driver: ReturnType<typeof createBuiltinDriver>;
  handle: Awaited<ReturnType<ReturnType<typeof createBuiltinDriver>["start"]>>;
  events: CanonicalEvent[];
  provider: CapturingProvider;
}

async function compactFixture(): Promise<CompactFixture> {
  const events: CanonicalEvent[] = [];
  const provider = new CapturingProvider();
  const driver = createBuiltinDriver({
    skillsDir: tempDir(),
    resolveProvider: () => PROVIDER,
    createClient: () => provider,
    tools: [],
  });
  const handle = await driver.start(BUILTIN_DECL, {
    cwd: tempDir(),
    sessionId: "s_compact",
    botId: "b1",
    providerId: "p1",
  });
  driver.onEvent(handle, (e) => events.push(e));
  await driver.newSession(handle, { cwd: tempDir(), systemPrompt: "你是测试 Bot" });
  return { driver, handle, events, provider };
}

async function say(
  fixture: CompactFixture,
  text: string,
  turnId: string,
): Promise<void> {
  setTurnContext(fixture.handle, { turnId, messageId: `m_${turnId}`, botId: "b1" });
  try {
    await fixture.driver.prompt(fixture.handle, { text });
  } finally {
    clearTurnContext(fixture.handle);
  }
}

describe("上下文压缩（R7 / G5）", () => {
  it("手动压缩（force）：裁剪历史、写 meta.compaction、下一轮带上摘要", async () => {
    const originalKeep = limits.compactionKeepRecent;
    limits.compactionKeepRecent = 4;
    try {
      const fixture = await compactFixture();
      // 消息写长一点：短对话压缩后摘要可能比原文还长，那是正常现象，不是缺陷
      for (let i = 1; i <= 4; i += 1) {
        await say(fixture, `第 ${i} 条消息 ${"内容".repeat(200)}`, `t${i}`);
      }

      const result = await fixture.driver.compact!(fixture.handle, { force: true });
      expect(result).not.toBeNull();
      expect(result?.ok).toBe(true);
      expect(result?.trigger).toBe("manual");
      expect(result?.removedMessages).toBeGreaterThan(0);
      expect(result?.afterTokens).toBeLessThan(result?.beforeTokens ?? 0);

      const marker = fixture.events.find(
        (e) => e.type === "meta" && (e.payload as { kind?: string }).kind === "compaction",
      );
      expect(marker).toBeDefined();
      expect((marker?.payload as { data?: { trigger?: string } }).data?.trigger).toBe("manual");

      // 下一轮发给模型的上下文里有摘要段，且原始消息已被裁掉
      fixture.provider.requests.splice(0);
      await say(fixture, "继续", "t5");
      const sent = fixture.provider.requests[0]?.messages ?? [];
      expect(sent.some((m) => m.content.includes("此前对话摘要"))).toBe(true);
      expect(sent.some((m) => m.content.includes("第 1 条消息"))).toBe(false);
    } finally {
      limits.compactionKeepRecent = originalKeep;
    }
  });

  it("手动压缩（非 force）未达阈值 → 不动历史，说明原因", async () => {
    const fixture = await compactFixture();
    await say(fixture, "只有一条", "t1");
    const result = await fixture.driver.compact!(fixture.handle, { force: false });
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain("阈值");
  });

  it("自动压缩：占用超过阈值比例时触发，并留流内标记", async () => {
    const originalRatio = limits.compactionRatio;
    const originalKeep = limits.compactionKeepRecent;
    limits.compactionRatio = 0.0001;
    limits.compactionKeepRecent = 2;
    try {
      const fixture = await compactFixture();
      for (let i = 1; i <= 4; i += 1) await say(fixture, `第 ${i} 条消息`, `t${i}`);
      const marker = fixture.events.find(
        (e) => e.type === "meta" && (e.payload as { kind?: string }).kind === "compaction",
      );
      expect(marker).toBeDefined();
      expect((marker?.payload as { data?: { trigger?: string } }).data?.trigger).toBe("auto");
    } finally {
      limits.compactionRatio = originalRatio;
      limits.compactionKeepRecent = originalKeep;
    }
  });
});
