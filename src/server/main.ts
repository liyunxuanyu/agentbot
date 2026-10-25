import { mkdirSync } from "node:fs";
import { config } from "./config.js";
import { closeDb, initDb, type DB } from "./core/db/db.js";
import { eventBus } from "./core/events/bus.js";
import { createTurnOrchestrator, type TurnRuntime } from "./core/orchestrator/turn.js";
import { createSupervisor, sessionCwdOf } from "./core/process/supervisor.js";
import { sweepZombies } from "./core/process/pid-registry.js";
import { createPermissionResolver } from "./core/permissions/resolver.js";
import { SWEEP_INTERVAL_MS } from "./core/permissions/policy.js";
import { createScheduler } from "./core/scheduling/scheduler.js";
import { createAssignmentRunner } from "./core/assignment/runner.js";
import { ensureWorktreeForBot } from "./core/assignment/worktree.js";
import { createUsageRecorder } from "./core/usage/recorder.js";
import { createSummarizer } from "./core/memory/summarizer.js";
import { createDriverFor, configureBuiltinDriver } from "./adapters/factory.js";
import { createBuiltinDriver } from "./adapters/channels/builtin/driver.js";
import { McpManager } from "./adapters/mcp/manager.js";
import { listProviders } from "./adapters/providers/store.js";
import { BUILTIN_RUNTIME_ID, builtinDeclaration } from "./adapters/builtin-runtime.js";
import { effectiveDetectCommand, resolveCommand } from "./adapters/launch.js";
import {
  listRuntimes,
  persistProbe,
  probeAll,
  readCustomDeclaration,
  readCustomDeclarations,
  type ProbeInput,
} from "./adapters/probe.js";
import { loadDeclarations } from "./adapters/registry.js";
import { ensureToken } from "./http/auth.js";
import { toRuntimeDto } from "./http/dto.js";
import { accessUrl, buildServer, type RuntimeSummary } from "./http/server.js";

/**
 * 启动序（架构 §2/§8）：
 *   建 ~/.agentbot → openDb + 迁移 → ensureToken
 *   → 加载 adapter 声明 + 并发探测（结果写缓存）
 *   → 装配 Supervisor（进程唯一管理者）+ 权限裁决
 *   → 僵尸清扫 + 权限清扫 → 编排器 → 调度器 → HTTP → 打印带 token 的 URL
 *
 * 任何一步失败都直接退出并给出可读原因——本地单用户服务，静默降级比崩溃更糟。
 */

const log = (msg: string): void => {
  console.log(`[agentbot] ${msg}`);
};

