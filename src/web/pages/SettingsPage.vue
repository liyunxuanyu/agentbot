<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api, isMissingEndpoint } from "../net/client";
import type {
  CatalogEntry,
  McpServerDto,
  McpServerPermission,
  ModelCatalogResponse,
  ModelMeta,
  PermissionDto,
  ProviderDto,
  ProviderProtocol,
  RuntimeDetailDto,
  RuntimeProtocol,
  TidyPreview,
  TidyTarget,
  TokenStatusResponse,
} from "../net/types";
import { useBotsStore } from "../stores/bots";
import { useChannelsStore } from "../stores/channels";
import { useMcpStore } from "../stores/mcp";
import { useProvidersStore } from "../stores/providers";
import { useRuntimesStore } from "../stores/runtimes";
import { useSkillsStore } from "../stores/skills";
import { useUiStore } from "../stores/ui";
import { dayTimeText, num } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import AppModal from "../components/common/AppModal.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import BotStateChip from "../components/bot/BotStateChip.vue";
import CapBadge from "../components/common/CapBadge.vue";
import EmptyState from "../components/common/EmptyState.vue";

/**
 * /settings —— 设置（UX §4.5）。四个分区：
 *   运行时 / 安全与 token / 数据与保留 / 权限审计
 *
 * 原则（UX §1 第 3 条）：治理动作在主流程内，这里只放默认值与审计回看。
 * 所以本页没有「一键批准」之类的东西 —— 批准必须在看到上下文的会话里做。
 *
 * 四态：加载（逐行骨架）/ 正常 / 空（无运行时给安装指引）/ 错误（单项失败只标该行）。
 */
const router = useRouter();
const ui = useUiStore();
const bots = useBotsStore();
const channels = useChannelsStore();
const runtimes = useRuntimesStore();
const providers = useProvidersStore();
const mcp = useMcpStore();
const skills = useSkillsStore();

type TabKey = "runtimes" | "providers" | "catalog" | "mcp" | "skills" | "security" | "data" | "audit";
const TABS: { key: TabKey; label: string }[] = [
  { key: "runtimes", label: "运行时" },
  { key: "providers", label: "模型供应商" },
  { key: "catalog", label: "模型映射表" },
  { key: "mcp", label: "MCP" },
  { key: "skills", label: "技能" },
  { key: "security", label: "安全与 token" },
  { key: "data", label: "数据与保留" },
  { key: "audit", label: "权限审计" },
];
const tab = ref<TabKey>("runtimes");

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------
// ---- 单行重试 / 全局重新探测（P0-01）----
const reprobing = ref(false);

/** 运行时行状态 → 六态 chip 的色调。 */
function rowState(r: RuntimeDetailDto): "done" | "waiting" | "blocked" {
  if (r.availability === "ready") return "done";
  if (r.availability === "timeout") return "waiting";
  return "blocked";
}

/** 单行重试：只探测这一行，原地更新；失败不静默。 */
async function retryOne(id: string): Promise<void> {
  const before = runtimes.find(id);
  try {
    const updated = await runtimes.probeOne(id);
    ui.toast(
      updated.availability === "ready"
        ? `${updated.displayName} 可用`
        : `${updated.displayName}：${runtimes.reasonOf(updated)}`,
    );
  } catch (err) {
    const label = before?.displayName ?? "该运行时";
    ui.toast(
      err instanceof ApiError
        ? `${label} 探测失败：${err.bodyMessage ?? err.code}`
        : `${label} 探测失败`,
    );
  }
}

/** 全局「重新探测」：逐个调 probe，行级 loading；单项失败不影响其余项。 */
async function reprobeAll(): Promise<void> {
  if (reprobing.value) return;
  if (runtimes.runtimes.length === 0) {
    await runtimes.load();
    return;
  }
  reprobing.value = true;
  try {
    const res = await runtimes.probeAll();
    ui.toast(
      res.failed > 0
        ? `重新探测完成：${res.probed} 项成功，${res.failed} 项失败`
        : `重新探测完成：${res.probed} 项`,
    );
  } finally {
    reprobing.value = false;
  }
}

// ---- 409 already_exists 后跳转并高亮该条目 ----
const highlightId = ref<string | null>(null);
let highlightTimer: number | null = null;

