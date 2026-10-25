<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api, isMissingEndpoint } from "../net/client";
import type {
  PermissionDto,
  RuntimeDetailDto,
  RuntimeProtocol,
  TokenStatusResponse,
} from "../net/types";
import { useBotsStore } from "../stores/bots";
import { useChannelsStore } from "../stores/channels";
import { useRuntimesStore } from "../stores/runtimes";
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

type TabKey = "runtimes" | "security" | "data" | "audit";
const TABS: { key: TabKey; label: string }[] = [
  { key: "runtimes", label: "运行时" },
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
// 生命周期
// ---------------------------------------------------------------------------
onMounted(async () => {
  ui.setCrumb([{ text: "设置" }]);
  if (runtimes.runtimes.length === 0) void runtimes.load();
  void loadToken();
  void loadAudit();
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
