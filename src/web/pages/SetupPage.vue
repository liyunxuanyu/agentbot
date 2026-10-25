<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api } from "../net/client";
import { openStream, type SseConnection } from "../net/stream";
import type { BotDto, FieldErrorDto, RuntimeDetailDto, SseFrame } from "../net/types";
import { useRuntimesStore } from "../stores/runtimes";
import { useBotsStore } from "../stores/bots";
import { useUiStore } from "../stores/ui";
import { botVars } from "../lib/botVars";
import { num } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import BotStateChip from "../components/bot/BotStateChip.vue";
import CapBadge from "../components/common/CapBadge.vue";

/**
 * /setup —— 首启向导（UX F1，S1「≤60s 到第一条消息」）。
 *
 * 三步：探测运行时 → 创建 Bot → 发第一条消息。全部接真实端点：
 *   ① `GET /api/runtimes`（探测结果，启动时已缓存）
 *   ② `POST /api/bots`（重名由后端 400 + fields 拦下，内联报错）
 *   ③ `POST /api/channels` 建私聊 → `POST /api/messages` → `GET /api/stream` 流式
 *
 * 四态（UX §4.1 `/setup` 行）：
 *   空   = 全部未安装 → 安装指引 + 「先跳过」，**不阻断**进入工作台
 *   加载 = 每行独立骨架（不整页转圈，也不阻塞其它行）
 *   正常 = 逐项出结果（每项显示名称 / 版本 / 路径 / 状态）
 *   错误 = 探测本身失败（本地服务无响应）→ 顶部 banner + 重试，行保持骨架
 *
 * 为什么「逐项出现」是动画而不是真的并发探测：探测发生在服务启动时
 * （`adapters/probe.ts` 并发 + 单项 3s 超时），渲染时读的是缓存 —— 架构 §3.8 明确
 * 要求不在渲染路径探测。这里按 420ms 间隔依次揭示，是对「每项独立、互不阻塞」
 * 的如实表达，不是假进度条：每行一旦出现就是终态，不会再跳。
 */
const router = useRouter();
const runtimes = useRuntimesStore();
const bots = useBotsStore();
const ui = useUiStore();

// ---------------------------------------------------------------------------
// 步骤与探测
// ---------------------------------------------------------------------------
const STEP_NAMES = ["探测运行时", "创建 Bot", "发第一条消息"] as const;
const step = ref<1 | 2 | 3>(1);

/** 已揭示的运行时 id（逐项出现）。 */
const revealed = ref<string[]>([]);
let revealTimer: number | null = null;

function stopReveal(): void {
  if (revealTimer !== null) {
    window.clearInterval(revealTimer);
    revealTimer = null;
  }
}

/**
 * 逐项揭示。
 *
 * 已揭示的数量只增不减：重试时不清空，避免用户已经看到的行「消失再出现」。
 * 全部揭示完后停表。
 */
function startReveal(): void {
  stopReveal();
  const list = runtimes.runtimes;
  if (list.length === 0) {
    revealed.value = [];
    return;
  }
  revealTimer = window.setInterval(() => {
    const next = list.find((r) => !revealed.value.includes(r.id));
    if (!next) {
      stopReveal();
      return;
    }
    revealed.value = [...revealed.value, next.id];
  }, 420);
}

/** 探测行（未揭示的用骨架，已揭示的用真实结果）。 */
interface ProbeRow {
  id: string;
  name: string;
  state: "pending" | "ready" | "missing" | "timeout" | "unhealthy" | "unprobed";
  detail: string;
}

const probeRows = computed<ProbeRow[]>(() =>
  runtimes.runtimes.map((r) => ({
    id: r.id,
    name: r.displayName,
    state: revealed.value.includes(r.id)
      ? (r.availability as ProbeRow["state"])
      : "pending",
    detail: revealed.value.includes(r.id) ? describeRuntime(r) : "",
  })),
);

/** 一行的副标题：可用时给「版本 · 可执行路径」，不可用时给原因。 */
function describeRuntime(r: RuntimeDetailDto): string {
  if (r.availability === "ready") {
    const version = r.version ? `v${r.version}` : "版本未知";
    return `${version} · ${r.executable ?? r.command}`;
  }
  if (r.availability === "missing") return "PATH 中未找到可执行文件";
  if (r.availability === "timeout") return "检测超时（3s 无响应）";
  if (r.availability === "unhealthy") return r.probeDetail ?? "健康检查失败";
  return "尚未探测";
}

