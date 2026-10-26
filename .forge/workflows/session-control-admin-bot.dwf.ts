/**
 * AgentBot 第二轮变更：会话控制（工作区/模型/权限模式）+ 管理员 Bot
 * + 会话级记忆隔离 + 上下文压缩 + 缓存命中率。
 *
 * 用户已拍板（Q15–Q18）：
 *  - 工作区在会话/群聊级（channels.workspace_path），群聊共用；Bot 上的路径降级为默认值
 *  - 每个会话/群聊的记忆也要隔离（即使同一个 Bot）
 *  - 需要上下文压缩 + 缓存命中率
 *  - 管理员 = 普通 Bot + role=admin 标记，可多个
 *  - 四档权限：confirm（默认）/ auto（边界内写自动批+审计）/ plan（只读）/ full（绕过边界但写审计）
 *  - 模型切换：供应商 + 模型都可切，仅内置引擎；跨协议提示新开会话
 *
 * 门禁：tsc / check-boundaries / vue-tsc / vitest，真跑，失败回灌同一个 builder 修，最多 3 轮。
 */

interface Finding {
  /** 覆盖范围，如「会话/工作区/模型绑定链」。 */
  scope: string;
  /** 现状事实，每条带 文件:行号。 */
  facts: string[];
  /** 现有实现做不到什么（只描述缺口，不给方案）。 */
  gaps: string[];
  /** 与需求的冲突点或需要产品裁定的地方。 */
  conflicts: string[];
}

interface StepResult {
  /** 一句话说明做了什么。 */
  summary: string;
  /** 改了/新建了哪些文件。 */
  files: string[];
  /** 与规格的偏差，没有就写 none。 */
  deviations: string;
}

const SPEC = ".forge/agentbot-12-change-spec.md";
const IMPACT = ".forge/agentbot-13-impact.md";
const ROOT = "D:/workspace/Agent WorkSpace/agentbot";

artifact.table("progress", {
  title: "会话控制变更进度",
  columns: [
    { field: "stage", label: "阶段" },
    { field: "status", label: "状态" },
    { field: "detail", label: "说明" },
  ],
  key: "stage",
});

function mark(stage: string, status: string, detail: string): void {
  report({ stage, status, detail: detail.slice(0, 200) }, "progress");
}

/** 四项门禁；失败回灌给同一个 builder，最多 3 轮。 */
async function gateAndFix(builder: Agent, stage: string): Promise<{ ok: boolean; detail: string }> {
  let last = "none";
  for (let round = 1; round <= 3; round += 1) {
    const tsc = await world.run(
      "node",
      ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"],
      { timeoutMs: 300000 },
    );
    if (tsc.exitCode !== 0) {
      last = `tsc 失败：\n${tsc.stdout.slice(0, 4000)}`;
      log(`${stage} 第 ${round} 轮：类型检查没过`);
      await builder.ask(
        `类型检查没过，逐条修掉；只改你负责的文件，不要顺手重构别的模块。\n${last}`,
      );
      continue;
    }
    const bounds = await world.run("node", ["scripts/check-boundaries.mjs"], { timeoutMs: 120000 });
    if (bounds.exitCode !== 0) {
      last = `分离铁律失败：\n${(bounds.stdout + bounds.stderr).slice(0, 2000)}`;
      log(`${stage} 第 ${round} 轮：分离铁律没过`);
      await builder.ask(`分离铁律检查失败，按提示修正：\n${last}`);
      continue;
    }
    const vtsc = await world.run(
      "node",
      ["node_modules/vue-tsc/bin/vue-tsc.js", "-p", "tsconfig.json", "--noEmit"],
      { timeoutMs: 300000 },
    );
    if (vtsc.exitCode !== 0) {
      last = `vue-tsc 失败：\n${vtsc.stdout.slice(0, 4000)}`;
      log(`${stage} 第 ${round} 轮：前端类型检查没过`);
      await builder.ask(`前端类型检查没过，逐条修掉：\n${last}`);
      continue;
    }
    const tests = await world.run(
      "node",
      ["node_modules/vitest/vitest.mjs", "run", "--reporter", "dot"],
      { timeoutMs: 900000 },
    );
    if (tests.exitCode !== 0) {
      last = `测试失败：\n${(tests.stdout + tests.stderr).slice(-5000)}`;
      log(`${stage} 第 ${round} 轮：测试没过`);
      await builder.ask(
        `测试没过。先判断是「实现有 bug」还是「新测试写错了」——两者都要修，但不要改宽松已有测试来蒙过去。\n${last}`,
      );
      continue;
    }
    log(`${stage} 四项门禁全过（第 ${round} 轮）`);
    return { ok: true, detail: `四项门禁全过（第 ${round} 轮）` };
  }
  return { ok: false, detail: last.slice(0, 800) };
}