/** 会话归属 Bot：权限请求可能在没有活跃 Turn 时到达（重连/恢复），需要兜底查一次。 */
function sessionBotId(db: DB, sessionId: string): string | null {
  const row = db.prepare("SELECT bot_id FROM sessions WHERE id = ?").get(sessionId) as
    | { bot_id: string }
    | undefined;
  return row?.bot_id ?? null;
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  // ① 状态目录
  mkdirSync(config.home, { recursive: true });
  log(`状态目录 ${config.home}`);

  // ② 数据库 + 迁移
  const { db, migration } = initDb();
  if (migration.applied.length > 0) {
    log(`数据库已迁移 v${migration.from} → v${migration.to}：${migration.applied.join("，")}`);
  } else {
    log(`数据库已是最新 v${migration.to}（${config.dbPath}）`);
  }

  // ③ 本地 token（P0-14）
  const token = ensureToken();
  log(`token 已就绪（${config.tokenPath}）`);

  // ④ 声明加载 + 并发探测（单项 3s 超时，互不阻塞，P0-01）
  //
  // 声明有两个来源：内置 YAML（`declarations/`）与用户手动添加的自定义运行时
  // （P0-01，整份声明存在 `runtime_definitions.capabilities._declaration`）。
  // 后者必须一并加载，否则「Bot 绑着自定义运行时」在重启后发不出消息
  // （`resolveRuntime` 按 adapter_name 查声明，查不到就返回 null）。
  const { loaded, errors } = loadDeclarations();
  for (const e of errors) {
    console.warn(`[agentbot] 声明文件无效，已跳过：${e.file} — ${e.message}`);
  }

  const declarationById = new Map(loaded.map((l) => [l.declaration.id, l.declaration]));
  const builtinIds = new Set(declarationById.keys());
  const customDeclarations = readCustomDeclarations(db);
  for (const declaration of customDeclarations) {
    // 内置 YAML 与自定义同 id 时以 YAML 为准：声明文件是安装的一部分，
    // 用户手动加的同名条目只可能是历史残留（添加时已拦过重名）。
    if (!declarationById.has(declaration.id)) declarationById.set(declaration.id, declaration);
  }

  // 内置引擎不是 PATH 里的可执行文件：单独注册，不参与 probeAll。
  const builtinDecl = builtinDeclaration();
  declarationById.set(BUILTIN_RUNTIME_ID, builtinDecl);

  const inputs: ProbeInput[] = [...declarationById.values()]
    .filter((declaration) => declaration.protocol !== "builtin")
    .map((declaration) => ({
      declaration,
      driver: createDriverFor(declaration),
    }));
  const probes = await probeAll(inputs);

  // 探测结果写缓存：渲染只读缓存，不在渲染时探测（架构 §3.8）
  for (const [id, outcome] of probes) {
    const decl = declarationById.get(id);
    if (!decl) continue;
    persistProbe(db, decl, outcome, resolveCommand(effectiveDetectCommand(decl)), {
      // 自定义运行时的声明本身要留在缓存里（重启后靠它恢复，见 readCustomDeclarations）
      source: builtinIds.has(id) ? "builtin" : "custom",
    });
  }

  // 内置引擎：可用性取决于「是否至少配置了一个供应商」，不跑 PATH 探测。
  function builtinOutcome() {
    const count = listProviders().length;
    const ready = count > 0;
    return {
      capabilities: builtinDecl.capabilities,
      source: "declared" as const,
      version: "0.1.0",
      healthStatus: ready ? ("healthy" as const) : ("unhealthy" as const),
      availability: ready ? ("ready" as const) : ("unhealthy" as const),
      meetsMinVersion: true,
      executable: null,
      ...(ready
        ? {}
        : { detail: "未配置模型供应商：请到设置 → 模型供应商添加一个" }),
    };
  }
  function refreshBuiltinRuntime(): void {
    persistProbe(db, builtinDecl, builtinOutcome(), null, { source: "builtin" });
  }
  refreshBuiltinRuntime();

  // MCP：随服务进程连接；单个失败只标状态，不阻断启动。
  const mcp = new McpManager();
  await mcp.start();
  configureBuiltinDriver(createBuiltinDriver({ mcp }));

  const runtimes: RuntimeSummary[] = listRuntimes(db).map(toRuntimeDto).map((r) => ({
    id: r.id,
    displayName: r.displayName,
    protocol: r.protocol,
    version: r.version,
    healthStatus: r.healthStatus,
    capabilitiesSource: r.capabilitiesSource,
    capabilities: r.capabilities,
  }));

  if (runtimes.length === 0) {
    log("未发现运行时声明（declarations/ 为空），绑定下拉将为空");
  } else {
    for (const r of runtimes) {
      const ver = r.version ?? "版本未知";
      log(`运行时 ${r.displayName}（${r.id}）${ver} · ${r.healthStatus} · ${r.capabilitiesSource}`);
    }
  }

  // ⑤ 编排器：按 Bot → default_runtime_id → 声明 → 驱动
  function resolveRuntime(botId: string): TurnRuntime | null {
    const row = db
      .prepare(
        `SELECT r.id, r.adapter_name, r.health_status
           FROM bots b
           JOIN runtime_definitions r ON r.id = b.default_runtime_id
          WHERE b.id = ?`,
      )
      .get(botId) as { id: string; adapter_name: string; health_status: string } | undefined;
    if (!row) return null;

    // 声明查找顺序：启动时加载的表 → 库里的自定义声明。
    //
    // 为什么必须回退：自定义运行时是**运行期**通过 `POST /api/runtimes` 加的，
    // 启动时的表里没有它。不回退的话「刚加的运行时绑定成功、一发送就
    // runtime_unavailable」—— 用户看不出哪里错了。找到后写回表里缓存，
    // 后续请求不再查库。
    let decl = declarationById.get(row.adapter_name);
    if (!decl) {
      const custom = readCustomDeclaration(db, row.id);
      if (custom) {
        decl = custom;
        declarationById.set(custom.id, custom);
      }
    }
    if (!decl) return null;

    // 内置引擎没有供应商就无法工作：即使缓存里的健康状态还是旧的 ready，
    // 这里也按实际配置再判一次（用户可能手改了 providers.json）。
    if (decl.protocol === "builtin" && listProviders().length === 0) return null;

    // P0-02：不可用的运行时不允许发送（前端也应已禁用，这里是服务端兜底）
    if (row.health_status !== "ready") return null;

    return { runtimeId: row.id, declaration: decl, driver: createDriverFor(decl) };
  }

  const supervisor = createSupervisor({ db, bus: eventBus, resolveRuntime });

  // ⑤' M13 用量记录 + M7 记忆摘要（都在编排器的收口路径上）
  const usageRecorder = createUsageRecorder({ db });
  const summarizer = createSummarizer({
    db,
    // 运行时不可用 → 只留待摘要标记，下次会话开始前重试（PRD P0-10 边界）
    isRuntimeAvailable: (botId) => resolveRuntime(botId) !== null,
  });

  /** 运行时倍率提示：从声明读，供用量页标注 headless 的 ×N。 */
  function runtimeMultiplier(runtimeId: string | null): number | null {
    if (!runtimeId) return null;
    const row = db
      .prepare("SELECT adapter_name FROM runtime_definitions WHERE id = ?")
      .get(runtimeId) as { adapter_name: string } | undefined;
    if (!row) return null;
    const hint = declarationById.get(row.adapter_name)?.modes?.multiplierHint;
    return typeof hint === "number" ? hint : null;
  }

  // ⑥ 权限裁决（M6）
  //
  // 装配顺序说明：resolver 需要 supervisor 的「进程在不在 / 回传裁决 / 保活」，
  // supervisor 需要把驱动上报的权限请求转给 resolver —— 两者互相依赖。
  // 用「resolver 先建、supervisor.addListener 后接」的方式断开循环：
  // supervisor 的 onPermission 回调里 resolver 一定已初始化（服务启动后才会有请求）。
  const permissions = createPermissionResolver({
    db,
    bus: eventBus,
    isSessionAlive: (sessionId) => supervisor.isAlive(sessionId),
    sessionCwdOf: (botId) => sessionCwdOf(db, botId),
    respond: (sessionId, requestId, decision) =>
      supervisor.respondPermission(sessionId, requestId, decision),
    setHeld: (sessionId, held) => supervisor.setHeld(sessionId, held),
    setSessionStatus: (sessionId, status) => supervisor.setStatus(sessionId, status),
  });

  // 驱动上报 → 裁决；进程退出 → 该会话待批全部转失效
  supervisor.addListener({
    onPermission: (sessionId, request) => {
      const turn = supervisor.activeTurn(sessionId);
      const botId = turn?.botId ?? sessionBotId(db, sessionId);
      if (!botId) {
        console.warn(`[agentbot] 权限请求找不到归属 Bot（session=${sessionId}），已忽略`);
        return;
      }
      void permissions
        .handle({
          sessionId,
          botId,
          turnId: turn?.turnId ?? "turn_unknown",
          request,
          source: turn?.source ?? "interactive",
        })
        .catch((err: unknown) => {
          console.warn(
            `[agentbot] 权限裁决失败：${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
    onExit: (sessionId, _info, crashed) => {
      permissions.invalidateSession(
        sessionId,
        crashed ? "运行时进程已崩溃" : "运行时进程已结束",
      );
    },
  });

  // 启动清扫：上一轮残留的进程 + 过期挂起（P0-08 边界处理 / 架构 §5）
  const swept = sweepZombies(db, { log: (m) => log(m) });
  if (swept.scanned > 0) {
    log(
      `僵尸清扫：扫描 ${swept.scanned}，已死 ${swept.dead}，PID 复用 ${swept.reused}，终止残留 ${swept.killed}，无法验证 ${swept.unverifiable}`,
    );
  }
  const sweptPerms = permissions.sweep();
  if (
    sweptPerms.timedOut + sweptPerms.hardTimedOut + sweptPerms.invalidated + sweptPerms.evicted >
    0
  ) {
    log(
      `权限清扫：超时 ${sweptPerms.timedOut}，挂起超时 ${sweptPerms.hardTimedOut}，失效 ${sweptPerms.invalidated}，挤占 ${sweptPerms.evicted}`,
    );
  }
  // 周期性兜底：hold 的 24h 上限与崩溃场景由它覆盖（reject 的 120s 由内存定时器精确触发）
  const permSweepTimer = setInterval(() => {
    try {
      permissions.sweep();
    } catch (err) {
      console.warn(
        `[agentbot] 权限扫描失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, SWEEP_INTERVAL_MS);
  permSweepTimer.unref?.();

  const orchestrator = createTurnOrchestrator({
    db,
    bus: eventBus,
    resolveRuntime,
    supervisor,
    // M13：每轮收口落一条 usage_records（未上报也落，标 reported=0）
    usageRecorder,
    // M7：会话开始前重试待摘要标记 + 每轮收口后检查 40 条阈值
    summarizer,
  });

  // ⑦ Assignment（M11）：独立线程执行 + 队列 + worktree + 报告
  //
  // 启动序里先修一遍 worktree：执行位置是 worktree 的 Bot，若目录已被用户删掉，
  // 这里会重新创建（或标 failed）—— 用户打开 Bot 详情看到的就是真实状态。
  const worktreeBots = db
    .prepare("SELECT id FROM bots WHERE execution_location = 'worktree' AND status = 'active'")
    .all() as { id: string }[];
  for (const b of worktreeBots) {
    const r = ensureWorktreeForBot(db, b.id);
    if (!r.ok) {
      log(`Bot ${b.id} 的 worktree 未就绪：${r.message ?? r.code ?? "未知原因"}`);
    }
  }

  const assignments = createAssignmentRunner({
    db,
    orchestrator,
    isRuntimeAvailable: (botId) => resolveRuntime(botId) !== null,
  });
  // 恢复：重启前残留的 running 标失败，排队按 queue_pos 继续
  assignments.recover();

  // ⑧ 调度器（M12）：不常驻轮询 —— 只挂「最早一次触发」的 setTimeout；
  //    启动时按 next_run_at 重建，并补跑服务未运行期间错过的任务（各 1 次）
  const scheduler = createScheduler({
    db,
    orchestrator,
    isRuntimeAvailable: (botId) => resolveRuntime(botId) !== null,
  });
  scheduler.start();

  // ⑨ HTTP
  const app = buildServer({
    db,
    runtimes,
    schemaVersion: migration.to,
    startedAt,
    resolveRuntime,
    orchestrator,
    permissions,
    assignments,
    scheduler,
    summarizer,
    runtimeMultiplier,
    groupDecisionTimeoutMs: config.limits.groupDecisionMs,
    // P0-01：单运行时重探要按 id 找回声明（内置 YAML + 自定义）
    declarations: declarationById,
    mcp,
    // 供应商增删改后刷新内置引擎的可用性（设置页保存后立刻生效）
    onProvidersChanged: refreshBuiltinRuntime,
  });

  await app.listen({ host: config.http.host, port: config.http.port });

  log(`启动耗时 ${Date.now() - startedAt}ms`);
  console.log("");
  console.log("  用浏览器打开（含 token，仅本机可访问）：");
  console.log(`  ${accessUrl(token)}`);
  console.log("");
  console.log(`  探活：http://${config.http.host}:${config.http.port}/api/health`);
  console.log("");

  // ⑨ 优雅退出：先停 HTTP，再停调度器与子进程，最后关库
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在退出…`);
    app
      .close()
      .catch(() => undefined)
      .finally(() => {
        scheduler.stop();
        assignments.stop();
        clearInterval(permSweepTimer);
        permissions.dispose();
        // 子进程必须先杀：否则 node 会等它们退出，服务看似卡住
        void Promise.all([
          orchestrator.dispose(),
          supervisor.dispose(),
          mcp.dispose(),
        ]).finally(() => {
          closeDb();
          process.exit(0);
        });
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[agentbot] 启动失败:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