const probeDone = computed(
  () => runtimes.runtimes.length > 0 && revealed.value.length >= runtimes.runtimes.length,
);

/**
 * 全部未安装：给安装指引（这不是错误）。
 *
 * 覆盖两种来源：`status === "empty"`（`/api/runtimes` 返回空数组 = 声明目录里一个
 * 运行时都没有）与「有运行时但一个都不可用」（都 missing/timeout）。后者才是
 * 「PATH 里没装 agent」的常见形态 —— 声明是内置的，运行时是探测出来的。
 */
const noneInstalled = computed(() => {
  if (runtimes.status === "empty") return true;
  return runtimes.status === "ready" && runtimes.readyCount === 0 && probeDone.value;
});

const usableRuntimes = computed(() => runtimes.bindable);

onMounted(async () => {
  ui.setCrumb([{ text: "首次启动" }]);
  await reloadProbe();
});

async function reloadProbe(): Promise<void> {
  stopReveal();
  await runtimes.load();
  startReveal();
}

const INSTALL_COMMANDS = "npm i -g @google/gemini-cli\nnpm i -g @openai/codex";

/** 复制安装命令（空态引导里唯一的「可执行」动作）。 */
function copyInstall(): void {
  void navigator.clipboard
    ?.writeText(INSTALL_COMMANDS)
    .then(() => ui.toast("已复制安装命令"))
    .catch(() => ui.toast("复制失败，请手动选择"));
}

async function retryOne(id: string): Promise<void> {
  // 单运行时重探：只调 /api/runtimes/:id/probe，其余步骤的行不受影响（P0-01）
  try {
    const rt = await runtimes.probeOne(id);
    ui.toast(
      rt.availability === "ready"
        ? `${rt.displayName} 可用`
        : `${rt.displayName}：${runtimes.reasonOf(rt)}`,
    );
  } catch (err) {
    ui.toast(
      err instanceof ApiError
        ? `探测失败：${err.bodyMessage ?? err.code}`
        : "探测失败，请重试",
    );
  }
}

// ---------------------------------------------------------------------------
// 第二步：创建 Bot
// ---------------------------------------------------------------------------
const form = reactive({
  name: "",
  persona: "用这个 Bot 做调研与整理，产出带出处的结论；不确定的地方直接说不确定。",
  runtimeId: "",
  location: "local" as "local" | "worktree",
  repoPath: "",
});

const nameError = ref("");
const repoError = ref("");
const creating = ref(false);

/** 选中运行时是否强制 worktree（无权限请求通道 → 产品层无法拦截写操作）。 */
const selectedRuntime = computed(() => runtimes.find(form.runtimeId));
const mustWorktree = computed(() => selectedRuntime.value?.requiresWorktree === true);
const effectiveLocation = computed<"local" | "worktree">(() =>
  mustWorktree.value ? "worktree" : form.location,
);

function goStep2(): void {
  if (!form.runtimeId) {
    form.runtimeId = usableRuntimes.value[0]?.id ?? "";
  }
  step.value = 2;
}

/** 名称校验（本地先拦一遍，最终以后端 400 为准 —— 唯一性是后端的真相）。 */
function validateName(): boolean {
  const name = form.name.trim();
  if (name.length === 0) {
    nameError.value = "名称不能为空。";
    return false;
  }
  if (name.length > 32) {
    nameError.value = "名称最多 32 个字符。";
    return false;
  }
  nameError.value = "";
  return true;
}

async function createBot(): Promise<void> {
  if (creating.value) return;
  if (!validateName()) return;

  const location = effectiveLocation.value;
  const repoPath = form.repoPath.trim();
  if (location === "worktree" && repoPath.length === 0) {
    repoError.value = mustWorktree.value
      ? `${selectedRuntime.value?.displayName ?? "该运行时"} 不提供权限请求，无法拦截文件写入，必须跑在 worktree 里。请填仓库根路径。`
      : "选 worktree 时必须填仓库根路径。";
    return;
  }
  repoError.value = "";
  creating.value = true;

  try {
    const res = await api.createBot({
      name: form.name.trim(),
      persona: form.persona.trim(),
      ...(form.runtimeId ? { runtimeId: form.runtimeId } : {}),
      executionLocation: location,
      ...(location === "worktree" ? { repoPath } : {}),
    });
    const bot = res.bot;
    if (!bot) {
      nameError.value = "创建失败：服务没有返回 Bot。";
      return;
    }
    createdBot.value = bot;
    step.value = 3;
    void bots.load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const fields = err.fieldErrors();
      const nameField = fields.find((f) => f.field === "name");
      const repoField = fields.find((f) => f.field === "repoPath");
      nameError.value = nameField?.message ?? "";
      repoError.value = repoField?.message ?? "";
      if (!nameError.value && !repoError.value) {
        nameError.value = "创建失败：请求未通过校验。";
      }
      return;
    }
    nameError.value = err instanceof Error ? `创建失败：${err.message}` : "创建失败。";
  } finally {
    creating.value = false;
  }
}