// ===========================================================================
phase("考古：摸清四处现状");
// ===========================================================================
const archBase =
  `你在 ${ROOT} 做**只读**考古。只读代码与文档，不改任何文件、不给改进建议。` +
  `每条结论必须带 文件:行号；明确区分「现状事实」与「缺口」。` +
  `缺口只写「现有实现做不到什么」，不要写方案。`;

const archWorkspace = future(async () => {
  phase("考古：会话、工作区与记忆作用域");
  const a = agent("考古·会话工作区", { system: archBase });
  const r = await a.ask<Finding>(
    `范围：src/server/core/db/{schema.sql,migrate.ts}、src/server/core/process/{supervisor,session-cwd}.ts、` +
      `src/server/core/orchestrator/turn.ts、src/server/core/group/{host,dispatcher}.ts、` +
      `src/server/core/memory/{assembler,summarizer}.ts、src/server/core/orchestrator/context.ts、` +
      `src/server/http/routes/{channels,messages,bots}.ts、src/server/http/dto.ts、` +
      `src/web/pages/{ChatPage,ChatsPage}.vue、src/web/stores/sessions.ts。\n\n` +
      `必须回答：\n` +
      `1. 会话的 cwd 从哪来、什么时候定、群聊里多个 Bot 的 cwd 是否可能不同（给调用链）\n` +
      `2. Session 在什么时候创建、sessions 表现在有哪些列、能不能承载「会话级工作区」\n` +
      `3. 记忆的读取与写入各自按什么维度（bot? session? channel?），memory_entries 的列与索引\n` +
      `4. 现有的上下文重建与摘要（40 条触发、6000 字符预算、窗口 70% 裁剪）具体实现在哪、触发点在哪\n` +
      `5. 群聊里「本轮小结」「未发言原因」这些按渠道聚合的地方，如果工作区变成渠道级会受什么影响`,
  );
  return r;
});

const archPermission = future(async () => {
  phase("考古：权限与内置引擎");
  const a = agent("考古·权限与内置引擎", { system: archBase });
  const r = await a.ask<Finding>(
    `范围：src/server/core/permissions/{boundary,resolver,policy,grants,worktree-guard}.ts、` +
      `src/server/core/agent/{loop,prompt,limits}.ts、src/server/core/agent/tools/{registry,paths}.ts、` +
      `src/server/core/agent/tools/builtin/*.ts、src/server/adapters/channels/builtin/driver.ts、` +
      `src/server/adapters/contract.ts、src/server/http/routes/permissions.ts、` +
      `src/web/components/chat/{PermissionBlock,PermissionCard}.vue、src/web/stores/permissions.ts。\n\n` +
      `必须回答：\n` +
      `1. 现有 source → reject/hold/preauth 的判定矩阵在哪一行、由谁决定\n` +
      `2. 边界拒绝与超时策略的先后顺序（越界是不是在弹卡之前就被拒）\n` +
      `3. 工具调用前请求权限的确切位置，plan（只读）能不能只靠工具白名单实现\n` +
      `4. 内置引擎的 provider/model 在哪一层固化（start? newSession? 每次 prompt?）\n` +
      `5. PermissionAction 目前有哪几种、加一个 admin 会影响哪些地方（审计/图标/DTO）`,
  );
  return r;
});

const archBot = future(async () => {
  phase("考古：Bot、管理员与前端入口");
  const a = agent("考古·Bot与管理员", { system: archBase });
  const r = await a.ask<Finding>(
    `范围：src/server/http/routes/{bots,admin}.ts、src/server/main.ts、src/server/core/group/{host,dispatcher}.ts、` +
      `src/server/adapters/providers/store.ts、src/web/pages/{SetupPage,BotsPage,BotDetailPage,SettingsPage}.vue、` +
      `src/web/stores/{bots,runtimes,providers}.ts、src/web/router/index.ts、src/web/components/chat/Composer.vue。\n\n` +
      `必须回答：\n` +
      `1. Bot 创建现在哪些字段必填、校验在哪、创建成功后做了什么副作用\n` +
      `2. 有没有「首次启动种子」逻辑（main.ts 启动序里）\n` +
      `3. 管理员 Bot 若复用普通 Bot，最少要改哪几处；create_bot 作为工具需要什么前置\n` +
      `4. 会话页 composer 现在有哪些控件（@ 指定 Bot / 发送 / 停止），设置类控件放哪合适\n` +
      `5. 设置页现有的供应商/MCP/技能三块结构，新增「会话默认值」放哪`,
  );
  return r;
});