async function highlightRuntime(id: string): Promise<void> {
  highlightId.value = id;
  await nextTick();
  document.getElementById(`rt-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (highlightTimer !== null) window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => {
    highlightId.value = null;
  }, 3200);
}

// ---- 手动添加自定义运行时（P0-01）----
const PROTOCOLS: { value: RuntimeProtocol; label: string; hint: string }[] = [
  { value: "acp", label: "ACP", hint: "支持反向权限请求，可弹权限卡片。" },
  { value: "codex-app-server", label: "Codex app-server", hint: "JSON-RPC 审批通道。" },
  { value: "opencode-http", label: "OpenCode HTTP", hint: "无权限通道，Bot 会被强制跑在 worktree。" },
  { value: "claude-sdk", label: "Claude SDK", hint: "无权限通道，Bot 会被强制跑在 worktree。" },
  { value: "cli-stdio", label: "CLI stdio", hint: "兜底通道，只呈现正文/用量/结束/错误；无权限通道，Bot 会被强制跑在 worktree。" },
];

const addOpen = ref(false);
const adding = ref(false);
const addForm = reactive({
  id: "",
  displayName: "",
  protocol: "cli-stdio" as RuntimeProtocol,
  command: "",
  argsText: "",
});
const addErrors = reactive<Record<string, string>>({});
let idTouched = false;

const protocolHint = computed(
  () => PROTOCOLS.find((p) => p.value === addForm.protocol)?.hint ?? "",
);

function clearAddErrors(): void {
  for (const key of Object.keys(addErrors)) delete addErrors[key];
}

function openAdd(): void {
  addForm.id = "";
  addForm.displayName = "";
  addForm.protocol = "cli-stdio";
  addForm.command = "";
  addForm.argsText = "";
  idTouched = false;
  clearAddErrors();
  addOpen.value = true;
}

/** 名称 → id 的保守 slug；中文名会得到空串，提交时回退到 `custom-<时间>`。 */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function onAddNameInput(): void {
  if (!idTouched) addForm.id = slugify(addForm.displayName);
  delete addErrors["displayName"];
}

function onAddIdInput(): void {
  idTouched = true;
  delete addErrors["id"];
}

/** 参数每行一个 argv 元素（含空格的参数整行保留）。 */
function parseArgs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function submitAdd(): Promise<void> {
  if (adding.value) return;
  clearAddErrors();

  const displayName = addForm.displayName.trim();
  const command = addForm.command.trim();
  if (displayName.length === 0) addErrors["displayName"] = "显示名称不能为空";
  if (command.length === 0) addErrors["command"] = "启动命令不能为空";

  let id = addForm.id.trim();
  if (id.length === 0) {
    id = slugify(displayName) || `custom-${Date.now().toString(36)}`;
    addForm.id = id;
  }
  if (Object.keys(addErrors).length > 0) return;

  adding.value = true;
  try {
    const rt = await runtimes.addCustom({
      id,
      displayName,
      protocol: addForm.protocol,
      command,
      args: parseArgs(addForm.argsText),
    });
    addOpen.value = false;
    if (rt) {
      ui.toast(
        rt.availability === "ready"
          ? `已添加 ${rt.displayName}`
          : `已添加 ${rt.displayName}：${runtimes.reasonOf(rt)}`,
      );
      void highlightRuntime(rt.id);
    } else {
      // 行已落库但探测结果没回来：刷新一次列表，让用户能点行内「重试」
      ui.toast("已添加，但探测结果未返回；可在该行点「重试」");
      void runtimes.load();
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === "already_exists") {
      const body = err.body as { existingId?: unknown } | undefined;
      const existingId = typeof body?.existingId === "string" ? body.existingId : null;
      addOpen.value = false;
      ui.toast(err.bodyMessage ?? "该运行时已存在");
      if (existingId) void highlightRuntime(existingId);
      return;
    }
    if (err instanceof ApiError && err.status === 400) {
      for (const field of err.fieldErrors()) addErrors[field.field] = field.message;
      if (Object.keys(addErrors).length === 0) {
        addErrors["general"] = err.bodyMessage ?? "添加失败：请求未通过校验。";
      }
      return;
    }
    addErrors["general"] =
      err instanceof ApiError ? (err.bodyMessage ?? `添加失败（${err.code}）`) : "添加失败，请重试";
  } finally {
    adding.value = false;
  }
}

const installCommands = "npm i -g @google/gemini-cli\nnpm i -g @openai/codex";

function copyInstall(): void {
  void navigator.clipboard
    ?.writeText(installCommands)
    .then(() => ui.toast("已复制安装命令"))
    .catch(() => ui.toast("复制失败，请手动选择"));
}

// ---------------------------------------------------------------------------
// 安全与 token（P0-14）
// ---------------------------------------------------------------------------
const tokenStatus = ref<TokenStatusResponse | null>(null);
const tokenLoading = ref(false);
const tokenError = ref("");
const resetOpen = ref(false);
const resetting = ref(false);
const resetResult = ref<{ url: string; closedStreams: number } | null>(null);

async function loadToken(): Promise<void> {
  tokenLoading.value = true;
  tokenError.value = "";
  try {
    tokenStatus.value = await api.tokenStatus();
  } catch (err) {
    if (isMissingEndpoint(err)) {
      tokenStatus.value = null;
      return;
    }
    tokenError.value = err instanceof Error ? err.message : "读取 token 状态失败";
  } finally {
    tokenLoading.value = false;
  }
}

/**
 * 重置 token（P0-14「10s 内断开所有已连接客户端并要求用新 URL」）。
 *
 * 重置后当前标签页的 token 已失效：下一次请求就是 401。所以这里不自动跳转，
 * 而是把新 URL 完整展示出来，让用户复制后自己打开 —— 这样「旧标签页失效」
 * 这件事是可见的，不会让人以为界面卡住了。
 */
async function resetToken(): Promise<void> {
  if (resetting.value) return;
  resetting.value = true;
  try {
    const res = await api.resetToken();
    resetResult.value = { url: res.url, closedStreams: res.closedStreams };
    resetOpen.value = false;
    // 本地缓存的 token 立刻作废：后续请求带旧 token 只会 401
    try {
      sessionStorage.removeItem("agentbot.token");
    } catch {
      // 隐私模式下可能不可写
    }
    await loadToken();
  } catch (err) {
    tokenError.value =
      err instanceof ApiError ? (err.messageText() ?? "重置失败") : "重置失败，请重试";
    resetOpen.value = false;
  } finally {
    resetting.value = false;
  }
}

function copyUrl(): void {
  const url = resetResult.value?.url;
  if (!url) return;
  void navigator.clipboard
    ?.writeText(url)
    .then(() => ui.toast("已复制新访问地址"))
    .catch(() => ui.toast("复制失败，请手动选择"));
}

// ---------------------------------------------------------------------------
// 数据与保留（P0-12 边界：全量删除）
// ---------------------------------------------------------------------------
const retention = ref(365);
const purgeOpen = ref(false);
const purgeInput = ref("");
const purging = ref(false);
const purgeError = ref("");
const PURGE_PHRASE = "删除全部数据";

// ---- 数据整理（清理归档/删除 Bot 留下的孤儿数据）----
const tidyPreview = ref<TidyPreview | null>(null);
const tidyBusy = ref(false);
const tidyError = ref("");
const tidyResult = ref<Record<string, number> | null>(null);
/** 勾选的整理项。默认不含用量历史 —— 那是账目，要用户主动勾。 */
const tidyTargets = ref<TidyTarget[]>(["channels", "orphanSessions", "memories"]);

const TIDY_OPTIONS: { key: TidyTarget; label: string; desc: string }[] = [
  {
    key: "channels",
    label: "空会话渠道",
    desc: "dm / 群聊里没有任何在用 Bot，连带它的会话、消息、事件一起删",
  },
  {
    key: "orphanSessions",
    label: "孤儿会话",
    desc: "渠道还在，但所属 Bot 已被删除",
  },
  {
    key: "memories",
    label: "孤儿记忆",
    desc: "记忆条目所属 Bot 已不存在",
  },
  {
    key: "orphanUsage",
    label: "孤儿用量记录",
    desc: "所属 Bot 已不存在的用量行；删了用量统计会变少，默认不勾",
  },
];

function tidyCountOf(key: TidyTarget): number {
  const p = tidyPreview.value;
  if (!p) return 0;
  if (key === "channels") return p.channels.length;
  if (key === "orphanSessions") return p.orphanSessions.length;
  if (key === "memories") return p.memories;
  return p.orphanUsage;
}

function toggleTidyTarget(key: TidyTarget): void {
  tidyTargets.value = tidyTargets.value.includes(key)
    ? tidyTargets.value.filter((k) => k !== key)
    : [...tidyTargets.value, key];
}

async function previewTidy(): Promise<void> {
  if (tidyBusy.value) return;
  tidyBusy.value = true;
  tidyError.value = "";
  tidyResult.value = null;
  try {
    const res = await api.tidyPreview();
    tidyPreview.value = res.preview;
  } catch (err) {
    tidyError.value =
      err instanceof ApiError ? (err.messageText() ?? `统计失败（${err.code}）`) : "统计失败，请重试";
    tidyPreview.value = null;
  } finally {
    tidyBusy.value = false;
  }
}

async function applyTidy(): Promise<void> {
  if (tidyBusy.value || !tidyPreview.value) return;
  if (tidyTargets.value.length === 0) {
    tidyError.value = "至少勾一类要整理的数据。";
    return;
  }
  tidyBusy.value = true;
  tidyError.value = "";
  try {
    const res = await api.tidyApply(tidyTargets.value);
    tidyResult.value = res.deleted;
    ui.toast(`已清理 ${res.deleted["channels"] ?? 0} 个渠道、${res.deleted["sessions"] ?? 0} 个会话`);
    // 列表与用量都变了：让下次进入时重新拉
    void channels.load();
    void bots.load();
    await previewTidy();
  } catch (err) {
    tidyError.value =
      err instanceof ApiError ? (err.messageText() ?? `整理失败（${err.code}）`) : "整理失败，请重试";
  } finally {
    tidyBusy.value = false;
  }
}

// ---- 模型能力对照表（可维护，独立分区）----
const catalog = ref<ModelCatalogResponse | null>(null);
const catalogErr = ref("");
const catalogLoading = ref(false);
/** 编辑中的用户覆盖表（保存前的草稿）。 */
const catalogDraft = ref<CatalogEntry[]>([]);
const catalogSaving = ref(false);
const catalogSaveErr = ref("");
const catalogTestModel = ref("");
const catalogTestResult = ref<{ match: string; hit: boolean } | null>(null);

async function loadCatalog(): Promise<void> {
  if (catalogLoading.value) return;
  catalogLoading.value = true;
  catalogErr.value = "";
  try {
    catalog.value = await api.modelCatalog();
    catalogDraft.value = catalog.value.user.map((e) => ({ ...e }));
  } catch (err) {
    catalogErr.value =
      err instanceof ApiError ? (err.messageText() ?? `读取失败（${err.code}）`) : "读取失败";
  } finally {
    catalogLoading.value = false;
  }
}

/** 从供应商表单跳过来时把模型表读一次。 */
function openCatalog(): void {
  tab.value = "catalog";
  catalogTestResult.value = null;
  catalogSaveErr.value = "";
  void loadCatalog();
}

function addCatalogRule(): void {
  catalogDraft.value = [
    ...catalogDraft.value,
    { match: "", contextWindow: null, maxOutputTokens: null },
  ];
}

function removeCatalogRule(index: number): void {
  catalogDraft.value = catalogDraft.value.filter((_, i) => i !== index);
}

/** 数字输入框回传的是字符串；空串表示 null（不填）。 */
function catalogNum(v: string): number | null {
  const t = v.trim();
  if (t.length === 0) return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

async function saveCatalog(): Promise<void> {
  if (catalogSaving.value) return;
  catalogSaving.value = true;
  catalogSaveErr.value = "";
  try {
    const res = await api.saveModelCatalog(catalogDraft.value);
    catalogDraft.value = res.user.map((e) => ({ ...e }));
    if (catalog.value) catalog.value = { ...catalog.value, user: res.user };
    ui.toast(`已保存 ${res.user.length} 条覆盖规则`);
  } catch (err) {
    catalogSaveErr.value =
      err instanceof ApiError
        ? (err.fieldErrors()[0]?.message ?? err.messageText() ?? err.message)
        : "保存失败";
  } finally {
    catalogSaving.value = false;
  }
}

async function testCatalogRule(rule: CatalogEntry): Promise<void> {
  const modelId = catalogTestModel.value.trim();
  if (modelId.length === 0 || rule.match.trim().length === 0) return;
  try {
    const res = await api.testCatalogRule(rule.match, modelId);
    catalogTestResult.value = { match: rule.match, hit: res.hit };
  } catch (err) {
    catalogSaveErr.value =
      err instanceof ApiError ? (err.messageText() ?? "测试失败") : "测试失败";
  }
}

async function purgeAll(): Promise<void> {
  if (purging.value) return;
  if (purgeInput.value.trim() !== PURGE_PHRASE) {
    purgeError.value = `请输入「${PURGE_PHRASE}」以确认。`;
    return;
  }
  purging.value = true;
  purgeError.value = "";
  try {
    const res = await api.purgeAll(PURGE_PHRASE);
    const total = Object.values(res.deleted).reduce((s, n) => s + n, 0);
    purgeOpen.value = false;
    purgeInput.value = "";
    ui.toast(`已删除全部数据（${num(total)} 行）`);
    // 数据没了：让所有页面下次进入时重新拉
    void bots.load();
    void channels.load();
    void router.push("/setup");
  } catch (err) {
    purgeError.value =
      err instanceof ApiError ? (err.messageText() ?? `删除失败（${err.code}）`) : "删除失败，请重试";
  } finally {
    purging.value = false;
  }
}

function exportUsage(): void {
  window.location.href = api.usageCsvUrl({ range: "all" });
  ui.toast("开始下载用量 CSV");
}

// ---------------------------------------------------------------------------
// 权限审计（只读）
// ---------------------------------------------------------------------------
/**
 * 审计记录的取法。
 *
 * 后端没有「全量审计」端点：`GET /api/permissions` 必须带 `sessionId`。
 * 因此这里按「渠道 → Session → 权限记录」两跳聚合（渠道是个位数，成本可接受），
 * 并按 decidedAt 倒序合并。这不是理想形态，但比显示一个假的空表诚实。
 *
 * 上限 30 个 Session：再多就只显示最近的，并在页脚说明（审计的完整导出在 P1）。
 */
const audit = ref<(PermissionDto & { botName: string; channelName: string })[]>([]);
const auditLoading = ref(false);
const auditError = ref("");
const auditMissing = ref(false);
const auditTruncated = ref(false);
const auditBotFilter = ref("all");

const AUDIT_SESSION_LIMIT = 30;

async function loadAudit(): Promise<void> {
  auditLoading.value = true;
  auditError.value = "";
  auditMissing.value = false;
  auditTruncated.value = false;
  try {
    if (channels.channels.length === 0) await channels.load();
    if (bots.bots.length === 0) await bots.load();

    const sessionRows: { sessionId: string; botId: string; channelName: string; startedAt: number }[] = [];
    for (const c of channels.channels) {
      try {
        const detail = await api.channel(c.id);
        for (const s of detail.sessions) {
          sessionRows.push({
            sessionId: s.id,
            botId: s.botId,
            channelName: detail.channel.name,
            startedAt: s.startedAt,
          });
        }
      } catch (err) {
        if (isMissingEndpoint(err)) {
          auditMissing.value = true;
          audit.value = [];
          return;
        }
        throw err;
      }
    }
    sessionRows.sort((a, b) => b.startedAt - a.startedAt);
    if (sessionRows.length > AUDIT_SESSION_LIMIT) auditTruncated.value = true;

    const collected: (PermissionDto & { botName: string; channelName: string })[] = [];
    for (const row of sessionRows.slice(0, AUDIT_SESSION_LIMIT)) {
      try {
        const res = await api.permissions(row.sessionId);
        for (const p of res.permissions) {
          // 只显示已决的：待批在会话里处置，审计区只做回看
          if (p.status === "pending") continue;
          collected.push({
            ...p,
            botName: bots.findBot(p.botId)?.name ?? "（已删除的 Bot）",
            channelName: row.channelName,
          });
        }
      } catch (err) {
        if (!isMissingEndpoint(err)) throw err;
        auditMissing.value = true;
        return;
      }
    }
    collected.sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
    audit.value = collected;
  } catch (err) {
    auditError.value = err instanceof Error ? err.message : "读取审计失败";
  } finally {
    auditLoading.value = false;
  }
}

const auditFiltered = computed(() =>
  auditBotFilter.value === "all"
    ? audit.value
    : audit.value.filter((a) => a.botId === auditBotFilter.value),
);

/** 审计行的决定文案与色调。 */
function decisionOf(p: PermissionDto): { text: string; ok: boolean } {
  switch (p.status) {
    case "decided":
      return { text: p.decision === "reject" ? "已拒绝" : "已批准", ok: p.decision !== "reject" };
    case "denied_timeout":
      return { text: "超时自动拒绝", ok: false };
    case "denied_hard_timeout":
      return { text: "挂起超时拒绝", ok: false };
    case "denied_boundary":
      return { text: "边界拒绝", ok: false };
    case "invalidated":
      return { text: "请求已失效", ok: false };
    default:
      return { text: p.decision ?? p.status, ok: false };
  }
}

const ACTION_WORD: Record<string, string> = {
  write: "写文件",
  read: "读文件",
  exec: "执行命令",
  network: "联网",
};

function actorOf(p: PermissionDto): string {
  if (p.status !== "decided") return "系统";
  return p.decidedBy === "system" ? "系统" : "你";
}

function botColorOf(botId: string): number {
  return bots.findBot(botId)?.colorIndex ?? 8;
}

// ---------------------------------------------------------------------------
// 模型供应商（内置引擎）
// ---------------------------------------------------------------------------
const providerOpen = ref(false);
const editingProviderId = ref<string | null>(null);
const providerErr = ref("");
const providerSaving = ref(false);
const providerBusy = ref<string | null>(null);
/** 从供应商拉到（或编辑时回填）的模型清单；空数组 = 还没拉过。 */
const modelList = ref<ModelMeta[]>([]);
const modelListBusy = ref(false);
const modelListErr = ref("");
/** 拉取结果是否来自内置对照表；false 时提示「默认值靠命名推断，请核对」。 */
const modelListAllKnown = ref(true);
const providerForm = reactive({
  name: "",
  protocol: "openai-chat" as ProviderProtocol,
  baseUrl: "",
  apiKey: "",
  model: "",
  contextWindow: "",
  maxOutputTokens: "",
  supportsTools: true,
  supportsStreaming: true,
});

/** 表单里选了某个模型后，把它的默认能力带出来（用户可再手改）。 */
function applyModelDefaults(id: string): void {
  const meta = modelList.value.find((m) => m.id === id);
  if (!meta) return;
  if (meta.contextWindow !== null) providerForm.contextWindow = String(meta.contextWindow);
  if (meta.maxOutputTokens !== null) providerForm.maxOutputTokens = String(meta.maxOutputTokens);
}

function onModelPick(): void {
  if (providerForm.model.trim().length > 0) applyModelDefaults(providerForm.model.trim());
}

/** 拉模型清单：新建时用表单值，编辑时只给 id（key 用已存的，不回显明文）。 */
async function loadModels(): Promise<void> {
  if (modelListBusy.value) return;
  modelListBusy.value = true;
  modelListErr.value = "";
  try {
    const res = await api.listProviderModels({
      ...(editingProviderId.value ? { id: editingProviderId.value } : {}),
      protocol: providerForm.protocol,
      baseUrl: providerForm.baseUrl.trim(),
      ...(providerForm.apiKey.trim().length > 0 ? { apiKey: providerForm.apiKey.trim() } : {}),
    });
    if (!res.ok) {
      modelListErr.value = res.error ?? "拉取失败";
      modelList.value = [];
      return;
    }
    modelList.value = res.models;
    modelListAllKnown.value = res.models.every((m) => m.known);
    if (res.models.length === 0) {
      modelListErr.value = "供应商返回了空列表，模型名请手填。";
      return;
    }
    // 当前模型不在清单里（或还没选）→ 自动选第一个并带出默认值
    const current = providerForm.model.trim();
    if (current.length === 0 || !res.models.some((m) => m.id === current)) {
      const first = res.models[0];
      if (first) {
        providerForm.model = first.id;
        applyModelDefaults(first.id);
      }
    } else {
      applyModelDefaults(current);
    }
    ui.toast(`拉到 ${res.count} 个模型 · ${res.latencyMs}ms`);
  } catch (err) {
    modelListErr.value = err instanceof ApiError ? (err.messageText() ?? err.message) : "拉取失败";
    modelList.value = [];
  } finally {
    modelListBusy.value = false;
  }
}

function openAddProvider(): void {
  editingProviderId.value = null;
  providerErr.value = "";
  providerForm.name = "";
  providerForm.protocol = "openai-chat";
  providerForm.baseUrl = "";
  providerForm.apiKey = "";
  providerForm.model = "";
  providerForm.contextWindow = "";
  providerForm.maxOutputTokens = "";
  providerForm.supportsTools = true;
  providerForm.supportsStreaming = true;
  modelList.value = [];
  modelListErr.value = "";
  providerOpen.value = true;
}

function openEditProvider(p: ProviderDto): void {
  editingProviderId.value = p.id;
  providerErr.value = "";
  providerForm.name = p.name;
  providerForm.protocol = p.protocol;
  providerForm.baseUrl = p.baseUrl;
  providerForm.apiKey = "";
  providerForm.model = p.model;
  providerForm.contextWindow = p.contextWindow === null ? "" : String(p.contextWindow);
  providerForm.maxOutputTokens = p.maxOutputTokens === null ? "" : String(p.maxOutputTokens);
  providerForm.supportsTools = p.supportsTools;
  providerForm.supportsStreaming = p.supportsStreaming;
  modelList.value = [];
  modelListErr.value = "";
  providerOpen.value = true;
}

async function saveProvider(): Promise<void> {
  if (providerSaving.value) return;
  providerErr.value = "";
  if (providerForm.baseUrl.trim().length === 0 || providerForm.model.trim().length === 0) {
    providerErr.value = "baseUrl 与 model 都不能为空。";
    return;
  }
  if (!editingProviderId.value && providerForm.apiKey.trim().length === 0) {
    providerErr.value = "新增供应商必须填 apiKey。";
    return;
  }
  const contextRaw = providerForm.contextWindow.trim();
  const contextWindow = contextRaw.length === 0 ? null : Number.parseInt(contextRaw, 10);
  if (contextWindow !== null && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
    providerErr.value = "上下文窗口必须是正整数或留空。";
    return;
  }
  const outRaw = providerForm.maxOutputTokens.trim();
  const maxOutputTokens = outRaw.length === 0 ? null : Number.parseInt(outRaw, 10);
  if (maxOutputTokens !== null && (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0)) {
    providerErr.value = "最大输出 token 必须是正整数或留空。";
    return;
  }
  if (
    contextWindow !== null &&
    maxOutputTokens !== null &&
    maxOutputTokens > contextWindow
  ) {
    providerErr.value = "最大输出 token 不能大于上下文窗口。";
    return;
  }
  providerSaving.value = true;
  try {
    const common = {
      name: providerForm.name.trim() || undefined,
      protocol: providerForm.protocol,
      baseUrl: providerForm.baseUrl.trim(),
      model: providerForm.model.trim(),
      contextWindow,
      maxOutputTokens,
      supportsTools: providerForm.supportsTools,
      supportsStreaming: providerForm.supportsStreaming,
    };
    if (editingProviderId.value) {
      const patch: typeof common & { apiKey?: string } = { ...common };
      if (providerForm.apiKey.trim().length > 0) patch.apiKey = providerForm.apiKey.trim();
      await providers.update(editingProviderId.value, patch);
      ui.toast("供应商已更新");
    } else {
      await providers.create({ ...common, apiKey: providerForm.apiKey.trim() });
      ui.toast("供应商已添加 · 内置引擎已可用");
    }
    providerOpen.value = false;
    // 内置引擎的可用性随后端刷新；重读运行时让列表同步
    void runtimes.load();
  } catch (err) {
    providerErr.value =
      err instanceof ApiError
        ? (err.fieldErrors()[0]?.message ?? err.messageText() ?? err.message)
        : err instanceof Error
          ? err.message
          : "保存失败";
  } finally {
    providerSaving.value = false;
  }
}

async function testProvider(p: ProviderDto): Promise<void> {
  providerBusy.value = p.id;
  try {
    const res = await api.testProvider(p.id);
    ui.toast(
      res.ok
        ? `${p.name} 可用 · ${res.latencyMs}ms · ${res.model}`
        : `${p.name} 不可用：${res.error ?? "未知错误"}`,
    );
  } catch (err) {
    ui.toast(err instanceof Error ? `测试失败：${err.message}` : "测试失败");
  } finally {
    providerBusy.value = null;
  }
}

async function setDefaultProvider(p: ProviderDto): Promise<void> {
  try {
    await providers.setDefault(p.id);
    ui.toast(`默认供应商：${p.name}`);
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : "设置默认供应商失败");
  }
}

async function removeProvider(p: ProviderDto): Promise<void> {
  if (!window.confirm(`删除供应商「${p.name}」？绑定它的 Bot 会回退到默认供应商。`)) return;
  try {
    await providers.remove(p.id);
    ui.toast(`已删除 ${p.name}`);
    void runtimes.load();
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : "删除失败");
  }
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
const mcpOpen = ref(false);
const editingMcpId = ref<string | null>(null);
const mcpErr = ref("");
const mcpSaving = ref(false);
const mcpForm = reactive({
  id: "",
  command: "",
  argsText: "",
  enabled: true,
  // R5-c：read 的 server 在计划模式下仍然可用；其它在计划模式下被裁掉
  permission: "exec" as McpServerPermission,
});

function openAddMcp(): void {
  editingMcpId.value = null;
  mcpErr.value = "";
  mcpForm.id = "";
  mcpForm.command = "";
  mcpForm.argsText = "";
  mcpForm.enabled = true;
  mcpForm.permission = "exec";
  mcpOpen.value = true;
}

function openEditMcp(s: McpServerDto): void {
  editingMcpId.value = s.id;
  mcpErr.value = "";
  mcpForm.id = s.id;
  mcpForm.command = s.command;
  mcpForm.argsText = s.args.join("\n");
  mcpForm.enabled = s.enabled;
  mcpForm.permission = s.permission ?? "exec";
  mcpOpen.value = true;
}

function mcpArgs(): string[] {
  return mcpForm.argsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function saveMcp(): Promise<void> {
  if (mcpSaving.value) return;
  mcpErr.value = "";
  if (mcpForm.command.trim().length === 0) {
    mcpErr.value = "command 不能为空。";
    return;
  }
  if (!editingMcpId.value && mcpForm.id.trim().length === 0) {
    mcpErr.value = "id 不能为空（用于工具名前缀）。";
    return;
  }
  mcpSaving.value = true;
  try {
    if (editingMcpId.value) {
      await mcp.update(editingMcpId.value, {
        command: mcpForm.command.trim(),
        args: mcpArgs(),
        enabled: mcpForm.enabled,
        permission: mcpForm.permission,
      });
      ui.toast("MCP server 已更新");
    } else {
      const created = await mcp.create({
        id: mcpForm.id.trim(),
        command: mcpForm.command.trim(),
        args: mcpArgs(),
        enabled: mcpForm.enabled,
        permission: mcpForm.permission,
      });
      ui.toast(
        created?.status === "connected"
          ? `已连接 ${created.id} · ${created.toolCount} 个工具`
          : `已保存 ${mcpForm.id.trim()}，当前未连接`,
      );
    }
    mcpOpen.value = false;
  } catch (err) {
    mcpErr.value =
      err instanceof ApiError
        ? (err.fieldErrors()[0]?.message ?? err.messageText() ?? err.message)
        : err instanceof Error
          ? err.message
          : "保存失败";
  } finally {
    mcpSaving.value = false;
  }
}

async function toggleMcp(s: McpServerDto): Promise<void> {
  try {
    await mcp.update(s.id, { enabled: !s.enabled });
    ui.toast(`${s.id} 已${s.enabled ? "停用" : "启用"}`);
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : "操作失败");
  }
}

async function reconnectMcp(s: McpServerDto): Promise<void> {
  try {
    const row = await mcp.reconnect(s.id);
    ui.toast(
      row?.status === "connected" ? `${s.id} 已连接 · ${row.toolCount} 个工具` : `${s.id} 仍不可用`,
    );
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : "重连失败");
  }
}

async function removeMcp(s: McpServerDto): Promise<void> {
  if (!window.confirm(`删除 MCP server「${s.id}」？`)) return;
  try {
    await mcp.remove(s.id);
    ui.toast(`已删除 ${s.id}`);
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : "删除失败");
  }
}

/** MCP 权限性质（R5-c）：未声明等价 exec。 */
function mcpPermissionWord(p: McpServerDto["permission"]): string {
  switch (p) {
    case "read":
      return "只读";
    case "write":
      return "写文件";
    case "network":
      return "联网";
    default:
      return "执行";
  }
}

/** MCP 连接状态 → 六态 chip 的色调。 */
function mcpState(s: McpServerDto): "done" | "waiting" | "blocked" {
  if (s.status === "connected") return "done";
  if (s.status === "connecting") return "waiting";
  return "blocked";
}

function mcpStatusWord(s: McpServerDto): string {
  switch (s.status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "disabled":
      return "已停用";
    default:
      return "不可用";
  }
}

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------
async function rescanSkills(): Promise<void> {
  try {
    const count = await skills.rescan();
    ui.toast(count === 0 ? `没有找到技能（${skills.dir}）` : `已重扫：${count} 个技能`);
  } catch (err) {
    ui.toast(err instanceof Error ? err.message : "重扫失败");
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
onMounted(async () => {
  ui.setCrumb([{ text: "设置" }]);
  if (runtimes.runtimes.length === 0) void runtimes.load();
  void providers.load();
  void mcp.load();
  void skills.load();
  void loadToken();
  void loadAudit();
  void loadCatalog();
});

onBeforeUnmount(() => {
  if (highlightTimer !== null) window.clearTimeout(highlightTimer);
});
</script>

<template>
  <div>
    <div class="page-head enter" :style="{ '--i': 0 }">
      <div>
        <h1 class="page-title">设置</h1>
        <p class="page-desc">
          治理动作发生在会话里；这里放默认值、运行时管理和审计回看。
        </p>
      </div>
    </div>

    <div class="set-grid">
      <div class="set-nav enter" :style="{ '--i': 1 }">
        <button
          v-for="t in TABS"
          :key="t.key"
          :class="{ 'is-on': tab === t.key }"
          @click="tab = t.key"
        >{{ t.label }}</button>
      </div>

      <div>
        <!-- ================= 运行时 ================= -->
        <template v-if="tab === 'runtimes'">
          <div v-if="runtimes.status === 'loading' || runtimes.status === 'idle'" style="display: grid; gap: 10px">
            <div v-for="i in 4" :key="i" class="sk" style="height: 48px" />
          </div>

          <div v-else-if="runtimes.status === 'error'" class="banner">
            <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
            <span>读取运行时失败：{{ runtimes.errorText }}</span>
            <span class="spacer" />
            <button class="btn btn--sm" @click="runtimes.load()">重试</button>
          </div>

          <EmptyState
            v-else-if="runtimes.status === 'empty'"
            title="还没有发现任何运行时"
            description="PATH 里没有找到可用的 agent。按下面任一命令装一个，然后重启服务重新探测；也可以用启动参数指定可执行文件。"
          >
            <template #icon><AppIcon name="gear" :size="24" /></template>
            <template #actions>
              <button class="btn btn--secondary" @click="copyInstall">复制安装命令</button>
              <button class="btn btn--secondary" :disabled="reprobing" @click="reprobeAll">
                {{ reprobing ? "探测中…" : "重新探测" }}
              </button>
              <button class="btn btn--ghost" @click="openAdd">手动添加</button>
            </template>
          </EmptyState>

          <template v-else>
            <div class="filters" style="min-height: auto">
              <span class="u-label">已发现</span>
              <span class="u-mono" style="color: var(--color-text-secondary)">
                {{ runtimes.runtimes.length }} 项 · 可用 {{ runtimes.readyCount }} 项
              </span>
              <span class="spacer" />
              <button class="btn btn--sm btn--secondary" :disabled="reprobing" @click="reprobeAll">
                {{ reprobing ? `探测中 ${runtimes.probeProgress.done}/${runtimes.probeProgress.total}` : "重新探测" }}
              </button>
              <button class="btn btn--sm btn--secondary" @click="openAdd">手动添加</button>
            </div>

            <div class="card" style="padding: 8px">
              <div class="grid-row is-head runtime-row">
                <span>名称</span><span>版本</span><span>协议</span><span>可执行文件</span>
                <span>状态</span><span>能力</span>
              </div>
              <div
                v-for="(r, i) in runtimes.runtimes"
                :id="`rt-row-${r.id}`"
                :key="r.id"
                class="grid-row runtime-row enter"
                :class="{ 'is-dim': r.availability !== 'ready', 'is-highlight': highlightId === r.id }"
                :style="{ '--i': Math.min(i, 5), cursor: 'default' }"
              >
                <span class="rt-name" style="font-weight: var(--weight-semibold); font-size: var(--font-size-caption)">
                  {{ r.displayName }}
                  <span v-if="r.availability !== 'ready'" class="rt-reason">{{ runtimes.reasonOf(r) }}</span>
                </span>
                <span class="rt-version u-mono u-muted">{{ r.version ? `v${r.version}` : "—" }}</span>
                <span class="rt-protocol u-muted" style="font-size: var(--font-size-caption)">{{ r.protocol }}</span>
                <span class="rt-path u-mono" style="color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                  {{ r.executable ?? r.command }}
                </span>
                <span class="rt-status">
                  <BotStateChip
                    :state="rowState(r)"
                    :label="runtimes.statusWordOf(r)"
                  />
                  <button
                    class="btn btn--sm btn--ghost"
                    :disabled="runtimes.isProbing(r.id) || reprobing"
                    :title="r.availability === 'ready' ? '重新探测该运行时' : runtimes.reasonOf(r)"
                    @click="retryOne(r.id)"
                  >{{ runtimes.isProbing(r.id) ? "检测中…" : "重试" }}</button>
                </span>
                <span class="rt-caps cap-row">
                  <CapBadge :value="r.capabilities.plan" />
                  <CapBadge :value="r.capabilities.permission" />
                  <CapBadge :value="r.capabilities.resume" />
                </span>
              </div>
            </div>

            <p class="hint">
              列表读的是探测缓存；「重试」只重探这一行（单项 3s 检测 + 最多 10s 健康检查），
              其余行不受影响。「重新探测」按顺序逐项重探。
              不可用原因优先显示后端 <code class="u-mono">probeDetail</code>（如「需要 ≥ 0.20.0，当前 0.1.0」）。
              能力「未知」表示运行时没有声明，不代表不支持。不提供权限请求的运行时（
              <code class="u-mono">permission: none</code>）会被强制跑在 worktree 里。
            </p>
          </template>
        </template>

        <!-- ================= 模型供应商 ================= -->
        <template v-else-if="tab === 'providers'">
          <div class="filters" style="min-height: auto">
            <span class="u-label">已配置</span>
            <span class="u-mono" style="color: var(--color-text-secondary)">
              {{ providers.providers.length }} 个 · 默认 {{ providers.defaultProvider?.name ?? "—" }}
            </span>
            <span class="spacer" />
            <button class="btn btn--sm btn--secondary" :disabled="providers.status === 'loading'" @click="providers.load()">
              刷新
            </button>
            <button class="btn btn--sm btn--secondary" @click="openCatalog">
              模型映射表
            </button>
            <button class="btn btn--sm btn--primary" @click="openAddProvider">添加供应商</button>
          </div>

          <div v-if="providers.status === 'loading' || providers.status === 'idle'" style="display: grid; gap: 10px">
            <div v-for="i in 3" :key="i" class="sk" style="height: 76px" />
          </div>

          <div v-else-if="providers.status === 'error'" class="banner">
            <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
            <span>读取模型供应商失败：{{ providers.errorText }}</span>
            <span class="spacer" />
            <button class="btn btn--sm" @click="providers.load()">重试</button>
          </div>

          <EmptyState
            v-else-if="providers.status === 'empty'"
            title="还没有配置模型供应商"
            description="内置引擎直连模型 API，需要至少一个供应商（OpenAI Chat Completions 或 Anthropic Messages 协议）。配好之后内置引擎在运行时列表里变为可用。"
          >
            <template #icon><AppIcon name="gear" :size="24" /></template>
            <template #actions>
              <button class="btn btn--primary" @click="openAddProvider">添加供应商</button>
            </template>
          </EmptyState>

          <template v-else>
            <div v-for="p in providers.providers" :key="p.id" class="card" style="padding: 14px 16px; margin-bottom: 10px">
              <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap">
                <div style="flex: 1; min-width: 220px">
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                    <span style="font-weight: var(--weight-semibold)">{{ p.name }}</span>
                    <span v-if="p.isDefault" class="chip is-on" style="cursor: default">默认</span>
                    <span class="chip" style="cursor: default">{{ p.protocol }}</span>
                  </div>
                  <div class="u-mono u-muted" style="font-size: var(--font-size-caption); margin-top: 4px">
                    {{ p.model }} · {{ p.contextWindow ? `${num(p.contextWindow)} token` : "窗口未知" }}
                  </div>
                  <div class="u-mono" style="font-size: var(--font-size-micro); color: var(--color-text-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                    {{ p.baseUrl }} · {{ p.apiKeyMasked }}
                  </div>
                </div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap">
                  <button class="btn btn--sm btn--secondary" :disabled="providerBusy === p.id" @click="testProvider(p)">
                    {{ providerBusy === p.id ? "测试中…" : "测试" }}
                  </button>
                  <button v-if="!p.isDefault" class="btn btn--sm btn--ghost" @click="setDefaultProvider(p)">设为默认</button>
                  <button class="btn btn--sm btn--ghost" @click="openEditProvider(p)">编辑</button>
                  <button class="btn btn--sm btn--danger" @click="removeProvider(p)">删除</button>
                </div>
              </div>
            </div>
            <p class="hint">
              apiKey 只保存在本机 <code class="u-mono">~/.agentbot/providers.json</code>（权限 0600），
              接口只回掩码。「测试」会发一次最小请求，不消耗工具调用。绑定供应商在 Bot 表单里选。
            </p>
          </template>
        </template>

        <!-- ================= 模型映射表 ================= -->
        <template v-else-if="tab === 'catalog'">
          <div class="filters" style="min-height: auto">
            <span class="u-label">生效规则</span>
            <span class="u-mono" style="color: var(--color-text-secondary)">
              覆盖 {{ catalogDraft.length }} 条 · 内置 {{ catalog?.builtin.length ?? 0 }} 条
            </span>
            <span class="spacer" />
            <button class="btn btn--sm btn--secondary" :disabled="catalogLoading" @click="loadCatalog">
              {{ catalogLoading ? "读取中…" : "重新读取" }}
            </button>
            <button class="btn btn--sm btn--primary" :disabled="catalogSaving" @click="saveCatalog">
              {{ catalogSaving ? "保存中…" : "保存覆盖规则" }}
            </button>
          </div>

          <div v-if="catalogErr" class="banner">
            <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
            <span>读取模型映射表失败：{{ catalogErr }}</span>
            <span class="spacer" />
            <button class="btn btn--sm" @click="loadCatalog">重试</button>
          </div>

          <div v-else-if="catalogLoading && !catalog" style="display: grid; gap: 10px">
            <div v-for="i in 3" :key="i" class="sk" style="height: 56px" />
          </div>

          <template v-else>
            <section class="card card-pad" style="margin-bottom: 14px">
              <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px">
                <div class="u-label" style="margin: 0">覆盖规则</div>
                <span class="chip" style="cursor: default">优先于内置表</span>
              </div>
              <p class="hint" style="margin-top: 0">
                匹配规则是正则，对模型 id 小写后按顺序取第一条命中。内置表认不出的模型会返回「未知」，
                在这里加一条就能补上；想改内置的某个值，加一条同 match 的规则顶掉即可。
              </p>

              <p v-if="catalogDraft.length === 0" class="hint">
                还没有覆盖规则。点下面「加一条」开始。
              </p>

              <div v-else class="card" style="padding: 6px; background: var(--color-surface-2)">
                <div class="grid-row is-head cat-head">
                  <span>匹配规则（正则）</span><span>上下文窗口</span><span>最大输出</span><span style="text-align: right">操作</span>
                </div>
                <div v-for="(rule, i) in catalogDraft" :key="`rule-${i}`" class="grid-row cat-row">
                  <span class="cat-field" data-label="匹配规则（正则）">
                    <input v-model="rule.match" class="cat-input" placeholder="如 ^my-model-200k$" />
                  </span>
                  <span class="cat-field" data-label="上下文窗口">
                    <input
                      :value="rule.contextWindow ?? ''"
                      class="cat-input"
                      placeholder="如 204800"
                      inputmode="numeric"
                      @input="rule.contextWindow = catalogNum(($event.target as HTMLInputElement).value)"
                    />
                  </span>
                  <span class="cat-field" data-label="最大输出">
                    <input
                      :value="rule.maxOutputTokens ?? ''"
                      class="cat-input"
                      placeholder="如 16384"
                      inputmode="numeric"
                      @input="rule.maxOutputTokens = catalogNum(($event.target as HTMLInputElement).value)"
                    />
                  </span>
                  <span class="cat-actions">
                    <button
                      class="btn btn--sm btn--ghost"
                      :disabled="rule.match.trim().length === 0 || catalogTestModel.trim().length === 0"
                      title="用下面输入的模型 id 试这条规则"
                      @click="testCatalogRule(rule)"
                    >试</button>
                    <button class="btn btn--sm btn--ghost" title="删除这条" @click="removeCatalogRule(i)">✕</button>
                  </span>
                </div>
              </div>

              <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px">
                <button class="btn btn--sm btn--secondary" @click="addCatalogRule">＋ 加一条</button>
                <input
                  v-model="catalogTestModel"
                  class="input u-mono"
                  style="width: 240px; font-size: var(--font-size-caption)"
                  placeholder="试匹配的模型 id，如 deepseek-v4.1-flash"
                />
              </div>
              <div v-if="catalogTestResult" class="hint">
                规则 <code class="u-mono">{{ catalogTestResult.match }}</code>
                对 <code class="u-mono">{{ catalogTestModel }}</code>
                {{ catalogTestResult.hit ? "命中" : "未命中" }}
              </div>
              <div v-if="catalogSaveErr" class="field-err" style="margin-top: 10px">{{ catalogSaveErr }}</div>
            </section>

            <section class="card card-pad">
              <div class="u-label" style="margin-bottom: 6px">
                内置规则 · {{ catalog?.builtinVersion }} 版（{{ catalog?.builtinUpdatedAt }}）
              </div>
              <p class="hint" style="margin-top: 0">
                只读，随代码升级。按顺序匹配，第一条命中即用。
              </p>
              <div class="card" style="padding: 6px; background: var(--color-surface-2)">
                <div class="grid-row is-head cat-head">
                  <span>匹配规则（正则）</span><span>上下文窗口</span><span>最大输出</span><span style="text-align: right">备注</span>
                </div>
                <div
                  v-for="(e, i) in catalog?.builtin ?? []"
                  :key="`b${i}`"
                  class="grid-row cat-row cat-builtin-row"
                >
                  <span class="cat-field cat-builtin-rule" data-label="匹配规则（正则）">
                    <span class="cat-rule-text">{{ e.match }}</span>
                  </span>
                  <span class="cat-field cat-builtin-nums" data-label="上下文窗口">
                    <span class="u-mono" style="font-variant-numeric: tabular-nums">{{ e.contextWindow ?? "—" }}</span>
                  </span>
                  <span class="cat-field" data-label="最大输出">
                    <span class="u-mono" style="font-variant-numeric: tabular-nums">{{ e.maxOutputTokens ?? "—" }}</span>
                  </span>
                  <span class="cat-note" style="text-align: right">{{ e.note ?? "" }}</span>
                </div>
              </div>
              <p v-if="(catalog?.sources.length ?? 0) > 0" class="hint" style="margin-top: 12px">
                来源：{{ catalog?.sources.join("；") }}
              </p>
            </section>
          </template>
        </template>


        <!-- ================= MCP ================= -->
        <template v-else-if="tab === 'mcp'">
          <div class="filters" style="min-height: auto">
            <span class="u-label">已配置</span>
            <span class="u-mono" style="color: var(--color-text-secondary)">
              {{ mcp.servers.length }} 个 · 已连接 {{ mcp.connectedCount }} · {{ mcp.toolCount }} 个工具
            </span>
            <span class="spacer" />
            <button class="btn btn--sm btn--secondary" :disabled="mcp.status === 'loading'" @click="mcp.load()">刷新</button>
            <button class="btn btn--sm btn--primary" @click="openAddMcp">添加 server</button>
          </div>

          <div v-if="!mcp.running" class="banner" style="margin-bottom: 12px">
            <span class="state-dot" :style="{ '--s': 'var(--state-waiting)' }" />
            <span>后端没有启动 MCP 管理器（可能是旧进程），保存后需重启服务才会连接。</span>
          </div>

          <div v-if="mcp.status === 'loading' || mcp.status === 'idle'" style="display: grid; gap: 10px">
            <div v-for="i in 3" :key="i" class="sk" style="height: 72px" />
          </div>

          <div v-else-if="mcp.status === 'error'" class="banner">
            <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
            <span>读取 MCP 配置失败：{{ mcp.errorText }}</span>
            <span class="spacer" />
            <button class="btn btn--sm" @click="mcp.load()">重试</button>
          </div>

          <EmptyState
            v-else-if="mcp.status === 'empty'"
            title="还没有 MCP server"
            description="配置一个 stdio MCP server 后，它的工具会以 mcp__<server>__<tool> 的名字出现在内置引擎里；每次调用都会走权限卡片。"
          >
            <template #icon><AppIcon name="gear" :size="24" /></template>
            <template #actions>
              <button class="btn btn--primary" @click="openAddMcp">添加 server</button>
            </template>
          </EmptyState>

          <template v-else>
            <div v-for="s in mcp.servers" :key="s.id" class="card" style="padding: 14px 16px; margin-bottom: 10px">
              <div style="display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap">
                <div style="flex: 1; min-width: 220px">
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                    <span style="font-weight: var(--weight-semibold)">{{ s.id }}</span>
                    <BotStateChip :state="mcpState(s)" :label="mcpStatusWord(s)" />
                    <span class="chip" style="cursor: default">{{ s.toolCount }} 个工具</span>
                    <span class="chip" style="cursor: default" :title="s.permission === 'read' ? '计划模式下仍可用' : '计划模式下会被裁掉'">
                      {{ mcpPermissionWord(s.permission) }}
                    </span>
                    <span v-if="!s.enabled" class="chip" style="cursor: default">已停用</span>
                  </div>
                  <div class="u-mono" style="font-size: var(--font-size-micro); color: var(--color-text-muted); margin-top: 4px; word-break: break-all">
                    {{ s.command }} {{ s.args.join(" ") }}
                  </div>
                  <div v-if="s.error" class="field-err" style="margin-top: 6px">{{ s.error }}</div>
                  <div v-if="s.tools.length > 0" class="hint" style="margin-top: 6px">
                    {{ s.tools.slice(0, 6).map((t) => t.name).join("、") }}{{ s.tools.length > 6 ? ` 等 ${s.tools.length} 个` : "" }}
                  </div>
                </div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap">
                  <button
                    v-if="s.enabled"
                    class="btn btn--sm btn--secondary"
                    :disabled="mcp.busyId === s.id"
                    @click="reconnectMcp(s)"
                  >{{ mcp.busyId === s.id ? "重连中…" : "重连" }}</button>
                  <button class="btn btn--sm btn--ghost" @click="toggleMcp(s)">{{ s.enabled ? "停用" : "启用" }}</button>
                  <button class="btn btn--sm btn--ghost" @click="openEditMcp(s)">编辑</button>
                  <button class="btn btn--sm btn--danger" @click="removeMcp(s)">删除</button>
                </div>
              </div>
            </div>
            <p class="hint">
              配置保存在 <code class="u-mono">~/.agentbot/mcp.json</code>。MCP 工具默认权限为「执行」，
              每次调用都会弹权限卡片；拒绝后模型会换做法，不会自动重试。
            </p>
          </template>
        </template>

        <!-- ================= 技能 ================= -->
        <template v-else-if="tab === 'skills'">
          <div class="filters" style="min-height: auto">
            <span class="u-label">技能目录</span>
            <span class="u-mono" style="color: var(--color-text-secondary); word-break: break-all">
              {{ skills.dir || "~/.agentbot/skills" }}
            </span>
            <span class="spacer" />
            <button class="btn btn--sm btn--secondary" :disabled="skills.status === 'loading'" @click="rescanSkills">
              重扫
            </button>
          </div>

          <div v-if="skills.status === 'loading' || skills.status === 'idle'" style="display: grid; gap: 10px">
            <div v-for="i in 3" :key="i" class="sk" style="height: 64px" />
          </div>

          <div v-else-if="skills.status === 'error'" class="banner">
            <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
            <span>读取技能失败：{{ skills.errorText }}</span>
            <span class="spacer" />
            <button class="btn btn--sm" @click="skills.load()">重试</button>
          </div>

          <EmptyState
            v-else-if="skills.status === 'empty'"
            title="还没有技能"
            description="在技能目录下建一个 <name>/SKILL.md（frontmatter 至少写 name 与 description），然后点「重扫」。技能索引会进系统提示，模型需要细节时用 read_skill 读取全文。"
          >
            <template #icon><AppIcon name="gear" :size="24" /></template>
            <template #actions>
              <button class="btn btn--secondary" @click="rescanSkills">重新扫描</button>
            </template>
          </EmptyState>

          <template v-else>
            <div v-for="s in skills.skills" :key="s.dirName" class="card" style="padding: 14px 16px; margin-bottom: 10px">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <span style="font-weight: var(--weight-semibold)">{{ s.name }}</span>
                <!-- N2：内置技能包随代码分发，技能页标出来 -->
                <span v-if="s.builtin" class="cap cap--scope" title="随代码分发的基础技能包；改过的内容不会被升级覆盖">内置</span>
              </div>
              <div style="font-size: var(--font-size-caption); color: var(--color-text-secondary); margin-top: 4px">
                {{ s.description || "（无描述）" }}
              </div>
              <div class="u-mono" style="font-size: var(--font-size-micro); color: var(--color-text-muted); margin-top: 6px; word-break: break-all">
                {{ s.path }}
              </div>
            </div>
            <p class="hint">
              技能索引总长度上限 800 字符、最多 12 条；超出部分不注入，模型可用
              <code class="u-mono">list_skills</code> 发现、<code class="u-mono">read_skill</code> 读取。
              改动 SKILL.md 后下一轮对话即生效（扫描按目录 mtime 自动失效，不需要重启）。
              哪个 Bot 启用哪些技能在 Bot 详情的「技能」标签里设置。
            </p>
          </template>
        </template>

        <!-- ================= 安全与 token ================= -->
        <template v-else-if="tab === 'security'">
          <div style="display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; align-items: start" class="detail-grid">
            <section class="card card-pad">
              <div class="u-label" style="margin-bottom: 8px">访问 token</div>
              <p style="font-size: var(--font-size-caption); color: var(--color-text-muted); line-height: 1.8; margin-bottom: 14px">
                所有 HTTP 与实时推送请求都要带 token。重置后 10 秒内断开所有已连接客户端，
                并需要你用新的访问地址重新打开。
              </p>

              <div v-if="tokenError" class="field-err" style="margin-bottom: 12px">{{ tokenError }}</div>

              <pre
                v-if="tokenStatus"
                class="u-mono"
                style="margin: 0 0 14px; padding: 12px; background: var(--color-surface-2); border-radius: 8px; color: var(--color-text-secondary); overflow: auto; white-space: pre-wrap; word-break: break-all"
              >{{ tokenStatus.url ?? "—" }}
token  {{ tokenStatus.preview }}</pre>
              <div v-else-if="tokenLoading" class="sk" style="height: 48px; margin-bottom: 14px" />
              <p v-else class="hint" style="margin-bottom: 14px">
                读不到 token 状态（端点未接入）。重置按钮仍可用，重置后服务会打印新地址。
              </p>

              <button class="btn btn--sm btn--danger" :disabled="resetting" @click="resetOpen = true">
                重置 token
              </button>

              <!-- 重置结果：把新 URL 摆出来，让人复制后自己打开 -->
              <div v-if="resetResult" class="banner banner--warn" style="margin: 16px 0 0">
                <div style="flex: 1; min-width: 0">
                  <div style="font-weight: var(--weight-semibold); margin-bottom: 4px">
                    token 已重置 · 已断开 {{ resetResult.closedStreams }} 个实时连接
                  </div>
                  <div class="u-mono" style="font-size: 11.5px; word-break: break-all">{{ resetResult.url }}</div>
                  <div style="font-size: var(--font-size-micro); margin-top: 4px; opacity: .85">
                    当前标签页已失效，请复制上面的地址在新标签页打开。
                  </div>
                </div>
                <button class="btn btn--sm btn--secondary" @click="copyUrl">复制</button>
              </div>
            </section>

            <section class="card card-pad">
              <div class="u-label" style="margin-bottom: 10px">当前连接</div>
              <div class="kv">
                <span class="k">实时连接</span>
                <span class="v">{{ tokenStatus ? tokenStatus.activeStreams : "—" }}</span>
              </div>
              <div class="kv">
                <span class="k">监听</span>
                <span class="v u-mono">127.0.0.1</span>
              </div>
              <div class="kv">
                <span class="k">鉴权</span>
                <span class="v">token（?t= 或 HttpOnly cookie）</span>
              </div>
              <p class="hint">
                「实时连接」是当前打开的 SSE 长连接数（每个会话一条）。
                重置 token 会把它们全部断开。
              </p>
            </section>
          </div>
        </template>

        <!-- ================= 数据与保留 ================= -->
        <template v-else-if="tab === 'data'">
          <div style="display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; align-items: start" class="detail-grid">
            <section class="card card-pad">
              <div class="u-label" style="margin-bottom: 12px">保留策略</div>
              <div class="radio-row">
                <label v-for="d in [90, 180, 365]" :key="d" class="radio">
                  <input
                    type="radio"
                    name="retention"
                    :value="d"
                    :checked="retention === d"
                    @change="retention = d"
                  />
                  {{ d }} 天
                </label>
              </div>
              <p class="hint">
                用量与权限审计固定保留 365 天；消息与事件按这里的设置清理。
                <strong>当前版本后端还没有保留策略端点</strong>，这个选择不会落库 ——
                清理由服务启动时的维护任务按配置执行，暂不可在界面内修改。
              </p>

              <div class="u-label" style="margin: 24px 0 10px">导出</div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <button class="btn btn--sm btn--secondary" @click="exportUsage">用量 CSV</button>
                <button
                  class="btn btn--sm btn--secondary"
                  disabled
                  title="后端尚未提供 Session JSON 导出端点"
                >Session JSON</button>
                <button
                  class="btn btn--sm btn--secondary"
                  disabled
                  title="后端尚未提供记忆 Markdown 导出端点"
                >记忆 Markdown</button>
              </div>
              <p class="hint">置灰的两个导出后端尚未提供，不做假下载。</p>
            </section>

            <section class="card card-pad">
              <div class="u-label" style="margin-bottom: 8px">数据整理</div>
              <p style="font-size: var(--font-size-caption); color: var(--color-text-muted); line-height: 1.8; margin-bottom: 12px">
                归档或删除 Bot 之后，它的会话、消息与事件不会自己消失，会继续占着列表和磁盘。
                这里清理这些孤儿数据 —— 先预览，再执行。
              </p>

              <div v-if="tidyPreview" style="margin-bottom: 12px">
                <div class="u-label" style="margin: 0 0 8px">选择要整理的数据</div>
                <label
                  v-for="opt in TIDY_OPTIONS"
                  :key="opt.key"
                  class="radio"
                  style="display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; opacity: tidyCountOf(opt.key) === 0 ? .5 : 1"
                >
                  <input
                    type="checkbox"
                    :checked="tidyTargets.includes(opt.key)"
                    :disabled="tidyCountOf(opt.key) === 0"
                    @change="toggleTidyTarget(opt.key)"
                  />
                  <span>
                    <b>{{ opt.label }}</b>
                    <span class="u-mono" style="margin-left: 6px">{{ tidyCountOf(opt.key) }}</span>
                    <span style="display: block; font-size: var(--font-size-micro); color: var(--color-text-muted)">{{ opt.desc }}</span>
                  </span>
                </label>
                <div class="kv"><span class="k">合计会话 / 消息 / 事件</span><span class="v u-mono">{{ tidyPreview.sessions }} / {{ tidyPreview.messages }} / {{ tidyPreview.events }}</span></div>
                <ul v-if="tidyPreview.channels.length > 0" class="hint" style="margin: 8px 0 0; padding-left: 18px">
                  <li v-for="c in tidyPreview.channels.slice(0, 6)" :key="c.id">
                    {{ c.type === "group" ? "群聊" : "私聊" }} · {{ c.name }}
                  </li>
                  <li v-if="tidyPreview.channels.length > 6">…还有 {{ tidyPreview.channels.length - 6 }} 个</li>
                </ul>
              </div>
              <div v-else-if="tidyError" class="field-err" style="margin-bottom: 12px">{{ tidyError }}</div>

              <div style="display: flex; gap: 8px; flex-wrap: wrap">
                <button class="btn btn--sm btn--secondary" :disabled="tidyBusy" @click="previewTidy">
                  {{ tidyBusy ? "统计中…" : "预览可整理数据" }}
                </button>
                <button
                  class="btn btn--sm btn--danger"
                  :disabled="tidyBusy || !tidyPreview || tidyTargets.length === 0"
                  @click="applyTidy"
                >
                  整理选中项
                </button>
              </div>
              <p v-if="tidyResult" class="hint" style="margin-top: 10px">
                已清理：渠道 {{ tidyResult["channels"] ?? 0 }} · 会话 {{ tidyResult["sessions"] ?? 0 }} ·
                消息 {{ tidyResult["messages"] ?? 0 }} · 事件 {{ tidyResult["events"] ?? 0 }} ·
                记忆 {{ tidyResult["memories"] ?? 0 }} · 用量 {{ tidyResult["orphanUsage"] ?? 0 }}
              </p>
            </section>

            <section class="card card-pad">
              <div class="u-label" style="margin-bottom: 8px; color: var(--color-danger-ink)">全量删除</div>
              <p style="font-size: var(--font-size-caption); color: var(--color-text-muted); line-height: 1.8; margin-bottom: 12px">
                需要输入确认短语。删除后不可恢复；worktree 目录不会被删除（那是你的文件）。
              </p>
              <button class="btn btn--sm btn--danger" @click="purgeOpen = true; purgeInput = ''; purgeError = ''">
                执行删除
              </button>
            </section>
          </div>
        </template>

        <!-- ================= 权限审计 ================= -->
        <template v-else>
          <div class="filters" style="min-height: auto">
            <span class="u-label">筛选</span>
            <button class="chip" :class="{ 'is-on': auditBotFilter === 'all' }" @click="auditBotFilter = 'all'">
              全部 Bot
            </button>
            <button
              v-for="b in bots.bots"
              :key="b.id"
              class="chip"
              :class="{ 'is-on': auditBotFilter === b.id }"
              @click="auditBotFilter = b.id"
            >{{ b.name }}</button>
            <span class="spacer" />
            <button class="btn btn--sm btn--secondary" :disabled="auditLoading" @click="loadAudit">
              {{ auditLoading ? "读取中…" : "刷新" }}
            </button>
          </div>

          <div v-if="auditLoading" style="display: grid; gap: 8px">
            <div v-for="i in 5" :key="i" class="sk" style="height: 40px" />
          </div>

          <div v-else-if="auditError" class="banner">
            <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
            <span>读取审计失败：{{ auditError }}</span>
            <span class="spacer" />
            <button class="btn btn--sm" @click="loadAudit">重试</button>
          </div>

          <EmptyState
            v-else-if="auditMissing"
            title="审计端点尚未接入"
            description="这个版本的后端没有提供权限记录查询接口，页面不显示假数据。"
          >
            <template #icon><AppIcon name="tasks" :size="24" /></template>
          </EmptyState>

          <EmptyState
            v-else-if="auditFiltered.length === 0"
            title="还没有已决的权限记录"
            description="在会话里批准或拒绝一次动作后，记录会出现在这里。待批的卡片在会话里处置。"
          >
            <template #icon><AppIcon name="tasks" :size="24" /></template>
            <template #actions>
              <RouterLink class="btn btn--secondary" to="/chats">去会话</RouterLink>
            </template>
          </EmptyState>

          <template v-else>
            <div class="card" style="padding: 8px">
              <div class="grid-row is-head audit-table-row">
                <span>时间</span><span>Bot</span><span>动作</span><span>决定</span><span>操作者</span>
              </div>
              <div
                v-for="(a, i) in auditFiltered"
                :key="a.id"
                class="grid-row audit-table-row enter"
                :style="{ '--i': Math.min(i, 5), cursor: 'default' }"
              >
                <span class="audit-time u-mono u-muted">{{ dayTimeText(a.decidedAt ?? a.createdAt) }}</span>
                <span class="audit-bot" style="display: flex; align-items: center; gap: 8px">
                  <BotAvatar :name="a.botName" :color-index="botColorOf(a.botId)" :size="20" />
                  <span style="font-size: var(--font-size-caption)">{{ a.botName }}</span>
                </span>
                <span class="audit-act u-mono" style="font-size: 11.5px; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                  {{ ACTION_WORD[a.action] ?? a.action }} · {{ a.target }}
                </span>
                <span
                  class="audit-decision"
                  :style="{ color: decisionOf(a).ok ? 'var(--color-success-ink)' : 'var(--color-danger-ink)', fontSize: 'var(--font-size-caption)', fontWeight: 600 }"
                >{{ decisionOf(a).text }}</span>
                <span class="audit-by u-muted" style="font-size: var(--font-size-caption)">{{ actorOf(a) }}</span>
              </div>
            </div>
            <p class="hint">
              审计记录只可导出，不能在界面内删除。
              <template v-if="auditTruncated">
                仅显示最近 {{ AUDIT_SESSION_LIMIT }} 个 Session 的记录。
              </template>
            </p>
          </template>
        </template>
      </div>
    </div>

    <!-- 重置 token 确认 -->
    <AppModal v-model:open="resetOpen" title="重置访问 token">
      <div class="banner banner--warn" style="margin-bottom: 12px">
        <span class="state-dot" :style="{ '--s': 'var(--state-warning)' }" />
        <span>重置后当前所有标签页与实时连接会立即失效，必须用新地址重新打开。</span>
      </div>
      <ul style="font-size: var(--font-size-caption); color: var(--color-text-secondary); line-height: 1.9; padding-left: 1.2em">
        <li>新 token 会写入 <code class="u-mono">~/.agentbot/token</code>，旧 token 立刻作废。</li>
        <li>所有 SSE 长连接会被主动断开（不等心跳超时）。</li>
        <li>正在执行的任务不受影响，它们继续在后台跑。</li>
      </ul>
      <template #footer>
        <button class="btn btn--secondary" @click="resetOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--danger" :disabled="resetting" @click="resetToken">
          {{ resetting ? "重置中…" : "确认重置" }}
        </button>
      </template>
    </AppModal>

    <!-- 全量删除确认（输入确认短语） -->
    <AppModal v-model:open="purgeOpen" title="删除全部数据">
      <div class="banner" style="margin-bottom: 12px">
        <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
        <span>这是不可逆操作。Bot、会话、消息、事件、记忆、任务、定时任务与用量都会被删除。</span>
      </div>
      <div class="field">
        <label class="u-label" for="purge-confirm">
          输入「{{ PURGE_PHRASE }}」以确认
        </label>
        <input
          id="purge-confirm"
          v-model="purgeInput"
          class="input"
          :placeholder="PURGE_PHRASE"
          autocomplete="off"
          @input="purgeError = ''"
        />
        <div v-if="purgeError" class="field-err" role="alert">{{ purgeError }}</div>
        <div v-else class="hint">
          运行时探测缓存与数据库结构会保留，所以删完还能直接重新开始建 Bot。
          worktree 目录（<code class="u-mono">~/.agentbot/wt</code>）不会被删除。
        </div>
      </div>
      <template #footer>
        <button class="btn btn--secondary" @click="purgeOpen = false">取消</button>
        <span class="spacer" />
        <button
          class="btn btn--danger"
          :disabled="purging || purgeInput.trim() !== PURGE_PHRASE"
          @click="purgeAll"
        >{{ purging ? "删除中…" : "永久删除" }}</button>
      </template>
    </AppModal>

    <!-- 手动添加自定义运行时（P0-01） -->
    <AppModal v-model:open="addOpen" title="手动添加运行时">
      <div class="banner banner--info" style="margin-bottom: 16px">
        <span class="state-dot" :style="{ '--s': 'var(--state-thinking)' }" />
        <span>
          自定义运行时没有声明文件，能力与事件掩码按所选协议保守推导。
          添加后会立即探测一次；探测失败也会保存，之后可在行内「重试」。
        </span>
      </div>

      <div class="field">
        <label class="u-label" for="rt-add-name">显示名称</label>
        <input
          id="rt-add-name"
          v-model="addForm.displayName"
          class="input"
          placeholder="例如：我的 Codex"
          autocomplete="off"
          @input="onAddNameInput"
        />
        <div v-if="addErrors['displayName']" class="field-err" role="alert">{{ addErrors["displayName"] }}</div>
      </div>

      <div class="field">
        <label class="u-label" for="rt-add-id">标识（id）</label>
        <input
          id="rt-add-id"
          v-model="addForm.id"
          class="input u-mono"
          placeholder="例如：my-codex"
          autocomplete="off"
          @input="onAddIdInput"
        />
        <div v-if="addErrors['id']" class="field-err" role="alert">{{ addErrors["id"] }}</div>
        <div v-else class="hint">只允许字母、数字、- 和 _，且以字母或数字开头；留空时按名称生成。</div>
      </div>

      <div class="field">
        <label class="u-label" for="rt-add-protocol">协议</label>
        <select id="rt-add-protocol" v-model="addForm.protocol" class="select">
          <option v-for="p in PROTOCOLS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <div v-if="addErrors['protocol']" class="field-err" role="alert">{{ addErrors["protocol"] }}</div>
        <div v-else class="hint">{{ protocolHint }}</div>
      </div>

      <div class="field">
        <label class="u-label" for="rt-add-command">启动命令</label>
        <input
          id="rt-add-command"
          v-model="addForm.command"
          class="input u-mono"
          placeholder="例如：codex 或 D:/tools/agent.exe"
          autocomplete="off"
        />
        <div v-if="addErrors['command']" class="field-err" role="alert">{{ addErrors["command"] }}</div>
        <div v-else class="hint">可执行文件名或绝对路径。重复添加同一可执行文件会提示「已存在」。</div>
      </div>

      <div class="field">
        <label class="u-label" for="rt-add-args">参数</label>
        <textarea
          id="rt-add-args"
          v-model="addForm.argsText"
          class="textarea u-mono"
          rows="3"
          placeholder="--serve&#10;--port&#10;9000"
        />
        <div class="hint">每行一个参数；含空格的参数整行保留为一个 argv 元素。</div>
      </div>

      <div v-if="addErrors['general']" class="field-err" role="alert">{{ addErrors["general"] }}</div>

      <template #footer>
        <button class="btn btn--secondary" :disabled="adding" @click="addOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--primary" :disabled="adding" @click="submitAdd">
          {{ adding ? "添加并探测中…" : "添加" }}
        </button>
      </template>
    </AppModal>

    <!-- 添加 / 编辑模型供应商 -->
    <AppModal v-model:open="providerOpen" :title="editingProviderId ? '编辑模型供应商' : '添加模型供应商'">
      <div class="field">
        <label class="u-label" for="pv-name">名称</label>
        <input id="pv-name" v-model="providerForm.name" class="input" placeholder="例如：DeepSeek 网关" />
      </div>
      <div class="field">
        <label class="u-label" for="pv-protocol">协议</label>
        <select id="pv-protocol" v-model="providerForm.protocol" class="select">
          <option value="openai-chat">OpenAI Chat Completions（含兼容网关）</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
        <div class="hint">协议决定请求体与流式事件格式；选错会在「测试」时给出供应商原始错误。</div>
      </div>
      <div class="field">
        <label class="u-label" for="pv-base">Base URL</label>
        <input id="pv-base" v-model="providerForm.baseUrl" class="input u-mono" placeholder="https://api.example.com/v1" autocomplete="off" />
        <div class="hint">不含 <code class="u-mono">/chat/completions</code> 或 <code class="u-mono">/v1/messages</code>；带不带 <code class="u-mono">/v1</code> 都行。</div>
      </div>
      <div class="field">
        <label class="u-label" for="pv-key">API Key</label>
        <input
          id="pv-key"
          v-model="providerForm.apiKey"
          class="input u-mono"
          type="password"
          autocomplete="new-password"
          :placeholder="editingProviderId ? '留空表示不修改' : 'sk-…'"
        />
        <div class="hint">只写入本机 providers.json（0600），接口只回掩码。</div>
      </div>
      <div class="field">
        <label class="u-label" for="pv-model">模型</label>
        <div style="display: flex; gap: 8px; align-items: flex-start">
          <input
            v-if="modelList.length === 0"
            id="pv-model"
            v-model="providerForm.model"
            class="input u-mono"
            style="flex: 1"
            placeholder="例如：deepseek-chat（也可以点右侧拉取）"
          />
          <select
            v-else
            id="pv-model"
            v-model="providerForm.model"
            class="select u-mono"
            style="flex: 1"
            @change="onModelPick"
          >
            <option v-for="m in modelList" :key="m.id" :value="m.id">
              {{ m.label === m.id ? m.id : `${m.id} · ${m.label}` }}
            </option>
          </select>
          <button
            class="btn btn--sm btn--secondary"
            :disabled="modelListBusy"
            :title="'用当前 Base URL 与 API Key 拉取可用模型'"
            @click="loadModels"
          >
            {{ modelListBusy ? "拉取中…" : "拉取模型" }}
          </button>
        </div>
        <div v-if="modelListErr" class="field-err" style="margin-top: 6px">{{ modelListErr }}</div>
        <div v-else-if="modelList.length > 0 && !modelListAllKnown" class="hint">
          部分模型的上下文窗口来自命名推断，请核对后按需修改。
        </div>
        <div v-else-if="modelList.length > 0" class="hint">
          已拉到 {{ modelList.length }} 个模型；选中后自动带出上下文与输出上限，可手改。
        </div>
        <div v-else class="hint">
          点「拉取模型」可从当前 Key 读取模型清单；拉不到时手填也可以。
        </div>
      </div>
      <div class="field">
        <label class="u-label" for="pv-window">上下文窗口（token）</label>
        <input id="pv-window" v-model="providerForm.contextWindow" class="input u-mono" placeholder="留空表示未知（用协议默认值）" inputmode="numeric" />
      </div>
      <div class="field">
        <label class="u-label" for="pv-out">最大输出 token</label>
        <input id="pv-out" v-model="providerForm.maxOutputTokens" class="input u-mono" placeholder="留空表示不限制，由供应商默认" inputmode="numeric" />
        <div class="hint">这是单次回复的上限，不是上下文窗口。留空时请求里不发送该参数。</div>
      </div>

      <!-- 模型能力对照表入口：单独一块，不做成提示文字里的链接 -->
      <div
        style="
          display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
          padding: 10px 12px; margin-bottom: 14px;
          background: var(--color-surface-2); border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
        "
      >
        <div style="flex: 1; min-width: 180px">
          <div style="font-size: var(--font-size-caption); font-weight: var(--weight-semibold)">
            上下文窗口与最大输出从哪来
          </div>
          <div style="font-size: var(--font-size-micro); color: var(--color-text-muted); margin-top: 2px">
            按模型名自动带出；认不出的模型留空，不猜。
          </div>
        </div>
        <button class="btn btn--sm btn--secondary" @click="openCatalog">
          维护模型映射表
        </button>
      </div>

      <div class="field">
        <label class="radio">
          <input v-model="providerForm.supportsTools" type="checkbox" />
          支持工具调用
        </label>
        <label class="radio" style="margin-left: 16px">
          <input v-model="providerForm.supportsStreaming" type="checkbox" />
          支持流式输出
        </label>
      </div>
      <div v-if="providerErr" class="field-err" role="alert">{{ providerErr }}</div>
      <template #footer>
        <button class="btn btn--secondary" :disabled="providerSaving" @click="providerOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--primary" :disabled="providerSaving" @click="saveProvider">
          {{ providerSaving ? "保存中…" : "保存" }}
        </button>
      </template>
    </AppModal>


    <!-- 添加 / 编辑 MCP server -->
    <AppModal v-model:open="mcpOpen" :title="editingMcpId ? '编辑 MCP server' : '添加 MCP server'">
      <div class="field">
        <label class="u-label" for="mcp-id">ID</label>
        <input
          id="mcp-id"
          v-model="mcpForm.id"
          class="input u-mono"
          placeholder="例如：filesystem"
          :disabled="!!editingMcpId"
          autocomplete="off"
        />
        <div class="hint">工具名会拼成 <code class="u-mono">mcp__&lt;id&gt;__&lt;tool&gt;</code>；创建后不可改。</div>
      </div>
      <div class="field">
        <label class="u-label" for="mcp-command">启动命令</label>
        <input id="mcp-command" v-model="mcpForm.command" class="input u-mono" placeholder="例如：npx" autocomplete="off" />
      </div>
      <div class="field">
        <label class="u-label" for="mcp-args">参数</label>
        <textarea
          id="mcp-args"
          v-model="mcpForm.argsText"
          class="textarea u-mono"
          rows="3"
          placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;D:/workspace"
        />
        <div class="hint">每行一个参数；含空格的参数整行保留为一个 argv 元素。</div>
      </div>
      <div class="field">
        <label class="u-label" for="mcp-permission">工具权限</label>
        <select id="mcp-permission" v-model="mcpForm.permission" class="select">
          <option value="read">只读（计划模式下仍可用）</option>
          <option value="write">写文件</option>
          <option value="exec">执行（默认）</option>
          <option value="network">联网</option>
        </select>
        <div class="hint">
          非只读的 MCP 工具在计划模式下会从工具表里裁掉；每次调用都会走权限卡片。
        </div>
      </div>
      <div class="field">
        <label class="radio">
          <input v-model="mcpForm.enabled" type="checkbox" />
          启用并连接
        </label>
      </div>
      <div v-if="mcpErr" class="field-err" role="alert">{{ mcpErr }}</div>
      <template #footer>
        <button class="btn btn--secondary" :disabled="mcpSaving" @click="mcpOpen = false">取消</button>
        <span class="spacer" />
        <button class="btn btn--primary" :disabled="mcpSaving" @click="saveMcp">
          {{ mcpSaving ? "保存中…" : "保存" }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
/* 运行时表：状态列要同时放 chip 与「重试」，比默认宽 40px。
   <900px 由 base.css 的两列断点覆盖（那里带 !important）。 */
.runtime-row {
  grid-template-columns: 150px 90px 110px minmax(0, 1fr) 150px 200px;
}
.rt-name {
  min-width: 0;
}
.rt-reason {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.45;
  font-weight: var(--weight-regular);
  color: var(--color-warning-ink);
  white-space: normal;
  overflow-wrap: anywhere;
}
.rt-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.rt-status .btn {
  height: 22px;
  padding: 0 6px;
  font-size: 11px;
}
/* 409 already_exists：滚到已有条目并闪两次主色描边（暗色下同样可见） */
.runtime-row.is-highlight {
  animation: rtFlash 1.5s var(--ease-out) 2;
}
@keyframes rtFlash {
  0%,
  100% {
    background: transparent;
    box-shadow: none;
  }
  50% {
    background: var(--color-primary-soft);
    box-shadow: inset 0 0 0 2px var(--color-primary);
  }
}
</style>