// ---------------------------------------------------------------------------
// 第三步：发第一条消息
// ---------------------------------------------------------------------------
const createdBot = ref<BotDto | null>(null);
const draft = ref("先看看这个仓库的结构，用三句话说明。");
const channelId = ref<string | null>(null);
const sessionId = ref<string | null>(null);
const sending = ref(false);
const sendError = ref("");
const streamText = ref("");
const streaming = ref(false);
const finished = ref(false);
const usage = ref<{ in: number | null; out: number | null; reported: boolean } | null>(null);
const elapsedMs = ref(0);

let conn: SseConnection | null = null;
let tickTimer: number | null = null;

const runtimeOfBot = computed(() => selectedRuntime.value);

const setupBotVars = computed(() =>
  createdBot.value
    ? botVars(createdBot.value)
    : botVars({ colorIndex: 1 }),
);

function stopTick(): void {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

function startTick(): void {
  stopTick();
  const from = Date.now();
  tickTimer = window.setInterval(() => {
    elapsedMs.value = Date.now() - from;
  }, 200);
}

function closeStream(): void {
  conn?.close();
  conn = null;
}

/** 建私聊渠道（幂等）→ 发消息 → 连 SSE。 */
async function sendFirst(): Promise<void> {
  const text = draft.value.trim();
  if (text.length === 0 || sending.value || !createdBot.value) return;
  sending.value = true;
  sendError.value = "";
  streamText.value = "";
  usage.value = null;
  finished.value = false;
  streaming.value = true;
  elapsedMs.value = 0;

  try {
    if (!channelId.value) {
      const ch = await api.createChannel({
        type: "dm",
        participantBotIds: [createdBot.value.id],
      });
      channelId.value = ch.channel.id;
    }

    // 先连 SSE 再发：发消息的响应回来前，运行时就可能已经推了首帧。
    // 首连游标 0 = 从头回放，不会漏掉响应返回前产生的事件。
    closeStream();
    const sid = await ensureSessionPlaceholder();
    void sid;

    const res = await api.sendMessage({ channelId: channelId.value, text });
    sessionId.value = res.sessionId;
    attachStream(res.sessionId, 0);
    startTick();
  } catch (err) {
    streaming.value = false;
    stopTick();
    sendError.value = humanizeSendError(err);
  } finally {
    sending.value = false;
  }
}

/**
 * 发送前无法预知 sessionId（它在 `POST /api/messages` 的响应里）。
 * 因此连接只能等响应回来才建，游标传 0 从头回放 —— 中间产生的帧不会丢。
 * 这个函数保留为「先建渠道」的语义占位，返回 null 不影响流程。
 */
async function ensureSessionPlaceholder(): Promise<string | null> {
  return null;
}

function attachStream(sid: string, fromEventId: number): void {
  conn = openStream({
    sessionId: sid,
    lastEventId: fromEventId,
    onFrame: (frame: SseFrame) => {
      if (frame.sessionId !== sid) return;
      if (frame.type === "message_delta") {
        const p = frame.payload as { phase?: unknown; text?: unknown };
        const text = typeof p.text === "string" ? p.text : "";
        if (p.phase === "start") streamText.value = text;
        else if (text.length > 0) streamText.value += text;
        return;
      }
      if (frame.type === "usage") {
        const p = frame.payload as {
          inputTokens?: unknown;
          outputTokens?: unknown;
          reported?: unknown;
        };
        usage.value = {
          in: typeof p.inputTokens === "number" ? p.inputTokens : null,
          out: typeof p.outputTokens === "number" ? p.outputTokens : null,
          reported: p.reported !== false,
        };
        return;
      }
      if (frame.type === "done") {
        const p = frame.payload as { durationMs?: unknown };
        if (typeof p.durationMs === "number" && p.durationMs > 0) elapsedMs.value = p.durationMs;
        finishStream();
        return;
      }
      if (frame.type === "error") {
        const p = frame.payload as { message?: unknown; fatal?: unknown };
        sendError.value = typeof p.message === "string" ? p.message : "运行时返回了错误。";
        if (p.fatal !== false) finishStream();
      }
    },
    onError: (fatal) => {
      if (fatal) {
        streaming.value = false;
        stopTick();
        sendError.value = "和本地服务的实时连接断开了。消息可能仍在执行，稍后可在会话里看到结果。";
      }
    },
  });
}

function finishStream(): void {
  streaming.value = false;
  finished.value = true;
  stopTick();
}

/** 发送失败的人话表达（UX §6.3）。 */
function humanizeSendError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "runtime_unavailable":
        return "这个 Bot 绑定的运行时当前不可用（未安装或健康检查失败）。可以换一个运行时，或先跳过向导到设置里补。";
      case "worktree_not_ready":
        return "worktree 还没准备好，发送被阻止。检查仓库路径后重试。";
      case "no_bot_in_channel":
        return "渠道里没有 Bot。返回上一步重新创建。";
      case "channel_not_found":
        return "会话创建失败，请重试。";
      default:
        break;
    }
    if (err.status === 0) return "本地服务没有响应。确认服务还在运行后重试。";
    return `发送失败（${err.code}）。已输入的内容保留，可以直接重试。`;
  }
  return "发送失败。已输入的内容保留，可以直接重试。";
}