const archUsage = future(async () => {
  phase("考古：用量与缓存命中");
  const a = agent("考古·用量与缓存", { system: archBase });
  const r = await a.ask<Finding>(
    `范围：src/server/core/usage/{recorder,aggregate}.ts、src/server/http/routes/usage.ts、` +
      `src/server/adapters/providers/{openai-chat,anthropic}.ts、src/web/pages/UsagePage.vue、` +
      `src/server/core/db/schema.sql 的 usage_records。\n\n` +
      `必须回答：\n` +
      `1. usage_records 有哪些列，provider 返回的缓存字段（prompt_cache_hit_tokens / cache_read_input_tokens）现在有没有被采集\n` +
      `2. 一次 Turn 多次调 provider 时用量怎么合并（cumulative 标记的含义）\n` +
      `3. 用量页现在的列与聚合口径，加「缓存命中率」需要动哪些地方`,
  );
  return r;
});

const [fWorkspace, fPermission, fBot, fUsage] = await Promise.all([
  archWorkspace,
  archPermission,
  archBot,
  archUsage,
]);
const findings: Finding[] = [fWorkspace, fPermission, fBot, fUsage];
log(`考古完成：4 份，共 ${findings.reduce((n, f) => n + f.facts.length + f.gaps.length, 0)} 条事实与缺口`);
mark("考古", "完成", findings.map((f) => f.scope).join("、"));

// ===========================================================================
phase("定变更规格");
// ===========================================================================
const pm = agent("需求规格", {
  system:
    `你在 ${ROOT} 写变更规格。先读 .forge/agentbot-11-requirements-align.md（本轮需求对齐，口径以此为准）、.forge/agentbot-06-builtin-engine.md、.forge/agentbot-09-change-spec.md ` +
    `了解上一轮口径，再读 .forge/agentbot-01-prd.md 与 02-ux.md。` +
    `输出必须可执行、可验收：每条 P0 有验收标准与边界处理。不要写实现细节（那是架构的事），不要画界面。`,
});
const spec = await pm.ask<StepResult>(
  `写 ${SPEC}（变更规格）。用户已拍板：\n` +
    `- 工作区在会话/群聊级（channels.workspace_path），群聊共用；Bot 上的 repo_path 降级为「默认工作区」可空\n` +
    `- 每个会话/群聊的记忆相互隔离（同一个 Bot 在两个会话里记忆不串）\n` +
    `- 需要上下文压缩（可感知、可手动触发）与缓存命中率统计\n` +
    `- 管理员 = 普通 Bot + role=admin，可多个，可删可改名；首次启动若已配模型就种一个\n` +
    `- 四档权限：confirm（默认）/ auto（边界内写自动批+审计）/ plan（只读）/ full（绕过边界但写审计）\n` +
    `- 模型切换：会话内可切供应商+模型，仅内置引擎；跨协议提示建议新开会话\n\n` +
    `缺口 G1–G10 按 .forge/agentbot-11-requirements-align.md 第 6 节的建议口径写，不要另起口径；` +
    `管理员种子、记忆回填、迁移 v3 属不可逆项，规格里单列一节，实现时逐条确认。\n\n` +
    `考古发现（照此写，不要推翻事实）：\n${JSON.stringify(findings)}\n\n` +
    `必须包含：目标、P0 清单（每条给验收标准 + 边界处理）、明确不做、页面与控件清单、` +
    `数据要求（哪些字段/表）、与现有 PRD 的差异表（原条目 → 新口径）。`,
);
log(`变更规格完成：${spec.summary}`);
mark("变更规格", "完成", spec.summary);

