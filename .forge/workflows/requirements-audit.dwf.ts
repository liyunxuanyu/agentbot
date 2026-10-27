// 需求与代码对齐审计：只读核对，不改任何代码，只产出记录文档。

interface Verdict {
  /** 需求编号，如 R1、G3、§4.1-3 */
  id: string;
  /** 需求原文（一句话） */
  requirement: string;
  /** aligned = 代码已对齐；partial = 部分；missing = 未做；diverged = 代码与需求不一致 */
  status: "aligned" | "partial" | "missing" | "diverged";
  /** 证据：file:line 或命令输出，至少一条 */
  evidence: string[];
  /** 缺口或不一致的具体描述；aligned 时为空 */
  gap: string;
}

interface Confirmation {
  /** 被复核的编号 */
  id: string;
  /** 是否复现了原判定 */
  reproduced: boolean;
  /** 反证或复现路径 */
  detail: string;
}

interface AuditDoc {
  /** workspace-relative 路径 */
  path: string;
  /** 两三句结论 */
  summary: string;
}

interface Finding {
  where: string;
  what: string;
  evidence: string;
  status: "verified" | "unconfirmed";
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  conclusion: string;
  findings: Finding[];
  verified: string[];
  notCovered: string[];
}

const ROOT = "D:/workspace/Agent WorkSpace/agentbot";
const OUT = ".forge/agentbot-17-requirements-audit.md";

/** 本轮要核对的需求分组：一人一组，避免一个人读整个仓库。 */
interface Group {
  key: string;
  /** 用户看得懂的名字 */
  name: string;
  /** 要核对的需求清单（编号 + 一句话） */
  items: { id: string; text: string }[];
  /** 最该打开的文件/目录 */
  focus: string;
}

const GROUPS: Group[] = [
  {
    key: "workspace",
    name: "工作区与会话控制",
    focus: "src/server/core/process/session-cwd.ts、src/server/http/routes/channels.ts、src/server/http/routes/sessions.ts、src/web/pages/ChatPage.vue",
    items: [
      { id: "R1", text: "创建 Bot 不需要项目地址（内置引擎），未设置时显示「未设置默认工作区」" },
      { id: "R2", text: "会话/群聊可指定工作区；回退链 会话 → 渠道 → Bot 默认 → cwd；坏路径明确报错、不要求 git" },
      { id: "R2-b", text: "群聊内所有 Bot 共用同一个工作区" },
      { id: "G7", text: "群聊共用 cwd 时写类工具串行（或明确记录现状）" },
      { id: "G8", text: "工作区校验：存在、是目录、可写，不要求 git" },
    ],
  },
  {
    key: "memory",
    name: "记忆隔离与上下文压缩",
    focus: "src/server/core/repo/memory.ts、src/server/core/memory/、src/server/core/orchestrator/context.ts、src/server/adapters/channels/builtin/driver.ts",
    items: [
      { id: "R3", text: "记忆按 bot/channel/session 三种作用域隔离，同一 Bot 不同会话不串" },
      { id: "G1", text: "历史记忆回填 scope='bot'，老数据行为不变" },
      { id: "R7", text: "上下文压缩：阈值自动触发 + 手动端点 + meta.compaction 入流可感知" },
      { id: "G5", text: "压缩阈值按上下文窗口占用比（默认 70%），摘要用当前会话模型" },
    ],
  },
  {
    key: "model",
    name: "模型切换与能力表",
    focus: "src/server/adapters/channels/builtin/driver.ts、src/server/http/routes/sessions.ts、src/server/adapters/providers/models.ts、src/web/pages/ChatPage.vue、src/web/pages/SettingsPage.vue",
    items: [
      { id: "R4", text: "会话内切供应商 + 模型，只影响后续轮次，仅内置引擎" },
      { id: "G9", text: "会话级模型覆盖存 sessions.provider_id/model，每轮 prompt 重新读取" },
      { id: "R4-b", text: "跨协议切换给出「建议新开会话」提示，不静默转换历史" },
      { id: "R8", text: "缓存命中率：两种协议都读缓存 token，落 usage_records，用量页展示，未上报显示 —" },
      { id: "X1", text: "供应商表单能从 Key 拉模型清单，自动带出上下文窗口与最大输出，可手改" },
      { id: "X2", text: "模型能力表可维护：内置 JSON + 用户覆盖表优先命中" },
    ],
  },
  {
    key: "permission",
    name: "四档权限与管理员",
    focus: "src/server/core/permissions/、src/server/adapters/channels/builtin/driver.ts、src/server/core/agent/tools/、src/server/core/bots/、src/web/components/chat/Composer.vue、src/web/pages/ChatPage.vue",
    items: [
      { id: "R5", text: "四档权限 confirm/auto/plan/full 全部生效" },
      { id: "R5-b", text: "输入区常显权限胶囊，四选一，Shift+Tab 循环，切换不二次确认" },
      { id: "G3", text: "生成中切模式只影响未裁决调用；切 plan 时挂起写请求置 rejected 并插系统块" },
      { id: "R5-c", text: "plan 下写类工具从 tools 列表裁掉，不是调用时才拒" },
      { id: "R6", text: "管理员 = 普通 Bot + role=admin，可多个，create_bot 工具，非管理员不可用" },
      { id: "G4", text: "管理员不自动获得 full 权限；create_bot 本身受四档约束" },
    ],
  },
  {
    key: "data",
    name: "数据整理与会话列表",
    focus: "src/server/http/routes/admin.ts、src/server/http/dto.ts、src/web/pages/SettingsPage.vue",
    items: [
      { id: "X3", text: "数据整理可按类别勾选：channels/orphanSessions/memories/orphanUsage" },
      { id: "X4", text: "默认不删孤儿用量记录（历史账目）" },
      { id: "X5", text: "会话列表过滤掉无在用参与者的 dm/group" },
    ],
  },
];