/** 换一个运行时重试（F1 失败分支：允许换运行时，向导不退出）。 */
function switchRuntime(): void {
  closeStream();
  stopTick();
  streaming.value = false;
  finished.value = false;
  streamText.value = "";
  usage.value = null;
  sendError.value = "";
  sessionId.value = null;
  channelId.value = null;
  step.value = 2;
}

function finish(): void {
  closeStream();
  stopTick();
  void router.push("/bots");
}

onBeforeUnmount(() => {
  closeStream();
  stopTick();
  stopReveal();
});
</script>

<template>
  <div class="setup-wrap">
    <div class="setup-col enter" :style="{ '--i': 0 }">
      <div class="setup-brand">
        <span class="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
        <div>
          <div class="brand-name">AgentBot</div>
          <div class="brand-sub">首次启动 · 大约 60 秒</div>
        </div>
        <span class="spacer" />
        <RouterLink class="btn btn--sm btn--ghost" to="/bots">跳过向导</RouterLink>
      </div>

      <div class="setup-steps">
        <template v-for="(n, i) in STEP_NAMES" :key="n">
          <div
            class="setup-step"
            :class="{ 'is-on': step === i + 1, 'is-done': step > i + 1 }"
          >
            <span class="n">{{ step > i + 1 ? "✓" : i + 1 }}</span><span>{{ n }}</span>
          </div>
          <span v-if="i < 2" class="bar" />
        </template>
      </div>

      <!-- ================= 第一步：探测运行时 ================= -->
      <template v-if="step === 1">
        <h1 class="setup-title">检测你机器上的 agent</h1>
        <p class="setup-sub">
          每项独立探测，3 秒超时互不阻塞。没有可用的也没关系，可以先跳过，稍后在设置里手动添加。
        </p>

        <!-- 错误态：探测本身失败（本地服务无响应） -->
        <div v-if="runtimes.status === 'error'" class="banner">
          <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
          <span>探测失败：{{ runtimes.errorText || "本地服务没有响应。" }}已探测到的项不受影响，可以直接跳过向导稍后重试。</span>
          <span class="spacer" />
          <button class="btn btn--sm" @click="reloadProbe">重试</button>
        </div>

        <div v-if="runtimes.status === 'loading'" class="probe-status" aria-live="polite">
          正在逐项检查…（每项独立 3s 超时）
        </div>

        <!-- 加载态：每行独立骨架 -->
        <div
          v-if="runtimes.status === 'loading' || runtimes.status === 'idle'"
          class="setup-card"
          aria-busy="true"
        >
          <div v-for="i in 5" :key="i" class="probe-row">
            <span class="sk" style="width: 16px; height: 16px; border-radius: 99px" />
            <div style="flex: 1">
              <div class="sk sk-line" style="width: 100px" />
              <div class="probe-bar"><i style="width: 30%" /></div>
            </div>
            <span class="probe-state">检测中…</span>
          </div>
        </div>

        <!-- 错误态：行保持骨架（真实结果未知，不编造） -->
        <div v-else-if="runtimes.status === 'error'" class="setup-card" aria-busy="true">
          <div v-for="i in 3" :key="i" class="probe-row">
            <span class="sk" style="width: 16px; height: 16px; border-radius: 99px" />
            <div style="flex: 1"><div class="sk sk-line" style="width: 100px" /></div>
            <span class="probe-state">未取到结果</span>
          </div>
        </div>

        <!-- 正常态 / 空态：逐项出结果 -->
        <div v-else class="setup-card">
          <div v-for="row in probeRows" :key="row.id" class="probe-row" :data-probe="row.id">
            <template v-if="row.state === 'pending'">
              <span class="sk" style="width: 16px; height: 16px; border-radius: 99px" />
              <div style="flex: 1">
                <div class="sk sk-line" style="width: 100px" />
                <div class="probe-bar"><i style="width: 30%" /></div>
              </div>
              <span class="probe-state">检测中…</span>
            </template>
            <template v-else>
              <span
                class="state"
                :class="row.state === 'ready' ? 'state--done' : row.state === 'timeout' ? 'state--waiting' : 'state--blocked'"
                style="padding: 0; width: 22px; justify-content: center"
              >
                <span class="state-dot" :style="{ '--s': `var(--state-${row.state === 'ready' ? 'done' : row.state === 'timeout' ? 'waiting' : 'blocked'})` }" />
              </span>
              <div style="flex: 1; min-width: 0">
                <div class="nm">{{ row.name }}</div>
                <div class="sub">{{ row.detail }}</div>
              </div>
              <span
                class="probe-state"
                :class="row.state === 'ready' ? 'is-ok' : row.state === 'timeout' ? 'is-timeout' : 'is-missing'"
              >
                {{ row.state === "ready" ? "可用" : row.state === "timeout" ? "检测超时" : row.state === "unhealthy" ? "健康检查失败" : "未安装" }}
                <button
                  v-if="row.state !== 'ready'"
                  class="btn btn--sm btn--ghost"
                  @click="retryOne(row.id)"
                >重试</button>
              </span>
            </template>
          </div>

          <!-- 空态：一台机器上一个都没装 -->
          <div v-if="noneInstalled" class="probe-empty">
            <div class="empty" style="box-shadow: none; background: var(--color-surface-2)">
              <div class="empty-icon"><AppIcon name="gear" :size="24" /></div>
              <h3 style="font-size: var(--font-size-h3)">没有找到可用的 agent</h3>
              <p>
                这不是错误：PATH 里确实一个都没有。按下面任一命令装一个，或者直接用「先跳过」进工作台，
                稍后在设置里补。
              </p>
              <pre class="u-mono" style="margin: 16px 0; padding: 12px 16px; background: var(--color-surface); border-radius: 8px; color: var(--color-text-secondary); text-align: left; width: 100%; max-width: 420px">{{ INSTALL_COMMANDS }}</pre>
              <div class="empty-actions">
                <button class="btn btn--sm btn--secondary" @click="copyInstall">复制命令</button>
                <button class="btn btn--sm btn--ghost" @click="router.push('/bots')">先跳过</button>
              </div>
            </div>
          </div>
        </div>

        <div class="setup-foot">
          <button class="btn btn--ghost" @click="router.push('/bots')">跳过</button>
          <span class="spacer" />
          <button
            class="btn btn--primary btn--lg"
            :disabled="!probeDone || usableRuntimes.length === 0"
            @click="goStep2"
          >下一步</button>
        </div>
      </template>

      <!-- ================= 第二步：创建 Bot ================= -->
      <template v-else-if="step === 2">
        <h1 class="setup-title">给你的第一个 Bot 起名</h1>
        <p class="setup-sub">
          Bot 是主角，运行时只是它当前绑定的机器。以后换运行时，人格和记忆都留着。
        </p>

        <div class="field">
          <label class="u-label" for="setup-name">名称</label>
          <input
            id="setup-name"
            v-model="form.name"
            class="input"
            maxlength="32"
            placeholder="例如：研究助手"
            :aria-invalid="nameError ? 'true' : 'false'"
            aria-describedby="setup-name-err"
            @input="nameError = ''"
          />
          <div v-if="nameError" id="setup-name-err" class="field-err" role="alert">{{ nameError }}</div>
          <div v-else class="hint" id="setup-name-err">1–32 个字符，工作区内唯一。</div>
        </div>

        <div class="field">
          <label class="u-label" for="setup-persona">人格</label>
          <textarea id="setup-persona" v-model="form.persona" class="textarea" rows="3" />
        </div>

        <div class="field">
          <label class="u-label">默认运行时</label>
          <div class="pick-list">
            <label
              v-for="r in usableRuntimes"
              :key="r.id"
              class="pick"
              :class="{ 'is-on': form.runtimeId === r.id }"
            >
              <input
                type="radio"
                name="setup-rt"
                :value="r.id"
                :checked="form.runtimeId === r.id"
                style="accent-color: var(--color-primary)"
                @change="form.runtimeId = r.id"
              />
              <div style="flex: 1; min-width: 0">
                <div style="font-size: var(--font-size-body-sm); font-weight: var(--weight-semibold)">
                  {{ r.displayName }}
                  <span class="u-mono u-muted">{{ r.version ? `v${r.version}` : "版本未知" }}</span>
                </div>
                <div class="cap-row" style="margin-top: 6px">
                  <span class="cap-label">plan</span><CapBadge :value="r.capabilities.plan" />
                  <span class="cap-label">permission</span><CapBadge :value="r.capabilities.permission" />
                  <span class="cap-label">resume</span><CapBadge :value="r.capabilities.resume" />
                </div>
              </div>
              <span class="rt-chip">{{ r.protocol }}</span>
            </label>
          </div>
          <div class="hint">能力值来自运行时上报。显示「未知」表示它没有声明，不代表不支持。</div>
        </div>

        <div class="field">
          <label class="u-label">执行位置</label>
          <div class="radio-row">
            <label class="radio">
              <input
                type="radio"
                name="setup-loc"
                value="local"
                :checked="effectiveLocation === 'local'"
                :disabled="mustWorktree"
                @change="form.location = 'local'"
              />
              local · 当前目录
            </label>
            <label class="radio">
              <input
                type="radio"
                name="setup-loc"
                value="worktree"
                :checked="effectiveLocation === 'worktree'"
                @change="form.location = 'worktree'"
              />
              git worktree · 另开一份
            </label>
          </div>
          <div v-if="mustWorktree" class="hint" style="color: var(--color-warning-ink)">
            {{ selectedRuntime?.displayName }} 不提供权限请求，产品层无法拦截文件写入，因此强制跑在 worktree 里。
          </div>
        </div>

        <div v-if="effectiveLocation === 'worktree'" class="field">
          <label class="u-label" for="setup-repo">仓库根路径</label>
          <input
            id="setup-repo"
            v-model="form.repoPath"
            class="input u-mono"
            placeholder="例如：D:/workspace/Agent WorkSpace/agentbot"
            :aria-invalid="repoError ? 'true' : 'false'"
            @input="repoError = ''"
          />
          <div v-if="repoError" class="field-err" role="alert">{{ repoError }}</div>
          <div v-else class="hint">必须是 git 仓库根目录。Bot 的所有执行都在这个仓库的独立 worktree 里。</div>
        </div>

        <div class="setup-foot">
          <button class="btn btn--secondary" @click="step = 1">上一步</button>
          <span class="spacer" />
          <button
            class="btn btn--primary btn--lg"
            :class="{ 'is-loading': creating }"
            :disabled="creating"
            @click="createBot"
          >{{ creating ? "创建中" : "创建" }}</button>
        </div>
      </template>

      <!-- ================= 第三步：发第一条消息 ================= -->
      <template v-else>
        <h1 class="setup-title">发第一条消息</h1>
        <p class="setup-sub">
          {{ createdBot?.name }} · {{ runtimeOfBot?.displayName ?? "未绑定" }} ·
          {{ createdBot?.executionLocation === "worktree" ? "worktree" : "local" }}
          {{ createdBot?.effectivePath ?? "" }}
        </p>

        <div class="setup-card" style="padding: 16px 20px; min-height: 220px">
          <section v-if="streamText || streaming || finished" class="turn" :style="setupBotVars">
            <header class="turn-head" style="position: static">
              <BotAvatar
                :name="createdBot?.name ?? 'Bot'"
                :color-index="createdBot?.colorIndex ?? 1"
                :avatar="createdBot?.avatar ?? null"
                :size="24"
              />
              <span class="turn-name">{{ createdBot?.name }}</span>
              <span class="rt-chip">
                {{ runtimeOfBot?.displayName }}<template v-if="runtimeOfBot"> · {{ runtimeOfBot.protocol }}</template>
              </span>
              <span class="turn-right">
                <BotStateChip v-if="streaming" state="working" label="生成中" />
                <BotStateChip v-else-if="finished && !sendError" state="done" label="完成" />
                <BotStateChip v-else-if="sendError" state="blocked" label="失败" />
                <span class="turn-sum u-num">{{ streaming ? `${(elapsedMs / 1000).toFixed(1)}s` : "" }}</span>
              </span>
            </header>
            <div class="turn-body" style="padding-left: 0">
              <div class="msg msg--bot" :style="setupBotVars">
                <BotAvatar
                  :name="createdBot?.name ?? 'Bot'"
                  :color-index="createdBot?.colorIndex ?? 1"
                  :avatar="createdBot?.avatar ?? null"
                  :size="32"
                />
                <div class="msg-col">
                  <div class="msg-name">{{ createdBot?.name }}</div>
                  <div class="bubble bubble--bot" style="min-height: 48px">
                    <template v-if="streamText">{{ streamText }}</template>
                    <span v-else-if="streaming" class="wait-line">等待运行时返回 · 已 {{ (elapsedMs / 1000).toFixed(1) }}s</span>
                    <span v-if="streaming && streamText" class="cursor-stream" />
                  </div>
                </div>
              </div>

              <!-- 用量：结束即显示（F1 步骤 4 硬要求） -->
              <div v-if="usage" class="usage-line">
                <span>∑</span>
                <span>
                  {{ usage.reported ? `${num(usage.in)} in / ${num(usage.out)} out · 交互 ×1` : "— 运行时未上报用量" }}
                </span>
              </div>
              <div v-if="finished && !sendError" class="end-stamp">
                <span class="state-dot" :style="{ '--s': 'var(--state-done)' }" />
                完成 · {{ (elapsedMs / 1000).toFixed(1) }}s
              </div>
            </div>
          </section>

          <div v-else class="empty" style="box-shadow: none; padding: 32px 0">
            <div class="empty-icon"><AppIcon name="chats" :size="24" /></div>
            <h3 style="font-size: var(--font-size-h3)">问点什么试试</h3>
            <p>比如：这个仓库的结构是什么样的？</p>
          </div>
        </div>

        <!-- 失败：人话 + 换运行时（向导不退出，输入内容保留） -->
        <div v-if="sendError" class="err-block" style="margin-top: 16px">
          <div class="err-msg">{{ sendError }}</div>
          <div class="err-actions">
            <button class="btn btn--sm btn--primary" @click="sendFirst">重发</button>
            <button class="btn btn--sm btn--secondary" @click="switchRuntime">换运行时</button>
          </div>
        </div>

        <div style="display: flex; gap: 8px; margin-top: 16px">
          <input
            v-model="draft"
            class="input"
            :placeholder="`给 ${createdBot?.name ?? 'Bot'} 发消息…`"
            :disabled="streaming"
            @keydown.enter.prevent="sendFirst"
          />
          <button
            class="btn btn--primary btn--lg"
            :disabled="streaming || draft.trim().length === 0"
            @click="sendFirst"
          >发送</button>
        </div>

        <div class="setup-foot">
          <button class="btn btn--secondary" @click="step = 2">上一步</button>
          <span class="spacer" />
          <span
            v-if="finished && !sendError"
            class="setup-done-hint"
          >完成，进入工作台</span>
          <button class="btn btn--primary btn--lg" :disabled="!finished || !!sendError" @click="finish">
            完成，进入工作台
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 向导是整页独立的（原型 viewSetup 不带应用壳），所以这里的少量局部样式
   只补 base.css 里没有的两个元素：能力标签与完成提示。颜色仍全部走令牌。 */
.cap-label {
  font-size: 10px;
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-wide);
  color: var(--color-text-muted);
  margin-right: 2px;
}
.cap-row {
  row-gap: 4px;
  align-items: center;
}
.probe-empty {
  border-top: 1px solid var(--color-border);
  padding: var(--space-4);
}
.setup-done-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: var(--space-3);
  font-size: var(--font-size-caption);
  color: var(--color-success-ink);
}
</style>
