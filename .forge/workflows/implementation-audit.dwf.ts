// 实现验收审计：逐条核对 R1–R8 是否真的落地，缺口独立复核，门禁用命令说话。

interface Req {
  id: string;
  text: string;
  /** 最该打开看的文件 */
  hint: string;
}

interface ItemVerdict {
  /** 需求编号，R1–R8 */
  id: string;
  /** implemented = 完全实现；partial = 有缺口；missing = 没做 */
  verdict: "implemented" | "partial" | "missing";
  /** 一句话结论 */
  summary: string;
  /** 证据，至少一条 file:line 或命令输出 */
  evidence: string[];
  /** 具体缺口；implemented 时必须为空数组 */
  gaps: string[];
}

interface GapCheck {
  /** 对应需求编号 */
  id: string;
  /** 被复核的缺口原文 */
  gap: string;
  /** 是否在代码里复现 */
  reproduced: boolean;
  /** 复现路径或反证 */
  detail: string;
  /** 对用户的影响 */
  severity: "low" | "medium" | "high";
}

interface GateOutcome {
  name: string;
  exitCode: number;
  tail: string;
}

interface AuditFile {
  /** 报告文件，workspace-relative */
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

const REQS: Req[] = [
  { id: "R1", text: "创建 Bot 不要求项目地址（内置引擎），未设置时卡片显示「未设置默认工作区」", hint: "src/server/http/routes/bots.ts、src/server/core/bots/create.ts、src/web/pages/BotsPage.vue" },
  { id: "R2", text: "会话/群聊指定工作区：回退链 会话 → 渠道 → Bot 默认 → cwd；坏路径明确报错、不要求 git", hint: "src/server/core/process/session-cwd.ts、src/server/http/routes/channels.ts、src/web/pages/ChatPage.vue" },
  { id: "R3", text: "记忆按会话/群聊隔离：作用域 bot/channel/session，装配与摘要按当前渠道过滤", hint: "src/server/core/repo/memory.ts、src/server/core/memory/、src/web/pages/BotDetailPage.vue" },
  { id: "R4", text: "会话内切模型：供应商 + 模型，每轮读取，仅内置引擎，跨协议提示新开会话", hint: "src/server/adapters/channels/builtin/driver.ts、src/server/http/routes/sessions.ts、src/web/pages/ChatPage.vue" },
  { id: "R5", text: "四档权限：confirm/auto/plan/full，输入区胶囊常显、Shift+Tab、生成中可切、plan 拒绝挂起写请求", hint: "src/server/core/permissions/、src/server/adapters/channels/builtin/driver.ts、src/web/components/chat/Composer.vue" },
  { id: "R6", text: "管理员 Bot：role=admin、create_bot 工具、种子、可多个、非管理员不可用", hint: "src/server/core/bots/seed.ts、src/server/core/agent/tools/builtin/create_bot.ts、src/server/http/routes/admin.ts" },
  { id: "R7", text: "上下文压缩：阈值自动触发、手动端点、meta.compaction 入流可感知", hint: "src/server/core/orchestrator/context.ts、src/server/http/routes/sessions.ts、src/web/lib/turnModel.ts" },
  { id: "R8", text: "缓存命中率：openai-chat 与 anthropic 两种协议都读缓存 token，落 usage_records，用量页展示", hint: "src/server/adapters/providers/openai-chat.ts、src/server/adapters/providers/anthropic.ts、src/server/core/usage/、src/web/pages/UsagePage.vue" },
];

artifact.table("verdicts", {
  title: "R1–R8 实现判定",
  columns: [
    { field: "id", label: "需求" },
    { field: "verdict", label: "判定" },
    { field: "gapCount", label: "缺口数" },
  ],
  key: "id",
});

phase("逐条核对 R1–R8");
const items = await Promise.all(
  REQS.map((req) =>
    agent(`核对-${req.id}`, {
      system:
        "你是只读验收员，不许修改任何文件。判定必须落到代码事实：打开函数确认逻辑真的被调用，" +
        "不能只看 grep 命中。implemented 必须给出至少一条 file:line 证据；gaps 只写真实缺口，" +
        "不写改进建议。无法确认的项标 partial 并说明原因。",
    }).ask<ItemVerdict>(
      `在 D:/workspace/Agent WorkSpace/agentbot 核对需求 ${req.id}：${req.text}\n` +
        `先读 .forge/agentbot-11-requirements-align.md 里 ${req.id} 的验收锚点与 §6 相关口径，` +
        `再读 .forge/agentbot-15-change-log-session-control.md 对照实现方声称的落点。\n` +
        `重点打开：${req.hint}\n` +
        `返回 ItemVerdict：id 固定为 ${req.id}；evidence 至少一条 file:line；gaps 没有就返回空数组。`,
    ),
  ),
);
for (const item of items) {
  report({ id: item.id, verdict: item.verdict, gapCount: item.gaps.length }, "verdicts");
  log(`${item.id}：${item.verdict}${item.gaps.length > 0 ? `（${item.gaps.length} 个缺口）` : ""} — ${item.summary}`);
}

phase("独立复核每个缺口");
const gapRefs: Array<{ id: string; gap: string }> = [];
for (const item of items) {
  for (const gap of item.gaps) gapRefs.push({ id: item.id, gap });
}
const checks = await Promise.all(
  gapRefs.map((ref, k) =>
    agent(`复核-${ref.id}-${k}`, {
      system:
        "你是独立复核员，只读，不许修改文件。只凭代码事实判断缺口是否真实存在；" +
        "能写出触发路径或反证都算完成。不要复述原判定，也不要提改进建议。",
    }).ask<GapCheck>(
      `需求 ${ref.id} 的缺口被报告为：「${ref.gap}」\n` +
        `请到 D:/workspace/Agent WorkSpace/agentbot 读相关代码核实：这个缺口真的存在吗？` +
        `存在就给出触发路径（用户做什么会碰到）；不存在就给出反证（file:line 与关键逻辑）。`,
    ),
  ),
);
const reproduced = checks.filter((c) => c.reproduced).length;
log(`复核完成：${checks.length} 个缺口，${reproduced} 个复现，${checks.length - reproduced} 个未复现`);

phase("跑确定性门禁");
const gates: GateOutcome[] = [];
const tsc = await world.run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"]);
gates.push({ name: "tsc", exitCode: tsc.exitCode, tail: (tsc.exitCode === 0 ? tsc.stdout : tsc.stderr).slice(-800) });
log(`tsc exit=${tsc.exitCode}`);
const vueTsc = await world.run("node", ["node_modules/vue-tsc/bin/vue-tsc.js", "-p", "tsconfig.json", "--noEmit"]);
gates.push({ name: "vue-tsc", exitCode: vueTsc.exitCode, tail: (vueTsc.exitCode === 0 ? vueTsc.stdout : vueTsc.stderr).slice(-800) });
log(`vue-tsc exit=${vueTsc.exitCode}`);
const bounds = await world.run("node", ["scripts/check-boundaries.mjs"]);
gates.push({ name: "boundaries", exitCode: bounds.exitCode, tail: (bounds.exitCode === 0 ? bounds.stdout : bounds.stderr).slice(-800) });
log(`boundaries exit=${bounds.exitCode}`);
const unit = await world.run("node", ["node_modules/vitest/vitest.mjs", "run"], { timeoutMs: 600_000 });
gates.push({ name: "vitest", exitCode: unit.exitCode, tail: (unit.exitCode === 0 ? unit.stdout : unit.stderr).slice(-800) });
log(`vitest exit=${unit.exitCode}`);
const smoke = await world.run("node", ["scripts/smoke-builtin.mjs"], { timeoutMs: 600_000 });
gates.push({ name: "smoke-builtin", exitCode: smoke.exitCode, tail: (smoke.exitCode === 0 ? smoke.stdout : smoke.stderr).slice(-1200) });
log(`smoke-builtin exit=${smoke.exitCode}`);

phase("写验收报告并发布");
const writer = agent("审计报告撰写人", {
  system:
    "你只写文档，不改代码。报告只写事实：判定、证据、复核结果、门禁输出。" +
    "缺口按严重度排序；未复现的缺口标「未复现」并保留原文。写中文。",
});
const audit = await writer.ask<AuditFile>(
  `在 D:/workspace/Agent WorkSpace/agentbot 写 .forge/agentbot-16-implementation-audit.md。\n` +
    `输入数据：\n${JSON.stringify({ items, checks, gates })}\n\n` +
    `报告结构：1) 结论（是否全部实现，一句话）；2) R1–R8 表格（编号 | 判定 | 证据 | 缺口）；` +
    `3) 缺口复核清单（复现/未复现、严重度、触发路径）；4) 门禁输出摘要；5) 未覆盖项。\n` +
    `写完后返回 { path, summary }，path 用 workspace-relative 路径。`,
);
try {
  await artifact.file("audit", audit.path, { title: "实现验收审计", primary: true });
} catch {
  const repaired = await writer.ask<AuditFile>(
    `artifact 发布失败：${audit.path} 读不到。请确认文件确实写在该路径，没有就重写到该路径，再返回 { path, summary }。`,
  );
  await artifact.file("audit", repaired.path, { title: "实现验收审计", primary: true });
}

const findings: Finding[] = [];
let k = 0;
for (const item of items) {
  for (const gap of item.gaps) {
    const check = checks[k];
    k += 1;
    findings.push({
      where: item.id,
      what: check !== undefined && check.reproduced ? gap : `${gap}（复核未复现）`,
      evidence: check !== undefined ? check.detail : "未复核",
      status: check !== undefined && check.reproduced ? "verified" : "unconfirmed",
      severity: check !== undefined ? check.severity : "low",
    });
  }
}

const incomplete = items.filter((i) => i.verdict !== "implemented").map((i) => i.id);
const gatesOk = gates.every((g) => g.exitCode === 0);

return {
  conclusion:
    incomplete.length === 0
      ? `R1–R8 全部实现；确定性门禁${gatesOk ? "全绿" : "有失败"}；${reproduced} 个缺口复现。报告：${audit.path}`
      : `有 ${incomplete.length} 条需求未完全实现（${incomplete.join("、")}）；门禁${gatesOk ? "全绿" : "有失败"}。报告：${audit.path}`,
  findings,
  verified: gates.map((g) => `${g.name} exit=${g.exitCode}`),
  notCovered: [
    "只核对内置引擎；CLI / ACP / native 不在本轮范围",
    "冒烟用假网关，未做真实模型的人工交互回归",
    "视觉细节只核对结构与文案，未做像素级比对",
  ],
};
