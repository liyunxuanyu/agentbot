import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DB } from "../../src/server/core/db/db.js";
import { openDb } from "../../src/server/core/db/db.js";
import { createEventBus } from "../../src/server/core/events/bus.js";
import {
  checkBoundary,
  isInside,
  normalizeAllowedDir,
  normalizeAllowedDirs,
  readBoundary,
  resolveRealish,
  type BoundarySnapshot,
} from "../../src/server/core/permissions/boundary.js";
import { createPermissionResolver } from "../../src/server/core/permissions/resolver.js";
import {
  actionKeyOf,
  createGrant,
  findGrant,
  listGrants,
} from "../../src/server/core/permissions/grants.js";
import { deadlinesOf, decideTimeoutPolicy, sweepExpired } from "../../src/server/core/permissions/policy.js";
import type { PermissionDecision } from "../../src/server/adapters/contract.js";

/**
 * M6 权限系统测试（P0-08 / P0-09 + board 03-decisions 的三档超时）。
 *
 * 全部用真实临时目录（`mkdtemp`）而不是假路径：边界判定的核心风险是
 * 符号链接、大小写、`..` 逃逸这些**文件系统行为**，mock 掉 fs 就什么都测不到了。
 */

const WIN = process.platform === "win32";

let root = "";
let allowedDir = "";
let outsideDir = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agentbot-perm-"));
  allowedDir = join(root, "workspace");
  outsideDir = join(root, "outside");
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(allowedDir, "note.txt"), "ok");
  writeFileSync(join(outsideDir, "secret.txt"), "no");
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 上偶发句柄未释放；临时目录留着不影响断言
  }
});