artifact.table("verdicts", {
  title: "需求对齐核对结果",
  columns: [
    { field: "id", label: "编号" },
    { field: "status", label: "状态" },
  ],
  key: "id",
});

phase("逐组核对需求与代码");
const groups = await Promise.all(
  GROUPS.map((g) =>
    agent(`核对-${g.name}`, {
      system:
        "你是只读审计员，**绝对不许修改任何文件**，也不许运行会改状态的服务或命令。" +
        "判定必须落到代码事实：打开函数确认逻辑真的被调用，不能只看 grep 命中。" +
        "aligned 必须给出至少一条 file:line 证据；gap 只写事实差异，不写改进建议。" +
        "如果需求在代码里找不到，标 missing 并说明你搜了哪些位置。",
    }).ask<Verdict[]>(
      `在 ${ROOT} 核对以下需求是否已在代码中落地：\n` +
        g.items.map((it) => `- ${it.id}：${it.text}`).join("\n") +
        `\n\n先读 .forge/agentbot-11-requirements-align.md 里对应条目的验收锚点，` +
        `再读 .forge/agentbot-15-change-log-session-control.md 对照实现方声称的落点。\n` +
        `重点打开：${g.focus}\n\n` +
        `返回 Verdict 数组，每个需求一条，id 与上面完全一致。`,
    ),
  ),
);

const allVerdicts = groups.flat();
for (const v of allVerdicts) {
  report({ id: v.id, status: v.status }, "verdicts");
}
const counts = {
  aligned: allVerdicts.filter((v) => v.status === "aligned").length,
  partial: allVerdicts.filter((v) => v.status === "partial").length,
  missing: allVerdicts.filter((v) => v.status === "missing").length,
  diverged: allVerdicts.filter((v) => v.status === "diverged").length,
};
log(
  `核对完成：${allVerdicts.length} 条，已对齐 ${counts.aligned}，部分 ${counts.partial}，` +
    `未做 ${counts.missing}，不一致 ${counts.diverged}`,
);

