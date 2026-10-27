<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api, isMissingEndpoint } from "../net/client";
import type {
  BotDto,
  BoundaryDto,
  GrantDto,
  MemoryEntryDto,
  MemoryInjectionDto,
  MemoryScope,
  RuntimeDetailDto,
  SessionDto,
} from "../net/types";
import { useBotsStore } from "../stores/bots";
import { useChannelsStore } from "../stores/channels";
import { useProvidersStore } from "../stores/providers";
import { useRuntimesStore } from "../stores/runtimes";
import { useUiStore } from "../stores/ui";
import { botVars } from "../lib/botVars";
import { clockTime, dateTimeText, dayTimeText, num } from "../lib/format";
import {
  runtimeOptionLabel,
  runtimeReason,
  runtimeUnavailable as isRuntimeUnavailable,
  worktreeIssue,
  worktreeStateWord,
} from "../lib/runtime";
import AppIcon from "../components/common/AppIcon.vue";
import AppModal from "../components/common/AppModal.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import BotStateChip from "../components/bot/BotStateChip.vue";
import CapBadge from "../components/common/CapBadge.vue";
import EmptyState from "../components/common/EmptyState.vue";

/**
 * /bots/:id —— Bot 详情（UX §4.3）。四个标签：概览 / 记忆 / 权限边界 / 会话列表。
 *
 * 四态（每个标签独立，头部立即显示）：
 *   加载 = 标签内容局部骨架（头部用 store 里已有的 Bot 立即渲染，不整页转圈）
 *   错误 = 顶部横幅（运行时不可用 / 读取失败）+ 其余标签仍可编辑
 *   空   = 各标签独立空态（记忆给「新增」、会话给「去发第一条消息」）
 *   正常 = 如上
 *
 * 数据来源（全部是既有端点，不新增读取接口）：
 *   `GET /api/bots/:id`         Bot + 边界 + 预授权
 *   `GET /api/bots/:id/memory`  条目 + 注入估算（全站唯一口径）
 *   `GET /api/channels` + `GET /api/channels/:id`  会话列表（按 botId 过滤）
 *
 * 「会话列表」为什么这样取：没有 `/api/bots/:id/sessions` 端点，而渠道详情里已经
 * 带 `sessions[]`（含 botId / resumeState / messageCount / tokens）。渠道数量是个位数，
 * 逐个拉一遍比新增一个只读端点侵入更小（本轮不允许改后端读取接口）。
 */
const props = defineProps<{ id: string }>();

const router = useRouter();
const bots = useBotsStore();
const channels = useChannelsStore();
const runtimes = useRuntimesStore();
const providers = useProvidersStore();
const ui = useUiStore();

type TabKey = "overview" | "memory" | "boundary" | "sessions";
const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "概览" },
  { key: "memory", label: "记忆" },
  { key: "boundary", label: "权限边界" },
  { key: "sessions", label: "会话列表" },
];
const tab = ref<TabKey>("overview");

// ---------------------------------------------------------------------------
// Bot / 边界
// ---------------------------------------------------------------------------
const bot = ref<BotDto | null>(null);
const boundary = ref<BoundaryDto | null>(null);
const grants = ref<GrantDto[]>([]);
const loading = ref(true);
const loadError = ref("");
const missingBot = ref(false);

const botVarsStyle = computed(() => (bot.value ? botVars(bot.value) : {}));

const runtime = computed<RuntimeDetailDto | null>(() => {
  const id = bot.value?.runtime?.id;
  return id ? (runtimes.find(id) ?? (bot.value?.runtime as RuntimeDetailDto | undefined) ?? null) : null;
});

/** 运行时不可用（P0-02：发送被阻止并给改绑入口）。 */
const runtimeUnavailable = computed(() => isRuntimeUnavailable(runtime.value));

/** 不可用原因：优先后端 probeDetail（如「需要 ≥ 0.20.0，当前 0.1.0」）。 */
const runtimeReasonText = computed(() => runtimeReason(runtime.value));

