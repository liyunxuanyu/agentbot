import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type DB } from "../../src/server/core/db/db.js";
import { computeSetupState } from "../../src/server/http/routes/setup.js";
import { writeProviderFile } from "../../src/server/adapters/providers/store.js";
import { config } from "../../src/server/config.js";

/**
 * N1：首启判定与 5 步完成度。
 *
 * 判据全在服务端（`GET /api/setup/state`）：前端首启跳转与侧栏「N/5」都读它，
 * 两处各拼一次必然漂移。这里直接测纯函数 computeSetupState（不依赖 HTTP），
 * 覆盖「空库 / 有供应商没 Bot / 有普通 Bot 没管理员 / 全齐」四种形态。
 */

let home = "";
let db: DB;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agentbot-setup-"));
  db = openDb(":memory:");
  // 运行时表里放一个 ready 的运行时（首启判断看 availability）
  db.prepare(
    `INSERT INTO runtime_definitions
       (id, adapter_name, display_name, source, version, command, protocol,
        capabilities, event_capabilities, health_status, created_at)
     VALUES ('builtin', 'builtin', '内置引擎', 'builtin', '0.1.0', '(内置)', 'builtin',
             ?, '[]', 'ready', ?)`,
  ).run(JSON.stringify({ plan: true, streaming: true, _probe: { availability: "ready" } }), Date.now());
});

afterAll(() => {
  db.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // 忽略
  }
});

function clearProviders(): void {
  writeProviderFile({ defaultId: null, providers: [] });
}

describe("/api/setup/state（N1）", () => {
  it("空库：needsSetup=true，5 步里只有可选的技能可能完成", () => {
    clearProviders();
    db.prepare("DELETE FROM bots").run();
    const state = computeSetupState(db);
    expect(state.needsSetup).toBe(true);
    expect(state.total).toBe(5);
    expect(state.steps.map((s) => s.key)).toEqual([
      "runtime",
      "provider",
      "admin",
      "workspace",
      "skills",
    ]);
    // 运行时 ready 已满足（内置引擎）
    expect(state.steps.find((s) => s.key === "runtime")?.done).toBe(true);
    expect(state.steps.find((s) => s.key === "provider")?.done).toBe(false);
    expect(state.steps.find((s) => s.key === "admin")?.done).toBe(false);
    // 可选步骤跳过不影响 needsSetup
    expect(state.needsSetup).toBe(true);
  });

  it("有供应商、有普通 Bot、没管理员 → 仍然 needsSetup（管理员是必需项）", () => {
    clearProviders();
    // config 在模块加载时确定：写默认路径（vitest 的临时 home）
    writeProviderFile({
      defaultId: "p1",
      providers: [
        {
          id: "p1",
          protocol: "openai-chat",
          baseUrl: "https://example.com/v1",
          apiKey: "sk-test",
          model: "m",
          contextWindow: null,
          maxOutputTokens: null,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    });
    db.prepare(
      `INSERT INTO bots (id, name, persona, role, repo_path, status, created_at, updated_at)
       VALUES ('b_member', '普通 Bot', '', 'member', NULL, 'active', ?, ?)`,
    ).run(Date.now(), Date.now());

    const state = computeSetupState(db);
    expect(state.steps.find((s) => s.key === "provider")?.done).toBe(true);
    expect(state.steps.find((s) => s.key === "admin")?.done).toBe(false);
    expect(state.steps.find((s) => s.key === "admin")?.detail).toContain("没有管理员");
    expect(state.needsSetup).toBe(true);
    db.prepare("DELETE FROM bots").run();
    clearProviders();
  });

  it("补齐必需项后 needsSetup=false（可选步骤没做完也不打扰）", () => {
    writeProviderFile({
      defaultId: "p1",
      providers: [
        {
          id: "p1",
          protocol: "openai-chat",
          baseUrl: "https://example.com/v1",
          apiKey: "sk-test",
          model: "m",
          contextWindow: null,
          maxOutputTokens: null,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    });
    db.prepare(
      `INSERT INTO bots (id, name, persona, role, repo_path, status, created_at, updated_at)
       VALUES ('b_admin', '管理员', '', 'admin', NULL, 'active', ?, ?)`,
    ).run(Date.now(), Date.now());

    const state = computeSetupState(db);
    expect(state.needsSetup).toBe(false);
    // 工作区与技能没做 → completed < total，侧栏仍提示，但不再强制跳转
    expect(state.completed).toBeLessThan(state.total);
    expect(state.steps.find((s) => s.key === "admin")?.done).toBe(true);
    db.prepare("DELETE FROM bots").run();
    clearProviders();
  });

  it("工作区与技能完成后 completed = total", () => {
    writeProviderFile({
      defaultId: "p1",
      providers: [
        {
          id: "p1",
          protocol: "openai-chat",
          baseUrl: "https://example.com/v1",
          apiKey: "sk-test",
          model: "m",
          contextWindow: null,
          maxOutputTokens: null,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    });
    db.prepare(
      `INSERT INTO bots (id, name, persona, role, repo_path, status, created_at, updated_at)
       VALUES ('b_admin2', '管理员二', '', 'admin', ?, 'active', ?, ?)`,
    ).run(process.cwd(), Date.now(), Date.now());

    // 技能目录里放一个技能
    mkdirSync(join(config.skillsDir, "demo"), { recursive: true });
    writeFileSync(join(config.skillsDir, "demo", "SKILL.md"), "---\nname: demo\n---\n", "utf8");

    const state = computeSetupState(db);
    expect(state.needsSetup).toBe(false);
    expect(state.completed).toBe(state.total);
    expect(state.steps.every((s) => s.done)).toBe(true);
    db.prepare("DELETE FROM bots").run();
    clearProviders();
    rmSync(join(config.skillsDir, "demo"), { recursive: true, force: true });
  });

  it("归档的管理员不算数（与 Bot 列表口径一致）", () => {
    writeProviderFile({
      defaultId: "p1",
      providers: [
        {
          id: "p1",
          protocol: "openai-chat",
          baseUrl: "https://example.com/v1",
          apiKey: "sk-test",
          model: "m",
          contextWindow: null,
          maxOutputTokens: null,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    });
    db.prepare(
      `INSERT INTO bots (id, name, persona, role, status, created_at, updated_at)
       VALUES ('b_arch', '归档管理员', '', 'admin', 'archived', ?, ?)`,
    ).run(Date.now(), Date.now());
    const state = computeSetupState(db);
    expect(state.steps.find((s) => s.key === "admin")?.done).toBe(false);
    db.prepare("DELETE FROM bots").run();
    clearProviders();
  });
});