// ===========================================================================
phase("影响分析");
// ===========================================================================
const architect = agent("技术架构", {
  system:
    `你在 ${ROOT} 做影响分析。读 ${SPEC}、.forge/agentbot-11-requirements-align.md、.forge/agentbot-05-architecture.md、` +
    `以及考古事实。输出必须落到「改哪个文件、什么契约、什么迁移、什么风险」，不写业务代码。`,
});
const impact = await architect.ask<StepResult>(
  `写 ${IMPACT}（影响分析）。必须给出：\n` +
    `1. 迁移 v3 的完整 SQL（sessions/channels/bots 的新列 + 索引），以及**向后兼容**说明（老数据回填什么值）\n` +
    `2. 契约变更：SpawnContext 会话覆盖字段、PermissionAction 增 admin、权限模式能力声明、DTO 字段\n` +
    `3. cwd 解析新顺序（渠道工作区 → Bot 默认 → 服务 cwd）与 worktree 交互\n` +
    `4. 四档模式 × 三档超时的判定矩阵（明确越界拒绝发生在哪一步之前）\n` +
    `5. 记忆作用域改造：memory_entries 如何区分 channel/session，装配与摘要在哪一层过滤\n` +
    `6. 上下文压缩与缓存命中的落点（数据列、触发点、UI）\n` +
    `7. 文件归属与并行边界（谁能改哪些文件），明确哪些文件必须串行\n` +
    `8. 不可逆项清单（迁移/种子数据）\n` +
    `9. 风险与取舍（full access、跨协议切换、管理员提权、群聊共用工作区的并发写）\n` + +
    `10. 逐条回应 agentbot-11 第 6 节的 G1–G10：采用/修改/否决，并说明理由\n\n` +
    `考古事实：\n${JSON.stringify(findings)}`,
);
log(`影响分析完成：${impact.summary}`);
mark("影响分析", "完成", impact.summary);

// ===========================================================================
phase("地基：迁移 v3 与共享类型");
// ===========================================================================
const foundation = agent("地基开发者", {
  system:
    `你在 ${ROOT} 实现地基。先读 ${SPEC} 与 ${IMPACT}。` +
    `只改：src/server/core/db/migrate.ts（迁移 v3）、src/server/http/dto.ts、src/web/net/types.ts、` +
    `src/server/http/routes/index.ts、src/server/core/process/supervisor.ts 的 SpawnContext 会话覆盖字段、` +
    `src/shared/events.ts 的 PermissionAction、tests/unit 里对应的迁移/DTO 单测。` +
    `**不要改 schema.sql**（新库靠迁移链）。自查只跑 npx tsc --noEmit，不要跑完整测试套件。`,
});
const f0 = await foundation.ask<StepResult>(
  `实现地基。按 ${IMPACT} 的迁移 SQL 写 v3：sessions 的 workspace_path/provider_id/model/permission_mode、` +
    `channels 的 workspace_path、bots 的 role（默认 member）、usage_records 的缓存列。` +
    `老数据回填：permission_mode 默认 'confirm'、bots.role 默认 'member'、其余留空。` +
    `同步补齐 DTO 与前端类型（先定稿，Wave 1 各模块只消费不改）。` +
    `补迁移单测：v2 库升到 v3 后列存在、回填值正确、重复执行幂等。`,
);
log(`地基完成：${f0.summary}`);
const g0 = await gateAndFix(foundation, "地基");
mark("地基", g0.ok ? "通过" : "失败", g0.detail);
if (!g0.ok) {
  return {
    conclusion: "地基（迁移 v3 与共享类型）未通过门禁，后续模块全部暂停。",
    findings: [
      {
        where: "src/server/core/db/migrate.ts",
        what: "迁移 v3 或共享类型未通过门禁",
        evidence: g0.detail,
        status: "unconfirmed",
        severity: "high",
      },
    ],
    verified: ["考古 4 份、变更规格、影响分析已完成"],
    notCovered: ["Wave 1 全部模块未开始"],
  };
}

// ===========================================================================
phase("四个模块并行实现");
// ===========================================================================
const m1 = future(async () => {
  phase("M1：会话工作区与记忆隔离");
  const b = agent("会话工作区开发者", {
    system:
      `你在 ${ROOT} 实现 M1。读 ${SPEC}、${IMPACT}。` +
      `独占文件：src/server/core/process/{session-cwd,supervisor}.ts（cwd 部分）、src/server/core/orchestrator/{turn,context}.ts、` +
      `src/server/core/group/{host,dispatcher}.ts、src/server/core/memory/{assembler,summarizer}.ts、` +
      `src/server/http/routes/{channels,messages,bots}.ts、src/server/core/assignment/worktree.ts。` +
      `**不要改 src/web/**、不要改 permissions/**、不要改 adapters/channels/builtin/**、不要改 schema.sql。**` +
      `自查只跑 npx tsc --noEmit。`,
  });
  const r = await b.ask<StepResult>(
    `实现 M1：\n` +
      `1. cwd 解析新顺序：channel.workspace_path → bot.repo_path（默认工作区）→ process.cwd()；` +
      `   群聊所有 Bot 共用渠道工作区；本轮只改内置引擎，CLI 运行时的 worktree 逻辑保持不动\n` +
      `2. 会话级工作区可读写：PATCH /api/channels/:id { workspacePath }，校验用 validateWorkingDir；` +
      `   写入后对该渠道后续 Turn 生效，进行中的 Turn 不变\n` +
      `3. 记忆隔离：memory_entries 增加作用域（channel/session），装配与摘要按「当前渠道」过滤；` +
      `   同一个 Bot 在两个会话里的记忆不互相注入。**必须补单测**证明隔离生效\n` +
      `4. 上下文压缩：在装配上下文时按 token 预算裁剪，触发时落一条 meta.compaction 让 UI 显示分隔条；` +
      `   保留现有 40 条摘要触发，新增「用户手动触发压缩」的入口（后端端点即可，UI 归 M5）\n` +
      `5. Bot 创建去路径化：repoPath 变可选（不填=沿用服务 cwd），校验仍要求填了就必须是可用目录\n\n` +
      `补单测覆盖：cwd 优先级、群聊共用工作区、记忆隔离、压缩触发与裁剪量。`,
  );
  return { r, g: await gateAndFix(b, "M1") };
});