async function loadBot(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  missingBot.value = false;
  try {
    const res = await api.bot(props.id);
    bot.value = res.bot;
    boundary.value = res.boundary;
    grants.value = res.grants;
    if (!res.bot) missingBot.value = true;
    if (res.boundary) syncBoundaryForm(res.boundary);
  } catch (err) {
    if (isMissingEndpoint(err)) {
      // 端点缺失（M4 之前）：如实显示空态，不伪装成「Bot 不存在」
      bot.value = bots.findBot(props.id) ?? null;
      if (!bot.value) missingBot.value = true;
      return;
    }
    if (err instanceof ApiError && err.status === 404) {
      missingBot.value = true;
      bot.value = null;
      return;
    }
    loadError.value = err instanceof Error ? err.message : "读取 Bot 失败";
    bot.value = bots.findBot(props.id) ?? null;
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------------------
// 人格编辑（P0-03「编辑人格后下一条消息即生效，不重启服务」）
// ---------------------------------------------------------------------------
const personaEditing = ref(false);
const personaDraft = ref("");
const personaSaving = ref(false);
const personaError = ref("");
const personaNotice = ref("");

function startPersonaEdit(): void {
  personaDraft.value = bot.value?.persona ?? "";
  personaError.value = "";
  personaNotice.value = "";
  personaEditing.value = true;
}

function cancelPersonaEdit(): void {
  personaEditing.value = false;
  personaError.value = "";
}

async function savePersona(): Promise<void> {
  if (personaSaving.value) return;
  if (personaDraft.value.length > 4000) {
    personaError.value = `人格最多 4000 个字符（当前 ${personaDraft.value.length}）`;
    return;
  }
  personaSaving.value = true;
  personaError.value = "";
  try {
    // 后端每轮重新读 bots.persona，没有缓存层：保存即生效，无需重启
    await api.patchBot(props.id, { persona: personaDraft.value });
    await loadBot();
    personaEditing.value = false;
    personaNotice.value = "已生效，下一条消息使用新人格";
    ui.toast("人格已保存");
    void bots.load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const field = err.fieldErrors().find((f) => f.field === "persona");
      personaError.value = field?.message ?? err.bodyMessage ?? "保存失败：请求未通过校验";
    } else {
      personaError.value =
        err instanceof ApiError ? (err.bodyMessage ?? `保存失败（${err.code}）`) : "保存失败，请重试";
    }
  } finally {
    personaSaving.value = false;
  }
}

// ---------------------------------------------------------------------------
// 记忆（P0-10）
// ---------------------------------------------------------------------------
const memory = ref<MemoryEntryDto[]>([]);
const injection = ref<MemoryInjectionDto | null>(null);
const memLoading = ref(false);
const memError = ref("");
const memMissing = ref(false);
const editingId = ref<string | null>(null);
const editingText = ref("");
const newOpen = ref(false);
const newText = ref("");
const newScope = ref<MemoryScope>("bot");
const newScopeSessionId = ref("");
const newScopeChannelId = ref("");
const memBusy = ref(false);
const summarizing = ref(false);

/** 记忆作用域标签：全局 / 本群聊 / 本会话（R3）。 */
function memoryScopeText(entry: MemoryEntryDto): string {
  if (entry.scope === "session") return "本会话";
  if (entry.scope === "channel") return "本群聊";
  return "全局";
}

function memoryScopeTitle(entry: MemoryEntryDto): string {
  if (entry.scope === "session") {
    return `只注入来源会话${entry.sourceSessionId ? `（${shortSessionId(entry.sourceSessionId)}）` : ""}`;
  }
  if (entry.scope === "channel") {
    // R3 方案 A：群聊记忆真共享 —— 同群所有 Bot 都能读到，与写入者无关
    return entry.sourceBotId
      ? `由「${entry.sourceBotName ?? entry.sourceBotId}」写入；本群聊里所有 Bot 共享，不进入其它群聊`
      : "本群聊里所有 Bot 共享，不进入其它群聊";
  }
  return "该 Bot 的所有会话都会注入";
}

/** 可选的群聊（去重，来自该 Bot 的 Session 列表）。 */
const memoryChannels = computed(() => {
  const map = new Map<string, string>();
  for (const s of botSessions.value) {
    if (s.channelId && !map.has(s.channelId)) map.set(s.channelId, s.channelName);
  }
  return [...map.entries()].map(([id, name]) => ({ id, name }));
});

function openNewMemory(): void {
  newText.value = "";
  newScope.value = "bot";
  newScopeSessionId.value = botSessions.value[0]?.id ?? "";
  newScopeChannelId.value = memoryChannels.value[0]?.id ?? "";
  newOpen.value = true;
}

async function loadMemory(): Promise<void> {
  memLoading.value = true;
  memError.value = "";
  memMissing.value = false;
  try {
    const res = await api.memory(props.id);
    memory.value = res.entries;
    injection.value = res.injection;
  } catch (err) {
    if (isMissingEndpoint(err)) {
      memMissing.value = true;
      memory.value = [];
      injection.value = null;
      return;
    }
    memError.value = err instanceof Error ? err.message : "读取记忆失败";
  } finally {
    memLoading.value = false;
  }
}

/** 注入估算的展示（全站唯一口径：后端 assemble 的 usedChars / budget）。 */
const injectionText = computed(() => {
  if (!injection.value) return "—";
  return `${num(injection.value.usedChars)} / ${num(injection.value.budget)} 字符`;
});

const injectedCount = computed(() => memory.value.filter((m) => m.injected).length);

async function toggleMemory(entry: MemoryEntryDto): Promise<void> {
  if (memBusy.value) return;
  memBusy.value = true;
  try {
    const res = await api.patchMemory(props.id, entry.id, { injected: !entry.injected });
    const idx = memory.value.findIndex((m) => m.id === entry.id);
    if (idx >= 0 && res.entry) memory.value[idx] = res.entry;
    injection.value = res.injection;
  } catch {
    ui.toast("切换注入开关失败");
  } finally {
    memBusy.value = false;
  }
}

function startEdit(entry: MemoryEntryDto): void {
  editingId.value = entry.id;
  editingText.value = entry.content;
}

async function saveEdit(entry: MemoryEntryDto): Promise<void> {
  const text = editingText.value.trim();
  if (text.length === 0) {
    ui.toast("内容不能为空");
    return;
  }
  memBusy.value = true;
  try {
    const res = await api.patchMemory(props.id, entry.id, { content: text });
    const idx = memory.value.findIndex((m) => m.id === entry.id);
    if (idx >= 0 && res.entry) memory.value[idx] = res.entry;
    injection.value = res.injection;
    editingId.value = null;
    ui.toast("已保存，下一条消息即生效");
  } catch {
    ui.toast("保存失败");
  } finally {
    memBusy.value = false;
  }
}

async function removeMemory(entry: MemoryEntryDto): Promise<void> {
  memBusy.value = true;
  try {
    await api.deleteMemory(props.id, entry.id);
    memory.value = memory.value.filter((m) => m.id !== entry.id);
    await loadMemory();
    ui.toast("已删除 · 只影响后续注入，历史消息不变");
  } catch {
    ui.toast("删除失败");
  } finally {
    memBusy.value = false;
  }
}

async function addMemory(): Promise<void> {
  const text = newText.value.trim();
  if (text.length === 0) {
    ui.toast("内容不能为空");
    return;
  }
  if (newScope.value === "session" && !newScopeSessionId.value) {
    ui.toast("选一个会话，或改为全局记忆");
    return;
  }
  if (newScope.value === "channel" && !newScopeChannelId.value) {
    ui.toast("选一个群聊，或改为全局记忆");
    return;
  }
  memBusy.value = true;
  try {
    const res = await api.createMemory(props.id, {
      content: text,
      ...(newScope.value === "session"
        ? { scope: "session" as const, sourceSessionId: newScopeSessionId.value }
        : {}),
      ...(newScope.value === "channel"
        ? { scope: "channel" as const, channelId: newScopeChannelId.value }
        : {}),
    });
    if (res.entry) memory.value = [...memory.value, res.entry];
    injection.value = res.injection;
    newText.value = "";
    newOpen.value = false;
    ui.toast("已新增，下一条消息即生效");
  } catch {
    ui.toast("新增失败");
  } finally {
    memBusy.value = false;
  }
}

async function summarizeNow(): Promise<void> {
  if (summarizing.value) return;
  summarizing.value = true;
  try {
    const res = await api.summarizeMemory(props.id);
    if (res.ok) {
      ui.toast(`已生成摘要（${num(res.chars)} 字符）`);
    } else if (res.reason === "runtime_unavailable" || res.reason) {
      // 运行时不可用不是错误：待摘要标记保留，下次会话前重试（P0-10 边界）
      ui.toast("运行时当前不可用，摘要已排队，下次会话开始前重试");
    } else {
      ui.toast("摘要未生成");
    }
    await loadMemory();
  } catch (err) {
    if (err instanceof ApiError && err.code === "no_session") {
      ui.toast("这个 Bot 还没有会话，先发一条消息再摘要");
    } else {
      ui.toast("摘要失败，稍后重试");
    }
  } finally {
    summarizing.value = false;
  }
}

// ---------------------------------------------------------------------------
// 权限边界（P0-09 / P0-13）
// ---------------------------------------------------------------------------
const boundaryForm = reactive({
  dirsText: "",
  allowShell: false,
  allowNetwork: false,
  autoApproveWrite: false,
  location: "local" as "local" | "worktree",
  repoPath: "",
});
const boundaryErrors = reactive<{ dirs: string[]; repo: string; general: string }>({
  dirs: [],
  repo: "",
  general: "",
});
const savingBoundary = ref(false);

function syncBoundaryForm(b: BoundaryDto): void {
  boundaryForm.dirsText = b.allowDirs.join("\n");
  boundaryForm.allowShell = b.allowShell;
  boundaryForm.allowNetwork = b.allowNetwork;
  boundaryForm.autoApproveWrite = b.autoApproveWrite;
  boundaryForm.location = bot.value?.executionLocation ?? "local";
  boundaryForm.repoPath = "";
}

const dirsDirty = computed(() => {
  if (!boundary.value) return false;
  const current = boundary.value.allowDirs.join("\n");
  return current !== boundaryForm.dirsText;
});

const boundaryDirty = computed(
  () =>
    dirsDirty.value ||
    (boundary.value !== null &&
      (boundaryForm.allowShell !== boundary.value.allowShell ||
        boundaryForm.allowNetwork !== boundary.value.allowNetwork ||
        boundaryForm.autoApproveWrite !== boundary.value.autoApproveWrite)),
);

function resetBoundaryErrors(): void {
  boundaryErrors.dirs = [];
  boundaryErrors.repo = "";
  boundaryErrors.general = "";
}

/** 一次保存：边界三项 + 执行位置（位置改动会触发 requiresWorktree 二次确认）。 */
async function saveBoundary(): Promise<void> {
  if (savingBoundary.value) return;
  resetBoundaryErrors();
  savingBoundary.value = true;

  const dirs = boundaryForm.dirsText
    .split("\n")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  const patch: Parameters<typeof api.patchBot>[1] = {
    allowDirs: dirs,
    allowShell: boundaryForm.allowShell,
    allowNetwork: boundaryForm.allowNetwork,
    autoApproveWrite: boundaryForm.autoApproveWrite,
  };

  const locationChanged = bot.value && boundaryForm.location !== bot.value.executionLocation;
  const repoTrimmed = boundaryForm.repoPath.trim();
  if (locationChanged || (boundaryForm.location === "worktree" && repoTrimmed.length > 0)) {
    patch.executionLocation = boundaryForm.location;
    if (repoTrimmed.length > 0) patch.repoPath = repoTrimmed;
  }

  await submitPatch(patch, false);
  savingBoundary.value = false;
}

/**
 * 提交 PATCH；`risk_confirmation_required` 时弹二次确认。
 *
 * 安全底线（用户裁定）：把「不提供权限请求」的运行时放到 local，产品层无法拦截
 * 文件写入 —— 必须让用户看着后端给的风险原文点一次确认，再带 `confirmRisk:true` 重发。
 * 这里**不使用自己编的文案**：风险说明由后端 `worktreeRiskMessage()` 生成。
 */
async function submitPatch(
  patch: Parameters<typeof api.patchBot>[1],
  confirmed: boolean,
): Promise<void> {
  try {
    const res = await api.patchBot(props.id, confirmed ? { ...patch, confirmRisk: true } : patch);
    boundary.value = res.boundary;
    if (res.boundary) syncBoundaryForm(res.boundary);
    await loadBot();
    ui.toast("已保存");
  } catch (err) {
    if (err instanceof ApiError && err.code === "risk_confirmation_required") {
      riskMessage.value = err.messageText() ?? "该运行时不提供权限请求，无法拦截文件写入。";
      pendingRiskPatch.value = patch;
      riskOpen.value = true;
      return;
    }
    if (err instanceof ApiError && err.status === 400) {
      const fields = err.fieldErrors();
      boundaryErrors.dirs = fields.filter((f) => f.field === "allowDirs").map((f) => f.message);
      boundaryErrors.repo = fields.find((f) => f.field === "repoPath")?.message ?? "";
      if (boundaryErrors.dirs.length === 0 && !boundaryErrors.repo) {
        boundaryErrors.general = err.messageText() ?? "保存失败：请求未通过校验。";
      }
      return;
    }
    boundaryErrors.general = err instanceof Error ? `保存失败：${err.message}` : "保存失败";
  }
}

const riskOpen = ref(false);
const riskMessage = ref("");
const pendingRiskPatch = ref<Parameters<typeof api.patchBot>[1] | null>(null);

async function confirmRisk(): Promise<void> {
  const patch = pendingRiskPatch.value;
  riskOpen.value = false;
  if (!patch) return;
  savingBoundary.value = true;
  await submitPatch(patch, true);
  savingBoundary.value = false;
  pendingRiskPatch.value = null;
}

// ---- 写操作自动批准（二次确认 + 风险文案）----
const autoApproveConfirmOpen = ref(false);

function askAutoApprove(): void {
  if (boundaryForm.autoApproveWrite) {
    // 关闭不需要确认
    boundaryForm.autoApproveWrite = false;
    void saveBoundary();
    return;
  }
  autoApproveConfirmOpen.value = true;
}

function confirmAutoApprove(): void {
  autoApproveConfirmOpen.value = false;
  boundaryForm.autoApproveWrite = true;
  void saveBoundary();
}

// ---- 改绑运行时（P0-02 / F5）----
const rebindOpen = ref(false);
const rebindTarget = ref("");
const rebindProvider = ref("");
const rebindError = ref("");

const rebindCandidates = computed(() => runtimes.runtimes);
const rebindIsBuiltin = computed(
  () => runtimes.find(rebindTarget.value)?.protocol === "builtin",
);
const currentProvider = computed(() => providers.find(bot.value?.providerId));

const rebindDiff = computed(() => {
  const from = runtime.value;
  const to = runtimes.find(rebindTarget.value);
  if (!to) return { gain: [] as string[], loss: [] as string[] };
  const keys = [
    ["plan", "计划"],
    ["permission", "权限请求"],
    ["resume", "续接（resume）"],
  ] as const;
  const gain: string[] = [];
  const loss: string[] = [];
  for (const [key, label] of keys) {
    const before = from?.capabilities?.[key] ?? null;
    const after = to.capabilities[key];
    if (after === true && before !== true) gain.push(label);
    if (before === true && after !== true) loss.push(label);
  }
  return { gain, loss };
});

function openRebind(): void {
  rebindTarget.value = runtime.value?.id ?? "";
  rebindProvider.value = bot.value?.providerId ?? providers.defaultId ?? "";
  rebindError.value = "";
  rebindOpen.value = true;
  if (providers.providers.length === 0) void providers.load();
}

async function confirmRebind(): Promise<void> {
  const sameRuntime = !rebindTarget.value || rebindTarget.value === runtime.value?.id;
  const sameProvider = !rebindIsBuiltin.value || rebindProvider.value === (bot.value?.providerId ?? "");
  if (sameRuntime && sameProvider) {
    rebindOpen.value = false;
    return;
  }
  rebindError.value = "";
  try {
    const res = await api.patchBot(props.id, {
      ...(sameRuntime ? {} : { runtimeId: rebindTarget.value }),
      ...(rebindIsBuiltin.value ? { providerId: rebindProvider.value || null } : {}),
    });
    rebindOpen.value = false;
    boundary.value = res.boundary;
    await loadBot();
    void bots.load();
    ui.toast(sameRuntime ? "模型供应商已更新" : "已改绑 · 人格与记忆保留，新 Session 开始");
  } catch (err) {
    if (err instanceof ApiError && err.code === "risk_confirmation_required") {
      // 改绑后当前执行位置是 local 且新运行时不提供权限请求：走风险确认
      rebindOpen.value = false;
      riskMessage.value = err.messageText() ?? "";
      pendingRiskPatch.value = { runtimeId: rebindTarget.value };
      riskOpen.value = true;
      return;
    }
    rebindError.value =
      err instanceof ApiError ? (err.messageText() ?? `改绑失败（${err.code}）`) : "改绑失败";
  }
}

// ---------------------------------------------------------------------------
// 会话列表（由渠道详情汇总）
// ---------------------------------------------------------------------------
interface BotSessionRow extends SessionDto {
  channelName: string;
}

const botSessions = ref<BotSessionRow[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref("");
const sessionsMissing = ref(false);

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  sessionsError.value = "";
  sessionsMissing.value = false;
  try {
    if (channels.channels.length === 0) await channels.load();
    const mine = channels.channels.filter((c) => c.participantBotIds.includes(props.id));
    const rows: BotSessionRow[] = [];
    for (const c of mine) {
      try {
        const detail = await api.channel(c.id);
        for (const s of detail.sessions) {
          if (s.botId === props.id) rows.push({ ...s, channelName: detail.channel.name });
        }
      } catch (err) {
        if (!isMissingEndpoint(err)) throw err;
        sessionsMissing.value = true;
      }
    }
    rows.sort((a, b) => b.startedAt - a.startedAt);
    botSessions.value = rows;
  } catch (err) {
    sessionsError.value = err instanceof Error ? err.message : "读取会话失败";
  } finally {
    sessionsLoading.value = false;
  }
}

const RESUME_WORD: Record<string, string> = {
  resumed: "已续接上下文",
  rebuilt: "已重建上下文",
  fresh: "新 Session",
};

// ---------------------------------------------------------------------------
// 记忆「来源会话」（P0-10）
// ---------------------------------------------------------------------------
function shortSessionId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/** 记忆条目只记 sessionId；渠道要从已加载的 Bot Session 列表反查。 */
function sessionChannelOf(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return botSessions.value.find((s) => s.id === sessionId)?.channelId ?? null;
}

/** 跳转到该会话的只读视图（与 Session 列表的「只读打开」同一 URL 契约）。 */
function openMemorySession(entry: MemoryEntryDto): void {
  const sessionId = entry.sourceSessionId;
  if (!sessionId) return;
  const channelId = sessionChannelOf(sessionId);
  if (!channelId) return;
  void router.push(`/chat/${channelId}?session=${encodeURIComponent(sessionId)}`);
}

// ---------------------------------------------------------------------------
// 进入会话 / 危险区
// ---------------------------------------------------------------------------
const opening = ref(false);

async function openChat(): Promise<void> {
  if (!bot.value || opening.value) return;
  opening.value = true;
  try {
    const id = await channels.openDm(bot.value.id);
    void router.push(`/chat/${id}`);
  } catch {
    ui.toast("打开会话失败，请稍后再试");
  } finally {
    opening.value = false;
  }
}

// ---------------------------------------------------------------------------
// worktree 重试（P0-13）
// ---------------------------------------------------------------------------
const retryingWorktree = ref(false);

const worktreeProblem = computed(() => worktreeIssue(bot.value));

/** 只有真的配在 worktree（或被运行时强制 worktree）时才给重建入口。 */
const canRetryWorktree = computed(() => {
  const b = bot.value;
  if (!b || !b.worktreeState || b.worktreeState === "ready") return false;
  return b.executionLocation === "worktree" || runtime.value?.requiresWorktree === true;
});

/**
 * 重新创建 worktree。
 *
 * 后端没有独立的重建端点，但 PATCH 执行位置会重新跑 `ensureWorktreeForBot`
 * （`executionLocation: "worktree"` 且不带 repoPath → 沿用已保存的仓库根）。
 * 需要新端点的话写进「待确认」，这里不自己加后端。
 */
async function retryWorktree(): Promise<void> {
  if (retryingWorktree.value) return;
  retryingWorktree.value = true;
  try {
    const res = await api.patchBot(props.id, { executionLocation: "worktree" });
    const state = res.execution?.worktreeState ?? null;
    await loadBot();
    void bots.load();
    ui.toast(
      state === "ready"
        ? "worktree 已创建"
        : "worktree 仍未就绪：请检查仓库根路径、磁盘空间与目录权限",
    );
  } catch (err) {
    if (err instanceof ApiError) {
      const fieldText = err.fieldErrors().map((f) => f.message).join("；");
      ui.toast(
        err.bodyMessage ?? (fieldText.length > 0 ? fieldText : `创建失败（${err.code}）`),
      );
    } else {
      ui.toast("创建 worktree 失败，请重试");
    }
  } finally {
    retryingWorktree.value = false;
  }
}

// ---------------------------------------------------------------------------
// 删除 Bot（P0-03）
// ---------------------------------------------------------------------------
const deleteOpen = ref(false);
const deleteName = ref("");
const deleteMode = ref<"cascade" | "archive" | "">("");
const deleteError = ref("");
const deleting = ref(false);

function openDelete(): void {
  deleteName.value = "";
  deleteMode.value = "";
  deleteError.value = "";
  deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  if (deleting.value || !bot.value) return;

  // 名称必须完全一致（后端同样不做 trim/大小写宽容）
  if (deleteName.value !== bot.value.name) {
    deleteError.value = "名称不一致";
    return;
  }
  if (deleteMode.value === "") {
    deleteError.value = "请选择删除方式";
    return;
  }

  const name = bot.value.name;
  const mode = deleteMode.value;
  deleting.value = true;
  deleteError.value = "";
  try {
    const res = await api.deleteBot(props.id, { confirmName: deleteName.value, mode });
    deleteOpen.value = false;
    bots.remove(props.id);
    const kept = res.usageRecordsKept ?? 0;
    ui.toast(
      mode === "archive"
        ? `已归档「${name}」`
        : `已删除「${name}」${kept > 0 ? ` · 用量记录保留 ${kept} 条` : ""}`,
    );
    void bots.load();
    void channels.load();
    await router.push("/bots");
  } catch (err) {
    if (err instanceof ApiError && err.code === "name_mismatch") {
      deleteError.value = "名称不一致";
      return;
    }
    deleteError.value =
      err instanceof ApiError ? (err.bodyMessage ?? `删除失败（${err.code}）`) : "删除失败，请重试";
  } finally {
    deleting.value = false;
  }
}

watch(tab, (next) => {
  if (next === "memory" && memory.value.length === 0 && !memLoading.value) void loadMemory();
  if (next === "sessions" && botSessions.value.length === 0 && !sessionsLoading.value) {
    void loadSessions();
  }
});

onMounted(async () => {
  ui.setCrumb([{ text: "Bot", to: "/bots" }]);
  if (bots.bots.length === 0) void bots.load();
  if (runtimes.runtimes.length === 0) void runtimes.load();
  if (providers.providers.length === 0) void providers.load();
  await loadBot();
  if (bot.value) ui.setCrumb([{ text: "Bot", to: "/bots" }, { text: bot.value.name }]);
  void loadMemory();
  void loadSessions();
});

void grants;
</script>

<template>
  <!-- Bot 不存在（端点已实现且 404） -->
  <div v-if="missingBot && !loading" style="padding: var(--space-4) 0">
    <EmptyState title="没有这个 Bot" description="它可能已被删除，或者链接里的 id 不对。">
      <template #icon><AppIcon name="bots" :size="24" /></template>
      <template #actions>
        <RouterLink class="btn btn--secondary" to="/bots">返回 Bot 列表</RouterLink>
      </template>
    </EmptyState>
  </div>

  <div v-else>
    <!-- 页头：身份区立即渲染（用 store 里已有的 Bot 兜底，不等详情返回） -->
    <div class="page-head enter" :style="{ '--i': 0 }">
      <div class="detail-head" :style="botVarsStyle">
        <BotAvatar
          :name="bot?.name ?? 'Bot'"
          :color-index="bot?.colorIndex ?? 8"
          :avatar="bot?.avatar ?? null"
          :size="48"
        />
        <div>
          <h1 class="detail-title">
            {{ bot?.name ?? "读取中…" }}
            <span v-if="bot?.role === 'admin'" class="cap cap--scope" title="管理员：多一个 create_bot 工具">
              管理员
            </span>
          </h1>
          <p class="detail-sub">{{ bot?.persona || "还没有写人格。" }}</p>
          <div class="detail-meta">
            <span v-if="runtime" class="rt-chip">
              {{ runtime.displayName }}<template v-if="runtime.protocol"> · {{ runtime.protocol }}</template>
            </span>
            <span v-else class="rt-chip">未绑定运行时</span>
            <span v-if="runtime?.protocol === 'builtin'" class="rt-chip">
              供应商 · {{ currentProvider?.name ?? "默认" }}
            </span>
            <BotStateChip v-if="bot" :state="bot.state" decay />
            <span v-if="bot" class="u-mono" style="color: var(--color-text-muted)">
              {{ bot.executionLocation }} · {{ bot.effectivePath ?? "未设置默认工作区" }}
            </span>
          </div>
        </div>
      </div>
      <div class="page-actions">
        <button class="btn btn--secondary" @click="openRebind">改绑运行时</button>
        <button class="btn btn--primary" :disabled="opening" @click="openChat">
          {{ opening ? "打开中…" : "进入会话" }}
        </button>
      </div>
    </div>

    <div class="tabs enter" :style="{ '--i': 1 }">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab"
        :class="{ 'is-on': tab === t.key }"
        :aria-selected="tab === t.key"
        role="tab"
        @click="tab = t.key"
      >{{ t.label }}</button>
    </div>

    <!-- 错误横幅：运行时不可用（其余标签仍可编辑） -->
    <div v-if="runtimeUnavailable && !loading" class="banner">
      <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
      <span>
        运行时不可用：{{ runtimeReasonText }}<template v-if="runtime">（{{ runtime.displayName }}）</template>。
        发送会被阻止，其余标签仍可编辑。
      </span>
      <span class="spacer" />
      <button class="btn btn--sm" @click="openRebind">改绑运行时</button>
    </div>

    <div v-if="loadError" class="banner">
      <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
      <span>读取 Bot 详情失败：{{ loadError }}</span>
      <span class="spacer" />
      <button class="btn btn--sm" @click="loadBot">重试</button>
    </div>

    <!-- 加载态：标签内容局部骨架 -->
    <div v-if="loading" style="display: grid; gap: 16px; max-width: 720px">
      <div v-for="w in ['60%', '80%', '40%', '70%']" :key="w" class="sk" :style="{ height: '28px', width: w }" />
    </div>

    <!-- ================= 概览 ================= -->
    <div v-else-if="tab === 'overview'" class="detail-grid">
      <div>
        <section class="card card-pad enter" :style="{ '--i': 2, marginBottom: '24px' }">
          <div class="u-label" style="margin-bottom: 14px">能力（来自运行时上报）</div>
          <div v-if="runtime" class="cap-row" style="gap: 20px">
            <span class="cap-pair"><span class="cap-name">plan</span><CapBadge :value="runtime.capabilities.plan" /></span>
            <span class="cap-pair"><span class="cap-name">permission</span><CapBadge :value="runtime.capabilities.permission" /></span>
            <span class="cap-pair"><span class="cap-name">resume</span><CapBadge :value="runtime.capabilities.resume" /></span>
            <span class="cap-pair">
              <span class="cap-name">上下文</span>
              <span class="u-mono" style="color: var(--color-text-secondary)">
                {{ runtime.capabilities.contextWindow ? num(runtime.capabilities.contextWindow) : "—" }}
              </span>
            </span>
          </div>
          <p v-else class="hint">还没有绑定运行时，能力未知。</p>
          <p v-if="runtime && runtime.capabilities.plan === null" class="hint">
            该运行时没有上报能力清单。未知 ≠ 不支持：它的流里只会出现实际产出的事件类型。
          </p>
        </section>

        <section class="card card-pad enter" :style="{ '--i': 3, marginBottom: '24px' }">
          <div class="u-label" style="margin-bottom: 12px">当前 Session</div>
          <div class="kv"><span class="k">状态</span><span class="v"><BotStateChip v-if="bot" :state="bot.state" /></span></div>
          <div class="kv">
            <span class="k">续接</span>
            <span class="v">{{ botSessions[0] ? RESUME_WORD[botSessions[0].resumeState] : "还没有会话" }}</span>
          </div>
          <div class="kv">
            <span class="k">开始</span>
            <span class="v">{{ botSessions[0] ? dateTimeText(botSessions[0].startedAt) : "—" }}</span>
          </div>
          <div class="kv">
            <span class="k">用量</span>
            <span class="v">
              <template v-if="botSessions[0]">
                {{ botSessions[0].tokensIn == null ? "— 未上报" : `${num(botSessions[0].tokensIn)} in / ${num(botSessions[0].tokensOut)} out` }}
              </template>
              <template v-else>—</template>
            </span>
          </div>
          <div class="kv">
            <span class="k">执行位置</span>
            <span class="v">
              {{ bot?.executionLocation ?? "—" }} · {{ bot?.effectivePath ?? "未设置默认工作区" }}
            </span>
          </div>
          <div class="kv">
            <span class="k">worktree</span>
            <span class="v" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
              <span
                :style="{
                  color:
                    bot?.worktreeState === 'failed'
                      ? 'var(--color-danger-ink)'
                      : bot?.worktreeState === 'missing'
                        ? 'var(--color-warning-ink)'
                        : undefined,
                }"
              >{{ worktreeStateWord(bot?.worktreeState ?? null) }}<span
                  v-if="bot?.worktreeState"
                  class="u-mono"
                  style="font-size: 11px; color: var(--color-text-muted)"
                >({{ bot.worktreeState }})</span></span>
              <button
                v-if="canRetryWorktree"
                class="btn btn--sm btn--secondary"
                :disabled="retryingWorktree"
                @click="retryWorktree"
              >{{ retryingWorktree ? "创建中…" : "重新创建 worktree" }}</button>
            </span>
          </div>
          <div
            v-if="worktreeProblem"
            class="hint"
            :style="{
              color:
                bot?.worktreeState === 'failed'
                  ? 'var(--color-danger-ink)'
                  : 'var(--color-warning-ink)',
            }"
          >{{ worktreeProblem }}</div>
        </section>

        <section class="card card-pad enter" :style="{ '--i': 4 }">
          <div class="u-label" style="margin-bottom: 8px">最近会话</div>
          <div v-if="botSessions.length > 0" class="rows">
            <button
              v-for="s in botSessions.slice(0, 3)"
              :key="s.id"
              class="row-item"
              @click="router.push(`/chat/${s.channelId}?session=${s.id}`)"
            >
              <div class="row-main">
                <div class="row-title">
                  {{ dayTimeText(s.startedAt) }}
                  <span class="rt-chip">{{ RESUME_WORD[s.resumeState] }}</span>
                </div>
                <div class="row-sub">{{ s.channelName }}</div>
              </div>
              <span class="cell-num u-muted">{{ s.messageCount }} 条</span>
              <span class="cell-num u-muted">
                {{ s.tokensIn == null ? "—" : `${num((s.tokensIn ?? 0) + (s.tokensOut ?? 0))}` }}
              </span>
            </button>
          </div>
          <p v-else class="hint">还没有会话。发第一条消息后，这里会出现 Session 记录。</p>
        </section>
      </div>

      <aside style="display: grid; gap: 16px">
        <section class="card card-pad">
          <div class="u-label" style="margin-bottom: 8px">人格</div>
          <template v-if="personaEditing">
            <textarea
              v-model="personaDraft"
              class="textarea"
              rows="5"
              placeholder="写这个 Bot 的身份、职责与说话方式。"
            />
            <div class="hint" style="display: flex; gap: 8px">
              <span>{{ personaDraft.length }} / 4000 字符</span>
              <span class="spacer" />
              <span>保存后下一条消息即生效</span>
            </div>
            <div v-if="personaError" class="field-err" role="alert">{{ personaError }}</div>
            <div style="display: flex; gap: 8px; margin-top: 10px">
              <button class="btn btn--sm btn--primary" :disabled="personaSaving" @click="savePersona">
                {{ personaSaving ? "保存中…" : "保存" }}
              </button>
              <button class="btn btn--sm btn--secondary" :disabled="personaSaving" @click="cancelPersonaEdit">
                取消
              </button>
            </div>
          </template>
          <template v-else>
            <p style="font-size: var(--font-size-body-sm); color: var(--color-text-secondary); line-height: 1.7">
              {{ bot?.persona || "还没有写人格。人格会随每条消息注入，换运行时不丢。" }}
            </p>
            <p v-if="personaNotice" class="hint" style="color: var(--color-success-ink)">
              {{ personaNotice }}
            </p>
            <button class="btn btn--sm btn--ghost" style="margin-top: 10px" @click="startPersonaEdit">
              编辑
            </button>
            <p class="hint">人格随每条消息注入；编辑后下一条消息即生效，不需要重启。</p>
          </template>
        </section>
        <section class="card card-pad" style="box-shadow: inset 0 0 0 1px var(--color-danger-soft), var(--shadow-card)">
          <div class="u-label" style="margin-bottom: 8px; color: var(--color-danger-ink)">危险区</div>
          <p style="font-size: var(--font-size-caption); color: var(--color-text-muted); line-height: 1.7; margin-bottom: 12px">
            删除需要输入 Bot 名称，并选择会话与记忆的处理方式。worktree 不会被自动删除。
          </p>
          <button class="btn btn--sm btn--danger" @click="openDelete">删除这个 Bot</button>
          <p class="hint">需要输入名称二次确认，并显式选择「一并删除」或「归档保留」。</p>
        </section>
      </aside>
    </div>

    <!-- ================= 记忆 ================= -->
    <div v-else-if="tab === 'memory'" class="detail-grid">
      <div>
        <div class="filters" style="min-height: auto">
          <span class="u-label">本轮注入估算</span>
          <span class="u-mono" style="color: var(--color-text-secondary)">{{ injectionText }}</span>
          <span class="spacer" />
          <button class="btn btn--sm btn--secondary" :disabled="summarizing" @click="summarizeNow">
            {{ summarizing ? "摘要中…" : "立即摘要" }}
          </button>
          <button class="btn btn--sm btn--primary" @click="openNewMemory">新增</button>
        </div>

        <div v-if="memLoading" style="display: grid; gap: 10px; margin-top: 12px">
          <div v-for="w in ['92%', '78%', '85%']" :key="w" class="sk" :style="{ height: '52px', width: w }" />
        </div>

        <div v-else-if="memError" class="banner">
          <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
          <span>读取记忆失败：{{ memError }}</span>
          <span class="spacer" />
          <button class="btn btn--sm" @click="loadMemory">重试</button>
        </div>

        <div v-else-if="memMissing" class="empty">
          <div class="empty-icon"><AppIcon name="bots" :size="24" /></div>
          <h3>记忆端点尚未接入</h3>
          <p>这个版本的后端没有提供记忆接口，页面不显示假数据。</p>
        </div>

        <div v-else-if="memory.length === 0">
          <EmptyState title="还没有记忆条目" description="记忆条目跨 Session 保留，换运行时不丢。">
            <template #icon><AppIcon name="bots" :size="24" /></template>
            <template #actions>
              <button class="btn btn--primary" @click="openNewMemory">新增记忆</button>
            </template>
          </EmptyState>
        </div>

        <div v-else style="margin-top: 4px">
          <div v-for="m in memory" :key="m.id" class="mem-item">
            <button
              class="switch"
              :class="{ 'is-on': m.injected }"
              :aria-pressed="m.injected"
              :aria-label="m.injected ? '取消注入这条记忆' : '注入这条记忆'"
              @click="toggleMemory(m)"
            />
            <div style="flex: 1; min-width: 0">
              <template v-if="editingId === m.id">
                <textarea v-model="editingText" class="textarea" rows="3" />
                <div style="display: flex; gap: 8px; margin-top: 8px">
                  <button class="btn btn--sm btn--primary" :disabled="memBusy" @click="saveEdit(m)">保存</button>
                  <button class="btn btn--sm btn--secondary" @click="editingId = null">取消</button>
                </div>
              </template>
              <template v-else>
                <div class="mem-text">{{ m.content }}</div>
                <div class="mem-meta">
                  <span
                    class="cap"
                    :class="m.scope === 'bot' ? 'cap--no' : 'cap--scope'"
                    :title="memoryScopeTitle(m)"
                  >{{ memoryScopeText(m) }}</span>
                  <span v-if="m.sourceBotId" class="cap cap--scope" title="这条群聊记忆由同群的另一个 Bot 写入，本 Bot 同样会注入">
                    来自 {{ m.sourceBotName ?? "同群 Bot" }}
                  </span>
                  <span>来源 {{ m.source === "auto" ? "自动摘要" : "手写" }}</span>
                  <span>
                    来源会话
                    <button
                      v-if="m.sourceSessionId && sessionChannelOf(m.sourceSessionId)"
                      class="mem-session"
                      :title="m.sourceSessionId"
                      @click="openMemorySession(m)"
                    >{{ shortSessionId(m.sourceSessionId) }}</button>
                    <span v-else-if="m.sourceSessionId" class="u-mono" :title="m.sourceSessionId">
                      {{ shortSessionId(m.sourceSessionId) }}
                    </span>
                    <span v-else>—</span>
                  </span>
                  <span>{{ dayTimeText(m.updatedAt) }}</span>
                  <span v-if="m.kind === 'summary'" class="cap cap--no">自动摘要</span>
                  <span class="spacer" />
                  <button class="btn btn--sm btn--ghost" @click="startEdit(m)">编辑</button>
                  <button class="btn btn--sm btn--ghost" @click="removeMemory(m)">删除</button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <aside>
        <section class="card card-pad">
          <div class="u-label" style="margin-bottom: 8px">注入规则</div>
          <p style="font-size: var(--font-size-caption); color: var(--color-text-muted); line-height: 1.8">
            人格 + 标记注入的记忆，总字符不超过
            {{ injection ? num(injection.budget) : "6,000" }}；超出按更新时间倒序截断，
            并在会话里显示「已截断 N 条」。当前注入 {{ injectedCount }} 条。
          </p>
          <div v-if="injection && injection.truncatedCount > 0" class="hint" style="color: var(--color-warning-ink)">
            本轮已截断 {{ injection.truncatedCount }} 条（超出预算）。
          </div>
          <div v-if="injection" class="kv" style="margin-top: 10px">
            <span class="k">人格占用</span>
            <span class="v u-mono">{{ num(injection.personaChars) }} 字符</span>
          </div>
        </section>
      </aside>
    </div>

    <!-- ================= 权限边界 ================= -->
    <div v-else-if="tab === 'boundary'" class="detail-grid">
      <div>
        <section class="card card-pad" style="margin-bottom: 24px">
          <div class="u-label" style="margin-bottom: 10px">允许目录（每行一个绝对路径）</div>
          <textarea
            v-model="boundaryForm.dirsText"
            class="textarea u-mono"
            rows="4"
            placeholder="例如：&#10;D:/workspace/project&#10;D:/workspace/project/docs"
          />
          <div v-for="(e, i) in boundaryErrors.dirs" :key="i" class="field-err">{{ e }}</div>
          <p class="hint">目录不存在或不可写会在保存时报错；相对路径先解析为绝对路径再判定。</p>

          <div class="u-label" style="margin: 20px 0 10px">工具</div>
          <div class="cap-row" style="gap: 20px">
            <label class="radio">
              <input type="checkbox" v-model="boundaryForm.allowShell" style="accent-color: var(--color-primary)" />
              Shell 允许执行命令
            </label>
            <label class="radio">
              <input type="checkbox" v-model="boundaryForm.allowNetwork" style="accent-color: var(--color-primary)" />
              联网
            </label>
          </div>
          <p class="hint">
            Shell 不做命令解析，只用这个布尔值 —— 写一个会被绕过的正则比不做更危险。
            完整命令交给人看卡片判断。
          </p>

          <div class="u-label" style="margin: 20px 0 10px">执行位置</div>
          <div class="radio-row">
            <label class="radio">
              <input
                type="radio"
                name="bd-loc"
                value="local"
                :checked="boundaryForm.location === 'local'"
                @change="boundaryForm.location = 'local'"
              />
              local · 直接在工作目录执行
            </label>
            <label class="radio">
              <input
                type="radio"
                name="bd-loc"
                value="worktree"
                :checked="boundaryForm.location === 'worktree'"
                @change="boundaryForm.location = 'worktree'"
              />
              git worktree · 隔离副本
            </label>
          </div>
          <div class="field" style="margin-top: 12px">
            <label class="u-label" for="bd-repo">
              {{ boundaryForm.location === "worktree" ? "仓库根路径" : "默认工作区" }}
            </label>
            <input
              id="bd-repo"
              v-model="boundaryForm.repoPath"
              class="input u-mono"
              :placeholder="bot?.effectivePath ?? '例如：D:/workspace/project'"
            />
            <div v-if="boundaryErrors.repo" class="field-err">{{ boundaryErrors.repo }}</div>
            <div v-else class="hint">
              {{
                boundaryForm.location === "worktree"
                  ? "留空表示沿用当前仓库根路径（必须是 git 仓库根）。"
                  : "会话没有单独指定工作区时用它。绝对路径、必须是已存在的目录，不需要是 git 仓库。"
              }}
            </div>
          </div>
          <div v-if="runtime?.requiresWorktree" class="hint" style="color: var(--color-warning-ink); margin-top: 10px">
            {{ runtime.displayName }} 不提供权限请求，无法拦截文件写入。改成 local 需要二次确认。
          </div>

          <div v-if="boundaryErrors.general" class="field-err" style="margin-top: 12px">{{ boundaryErrors.general }}</div>

          <div style="display: flex; gap: 8px; margin-top: 20px; align-items: center">
            <button
              class="btn btn--primary"
              :class="{ 'is-loading': savingBoundary }"
              :disabled="savingBoundary"
              @click="saveBoundary"
            >{{ savingBoundary ? "保存中" : "保存边界" }}</button>
            <span v-if="boundary" class="u-mono hint" style="margin: 0">
              版本 {{ boundary.version }}（进行中的请求按旧版本判定）
            </span>
          </div>
        </section>

        <section class="card card-pad">
          <div class="u-label" style="margin-bottom: 8px">预授权</div>
          <div v-if="grants.length > 0">
            <div
              v-for="g in grants"
              :key="g.id"
              class="grid-row"
              style="grid-template-columns: minmax(0, 1fr) 90px 120px; cursor: default"
            >
              <span class="u-mono" style="font-size: 11.5px">{{ g.actionKey }}</span>
              <span class="u-muted" style="font-size: var(--font-size-caption)">
                {{ g.scope === "bot" ? "本 Bot 永久" : "本会话" }}
              </span>
              <span class="u-mono u-muted" style="font-size: 11px; text-align: right">
                {{ g.expiresAt ? dayTimeText(g.expiresAt) + " 到期" : "长期" }}
              </span>
            </div>
          </div>
          <p v-else style="font-size: var(--font-size-caption); color: var(--color-text-muted)">
            暂无。记住过的动作会出现在这里。
          </p>
        </section>
      </div>

      <aside style="display: grid; gap: 16px">
        <section class="card card-pad">
          <div class="u-label" style="margin-bottom: 8px">写操作自动批准</div>
          <p style="font-size: var(--font-size-caption); color: var(--color-text-muted); line-height: 1.8; margin-bottom: 12px">
            开启后，边界内的写操作不再弹卡片，只写审计。边界外仍然拒绝。
          </p>
          <button
            class="btn btn--sm"
            :class="boundaryForm.autoApproveWrite ? 'btn--secondary' : 'btn--danger'"
            :disabled="savingBoundary"
            @click="askAutoApprove"
          >{{ boundaryForm.autoApproveWrite ? "关闭自动批准" : "开启（需二次确认）" }}</button>
          <p v-if="boundaryForm.autoApproveWrite" class="hint" style="color: var(--color-warning-ink)">
            当前已开启：边界内的写操作不再弹卡片。
          </p>
        </section>
        <section class="card card-pad">
          <div class="u-label" style="margin-bottom: 8px">边界拒绝记录（只读）</div>
          <p style="font-size: var(--font-size-caption); color: var(--color-text-muted)">
            没有可展示的记录。拒绝记录写在会话的权限审计里（设置 › 权限审计）。
          </p>
        </section>
      </aside>
    </div>

    <!-- ================= 会话列表 ================= -->
    <div v-else>
      <div v-if="sessionsLoading" class="rows">
        <div v-for="i in 3" :key="i" class="row-item" aria-hidden="true">
          <span class="sk sk-line" style="width: 70%; display: block" />
        </div>
      </div>

      <div v-else-if="sessionsError" class="banner">
        <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
        <span>读取会话列表失败：{{ sessionsError }}</span>
        <span class="spacer" />
        <button class="btn btn--sm" @click="loadSessions">重试</button>
      </div>

      <EmptyState
        v-else-if="botSessions.length === 0"
        title="还没有会话"
        description="发第一条消息后，这里会出现 Session 记录：时间、运行时、续接状态、消息数与用量。"
      >
        <template #icon><AppIcon name="chats" :size="24" /></template>
        <template #actions>
          <button class="btn btn--primary" @click="openChat">去发第一条消息</button>
        </template>
      </EmptyState>

      <div v-else class="card" style="padding: 8px">
        <div class="grid-row is-head sess-head">
          <span>时间</span><span>运行时</span><span>续接状态</span>
          <span style="text-align: right">消息</span>
          <span style="text-align: right">token</span><span />
        </div>
        <div
          v-for="s in botSessions"
          :key="s.id"
          class="grid-row sess-row"
          @click="router.push(`/chat/${s.channelId}?session=${s.id}`)"
        >
          <span class="sess-time">{{ dateTimeText(s.startedAt) }}</span>
          <span class="sess-rt u-muted">
            {{ runtimes.find(s.runtimeId)?.displayName ?? s.runtimeId ?? "—" }}
          </span>
          <span class="sess-state u-muted">{{ RESUME_WORD[s.resumeState] ?? s.resumeState }}</span>
          <span class="cell-num sess-msgs">{{ s.messageCount }}</span>
          <span class="cell-num sess-tokens">
            {{ s.tokensIn == null ? "—" : num((s.tokensIn ?? 0) + (s.tokensOut ?? 0)) }}
          </span>
          <span class="sess-open" style="text-align: right">
            <span class="btn btn--sm btn--ghost">只读打开</span>
          </span>
        </div>
      </div>
      <p class="hint">「只读打开」进入该会话的 Session 透镜（URL 带 ?session=），不续写上下文。</p>
    </div>

    <!-- 改绑运行时（F5：能力差异预览 + 人格记忆保留说明） -->
    <AppModal v-model:open="rebindOpen" title="改绑运行时">
      <div class="field">
        <label class="u-label" for="rebind-select">运行时</label>
        <select id="rebind-select" v-model="rebindTarget" class="select">
          <option
            v-for="r in rebindCandidates"
            :key="r.id"
            :value="r.id"
            :disabled="runtimes.isUnavailable(r)"
          >{{ runtimeOptionLabel(r) }}</option>
        </select>
        <div class="hint">
          不可用项已置灰；原因优先用后端探测详情（如「需要 ≥ 0.20.0，当前 0.1.0」）。
        </div>
      </div>

      <div v-if="rebindIsBuiltin" class="field">
        <label class="u-label" for="rebind-provider">模型供应商</label>
        <select id="rebind-provider" v-model="rebindProvider" class="select">
          <option value="">使用默认供应商</option>
          <option v-for="p in providers.providers" :key="p.id" :value="p.id">
            {{ p.name }} · {{ p.model }}
          </option>
        </select>
        <div v-if="providers.providers.length === 0" class="hint" style="color: var(--color-warning-ink)">
          还没有配置模型供应商。先到「设置 › 模型供应商」添加。
        </div>
      </div>

      <div class="cap-diff">
        <div class="cap-box gain">
          <h5>将获得</h5>
          <ul v-if="rebindDiff.gain.length > 0">
            <li v-for="g in rebindDiff.gain" :key="g">{{ g }}</li>
          </ul>
          <p v-else style="font-size: var(--font-size-caption); color: var(--color-text-muted)">没有新增能力</p>
        </div>
        <div class="cap-box loss">
          <h5>将失去</h5>
          <ul v-if="rebindDiff.loss.length > 0">
            <li v-for="l in rebindDiff.loss" :key="l">{{ l }}</li>
          </ul>
          <p v-else style="font-size: var(--font-size-caption); color: var(--color-text-muted)">没有能力丢失</p>
        </div>
      </div>

      <div class="cap-row" style="margin-top: 12px" v-if="runtimes.find(rebindTarget)">
        <span class="u-label">{{ runtimes.find(rebindTarget)?.displayName }}</span>
        <CapBadge :value="runtimes.find(rebindTarget)!.capabilities.plan" />
        <CapBadge :value="runtimes.find(rebindTarget)!.capabilities.permission" />
        <CapBadge :value="runtimes.find(rebindTarget)!.capabilities.resume" />
      </div>

      <p class="hint" style="margin-top: 14px">
        人格与记忆保留，新 Session 开始。执行位置与 worktree 路径保留。
      </p>
      <p v-if="runtimes.find(rebindTarget)?.requiresWorktree" class="hint" style="color: var(--color-warning-ink)">
        该运行时不提供权限请求：改绑后如果执行位置是 local，会再要你确认一次风险。
      </p>
      <div v-if="rebindError" class="field-err" role="alert">{{ rebindError }}</div>

      <template #footer>
        <button class="btn btn--secondary" @click="rebindOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--primary" @click="confirmRebind">改绑</button>
      </template>
    </AppModal>

    <!-- 风险二次确认（文案来自后端 worktreeRiskMessage） -->
    <AppModal v-model:open="riskOpen" title="确认风险">
      <div class="banner" style="margin-bottom: 0">
        <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
        <span>{{ riskMessage }}</span>
      </div>
      <p class="hint">
        你可以在「权限边界」里随时改回 worktree。worktree 会为这个 Bot 单独复制一份仓库，
        运行时的写入不会碰到你的工作目录。
      </p>
      <template #footer>
        <button class="btn btn--secondary" @click="riskOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--danger" @click="confirmRisk">我明白风险，继续</button>
      </template>
    </AppModal>

    <!-- 写操作自动批准二次确认 -->
    <AppModal v-model:open="autoApproveConfirmOpen" title="开启写操作自动批准">
      <div class="banner banner--warn" style="margin-bottom: 12px">
        <span class="state-dot" :style="{ '--s': 'var(--state-warning)' }" />
        <span>开启后，边界内的写操作不再弹卡片，只写审计记录。</span>
      </div>
      <ul style="font-size: var(--font-size-caption); color: var(--color-text-secondary); line-height: 1.9; padding-left: 1.2em">
        <li>这个 Bot 可以在你配置的允许目录里任意创建、修改、删除文件，**不会**先问你。</li>
        <li>边界外的动作仍然会被拒绝，不会因为开了这个就放行。</li>
        <li>每次自动批准都会写进权限审计，事后可以查，但界面内不能删除。</li>
        <li>想收回：回到这里关闭即可，只影响之后的请求。</li>
      </ul>
      <p class="hint">这是给「确认过这个 Bot 只动自己那几个目录」的场景用的，不是默认值。</p>
      <template #footer>
        <button class="btn btn--secondary" @click="autoApproveConfirmOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--danger" @click="confirmAutoApprove">我明白，开启</button>
      </template>
    </AppModal>

    <!-- 新增记忆 -->
    <AppModal v-model:open="newOpen" title="新增记忆">
      <div class="field">
        <label class="u-label" for="mem-new">内容</label>
        <textarea
          id="mem-new"
          v-model="newText"
          class="textarea"
          rows="4"
          placeholder="例如：团队用 pnpm，不用 npm；发布分支是 release/*。"
        />
        <div class="hint">保存后下一条消息即生效。作用域决定哪些会话能看到它。</div>
      </div>
      <div class="field">
        <label class="u-label">作用域</label>
        <div class="radio-row">
          <label class="radio">
            <input v-model="newScope" type="radio" name="mem-scope" value="bot" />
            全局（所有会话）
          </label>
          <label class="radio">
            <input
              v-model="newScope"
              type="radio"
              name="mem-scope"
              value="channel"
              :disabled="memoryChannels.length === 0"
            />
            本群聊
          </label>
          <label class="radio">
            <input
              v-model="newScope"
              type="radio"
              name="mem-scope"
              value="session"
              :disabled="botSessions.length === 0"
            />
            本会话
          </label>
        </div>
        <select
          v-if="newScope === 'channel'"
          v-model="newScopeChannelId"
          class="select"
          style="margin-top: 8px"
        >
          <option v-for="c in memoryChannels" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <select
          v-if="newScope === 'session'"
          v-model="newScopeSessionId"
          class="select"
          style="margin-top: 8px"
        >
          <option v-for="s in botSessions" :key="s.id" :value="s.id">
            {{ s.channelName }} · {{ dateTimeText(s.startedAt) }}
          </option>
        </select>
        <div v-if="newScope === 'bot'" class="hint">
          这个 Bot 在所有会话里都会注入；想隔离到某个会话就选「本会话」。
        </div>
        <div v-else-if="newScope === 'channel'" class="hint">
          只有所选群聊里的会话会注入，群内所有 Bot 共享。
        </div>
        <div v-else class="hint">只在所选会话里注入，同一个 Bot 的其它会话看不到。</div>
      </div>
      <template #footer>
        <button class="btn btn--secondary" @click="newOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--primary" :disabled="memBusy" @click="addMemory">保存</button>
      </template>
    </AppModal>

    <!-- 删除 Bot（P0-03） -->
    <AppModal v-model:open="deleteOpen" title="删除这个 Bot">
      <div
        class="banner"
        :class="{ 'banner--warn': deleteMode === 'archive' }"
        style="margin-bottom: 16px"
      >
        <span
          class="state-dot"
          :style="{ '--s': deleteMode === 'archive' ? 'var(--state-waiting)' : 'var(--state-blocked)' }"
        />
        <span v-if="deleteMode === 'cascade'">
          这是不可逆操作：会话、消息、事件、记忆、定时任务与权限记录都会被删除；用量记录保留。
        </span>
        <span v-else-if="deleteMode === 'archive'">
          归档后这个 Bot 不再出现在列表里，但全部数据保留在本地数据库。
        </span>
        <span v-else>先选择处理方式。误删不可逆；归档只需再删一次。</span>
      </div>

      <div class="field">
        <label class="u-label" for="bot-del-name">
          输入 Bot 名称「{{ bot?.name }}」以确认
        </label>
        <input
          id="bot-del-name"
          v-model="deleteName"
          class="input"
          :placeholder="bot?.name ?? ''"
          autocomplete="off"
          @input="deleteError = ''"
        />
        <div v-if="deleteError" class="field-err" role="alert">{{ deleteError }}</div>
        <div v-else class="hint">必须与名称完全一致（不做 trim 或大小写宽容）。</div>
      </div>

      <div class="field">
        <div class="u-label" style="margin-bottom: 8px">处理方式</div>
        <div style="display: grid; gap: 8px">
          <label class="radio">
            <input v-model="deleteMode" type="radio" value="cascade" />
            一并删除会话、记忆与定时任务
          </label>
          <label class="radio">
            <input v-model="deleteMode" type="radio" value="archive" />
            归档保留（不再显示但数据保留）
          </label>
        </div>
        <div v-if="deleteMode === 'cascade'" class="hint" style="color: var(--color-danger-ink)">
          级联删除会清掉该 Bot 的会话、消息、事件、记忆、定时任务、任务、权限与绑定；
          用量记录保留并标记为「已删除 Bot」。
        </div>
        <div v-else-if="deleteMode === 'archive'" class="hint">
          归档只把状态置为 archived，一行数据都不删；定时任务会显示 bot_archived。
        </div>
      </div>

      <p class="hint">
        worktree 不会被自动删除（那是你的文件）。
        <template v-if="bot?.executionLocation === 'worktree' && bot?.effectivePath">
          当前路径：<code class="u-mono">{{ bot.effectivePath }}</code>
        </template>
      </p>

      <template #footer>
        <button class="btn btn--secondary" :disabled="deleting" @click="deleteOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--danger" :disabled="deleting" @click="confirmDelete">
          {{ deleting ? "处理中…" : deleteMode === "archive" ? "归档" : "删除" }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.cap-pair {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cap-name {
  font-size: var(--font-size-micro);
  font-weight: var(--weight-semibold);
  letter-spacing: 0;
  color: var(--color-text-muted);
}
.mem-meta .spacer {
  flex: 1;
}
/* 记忆条目的「来源会话」：看起来像链接，但用按钮语义（点击是路由动作） */
.mem-session {
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--color-primary-ink);
  font-family: var(--font-mono);
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}
.mem-session:hover {
  color: var(--color-primary);
}
</style>