function snapshot(overrides: Partial<BoundarySnapshot> = {}): BoundarySnapshot {
  return {
    allowDirs: [allowedDir],
    allowShell: false,
    allowNetwork: false,
    autoApproveWrite: false,
    version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 边界判定
// ---------------------------------------------------------------------------

describe("边界判定 · 目录内/外", () => {
  it("允许目录内的写 → allowed，并回报命中的目录", () => {
    const res = checkBoundary(snapshot(), "write", join(allowedDir, "out.md"), root);
    expect(res.verdict).toBe("allowed");
    expect(res.matchedDir).toBeTruthy();
    expect(res.target.toLowerCase()).toContain("workspace");
  });

  it("允许目录外的写 → denied，原因说明「不在允许目录内」", () => {
    const res = checkBoundary(snapshot(), "write", join(outsideDir, "x.md"), root);
    expect(res.verdict).toBe("denied");
    expect(res.reason).toContain("不在 Bot 的允许目录内");
  });

  it("默认全关：没有允许目录时写操作一律拒绝", () => {
    const res = checkBoundary(snapshot({ allowDirs: [] }), "write", join(allowedDir, "a.md"), root);
    expect(res.verdict).toBe("denied");
    expect(res.reason).toContain("未配置允许目录");
  });

  it("默认全关：没有允许目录时读操作放行（只读不改变磁盘）", () => {
    const res = checkBoundary(snapshot({ allowDirs: [] }), "read", join(outsideDir, "secret.txt"), root);
    expect(res.verdict).toBe("allowed");
  });

  it("shell 与联网默认拒绝，开启后放行（不做命令解析）", () => {
    expect(checkBoundary(snapshot(), "exec", "rm -rf /", root).verdict).toBe("denied");
    expect(checkBoundary(snapshot({ allowShell: true }), "exec", "rm -rf /", root).verdict).toBe(
      "allowed",
    );
    expect(checkBoundary(snapshot(), "network", "api.example.com", root).verdict).toBe("denied");
    expect(
      checkBoundary(snapshot({ allowNetwork: true }), "network", "api.example.com", root).verdict,
    ).toBe("allowed");
  });

  it("`..` 无法逃出允许目录", () => {
    const escape = join(allowedDir, "..", "outside", "x.md");
    const res = checkBoundary(snapshot(), "write", escape, root);
    expect(res.verdict).toBe("denied");
  });

  it("`isInside` 不会把前缀相同的兄弟目录算进来（/work 不含 /workspace）", () => {
    const a = WIN ? "c:\\work" : "/work";
    const b = WIN ? "c:\\workspace\\x" : "/workspace/x";
    expect(isInside(a, b)).toBe(false);
    expect(isInside(a, `${a}${sep}x`)).toBe(true);
    expect(isInside(a, a)).toBe(true);
  });
});

describe("边界判定 · 相对路径与无法解析", () => {
  it("相对路径以会话 cwd 为基准解析后再判定", () => {
    const inside = checkBoundary(snapshot(), "write", "draft.md", allowedDir);
    expect(inside.verdict).toBe("allowed");

    const outside = checkBoundary(snapshot(), "write", "draft.md", outsideDir);
    expect(outside.verdict).toBe("denied");
  });

  it("目标为空 → 拒绝（无法解析）", () => {
    const res = checkBoundary(snapshot(), "write", "   ", allowedDir);
    expect(res.verdict).toBe("denied");
    expect(res.reason).toContain("没有给出目标路径");
  });

  it("Windows 盘符相对路径（C:foo）不是绝对路径 → 按 cwd 解析后仍受边界约束", () => {
    const res = checkBoundary(snapshot(), "write", "C:foo.md", outsideDir);
    expect(res.verdict).toBe("denied");
  });

  it("不存在的目标路径也能判定（最近存在祖先 + 未存在段拼回）", () => {
    const deep = join(allowedDir, "a", "b", "c", "new-file.md");
    const res = checkBoundary(snapshot(), "write", deep, root);
    expect(res.verdict).toBe("allowed");
    expect(resolveRealish(deep).toLowerCase()).toContain("workspace");
  });

  it("允许目录本身不存在时（保存时已拦）判定仍保守：不命中任何目录", () => {
    const ghost = join(root, "does-not-exist");
    const res = checkBoundary(snapshot({ allowDirs: [ghost] }), "write", join(allowedDir, "x.md"), root);
    expect(res.verdict).toBe("denied");
  });
});

describe("边界保存校验（P0-09 目录不存在或不可写 → 内联报错）", () => {
  it("绝对路径 + 存在 + 可写 → ok，且返回归一化后的真实路径", () => {
    const res = normalizeAllowedDir(allowedDir);
    expect(res.ok).toBe(true);
    // 归一化会解 realpath（Windows 上可能把长名转成 8.3 短名），所以两边都归一化后比较
    if (res.ok) expect(resolveRealish(res.dir)).toBe(resolveRealish(allowedDir));
  });

  it("相对路径 → not_absolute", () => {
    const res = normalizeAllowedDir("workspace/sub");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_absolute");
  });

  it("不存在的目录 → not_found", () => {
    const res = normalizeAllowedDir(join(root, "nope", "nope"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("是文件不是目录 → not_directory", () => {
    const res = normalizeAllowedDir(join(allowedDir, "note.txt"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_directory");
  });

  it("批量校验：一条失败就整体失败，并给出 index", () => {
    const res = normalizeAllowedDirs([allowedDir, "relative/path"]);
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.index).toBe(1);
    // 合法的那条仍被归一化（供路由层展示已通过项）
    expect(res.dirs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 三档超时策略
// ---------------------------------------------------------------------------

describe("三档超时 · 场景自动判定", () => {
  it("交互会话 + 普通写 → reject", () => {
    expect(
      decideTimeoutPolicy({
        source: "interactive",
        action: "write",
        boundaryVerdict: "allowed",
        autoApproveWrite: false,
      }),
    ).toBe("reject");
  });

  it("Assignment / 定时任务 → hold", () => {
    for (const source of ["assignment", "schedule"] as const) {
      expect(
        decideTimeoutPolicy({
          source,
          action: "write",
          boundaryVerdict: "allowed",
          autoApproveWrite: false,
        }),
      ).toBe("hold");
    }
  });

  it("开启写自动批准 + 边界内写 → preauth", () => {
    expect(
      decideTimeoutPolicy({
        source: "interactive",
        action: "write",
        boundaryVerdict: "allowed",
        autoApproveWrite: true,
      }),
    ).toBe("preauth");
  });

  it("开启写自动批准但边界外 → 仍按来源走 reject/hold（不 preauth）", () => {
    expect(
      decideTimeoutPolicy({
        source: "interactive",
        action: "write",
        boundaryVerdict: "denied",
        autoApproveWrite: true,
      }),
    ).toBe("reject");
    expect(
      decideTimeoutPolicy({
        source: "assignment",
        action: "write",
        boundaryVerdict: "denied",
        autoApproveWrite: true,
      }),
    ).toBe("hold");
  });

  it("preauth 只覆盖写操作：读/exec 不走 preauth", () => {
    expect(
      decideTimeoutPolicy({
        source: "interactive",
        action: "exec",
        boundaryVerdict: "allowed",
        autoApproveWrite: true,
      }),
    ).toBe("reject");
  });

  it("deadlinesOf：reject 120s / hold 24h 且记 heldSince / preauth 无倒计时", () => {
    const now = 1_700_000_000_000;
    const reject = deadlinesOf("reject", now);
    expect(reject.expiresAt! - now).toBe(120_000);
    expect(reject.heldSince).toBeNull();

    const hold = deadlinesOf("hold", now);
    expect(hold.expiresAt! - now).toBe(24 * 60 * 60 * 1000);
    expect(hold.heldSince).toBe(now);

    const preauth = deadlinesOf("preauth", now);
    expect(preauth.expiresAt).toBeNull();
    expect(preauth.heldSince).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 裁决器：越界直接拒绝 / grant 命中 / 三档计时
// ---------------------------------------------------------------------------

interface Fixture {
  db: DB;
  resolver: ReturnType<typeof createPermissionResolver>;
  /** 回传运行时的记录（断言「越界不转发」用）。 */
  responded: { requestId: string; decision: PermissionDecision }[];
  /** 会话进程是否还活着；测试里直接改它模拟崩溃。 */
  alive: boolean;
  close: () => void;
}

function setup(
  botBoundary: Partial<BoundarySnapshot> = {},
  opts: { alive?: boolean; rejectTimeoutMs?: number } = {},
): Fixture {
  const db = openDb(":memory:");
  const now = Date.now();
  const botId = "bot_perm";
  const channelId = "ch_perm";
  const sessionId = "sess_perm";

  db.prepare(
    `INSERT INTO channels (id, type, name, participant_bot_ids, host_bot_id, created_at)
     VALUES (?, 'dm', '私聊', ?, NULL, ?)`,
  ).run(channelId, JSON.stringify([botId]), now);
  db.prepare(
    `INSERT INTO bots (id, name, persona, execution_location, repo_path, status,
                       allow_dirs, allow_shell, allow_network, auto_approve_write, created_at, updated_at)
     VALUES (?, '写手', '负责改代码', 'local', ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    botId,
    allowedDir,
    JSON.stringify(botBoundary.allowDirs ?? [allowedDir]),
    botBoundary.allowShell ? 1 : 0,
    botBoundary.allowNetwork ? 1 : 0,
    botBoundary.autoApproveWrite ? 1 : 0,
    now,
    botBoundary.version ?? 1,
  );
  db.prepare(
    `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
     VALUES (?, ?, ?, 'running', ?)`,
  ).run(sessionId, botId, channelId, now);

  const bus = createEventBus({ ringSize: 50 });
  const responded: { requestId: string; decision: PermissionDecision }[] = [];
  const state = { alive: opts.alive ?? true };

  const resolver = createPermissionResolver({
    db,
    bus,
    isSessionAlive: () => state.alive,
    sessionCwdOf: () => allowedDir,
    respond: async (_sessionId, requestId, decision) => {
      if (!state.alive) return false;
      responded.push({ requestId, decision });
      return true;
    },
    setHeld: () => undefined,
    setSessionStatus: () => undefined,
    ...(opts.rejectTimeoutMs === undefined ? {} : { rejectTimeoutMs: opts.rejectTimeoutMs }),
    log: () => undefined,
  });

  return {
    db,
    resolver,
    responded,
    get alive() {
      return state.alive;
    },
    set alive(v: boolean) {
      state.alive = v;
    },
    close: () => {
      resolver.dispose();
      db.close();
    },
  };
}

const SESSION = "sess_perm";
const BOT = "bot_perm";

describe("裁决器 · 超出边界直接拒绝、不转发运行时", () => {
  it("已配置允许目录但目标在外 → 直接拒绝（明确的边界，不弹卡）", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_1",
      source: "interactive",
      request: { requestId: "perm_out", action: "write", target: join(outsideDir, "x.md") },
    });

    const row = f.resolver.get("perm_out");
    expect(row?.status).toBe("denied_boundary");
    expect(row?.boundaryVerdict).toBe("denied");
    expect(row?.decision).toBe("reject");
    expect(row?.decidedBy).toBe("system");
    // 越界也要回传：否则运行时永远卡在这个请求上
    expect(f.responded).toHaveLength(1);
    expect(f.responded[0]?.decision.kind).toBe("deny");
    f.close();
  });

  it("已配置边界时越界请求不占 120s：expiresAt 为 null，没有 pending 状态", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_1",
      source: "interactive",
      request: { requestId: "perm_out2", action: "write", target: join(outsideDir, "y.md") },
    });
    const row = f.resolver.get("perm_out2");
    expect(row?.expiresAt).toBeNull();
    expect(row?.heldSince).toBeNull();
    f.close();
  });

  it("**未配置允许目录**（默认状态）→ confirm 模式弹卡等用户决定，不再静默拒绝", async () => {
    // 2026-10-28 真机反馈的根因：新建 Bot 的 allow_dirs 是空数组，
    // 写请求被直接判成 denied_boundary、不落 pending —— 手机上没有任何确认框。
    // PRD P0-09 的默认口径本就是「只读 + 写需批准」，这里对齐它。
    const f = setup({ allowDirs: [] });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_1",
      source: "interactive",
      request: { requestId: "perm_unset", action: "write", target: join(outsideDir, "u.md") },
    });

    const row = f.resolver.get("perm_unset");
    expect(row?.status).toBe("pending");
    expect(row?.boundaryVerdict).toBe("denied");
    expect(row?.timeoutPolicy).toBe("reject");
    expect(row?.expiresAt).not.toBeNull();
    // 还没人做决定：绝不提前回传，否则卡片点了也没用
    expect(f.responded).toHaveLength(0);

    const decided = await f.resolver.decide("perm_unset", "approve");
    expect(decided.ok).toBe(true);
    expect(f.resolver.get("perm_unset")?.status).toBe("decided");
    expect(f.responded[0]?.decision.kind).toBe("approve");
    f.close();
  });

  it("未配置允许目录 + 用户不点批准 → 120s 超时自动拒绝（安全默认不变）", async () => {
    const f = setup({ allowDirs: [] }, { rejectTimeoutMs: 120 });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_1",
      source: "interactive",
      request: { requestId: "perm_unset_timeout", action: "write", target: join(outsideDir, "t.md") },
    });
    expect(f.resolver.get("perm_unset_timeout")?.status).toBe("pending");
    await new Promise((r) => setTimeout(r, 260));
    const row = f.resolver.get("perm_unset_timeout")!;
    expect(row.status).toBe("denied_timeout");
    expect(f.responded[0]?.decision.kind).toBe("deny");
    f.close();
  });

  it("auto 模式越界写 → 直接拒绝、不弹卡（R5 口径 B 不变）", async () => {
    const f = setup();
    f.db.prepare("UPDATE sessions SET permission_mode = 'auto' WHERE id = ?").run(SESSION);
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_auto",
      source: "interactive",
      request: { requestId: "perm_auto_out", action: "write", target: join(outsideDir, "a.md") },
    });
    const row = f.resolver.get("perm_auto_out")!;
    expect(row.status).toBe("denied_boundary");
    expect(f.responded[0]?.decision.kind).toBe("deny");
    f.close();
  });

  it("越界 exec（未开启 shell）仍直接拒绝，不弹卡", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_exec",
      source: "interactive",
      request: { requestId: "perm_exec_out", action: "exec", target: "rm -rf /" },
    });
    expect(f.resolver.get("perm_exec_out")?.status).toBe("denied_boundary");
    f.close();
  });

  it("越界时落了一条 permission_request 事件，boundaryVerdict=denied（卡片标「超出 Bot 边界」）", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_1",
      source: "interactive",
      request: { requestId: "perm_evt", action: "write", target: join(outsideDir, "z.md") },
    });
    const rows = f.db
      .prepare("SELECT payload FROM events WHERE session_id = ? AND type = 'permission_request'")
      .all(SESSION) as { payload: string }[];
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload) as { boundaryVerdict: string; requestId: string };
    expect(payload.boundaryVerdict).toBe("denied");
    expect(payload.requestId).toBe("perm_evt");
    f.close();
  });
});

describe("裁决器 · 授权命中自动批准", () => {
  it("session 域 grant 命中 → 直接 decided/approve，不产生 pending", async () => {
    const f = setup();
    const target = join(allowedDir, "same.md");
    createGrant(f.db, {
      botId: BOT,
      sessionId: SESSION,
      actionKey: actionKeyOf("write", target),
      scope: "session",
    });

    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_2",
      source: "interactive",
      request: { requestId: "perm_grant", action: "write", target },
    });

    const row = f.resolver.get("perm_grant");
    expect(row?.status).toBe("decided");
    expect(row?.decision).toBe("approve");
    expect(f.responded[0]?.decision.kind).toBe("approve");
    f.close();
  });

  it("bot 域 grant 跨 Session 命中", async () => {
    const f = setup();
    const target = join(allowedDir, "cross.md");
    createGrant(f.db, { botId: BOT, sessionId: SESSION, actionKey: actionKeyOf("write", target), scope: "bot" });

    // 另一会话，同一 Bot
    f.db
      .prepare(
        `INSERT INTO sessions (id, bot_id, channel_id, status, started_at)
         VALUES ('sess_other', ?, 'ch_perm', 'running', ?)`,
      )
      .run(BOT, Date.now());

    await f.resolver.handle({
      sessionId: "sess_other",
      botId: BOT,
      turnId: "turn_3",
      source: "interactive",
      request: { requestId: "perm_cross", action: "write", target },
    });
    expect(f.resolver.get("perm_cross")?.status).toBe("decided");
    f.close();
  });

  it.skipIf(!WIN)("Windows 上 grant 的 action_key 对路径大小写不敏感（同一文件只记一次）", () => {
    // 大小写不敏感是 Windows 文件系统的语义；POSIX 上 Case.md 与 case.md
    // 是两个不同文件，归一化绝不能把它们合并成同一个授权。
    const a = actionKeyOf("write", join(allowedDir, "Case.md"));
    const b = actionKeyOf("write", join(allowedDir, "case.md") + "\\");
    expect(a).toBe(b);
  });

  it("联网授权按主机归一化：同站不同页面只记一次（浏览器连续操作）", () => {
    // 浏览器控制一次任务会连续访问同站多个页面；按完整 URL 记指纹的话，
    // 用户点「记住（本会话）」只对那一个 URL 生效，下一页又弹卡（实测）。
    const a = actionKeyOf("network", "https://example.com/");
    const b = actionKeyOf("network", "https://example.com/about?x=1");
    const c = actionKeyOf("network", "EXAMPLE.com:443");
    expect(a).toBe("network:example.com");
    expect(b).toBe(a);
    // 不同站点 / 不同端口仍是不同授权
    expect(actionKeyOf("network", "https://example.org/")).not.toBe(a);
    expect(actionKeyOf("network", "http://example.com:8080/")).not.toBe(a);
    // 裸词（没有 scheme）按 https 解析；解析不了就退回原文
    expect(actionKeyOf("network", "example.net")).toBe("network:example.net");
    expect(c).toBe(a);
  });

  it("grant 的 action_key 去掉尾部分隔符（同一路径只记一次）", () => {
    const a = actionKeyOf("write", join(allowedDir, "same.md"));
    const b = actionKeyOf("write", join(allowedDir, "same.md") + "/");
    expect(a).toBe(b);
  });

  it("过期 grant 不算命中，且顺手被清掉", () => {
    const f = setup();
    const target = join(allowedDir, "old.md");
    createGrant(f.db, {
      botId: BOT,
      sessionId: SESSION,
      actionKey: actionKeyOf("write", target),
      scope: "session",
      now: Date.now() - 48 * 60 * 60 * 1000,
    });
    const hit = findGrant(f.db, {
      botId: BOT,
      sessionId: SESSION,
      actionKey: actionKeyOf("write", target),
    });
    expect(hit).toBeNull();
    expect(listGrants(f.db, BOT)).toHaveLength(0);
    f.close();
  });
});

describe("裁决器 · 三档计时（reject 120s / hold 24h / preauth）", () => {
  it("交互写 → pending + timeoutPolicy=reject + expiresAt≈now+120s", async () => {
    const f = setup();
    const before = Date.now();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_r",
      source: "interactive",
      request: { requestId: "perm_reject", action: "write", target: join(allowedDir, "r.md") },
    });
    const row = f.resolver.get("perm_reject")!;
    expect(row.status).toBe("pending");
    expect(row.timeoutPolicy).toBe("reject");
    expect(row.heldSince).toBeNull();
    expect(row.expiresAt).not.toBeNull();
    const ttl = row.expiresAt! - before;
    // 120s ± 1s（真实取值来自 config，这里断言量级正确而不是精确相等）
    expect(ttl).toBeGreaterThan(118_000);
    expect(ttl).toBeLessThanOrEqual(121_000);
    f.close();
  });

  it("Assignment 来源 → pending + hold + heldSince 有值 + 上限 24h", async () => {
    const f = setup();
    const before = Date.now();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_h",
      source: "assignment",
      request: { requestId: "perm_hold", action: "write", target: join(allowedDir, "h.md") },
    });
    const row = f.resolver.get("perm_hold")!;
    expect(row.status).toBe("pending");
    expect(row.timeoutPolicy).toBe("hold");
    expect(row.heldSince).not.toBeNull();
    expect(row.expiresAt! - before).toBeGreaterThan(23 * 60 * 60 * 1000);
    f.close();
  });

  it("preauth：边界内写自动批准，不产生卡片", async () => {
    const f = setup({ autoApproveWrite: true });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_p",
      source: "interactive",
      request: { requestId: "perm_preauth", action: "write", target: join(allowedDir, "p.md") },
    });
    const row = f.resolver.get("perm_preauth")!;
    expect(row.status).toBe("decided");
    expect(row.timeoutPolicy).toBe("preauth");
    expect(row.decision).toBe("approve");
    expect(f.responded[0]?.decision.kind).toBe("approve");
    f.close();
  });

  it("preauth 下边界外写仍走 reject（不自动批准）", async () => {
    const f = setup({ autoApproveWrite: true });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_p2",
      source: "interactive",
      request: { requestId: "perm_preauth_out", action: "write", target: join(outsideDir, "p.md") },
    });
    const row = f.resolver.get("perm_preauth_out")!;
    expect(row.status).toBe("denied_boundary");
    expect(f.responded[0]?.decision.kind).toBe("deny");
    f.close();
  });

  it("用户决策：approve 写 decided + decidedBy=user + 回传 approve", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_d",
      source: "interactive",
      request: { requestId: "perm_decide", action: "write", target: join(allowedDir, "d.md") },
    });
    const res = await f.resolver.decide("perm_decide", "approve");
    expect(res.ok).toBe(true);
    const row = f.resolver.get("perm_decide")!;
    expect(row.status).toBe("decided");
    expect(row.decision).toBe("approve");
    expect(row.decidedBy).toBe("user");
    expect(row.decidedAt).not.toBeNull();
    expect(f.responded.at(-1)?.decision.kind).toBe("approve");
    f.close();
  });

  it("记住本会话 → 写 grant，同动作再次请求直接自动批准", async () => {
    const f = setup();
    const target = join(allowedDir, "remember.md");
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_1",
      source: "interactive",
      request: { requestId: "perm_remember", action: "write", target },
    });
    await f.resolver.decide("perm_remember", "remember_session");

    const grants = listGrants(f.db, BOT);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.scope).toBe("session");

    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_2",
      source: "interactive",
      request: { requestId: "perm_remember2", action: "write", target },
    });
    expect(f.resolver.get("perm_remember2")?.status).toBe("decided");
    f.close();
  });

  it("进程已退出时决策 → 卡片转 invalidated（不假装批准成功）", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_x",
      source: "interactive",
      request: { requestId: "perm_dead", action: "write", target: join(allowedDir, "x.md") },
    });
    f.alive = false;
    const res = await f.resolver.decide("perm_dead", "approve");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("invalidated");
    expect(f.resolver.get("perm_dead")?.status).toBe("invalidated");
    f.close();
  });
});

describe("裁决器 · 扫描器（hold 24h / 进程退出 / 挂起数上限）", () => {
  it("hold 超 24h → denied_hard_timeout，并回传 deny", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_h24",
      source: "schedule",
      request: { requestId: "perm_h24", action: "write", target: join(allowedDir, "h24.md") },
    });
    // 把 expires_at 拨到过去，模拟 24h 已过
    f.db
      .prepare("UPDATE permission_requests SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1000, "perm_h24");

    const result = f.resolver.sweep();
    expect(result.hardTimedOut).toBe(1);
    expect(f.resolver.get("perm_h24")?.status).toBe("denied_hard_timeout");
    expect(f.responded.at(-1)?.decision.kind).toBe("deny");
    f.close();
  });

  it("reject 超时（扫描器兜底）→ denied_timeout", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_rt",
      source: "interactive",
      request: { requestId: "perm_rt", action: "write", target: join(allowedDir, "rt.md") },
    });
    f.db
      .prepare("UPDATE permission_requests SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1000, "perm_rt");

    const result = f.resolver.sweep();
    expect(result.timedOut).toBe(1);
    expect(f.resolver.get("perm_rt")?.status).toBe("denied_timeout");
    f.close();
  });

  it("服务重启场景：挂起超 24h 且进程已不在 → 转 denied_hard_timeout（不是 invalidated）", async () => {
    // board 03-decisions 明确要求「服务重启时对超过 24h 的挂起卡片直接转拒绝」。
    // 重启后进程必然不在，所以「先判超时、再判进程」的顺序是硬要求。
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_restart",
      source: "schedule",
      request: { requestId: "perm_restart", action: "write", target: join(allowedDir, "re.md") },
    });
    f.db
      .prepare("UPDATE permission_requests SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1000, "perm_restart");
    f.alive = false;

    const result = f.resolver.sweep();
    expect(result.hardTimedOut).toBe(1);
    expect(result.invalidated).toBe(0);
    expect(f.resolver.get("perm_restart")?.status).toBe("denied_hard_timeout");
    f.close();
  });

  it("进程已退出 → pending 直接 invalidated，不占满 24h", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_inv",
      source: "assignment",
      request: { requestId: "perm_inv", action: "write", target: join(allowedDir, "i.md") },
    });
    f.alive = false;
    const result = f.resolver.sweep();
    expect(result.invalidated).toBe(1);
    expect(f.resolver.get("perm_inv")?.status).toBe("invalidated");
    f.close();
  });

  it("同时挂起超过 5 个 → 最老的转 invalidated", async () => {
    const f = setup();
    for (let i = 0; i < 7; i += 1) {
      await f.resolver.handle({
        sessionId: SESSION,
        botId: BOT,
        turnId: `turn_many_${i}`,
        source: "assignment",
        request: {
          requestId: `perm_many_${i}`,
          action: "write",
          target: join(allowedDir, `m${i}.md`),
        },
      });
      // created_at 精度到 ms：拉开顺序，保证「最老」判定确定
      await new Promise((r) => setTimeout(r, 3));
    }
    const result = f.resolver.sweep();
    expect(result.evicted).toBe(2);
    expect(f.resolver.get("perm_many_0")?.status).toBe("invalidated");
    expect(f.resolver.get("perm_many_1")?.status).toBe("invalidated");
    expect(f.resolver.get("perm_many_6")?.status).toBe("pending");
    f.close();
  });

  it("sweepExpired 直接调用也幂等（已决的不再动）", async () => {
    const f = setup();
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_idem",
      source: "interactive",
      request: { requestId: "perm_idem", action: "write", target: join(allowedDir, "idem.md") },
    });
    await f.resolver.decide("perm_idem", "reject");
    const again = sweepExpired({
      db: f.db,
      isSessionAlive: () => true,
      onSettled: () => undefined,
    });
    expect(again.timedOut + again.hardTimedOut + again.invalidated).toBe(0);
    expect(f.resolver.get("perm_idem")?.status).toBe("decided");
    f.close();
  });
});

describe("裁决器 · 真实定时器（把 120s 缩短到 150ms 验证行为一致）", () => {
  it("reject 策略到点自动拒绝，并回传 deny", async () => {
    // 真实 120s 无法在单测里等；这里注入 150ms 验证「到点转 denied_timeout + 回传 deny」
    // 这条链路与 120s 完全一致（同一个 setTimeout，同一个 settleBySystem）。
    const f = setup({}, { rejectTimeoutMs: 150 });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_timer",
      source: "interactive",
      request: { requestId: "perm_timer", action: "write", target: join(allowedDir, "timer.md") },
    });

    expect(f.resolver.get("perm_timer")?.status).toBe("pending");
    expect(f.resolver.get("perm_timer")?.expiresAt! - Date.now()).toBeLessThanOrEqual(200);

    await new Promise((r) => setTimeout(r, 300));

    const row = f.resolver.get("perm_timer")!;
    expect(row.status).toBe("denied_timeout");
    expect(row.decision).toBe("reject");
    expect(row.decidedBy).toBe("system");
    expect(f.responded.at(-1)?.decision.kind).toBe("deny");
    f.close();
  });

  it("hold 策略不挂定时器：等到上限也不自动拒绝（由扫描器兜底）", async () => {
    const f = setup({}, { rejectTimeoutMs: 100 });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_hold_timer",
      source: "assignment",
      request: { requestId: "perm_hold_timer", action: "write", target: join(allowedDir, "hold.md") },
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(f.resolver.get("perm_hold_timer")?.status).toBe("pending");
    f.close();
  });

  it("用户在超时前决策 → 定时器作废，不再覆盖用户的决定", async () => {
    const f = setup({}, { rejectTimeoutMs: 150 });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_race",
      source: "interactive",
      request: { requestId: "perm_race", action: "write", target: join(allowedDir, "race.md") },
    });
    await f.resolver.decide("perm_race", "approve");
    await new Promise((r) => setTimeout(r, 300));

    const row = f.resolver.get("perm_race")!;
    expect(row.status).toBe("decided");
    expect(row.decision).toBe("approve");
    expect(row.decidedBy).toBe("user");
    f.close();
  });
});

describe("裁决器 · requestId 冲突（ACP 的 JSON-RPC id 每个进程从 1 重数）", () => {
  it("不同请求复用同一个 requestId → 第二张卡不会被当成重复上报丢弃", async () => {
    // 实测踩到：假运行时进程被回收重建后，第二个权限请求的 JSON-RPC id 又是 1000。
    // 若直接拿它当主键，第二张卡会被判为「重复上报」静默丢掉，用户看不到请求、
    // 运行时永远卡着。这里断言两张卡都在，且回传时用的是原始 id。
    const f = setup();

    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_a",
      source: "interactive",
      request: { requestId: "1000", action: "write", target: join(allowedDir, "a.md") },
    });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_b",
      source: "interactive",
      request: { requestId: "1000", action: "write", target: join(allowedDir, "b.md") },
    });

    const rows = f.resolver.listBySession(SESSION);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(rows[0]?.id).toBe("1000");
    expect(rows[1]?.id).toBe("1000#2");

    // 决策第二张：回传运行时的 id 必须是原始的 "1000"（驱动只认自己的 JSON-RPC id）
    await f.resolver.decide("1000#2", "approve");
    expect(f.responded.at(-1)?.requestId).toBe("1000");
    f.close();
  });

  it("同一 Turn 内同 requestId 重复上报 → 只重推事件，不新增行", async () => {
    const f = setup();
    const req = {
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_dup",
      source: "interactive" as const,
      request: { requestId: "2000", action: "write" as const, target: join(allowedDir, "d.md") },
    };
    await f.resolver.handle(req);
    await f.resolver.handle(req);

    expect(f.resolver.listBySession(SESSION)).toHaveLength(1);
    const events = f.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'permission_request'")
      .get(SESSION) as { n: number };
    // 重复上报会再推一条事件（前端据此刷新），但卡片只有一张
    expect(events.n).toBe(2);
    f.close();
  });
});

describe("边界快照 · 进行中的请求按旧版本判定（P0-09）", () => {
  it("保存新边界后，已存在的请求仍保留旧快照与版本号", async () => {
    const f = setup({ version: 7 });
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_snap",
      source: "interactive",
      request: { requestId: "perm_snap", action: "write", target: join(allowedDir, "s.md") },
    });

    // 收紧边界（把允许目录改到别处）
    f.db
      .prepare("UPDATE bots SET allow_dirs = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify([outsideDir]), Date.now(), BOT);

    const row = f.db
      .prepare("SELECT boundary_version, boundary_snapshot FROM permission_requests WHERE id = ?")
      .get("perm_snap") as { boundary_version: number; boundary_snapshot: string };
    expect(row.boundary_version).toBe(7);
    const snap = JSON.parse(row.boundary_snapshot) as { allowDirs: string[] };
    expect(snap.allowDirs[0]?.toLowerCase()).toContain("workspace");

    // 新请求按新边界判定：同一个目标现在越界
    await f.resolver.handle({
      sessionId: SESSION,
      botId: BOT,
      turnId: "turn_snap2",
      source: "interactive",
      request: { requestId: "perm_snap2", action: "write", target: join(allowedDir, "s2.md") },
    });
    expect(f.resolver.get("perm_snap2")?.status).toBe("denied_boundary");

    // readBoundary 返回的是新版本
    expect(readBoundary(f.db, BOT)?.version).toBeGreaterThan(7);
    f.close();
  });
});