const m2 = future(async () => {
  phase("M2：会话内模型与权限模式切换");
  const b = agent("会话控制开发者", {
    system:
      `你在 ${ROOT} 实现 M2（模型切换 + 四档权限模式）。读 ${SPEC}、${IMPACT}。` +
      `独占文件：src/server/adapters/channels/builtin/driver.ts、src/server/adapters/providers/store.ts、` +
      `src/server/adapters/contract.ts、src/server/core/agent/{loop,prompt,limits}.ts、` +
      `src/server/core/agent/tools/{registry}.ts、src/server/core/permissions/{policy,resolver,boundary}.ts、` +
      `src/server/http/routes/permissions.ts。` +
      `**不要改 src/web/**、不要改 orchestrator/turn.ts（M1 拥有）、不要改 schema.sql。**` +
      `自查只跑 npx tsc --noEmit。`,
  });
  const r = await b.ask<StepResult>(
    `实现 M2（本轮只做内置引擎；其它运行时显示禁用态，不改它们的权限链路）：\n` +
      `1. 会话级模型覆盖：sessions.provider_id / model 优先于 Bot 的默认值；内置引擎在**每次 prompt** 读取（不要固化在 newSession）。` +
      `   跨协议切换（openai-chat ↔ anthropic-messages）不静默转换，返回明确提示让用户新开会话\n` +
      `2. 四档权限模式（sessions.permission_mode）：\n` +
      `   - confirm：写/shell/network 都问，沿用 reject/hold 超时\n` +
      `   - auto：边界内写自动批准并写审计；shell/network 仍问\n` +
      `   - plan：只读工具可用，write/exec/network 直接拒绝（不弹卡），模型收到「当前是计划模式，只能读取」\n` +
      `   - full：绕过 Bot 边界，但仍逐条写审计；不弹卡\n` +
      `   越界拒绝的优先级要写清：full 下不生效，其余模式下仍在弹卡之前\n` +
      `3. 工具白名单按模式裁剪：plan 模式把写类工具从 tools 列表里去掉（而不是调用时才拒）\n` +
      `4. PATCH /api/sessions/:id/controls { providerId?, model?, permissionMode? }，写审计\n` +
      `5. 生成中切模式：只影响尚未裁决的工具调用；切到 plan 时把该会话挂起的写类权限请求置为 rejected，并插一条系统块说明已拒绝几个\n` +
      `补单测覆盖：四档 × 四类动作的矩阵、auto 的审计、plan 的工具裁剪、full 的边界绕过、模型热切换。`,
  );
  return { r, g: await gateAndFix(b, "M2") };
});

