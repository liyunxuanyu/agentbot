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
  maxOutputTokens: null,
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
      // R7：流内分隔条靠这两个数字（前端 dividerText 直接读 payload.data）
      const markerData = (marker?.payload as {
        data?: { trigger?: string; removedMessages?: number; summaryChars?: number };
      }).data;
      expect(markerData?.trigger).toBe("manual");
      expect(markerData?.removedMessages).toBe(result?.removedMessages);
      expect(markerData?.summaryChars).toBe(result?.summaryChars);
      expect(markerData?.removedMessages).toBeGreaterThan(0);
      expect(markerData?.summaryChars).toBeGreaterThan(0);

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

// ---------------------------------------------------------------------------
// 归档 Bot 的会话不再出现在列表里
// ---------------------------------------------------------------------------

describe("会话列表过滤已归档 Bot（R1 附带）", () => {
  it("dm / group 至少有一个在用参与者才显示；task 渠道始终显示", async () => {
    const { listChannels } = await import("../../src/server/http/dto.js");
    const db = openDb(":memory:");
    try {
      db.prepare(
        `INSERT INTO bots (id, name, persona, status, created_at, updated_at)
         VALUES ('alive', '在用的', '', 'active', ?, ?), ('gone', '已归档的', '', 'archived', ?, ?)`,
      ).run(NOW, NOW, NOW, NOW);
      const insert = db.prepare(
        `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run("dm_alive", "dm", "在用私聊", '["alive"]', NOW);
      insert.run("dm_gone", "dm", "归档私聊", '["gone"]', NOW);
      insert.run("grp_mixed", "group", "混合群聊", '["alive","gone"]', NOW);
      insert.run("grp_gone", "group", "全归档群聊", '["gone"]', NOW);
      insert.run("task_1", "task", "任务渠道", '["gone"]', NOW);

      const ids = listChannels(db).map((c) => c.id).sort();
      expect(ids).toEqual(["dm_alive", "grp_mixed", "task_1"]);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 群聊记忆跨 Bot 共享（R3 方案 A）
// ---------------------------------------------------------------------------

describe("群聊记忆跨 Bot 共享（R3）", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(":memory:");
    for (const id of ["b1", "b2", "b3"]) {
      db.prepare(
        `INSERT INTO bots (id, name, persona, created_at, updated_at)
         VALUES (?, ?, '', ?, ?)`,
      ).run(id, `Bot ${id}`, NOW, NOW);
    }
    // ch1：b1 + b2 都在；ch2：只有 b2 和 b3（b1 不在）
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
       VALUES ('ch1', 'group', '群聊 A', '["b1","b2"]', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
       VALUES ('ch2', 'group', '群聊 B', '["b2","b3"]', ?)`,
    ).run(NOW);
    for (const [sid, bot, ch] of [
      ["s1", "b1", "ch1"],
      ["s2", "b2", "ch1"],
      ["s3", "b2", "ch2"],
    ] as const) {
      db.prepare(
        `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
         VALUES (?, ?, ?, 'ready', ?)`,
      ).run(sid, bot, ch, NOW);
    }

    // Bot A 在群聊 A 写一条 channel 记忆
    memoryRepo.create(db, {
      id: "m_a_ch1",
      botId: "b1",
      content: "群聊 A 的约定：先给结论",
      scope: "channel",
      channelId: "ch1",
    });
    // Bot B 在群聊 B 写一条 channel 记忆
    memoryRepo.create(db, {
      id: "m_b_ch2",
      botId: "b2",
      content: "群聊 B 的约定：用表格",
      scope: "channel",
      channelId: "ch2",
    });
    // Bot A 的私有记忆
    memoryRepo.create(db, { id: "m_a_bot", botId: "b1", content: "Bot A 的全局记忆" });
  });

  afterEach(() => {
    db.close();
  });

  it("Bot A 在群聊 A 写的 channel 记忆，Bot B 的下一轮注入里出现", () => {
    const b2Rows = memoryRepo.listInjected(db, "b2", { sessionId: "s2", channelId: "ch1" });
    expect(b2Rows.map((m) => m.id)).toContain("m_a_ch1");
    // 装配器走同一条 SQL：提示里真的能看到原文
    const text = assemble(db, "b2", { sessionId: "s2", channelId: "ch1" }).text;
    expect(text).toContain("群聊 A 的约定：先给结论");
  });

  it("Bot A 在别的群聊（B）写的 channel 记忆，Bot B 在群聊 A 读不到", () => {
    const b2InCh1 = memoryRepo.listInjected(db, "b2", { sessionId: "s2", channelId: "ch1" });
    expect(b2InCh1.map((m) => m.id)).not.toContain("m_b_ch2");

    // 反过来：B 在群聊 B 能看到自己的，A 不在群聊 B → 不注入
    const b2InCh2 = memoryRepo.listInjected(db, "b2", { sessionId: "s3", channelId: "ch2" });
    expect(b2InCh2.map((m) => m.id)).toContain("m_b_ch2");
  });

  it("bot 全局记忆仍然只属于自己（共享只放开 channel）", () => {
    const b2Rows = memoryRepo.listInjected(db, "b2", { sessionId: "s2", channelId: "ch1" });
    expect(b2Rows.map((m) => m.id)).not.toContain("m_a_bot");
  });

  it("Bot B 的记忆页能看到群聊记忆，并标明来源 Bot", () => {
    const rows = memoryRepo.listByBot(db, "b2");
    expect(rows.map((m) => m.id)).toContain("m_a_ch1");
    // 别的群聊的 channel 记忆不出现（b2 不在群聊 A 之外的 ch2 里？b2 在 ch2 里，
    // 所以 ch2 的 m_b_ch2 也应该出现 —— 它本来就连在 b2 名下）
    expect(rows.map((m) => m.id)).toContain("m_b_ch2");

    // Bot A 的页面看不到群聊 B 的记忆（A 不在群聊 B）
    const aRows = memoryRepo.listByBot(db, "b1");
    expect(aRows.map((m) => m.id)).toContain("m_a_ch1");
    expect(aRows.map((m) => m.id)).not.toContain("m_b_ch2");
  });

  it("同群 Bot 的 channel 记忆可被本 Bot 停用（注入开关生效）", () => {
    // 场景：A 写了群聊记忆，B 觉得不合适 → 在 B 的记忆页关掉它
    memoryRepo.update(db, "m_a_ch1", { injected: false });
    const b2Rows = memoryRepo.listInjected(db, "b2", { sessionId: "s2", channelId: "ch1" });
    expect(b2Rows.map((m) => m.id)).not.toContain("m_a_ch1");
  });
});

// ---------------------------------------------------------------------------
// 群聊记忆的 HTTP 层（R3）：记忆页可见 + 来源 Bot 标注 + 同群可管理
// ---------------------------------------------------------------------------

describe("群聊记忆 HTTP 层（R3）", () => {
  it("Bot B 的记忆页能看到同群 Bot A 写的条目，带 sourceBotName；别的群看不到", async () => {
    const { buildServer } = await import("../../src/server/http/server.js");
    const { createEventBus } = await import("../../src/server/core/events/bus.js");
    const { createSessionLock } = await import("../../src/server/core/orchestrator/session-lock.js");
    const { createTurnOrchestrator } = await import("../../src/server/core/orchestrator/turn.js");
    const { createSupervisor } = await import("../../src/server/core/process/supervisor.js");
    const { createPermissionResolver } = await import(
      "../../src/server/core/permissions/resolver.js"
    );
    const { listenEphemeral } = await import("./http-listen.js");

    const db = openDb(":memory:");
    const now = Date.now();
    for (const [id, name] of [
      ["b1", "小助"],
      ["b2", "小研"],
      ["b3", "外人"],
    ] as const) {
      db.prepare(
        `INSERT INTO bots (id, name, persona, created_at, updated_at) VALUES (?, ?, '', ?, ?)`,
      ).run(id, name, now, now);
    }
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
       VALUES ('ch1', 'group', '群聊 A', '["b1","b2"]', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
       VALUES ('ch2', 'group', '群聊 B', '["b3"]', ?)`,
    ).run(now);
    memoryRepo.create(db, {
      id: "m_shared",
      botId: "b1",
      content: "群聊 A 的共享记忆",
      scope: "channel",
      channelId: "ch1",
    });
    memoryRepo.create(db, {
      id: "m_other",
      botId: "b3",
      content: "群聊 B 的记忆",
      scope: "channel",
      channelId: "ch2",
    });

    const bus = createEventBus();
    const resolveRuntime = () => null;
    const supervisor = createSupervisor({ db, bus, resolveRuntime });
    const permissions = createPermissionResolver({
      db,
      bus,
      isSessionAlive: () => false,
      sessionCwdOf: () => process.cwd(),
      respond: async () => true,
      setHeld: () => undefined,
      setSessionStatus: () => undefined,
      log: () => undefined,
    });
    const orchestrator = createTurnOrchestrator({
      db,
      bus,
      lock: createSessionLock(),
      resolveRuntime,
      supervisor,
    });
    const app = buildServer(
      {
        db,
        runtimes: [],
        schemaVersion: 4,
        startedAt: now,
        resolveRuntime: () => null,
        orchestrator,
        permissions,
        assignments: { stop: () => undefined } as never,
      },
      { authEnabled: false, webRoot: join(root, "no-web") },
    );
    const base = await listenEphemeral(app);
    try {
      const res = await fetch(`${base}/api/bots/b2/memory`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        entries: { id: string; sourceBotId?: string; sourceBotName?: string | null }[];
      };
      const shared = body.entries.find((e) => e.id === "m_shared");
      expect(shared).toBeDefined();
      expect(shared?.sourceBotId).toBe("b1");
      expect(shared?.sourceBotName).toBe("小助");
      // 别的群聊的 channel 记忆不出现
      expect(body.entries.find((e) => e.id === "m_other")).toBeUndefined();

      // 同群 Bot 可以停用这条共享记忆（注入开关）
      const patch = await fetch(`${base}/api/bots/b2/memory/m_shared`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ injected: false }),
      });
      expect(patch.status).toBe(200);
      const after = (await patch.json()) as { entry?: { injected: boolean } | null };
      expect(after.entry?.injected).toBe(false);

      // 别的群聊的条目仍然不可管理
      const denied = await fetch(`${base}/api/bots/b2/memory/m_other`, {
        method: "DELETE",
      });
      expect(denied.status).toBe(404);

      // b3 不在群聊 A → 看不到 m_shared
      const res3 = await fetch(`${base}/api/bots/b3/memory`);
      const body3 = (await res3.json()) as { entries: { id: string }[] };
      expect(body3.entries.find((e) => e.id === "m_shared")).toBeUndefined();
    } finally {
      await app.close();
      permissions.dispose();
      await orchestrator.dispose();
      await supervisor.dispose();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// G3：切 plan 的「已拒绝 N 个」要落库（刷新后仍在）
// ---------------------------------------------------------------------------

describe("切 plan 的持久系统块（G3）", () => {
  it("PATCH controls → 落一条 config_update meta，带 rejectedPending", async () => {
    const { buildServer } = await import("../../src/server/http/server.js");
    const { createEventBus } = await import("../../src/server/core/events/bus.js");
    const { createSessionLock } = await import("../../src/server/core/orchestrator/session-lock.js");
    const { createTurnOrchestrator } = await import("../../src/server/core/orchestrator/turn.js");
    const { createSupervisor } = await import("../../src/server/core/process/supervisor.js");
    const { createPermissionResolver } = await import(
      "../../src/server/core/permissions/resolver.js"
    );
    const { listenEphemeral } = await import("./http-listen.js");

    const db = openDb(":memory:");
    const now = Date.now();
    // allow_dirs 必须包含 dirA，否则写请求在边界判定阶段就被拒（落 denied_boundary），
    // 根本不会进入 pending —— 测不到「切 plan 拒绝挂起」这条路径。
    db.prepare(
      `INSERT INTO bots (id, name, persona, allow_dirs, created_at, updated_at)
       VALUES ('b1', '小助', '', ?, ?, ?)`,
    ).run(JSON.stringify([dirA]), now, now);
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
       VALUES ('ch1', 'dm', '私聊', '["b1"]', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
       VALUES ('s1', 'b1', 'ch1', 'ready', ?)`,
    ).run(now);

    const bus = createEventBus();
    const resolveRuntime = () => null;
    const supervisor = createSupervisor({ db, bus, resolveRuntime });
    const permissions = createPermissionResolver({
      db,
      bus,
      // 会话在跑：否则请求直接 invalidated，进不了 pending（G3 测的是 pending → rejected）
      isSessionAlive: () => true,
      sessionCwdOf: () => process.cwd(),
      respond: async () => true,
      setHeld: () => undefined,
      setSessionStatus: () => undefined,
      log: () => undefined,
    });
    const orchestrator = createTurnOrchestrator({
      db,
      bus,
      lock: createSessionLock(),
      resolveRuntime,
      supervisor,
    });
    const app = buildServer(
      {
        db,
        runtimes: [],
        schemaVersion: 4,
        startedAt: now,
        resolveRuntime: () => null,
        orchestrator,
        permissions,
        assignments: { stop: () => undefined } as never,
      },
      { authEnabled: false, webRoot: join(root, "no-web") },
    );
    const base = await listenEphemeral(app);
    try {
      // 先制造一个挂起的写类权限请求（切 plan 时会被拒）
      // 等裁决完成再切档：handle 是异步的（边界判定 + 落库 + 回传）
      await permissions.handle({
        sessionId: "s1",
        botId: "b1",
        turnId: "t1",
        source: "interactive",
        request: {
          requestId: "req_1",
          action: "write",
          target: join(dirA, "a.md"),
        },
      });

      const res = await fetch(`${base}/api/sessions/s1/controls`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionMode: "plan" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; rejectedPending?: number };
      expect(body.ok).toBe(true);

      // 库里确实有一条 meta（不是前端本地插入的）
      const row = db
        .prepare(
          `SELECT payload FROM events WHERE session_id = 's1' AND type = 'meta' ORDER BY id DESC LIMIT 1`,
        )
        .get() as { payload: string } | undefined;
      expect(row).toBeDefined();
      const payload = JSON.parse(row?.payload ?? "{}") as {
        kind?: string;
        data?: { rejectedPending?: number; modeSwitchedTo?: string };
      };
      expect(payload.kind).toBe("config_update");
      // 有挂起写请求 → 拒绝数 > 0 才带 modeSwitchedTo（G3 分隔条的触发条件）
      expect(payload.data?.modeSwitchedTo).toBe("plan");
      expect(payload.data?.rejectedPending).toBe(1);
    } finally {
      await app.close();
      permissions.dispose();
      await orchestrator.dispose();
      await supervisor.dispose();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 切 full：挂起请求自动批准（2026-10-28 真机反馈）
// ---------------------------------------------------------------------------

describe("切 full 时自动批准挂起请求", () => {
  it("PATCH controls {permissionMode:'full'} → 挂起请求变 decided，响应带 approvedPending", async () => {
    const { buildServer } = await import("../../src/server/http/server.js");
    const { createEventBus } = await import("../../src/server/core/events/bus.js");
    const { createSessionLock } = await import("../../src/server/core/orchestrator/session-lock.js");
    const { createTurnOrchestrator } = await import("../../src/server/core/orchestrator/turn.js");
    const { createSupervisor } = await import("../../src/server/core/process/supervisor.js");
    const { createPermissionResolver } = await import(
      "../../src/server/core/permissions/resolver.js"
    );
    const { listenEphemeral } = await import("./http-listen.js");

    const db = openDb(":memory:");
    const now = Date.now();
    // allow_dirs 为空：confirm 模式下「未配置允许目录」的写会落 pending（这是
    // 用户真机上的形态），切 full 时必须被自动批准。
    db.prepare(
      `INSERT INTO bots (id, name, persona, allow_dirs, created_at, updated_at)
       VALUES ('b1', '小助', '', '[]', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO channels (id, type, name, participant_bot_ids, created_at)
       VALUES ('ch1', 'dm', '私聊', '["b1"]', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
       VALUES ('s1', 'b1', 'ch1', 'waiting_permission', ?)`,
    ).run(now);

    const responded: string[] = [];
    const bus = createEventBus();
    const supervisor = createSupervisor({ db, bus, resolveRuntime: () => null });
    const permissions = createPermissionResolver({
      db,
      bus,
      isSessionAlive: () => true,
      sessionCwdOf: () => dirA,
      respond: async (_s, requestId) => {
        responded.push(requestId);
        return true;
      },
      setHeld: () => undefined,
      setSessionStatus: () => undefined,
      log: () => undefined,
    });
    const orchestrator = createTurnOrchestrator({
      db,
      bus,
      lock: createSessionLock(),
      resolveRuntime: () => null,
      supervisor,
    });
    const app = buildServer(
      {
        db,
        runtimes: [],
        schemaVersion: 4,
        startedAt: now,
        resolveRuntime: () => null,
        orchestrator,
        permissions,
        assignments: { stop: () => undefined } as never,
      },
      { authEnabled: false, webRoot: join(root, "no-web") },
    );
    const base = await listenEphemeral(app);
    try {
      await permissions.handle({
        sessionId: "s1",
        botId: "b1",
        turnId: "t1",
        source: "interactive",
        request: { requestId: "req_full", action: "write", target: join(dirA, "a.md") },
      });
      expect(permissions.get("req_full")?.status).toBe("pending");

      const res = await fetch(`${base}/api/sessions/s1/controls`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionMode: "full" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; approvedPending?: number };
      expect(body.approvedPending).toBe(1);

      const row = permissions.get("req_full");
      expect(row?.status).toBe("decided");
      expect(row?.decision).toBe("approve");
      // 回传运行时用的原始 requestId（不是落库 id 的后缀形态）
      expect(responded).toContain("req_full");

      // 审计 meta 带 approvedPending 与 modeSwitchedTo:'full'（分隔条据此生成）
      const meta = db
        .prepare(
          `SELECT payload FROM events WHERE session_id = 's1' AND type = 'meta' ORDER BY id DESC LIMIT 1`,
        )
        .get() as { payload: string } | undefined;
      const payload = JSON.parse(meta?.payload ?? "{}") as {
        data?: { approvedPending?: number; modeSwitchedTo?: string };
      };
      expect(payload.data?.approvedPending).toBe(1);
      expect(payload.data?.modeSwitchedTo).toBe("full");
    } finally {
      await app.close();
      permissions.dispose();
      await orchestrator.dispose();
      await supervisor.dispose();
      db.close();
    }
  });
});