phase("独立复核未对齐的条目");
const suspect = allVerdicts.filter((v) => v.status !== "aligned");
const confirmations = await Promise.all(
  suspect.map((v, k) =>
    agent(`复核-${v.id}-${k}`, {
      system:
        "你是独立复核员，只读，不许修改文件。只凭代码事实判断原判定是否成立；" +
        "能写出触发路径或反证都算完成。不要复述原判定，也不要提改进建议。",
    }).ask<Confirmation>(
      `编号 ${v.id} 被判定为 ${v.status}，理由是：「${v.gap}」\n` +
        `请到 ${ROOT} 读相关代码核实：这个判定成立吗？` +
        `成立就给出用户会怎么碰到的路径；不成立就给出反证（file:line 与关键逻辑）。`,
    ),
  ),
);
const confirmed = confirmations.filter((c) => c.reproduced).length;
log(`复核完成：${confirmations.length} 条待核，${confirmed} 条成立，${confirmations.length - confirmed} 条不成立`);

phase("跑确定性门禁");
const gates: { name: string; exitCode: number }[] = [];
const tsc = await world.run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"]);
gates.push({ name: "tsc", exitCode: tsc.exitCode });
const vueTsc = await world.run("node", ["node_modules/vue-tsc/bin/vue-tsc.js", "-p", "tsconfig.json", "--noEmit"]);
gates.push({ name: "vue-tsc", exitCode: vueTsc.exitCode });
const bounds = await world.run("node", ["scripts/check-boundaries.mjs"]);
gates.push({ name: "boundaries", exitCode: bounds.exitCode });
const unit = await world.run("node", ["node_modules/vitest/vitest.mjs", "run"], { timeoutMs: 600_000 });
gates.push({ name: "vitest", exitCode: unit.exitCode });
for (const g of gates) log(`${g.name} exit=${g.exitCode}`);

phase("写审计记录");
const writer = agent("审计记录撰写人", {
  system:
    "你只写文档，不改代码。记录只写事实：判定、证据、复核结果、门禁退出码。" +
    "未对齐项按状态分组；复核不成立的标「复核未成立」但保留原判定。写中文。",
});
const doc = await writer.ask<AuditDoc>(
  `在 ${ROOT} 写 ${OUT}。\n` +
    `数据：\n${JSON.stringify({ verdicts: allVerdicts, confirmations, gates })}\n\n` +
    `结构：1) 一句话结论；2) 汇总（已对齐/部分/未做/不一致 各几条）；` +
    `3) 逐条表格（编号 | 需求 | 状态 | 证据 | 缺口）；4) 复核结果；5) 门禁退出码；6) 本次未覆盖的范围。\n` +
    `写完后返回 { path, summary }。`,
);
try {
  await artifact.file("audit", doc.path, { title: "需求对齐审计记录", primary: true });
} catch {
  const retry = await writer.ask<AuditDoc>(
    `artifact 发布失败：${doc.path} 读不到。请确认文件确实写在该路径，没有就重写到该路径，再返回 { path, summary }。`,
  );
  await artifact.file("audit", retry.path, { title: "需求对齐审计记录", primary: true });
}

const findings: Finding[] = suspect.map((v, k) => {
  const c = confirmations[k];
  return {
    where: v.id,
    what: v.gap.length > 0 ? v.gap : `${v.status}：${v.requirement}`,
    evidence: c !== undefined ? c.detail : "未复核",
    status: c !== undefined && c.reproduced ? "verified" : "unconfirmed",
    severity: v.status === "missing" ? "high" : v.status === "diverged" ? "high" : "medium",
  };
});

const gatesOk = gates.every((g) => g.exitCode === 0);
return {
  conclusion:
    `共核对 ${allVerdicts.length} 条需求：已对齐 ${counts.aligned}、部分 ${counts.partial}、` +
    `未做 ${counts.missing}、不一致 ${counts.diverged}；复核成立 ${confirmed} 条。` +
    `门禁${gatesOk ? "全绿" : "有失败"}。记录：${doc.path}`,
  findings,
  verified: gates.map((g) => `${g.name} exit=${g.exitCode}`),
  notCovered: [
    "只核对文档里写明的需求；未写进文档的隐含行为不在范围",
    "只做静态代码核对与门禁，未做人工交互回归",
    "CLI / ACP / native 三条通道不在本轮需求范围",
  ],
};