const m3 = future(async () => {
  phase("M3：管理员 Bot");
  const b = agent("管理员Bot开发者", {
    system:
      `你在 ${ROOT} 实现 M3。读 ${SPEC}、${IMPACT}。` +
      `独占文件：新建 src/server/core/bots/create.ts（把创建逻辑从路由抽出）、` +
      `src/server/core/agent/tools/builtin/create_bot.ts 与 index.ts、src/server/main.ts（种子逻辑）、` +
      `src/server/http/routes/admin.ts。` +
      `**不要改 src/web/**、不要改 routes/bots.ts（M1 拥有）、不要改 permissions/**、不要改 schema.sql。**` +
      `自查只跑 npx tsc --noEmit。`,
  });
  const r = await b.ask<StepResult>(
    `实现 M3：\n` +
      `1. 把 Bot 创建逻辑抽成 core/bots/create.ts，路由与工具共用同一份校验\n` +
      `2. 新增内置工具 create_bot（参数：name / persona / runtimeId / providerId / workspacePath?），` +
      `   permission 标为新增的 'admin' 动作 —— 每次创建都要走权限确认并写审计\n` +
      `3. 管理员种子：首次启动若 bots 表为空且已配置至少一个 provider，种一个 role=admin 的 Bot` +
      `   （人格写成「你是工作台管理员，可以帮用户创建 Bot」）；没有 provider 时跳过并在日志说明\n` +
      `4. GET /api/admin/bots 与 PATCH /api/bots/:id 支持 role 切换（提升/取消管理员），写审计\n\n` +
      `补单测覆盖：create_bot 走权限确认、种子只在空库+有 provider 时执行一次、role 切换。`,
  );
  return { r, g: await gateAndFix(b, "M3") };
});

const m5 = future(async () => {
  phase("M5：前端会话设置栏");
  const b = agent("前端开发者", {
    system:
      `你在 ${ROOT} 做前端。读 ${SPEC}、${IMPACT}、以及 .forge/agentbot-03-ui.md 的令牌与组件规格。` +
      `独占文件：src/web/** 全部。**不要改 src/server/**。** 颜色只用 var(--...)。` +
      `自查只跑 npx vue-tsc --noEmit。`,
  });
  const r = await b.ask<StepResult>(
    `实现 M5：\n` +
      `1. 会话页新增「会话设置」控件（composer 上方一行，或会话头右侧抽屉，你按 03-ui 的组件语言定）：\n` +
      `   - 工作区：显示当前路径 + 可修改（调 PATCH /api/channels/:id）\n` +
      `   - 模型：供应商 + 模型两级下拉（仅内置引擎显示；跨协议切换给「建议新开会话」提示）\n` +
      `   - 权限模式：输入区左侧常显胶囊（8px 语义色点 + 模式名 + chev），点击弹四选一菜单，每项一句说明，当前项打勾；` +
      `     切换立即生效不二次确认；Shift+Tab 循环切换；切到 plan 时把挂起的写类权限卡置为 rejected 并插系统块；` +
      `     群聊里作用于当前展开的 Bot，菜单首项「应用到本群全部 Bot」；非内置引擎显示禁用态 + tooltip 原因\n` +
      `2. Bot 创建表单：路径字段改为可选「默认工作区」，不填有明确说明\n` +
      `3. 用量页：新增「缓存命中率」列（命中 token / 输入 token），未上报显示 —\n` +
      `4. 记忆页：显示记忆的作用域（本会话 / 全局），支持把某条记忆限定到当前会话\n` +
      `5. 四态齐全、暗色可读（≥4.5:1）、1440/1280/1024/768/375 无横向滚动\n\n` +
      `后端接口可能还没全部就绪：404 时按「后端未就绪」渲染禁用态，不要报错。`,
  );
  return { r, g: await gateAndFix(b, "M5") };
});

const [r1, r2, r3, r5] = await Promise.all([m1, m2, m3, m5]);
log(`M1：${r1.r.summary}`);
log(`M2：${r2.r.summary}`);
log(`M3：${r3.r.summary}`);
log(`M5：${r5.r.summary}`);
mark("M1 工作区与记忆隔离", r1.g.ok ? "通过" : "失败", r1.g.detail);
mark("M2 模型与权限模式", r2.g.ok ? "通过" : "失败", r2.g.detail);
mark("M3 管理员 Bot", r3.g.ok ? "通过" : "失败", r3.g.detail);
mark("M5 前端", r5.g.ok ? "通过" : "失败", r5.g.detail);

const failedModules = [
  r1.g.ok ? null : "M1",
  r2.g.ok ? null : "M2",
  r3.g.ok ? null : "M3",
  r5.g.ok ? null : "M5",
].filter((x): x is string => x !== null);
if (failedModules.length > 0) {
  return {
    conclusion: `实现完成但 ${failedModules.join("、")} 未通过门禁，需要按各模块 detail 定位后重跑。`,
    findings: failedModules.map((m) => ({
      where: `模块 ${m}`,
      what: "四项门禁未通过",
      evidence: "见运行日志与 progress 表",
      status: "unconfirmed",
      severity: "high",
    })),
    verified: ["考古、变更规格、影响分析、地基"],
    notCovered: ["集成与验收未开始"],
  };
}

// ===========================================================================
phase("集成与端到端回归");
// ===========================================================================
const integrator = agent("集成开发者", {
  system:
    `你在 ${ROOT} 做集成。读 ${SPEC}、${IMPACT}。` +
    `只做接线与回归，不新增功能：修模块之间的接缝（cwd 与权限模式、模型覆盖与 loop、管理员工具与注册表）、` +
    `扩展 scripts/smoke-builtin.mjs 覆盖「会话工作区 + 权限模式 + 模型切换」三条链路。` +
    `可以改任何 src 文件，但每处改动都要能说出属于哪两个模块的接缝。`,
});
const integ = await integrator.ask<StepResult>(
  `做集成与端到端回归：\n` +
    `1. 跑一遍真实链路（临时 AGENTBOT_HOME，端口自选）：建 Bot（不填路径）→ 建会话 → 设工作区 → 发消息 → ` +
    `切权限模式到 plan 再发 → 切模型 → 用量页看到缓存命中率。把每条链路的真实响应贴进报告\n` +
    `2. 扩展 smoke-builtin.mjs，让 npm run smoke:builtin 覆盖上述三条链路\n` +
    `3. 修发现的接缝 bug（不要顺手改设计）`,
);
log(`集成完成：${integ.summary}`);
const gi = await gateAndFix(integrator, "集成");
mark("集成", gi.ok ? "通过" : "失败", gi.detail);

const smoke = await world.run("node", ["scripts/smoke-builtin.mjs"], { timeoutMs: 600000 });
log(`smoke-builtin exit=${smoke.exitCode}`);

// ===========================================================================
phase("独立验收");
// ===========================================================================
const criticSpec =
  `你在 ${ROOT} 做**只读**验收，绝不修改任何文件。判定依据是 ${SPEC} 的 P0 验收标准与边界处理。` +
  `每条判定必须给实测证据（命令输出 / DB 查询 / HTTP 响应），不接受「代码看起来实现了」。`;

const c1 = future(async () => {
  phase("验收：工作区与记忆隔离");
  const c = agent("验收·工作区记忆", { system: criticSpec });
  return c.ask<string>(
    `验收「会话工作区 + 记忆隔离 + 上下文压缩」三条。重点：\n` +
      `- 群聊里两个 Bot 是否真的共用同一份工作区\n` +
      `- 同一个 Bot 在两个会话里的记忆是否互不注入（给出 DB 与注入内容的证据）\n` +
      `- 压缩触发后 UI 是否出现分隔条、裁剪量是否正确\n` +
      `- Bot 创建不填路径时 cwd 落在哪里\n给通过/不通过 + 证据。`,
  );
});

const c2 = future(async () => {
  phase("验收：模型与权限模式");
  const c = agent("验收·模型权限", { system: criticSpec });
  return c.ask<string>(
    `验收「会话内模型切换 + 四档权限模式」。重点：\n` +
      `- 四档 × 四类动作的矩阵是否与规格一致（逐格给证据）\n` +
      `- plan 模式下写类工具是否从 tools 列表消失（不是调用时才拒）\n` +
      `- full 是否真的绕过边界且仍写审计\n` +
      `- 模型热切换是否下一轮就生效、跨协议是否有明确提示\n给通过/不通过 + 证据。`,
  );
});

const c3 = future(async () => {
  phase("验收：管理员 Bot 与前端");
  const c = agent("验收·管理员前端", { system: criticSpec });
  return c.ask<string>(
    `验收「管理员 Bot + 前端会话设置栏 + 缓存命中率」。重点：\n` +
      `- 空库+有 provider 时是否只种一次管理员；无 provider 时是否跳过\n` +
      `- create_bot 是否走权限确认并写审计\n` +
      `- 会话设置栏三组控件是否可用、四态是否齐全、暗色对比度是否 ≥4.5:1\n` +
      `- 用量页缓存命中率是否正确（未上报显示 —）\n给通过/不通过 + 证据。`,
  );
});

const [v1, v2, v3] = await Promise.all([c1, c2, c3]);
mark("验收", "完成", "3 份独立验收已产出");

// ===========================================================================
phase("文档对齐");
// ===========================================================================
const doc = agent("文档维护", {
  system:
    `你在 ${ROOT} 更新文档。只改文档，不改代码。先读 ${SPEC} 与 ${IMPACT}，再按需改：` +
    `.forge/agentbot-01-prd.md、.forge/agentbot-02-ux.md、.forge/agentbot-03-ui.md、` +
    `.forge/agentbot-05-architecture.md、README.md、docs/memory/agentbot-project-state.md。` +
    `历史文档（06/08/09）只加一行「已被 12 号规格扩展」的指针，不要重写。`,
});
const docs = await doc.ask<StepResult>(
  `对齐文档：\n` +
    `1. PRD：P0-03（创建不要求路径）、P0-06（群聊工作区）、P0-08/P0-09（四档模式与边界）、P0-13（执行位置改会话工作区）、` +
    `   P0-15（会话配置持久化）、新增 P0-16 会话控制；**把 §8 Out 清单里的「自研 agent loop」移出**（上一轮已落地）\n` +
    `2. UX：F1/F2/F4/F5 相应更新，新增 F7「会话内切换工作区/模型/权限模式」\n` +
    `3. UI：新增「会话设置栏」组件规格、管理员徽标\n` +
    `4. 架构：数据模型新列、cwd 解析顺序、四档×三档矩阵、记忆作用域、压缩与缓存\n` +
    `5. README 与 docs/memory/agentbot-project-state.md 补本轮变更与已知限制`,
);
log(`文档完成：${docs.summary}`);
mark("文档", "完成", docs.summary);

// ===========================================================================
phase("汇总报告");
// ===========================================================================
const allGreen = gi.ok && smoke.exitCode === 0;
await artifact.markdown(
  "report",
  [
    "# 会话控制 + 管理员 Bot 实施报告",
    "",
    `## 结论`,
    allGreen
      ? "五个模块全部落地，集成与端到端冒烟通过。"
      : "实现完成但集成门禁或冒烟未通过，需按下方证据定位。",
    "",
    "## 各阶段",
    `- 考古：4 份（${findings.map((f) => f.scope).join("、")}）`,
    `- 变更规格：${spec.summary}`,
    `- 影响分析：${impact.summary}`,
    `- 地基：${f0.summary}`,
    `- M1 工作区与记忆隔离：${r1.r.summary}`,
    `- M2 模型与权限模式：${r2.r.summary}`,
    `- M3 管理员 Bot：${r3.r.summary}`,
    `- M5 前端：${r5.r.summary}`,
    `- 集成：${integ.summary}`,
    `- 文档：${docs.summary}`,
    "",
    "## 门禁",
    `- 地基：${g0.ok ? "通过" : "失败"}`,
    `- M1：${r1.g.ok ? "通过" : "失败"} / M2：${r2.g.ok ? "通过" : "失败"} / M3：${r3.g.ok ? "通过" : "失败"} / M5：${r5.g.ok ? "通过" : "失败"}`,
    `- 集成：${gi.ok ? "通过" : "失败"}`,
    `- smoke-builtin：exit ${smoke.exitCode}`,
    "",
    "## 独立验收",
    "### 工作区与记忆隔离",
    v1,
    "### 模型与权限模式",
    v2,
    "### 管理员 Bot 与前端",
    v3,
  ].join("\n"),
  {
    title: "会话控制 + 管理员 Bot 实施报告",
    description: "5 个模块的实现结果、门禁、端到端冒烟与三份独立验收。",
    primary: true,
  },
);

return {
  conclusion: allGreen
    ? "会话工作区、会话级记忆隔离、上下文压缩、会话内模型切换、四档权限模式、管理员 Bot、缓存命中率全部落地，四项门禁与端到端冒烟通过。三份独立验收见报告。"
    : "实现完成但集成或冒烟未通过，报告里有各模块门禁结果与验收结论。",
  findings: [
    ...findings.map((f) => ({
      where: `考古 · ${f.scope}`,
      what: `发现 ${f.gaps.length} 处缺口`,
      evidence: f.gaps.slice(0, 3).join("；"),
      status: "verified" as const,
      severity: "low" as const,
    })),
    ...(failedModules.length > 0
      ? failedModules.map((m) => ({
          where: `模块 ${m}`,
          what: "门禁未通过",
          evidence: "见 progress 表与运行日志",
          status: "unconfirmed" as const,
          severity: "high" as const,
        }))
      : []),
  ],
  verified: [
    `tsc -p tsconfig.json --noEmit（每波次都跑）`,
    `check-boundaries.mjs（每波次都跑）`,
    `vue-tsc --noEmit（每波次都跑）`,
    `vitest run（每波次都跑）`,
    `smoke-builtin.mjs：exit ${smoke.exitCode}`,
  ],
  notCovered: [
    "真实 ZCode/Codex 运行时回归（本轮只动内置引擎与会话层，但未跑外部运行时）",
    "迁移 v3 在真实用户库上的执行（只在临时库与单测里验证；真库在下次重启时迁移）",
    "跨设备一致性（同一工作区在两台机器上并发写）",
  ],
};