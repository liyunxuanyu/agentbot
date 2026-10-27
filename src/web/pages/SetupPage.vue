<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError, api } from "../net/client";
import { openStream, type SseConnection } from "../net/stream";
import type {
  BotDto,
  ProviderDto,
  ProviderProtocol,
  RuntimeDetailDto,
  SseFrame,
} from "../net/types";
import { useRuntimesStore } from "../stores/runtimes";
import { useBotsStore } from "../stores/bots";
import { useProvidersStore } from "../stores/providers";
import { useSkillsStore } from "../stores/skills";
import { useSetupStore } from "../stores/setup";
import { useUiStore } from "../stores/ui";
import { botVars } from "../lib/botVars";
import { num } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import BotStateChip from "../components/bot/BotStateChip.vue";
import CapBadge from "../components/common/CapBadge.vue";

/**
 * /setup —— 初始化引导（N1）。
 *
 * 五步，每步可跳过（UX F1「≤60s 到第一条消息」是最后一条可选演练）：
 *   ① 环境检查：至少一个运行时可用（否则给安装指引）
 *   ② 模型供应商：内置引擎没有供应商就不可用；保存后可「测试连接」
 *   ③ Bot：默认创建管理员（可改成普通 Bot），已存在管理员时显示 ✓
 *   ④ 默认工作区：可选；不设置时按会话 / 渠道回退链
 *   ⑤ 基础技能：一键安装内置技能包（启动时已装，这里可补装 / 确认）
 *
 * 关键设计（与 agentbot-19 对齐）：
 *   - **可重入**：任何时候都能从设置页进来；打开时按 `/api/setup/state`
 *     跳到第一个未完成步骤，已完成的步骤在步骤条里显示 ✓；
 *   - **不阻断**：每步都有「稍后再说」，跳过后侧栏显示「初始化未完成 N/5」；
 *   - **幂等**：供应商按 baseUrl+protocol 去重、Bot 按名字去重（后端 400 内联报错）、
 *     技能按目录名去重（安装器跳过已存在的目录）。
 *
 * 探测仍读服务启动时的缓存（架构 §3.8：不在渲染路径探测），逐项揭示只是
 * 对「每项独立、互不阻塞」的如实表达。
 */
const router = useRouter();
const runtimes = useRuntimesStore();
const bots = useBotsStore();
const providers = useProvidersStore();
const skills = useSkillsStore();
const setup = useSetupStore();
const ui = useUiStore();

// ---------------------------------------------------------------------------
// 步骤框架
// ---------------------------------------------------------------------------
const STEP_NAMES = ["环境检查", "模型供应商", "Bot", "默认工作区", "基础技能"] as const;
/** 1–5 是引导步骤；6 是完成后的「发第一条消息」演练（不算在 N/5 里）。 */
const step = ref<1 | 2 | 3 | 4 | 5 | 6>(1);
const TOTAL_STEPS = STEP_NAMES.length;

/** 每一步是否已完成（从服务端状态读，刷新后仍准确）。 */
const doneSteps = computed<Record<string, boolean>>(() => {
  const map: Record<string, boolean> = {};
  for (const s of setup.steps) map[s.key] = s.done;
  return map;
});

const stepKeys = ["runtime", "provider", "admin", "workspace", "skills"] as const;
function isStepDone(index: number): boolean {
  const key = stepKeys[index];
  return key ? doneSteps.value[key] === true : false;
}

function goStep(n: 1 | 2 | 3 | 4 | 5 | 6): void {
  step.value = n;
  if (n === 5) void skills.load();
}

/** 跳到第一个未完成的步骤（可重入时用）。 */
function jumpToFirstIncomplete(): void {
  const index = stepKeys.findIndex((key) => doneSteps.value[key] !== true);
  if (index >= 0 && index < TOTAL_STEPS) {
    goStep((index + 1) as 1 | 2 | 3 | 4 | 5);
    return;
  }
  // 全部完成：直接给最后一步（演练）
  goStep(6);
}

// ---------------------------------------------------------------------------
// 第 1 步：探测运行时
// ---------------------------------------------------------------------------
const revealed = ref<string[]>([]);
let revealTimer: number | null = null;

function stopReveal(): void {
  if (revealTimer !== null) {
    window.clearInterval(revealTimer);
    revealTimer = null;
  }
}

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

const noneInstalled = computed(() => {
  if (runtimes.status === "empty") return true;
  return runtimes.status === "ready" && runtimes.readyCount === 0 && probeDone.value;
});

const usableRuntimes = computed(() => runtimes.bindable);

const INSTALL_COMMANDS = "npm i -g @google/gemini-cli\nnpm i -g @openai/codex";

function copyInstall(): void {
  void navigator.clipboard
    ?.writeText(INSTALL_COMMANDS)
    .then(() => ui.toast("已复制安装命令"))
    .catch(() => ui.toast("复制失败，请手动选择"));
}

async function retryOne(id: string): Promise<void> {
  try {
    const rt = await runtimes.probeOne(id);
    ui.toast(
      rt.availability === "ready"
        ? `${rt.displayName} 可用`
        : `${rt.displayName}：${runtimes.reasonOf(rt)}`,
    );
  } catch (err) {
    ui.toast(
      err instanceof ApiError ? `探测失败：${err.bodyMessage ?? err.code}` : "探测失败，请重试",
    );
  }
}

// ---------------------------------------------------------------------------
// 第 2 步：模型供应商
// ---------------------------------------------------------------------------
const providerForm = reactive({
  protocol: "openai-chat" as ProviderProtocol,
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
});
const providerErr = ref("");
const providerBusy = ref(false);
const providerTested = ref<{ ok: boolean; text: string } | null>(null);

const hasProvider = computed(() => providers.providers.length > 0);

function openProviderForm(): void {
  providerForm.protocol = "openai-chat";
  providerForm.name = "";
  providerForm.baseUrl = "";
  providerForm.apiKey = "";
  providerForm.model = "";
  providerErr.value = "";
  providerTested.value = null;
}

/** 保存供应商 → 测试连通性（测试失败不删除配置，只提示）。 */
async function saveProvider(): Promise<void> {
  if (providerBusy.value) return;
  providerErr.value = "";
  providerTested.value = null;
  if (providerForm.baseUrl.trim().length === 0) {
    providerErr.value = "baseUrl 不能为空。";
    return;
  }
  if (providerForm.apiKey.trim().length === 0) {
    providerErr.value = "apiKey 不能为空。";
    return;
  }
  if (providerForm.model.trim().length === 0) {
    providerErr.value = "模型名不能为空。";
    return;
  }
  providerBusy.value = true;
  try {
    // 幂等：同 baseUrl + 同协议已经存在 → 不重复创建
    const existing = providers.providers.find(
      (p) => p.baseUrl === providerForm.baseUrl.trim() && p.protocol === providerForm.protocol,
    );
    if (existing) {
      ui.toast("这个供应商已存在，跳过创建");
      await testExistingProvider(existing);
      return;
    }
    const created = await api.createProvider({
      protocol: providerForm.protocol,
      ...(providerForm.name.trim().length > 0 ? { name: providerForm.name.trim() } : {}),
      baseUrl: providerForm.baseUrl.trim(),
      apiKey: providerForm.apiKey.trim(),
      model: providerForm.model.trim(),
    });
    await providers.load();
    void runtimes.load();
    await testExistingProvider(created.provider);
  } catch (err) {
    providerErr.value =
      err instanceof ApiError
        ? (err.fieldErrors()[0]?.message ?? err.messageText() ?? err.message)
        : err instanceof Error
          ? err.message
          : "保存失败";
  } finally {
    providerBusy.value = false;
  }
}

async function testExistingProvider(p: ProviderDto): Promise<void> {
  try {
    const res = await api.testProvider(p.id);
    providerTested.value = res.ok
      ? { ok: true, text: `${p.name} 可用 · ${res.latencyMs}ms · ${res.model}` }
      : { ok: false, text: `${p.name} 不可用：${res.error ?? "未知错误"}` };
    if (res.ok) await setup.refresh();
  } catch (err) {
    providerTested.value = { ok: false, text: err instanceof Error ? err.message : "测试失败" };
  }
}

async function testProviderRow(p: ProviderDto): Promise<void> {
  if (providerBusy.value) return;
  providerBusy.value = true;
  try {
    await testExistingProvider(p);
  } finally {
    providerBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// 第 3 步：创建 Bot（默认管理员）
// ---------------------------------------------------------------------------
const botForm = reactive({
  name: "管理员",
  persona:
    "你是这个 AgentBot 实例的管理员。你可以在用户确认后创建新的 Bot：先问清名称、职责/人格、用哪个模型供应商与默认工作区，再调用 create_bot。不要替用户臆测需求。",
  runtimeId: "",
  asAdmin: true,
});
const botErr = ref("");
const creating = ref(false);
const createdBot = ref<BotDto | null>(null);

const adminExists = computed(() => doneSteps.value["admin"] === true);

function goToBot(): void {
  if (!botForm.runtimeId) botForm.runtimeId = usableRuntimes.value[0]?.id ?? "";
  goStep(3);
}

function validateBotName(): boolean {
  const name = botForm.name.trim();
  if (name.length === 0) {
    botErr.value = "名称不能为空。";
    return false;
  }
  if (name.length > 32) {
    botErr.value = "名称最多 32 个字符。";
    return false;
  }
  botErr.value = "";
  return true;
}

async function createSetupBot(): Promise<void> {
  if (creating.value) return;
  if (!validateBotName()) return;
  creating.value = true;
  botErr.value = "";
  try {
    const res = await api.createBot({
      name: botForm.name.trim(),
      persona: botForm.persona.trim(),
      ...(botForm.runtimeId ? { runtimeId: botForm.runtimeId } : {}),
      role: botForm.asAdmin ? "admin" : "member",
    });
    if (!res.bot) {
      botErr.value = "创建失败：服务没有返回 Bot。";
      return;
    }
    createdBot.value = res.bot;
    void bots.load();
    await setup.refresh();
    ui.toast(botForm.asAdmin ? `已创建管理员「${res.bot.name}」` : `已创建「${res.bot.name}」`);
    goStep(4);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const field = err.fieldErrors().find((f) => f.field === "name");
      botErr.value = field?.message ?? "创建失败：请求未通过校验。";
      return;
    }
    botErr.value = err instanceof Error ? `创建失败：${err.message}` : "创建失败。";
  } finally {
    creating.value = false;
  }
}

// ---------------------------------------------------------------------------
// 第 4 步：默认工作区（可选）
// ---------------------------------------------------------------------------
const workspace = ref("");
const workspaceErr = ref("");
const workspaceBusy = ref(false);

/** 优先给刚建的 Bot 设工作区；否则给第一个 Bot。 */
const workspaceTarget = computed<BotDto | null>(
  () => createdBot.value ?? bots.bots.find((b) => b.status === "active") ?? null,
);

async function saveWorkspace(): Promise<void> {
  if (workspaceBusy.value) return;
  const target = workspaceTarget.value;
  const value = workspace.value.trim();
  workspaceErr.value = "";
  if (!target) {
    // 没建 Bot 也能先把工作区记下来？没有归属就不保存，跳过去建 Bot 更直接
    workspaceErr.value = "还没有 Bot，工作区需要一个归属。可以先跳过，建好 Bot 后再设置。";
    return;
  }
  if (value.length === 0) {
    goStep(5);
    return;
  }
  workspaceBusy.value = true;
  try {
    await api.patchBot(target.id, { repoPath: value });
    await loadBotsQuietly();
    await setup.refresh();
    ui.toast(`已把「${target.name}」的默认工作区设为 ${value}`);
    goStep(5);
  } catch (err) {
    if (err instanceof ApiError) {
      const field = err.fieldErrors().find((f) => f.field === "repoPath");
      workspaceErr.value = field?.message ?? err.messageText() ?? `保存失败（${err.code}）`;
      return;
    }
    workspaceErr.value = err instanceof Error ? err.message : "保存失败";
  } finally {
    workspaceBusy.value = false;
  }
}

async function loadBotsQuietly(): Promise<void> {
  try {
    await bots.load();
  } catch {
    // 刷新失败不影响当前步骤
  }
}

// ---------------------------------------------------------------------------
// 第 5 步：基础技能（可选）
// ---------------------------------------------------------------------------
const skillBusy = ref(false);
const skillMessage = ref("");

async function installSkills(): Promise<void> {
  if (skillBusy.value) return;
  skillBusy.value = true;
  skillMessage.value = "";
  try {
    const count = await skills.rescan();
    skillMessage.value =
      skills.installed.length > 0
        ? `已安装 ${skills.installed.length} 个内置技能（共 ${count} 个技能可用）`
        : `技能已就绪（共 ${count} 个）`;
    ui.toast(skillMessage.value);
    await setup.refresh();
  } catch (err) {
    skillMessage.value = err instanceof ApiError ? (err.messageText() ?? "安装失败") : "安装失败";
  } finally {
    skillBusy.value = false;
  }
}

// ---------------------------------------------------------------------------
// 第 6 步：发第一条消息（演练，不算在 5 步里）
// ---------------------------------------------------------------------------
const draft = ref("用一句话介绍你自己，然后说说你能做什么。");
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

const chatBot = computed<BotDto | null>(
  () => createdBot.value ?? bots.bots.find((b) => b.status === "active") ?? null,
);

const setupBotVars = computed(() =>
  chatBot.value ? botVars(chatBot.value) : botVars({ colorIndex: 1 }),
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

async function sendFirst(): Promise<void> {
  const text = draft.value.trim();
  if (text.length === 0 || sending.value || !chatBot.value) return;
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
        participantBotIds: [chatBot.value.id],
      });
      channelId.value = ch.channel.id;
    }
    closeStream();
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

function humanizeSendError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "runtime_unavailable":
        return "这个 Bot 绑定的运行时当前不可用（未安装或健康检查失败）。可以回上一步换一个运行时。";
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

function finish(): void {
  closeStream();
  stopTick();
  void router.push("/bots");
}

/** 「稍后再说」：本次会话不再自动跳回引导，进入工作台（侧栏保留未完成提示）。 */
function skipAll(): void {
  setup.dismiss();
  closeStream();
  stopTick();
  void router.push("/bots");
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
onMounted(async () => {
  ui.setCrumb([{ text: "首次启动" }]);
  // App.vue 也会在挂载时 load 一次（首启跳转需要）；已有状态就不重复请求
  if (setup.state === null) await setup.load();
  await Promise.all([reloadProbe(), providers.load().catch(() => undefined), bots.load().catch(() => undefined)]);
  // 可重入：打开时停在第一个未完成的步骤
  jumpToFirstIncomplete();
});

async function reloadProbe(): Promise<void> {
  stopReveal();
  await runtimes.load();
  startReveal();
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
          <div class="brand-sub">
            初始化引导 · 已完成 {{ setup.completed }} / {{ setup.total }}
          </div>
        </div>
        <span class="spacer" />
        <RouterLink class="btn btn--sm btn--ghost" to="/bots" @click="setup.dismiss()">稍后再说</RouterLink>
      </div>

      <div class="setup-steps">
        <template v-for="(n, i) in STEP_NAMES" :key="n">
          <div
            class="setup-step"
            :class="{ 'is-on': step === i + 1, 'is-done': isStepDone(i) && step !== i + 1 }"
          >
            <span class="n">{{ isStepDone(i) ? "✓" : i + 1 }}</span><span>{{ n }}</span>
          </div>
          <span v-if="i < STEP_NAMES.length - 1" class="bar" />
        </template>
      </div>

      <!-- ================= ① 环境检查 ================= -->
      <template v-if="step === 1">
        <h1 class="setup-title">检测你机器上的 agent</h1>
        <p class="setup-sub">
          每项独立探测，3 秒超时互不阻塞。没有可用的也没关系：内置引擎只需要配置一个模型供应商就能用。
        </p>

        <div v-if="runtimes.status === 'error'" class="banner">
          <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
          <span>探测失败：{{ runtimes.errorText || "本地服务没有响应。" }}已探测到的项不受影响。</span>
          <span class="spacer" />
          <button class="btn btn--sm" @click="reloadProbe">重试</button>
        </div>

        <div v-if="runtimes.status === 'loading'" class="probe-status" aria-live="polite">
          正在逐项检查…（每项独立 3s 超时）
        </div>

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

        <div v-else-if="runtimes.status === 'error'" class="setup-card" aria-busy="true">
          <div v-for="i in 3" :key="i" class="probe-row">
            <span class="sk" style="width: 16px; height: 16px; border-radius: 99px" />
            <div style="flex: 1"><div class="sk sk-line" style="width: 100px" /></div>
            <span class="probe-state">未取到结果</span>
          </div>
        </div>

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

          <div v-if="noneInstalled" class="probe-empty">
            <div class="empty" style="box-shadow: none; background: var(--color-surface-2)">
              <div class="empty-icon"><AppIcon name="gear" :size="24" /></div>
              <h3 style="font-size: var(--font-size-h3)">没有找到可用的 agent</h3>
              <p>
                这不是错误：PATH 里确实一个都没有。按下面任一命令装一个，或者继续下一步 ——
                内置引擎只要配好模型供应商就能用。
              </p>
              <pre class="u-mono" style="margin: 16px 0; padding: 12px 16px; background: var(--color-surface); border-radius: 8px; color: var(--color-text-secondary); text-align: left; width: 100%; max-width: 420px">{{ INSTALL_COMMANDS }}</pre>
              <div class="empty-actions">
                <button class="btn btn--sm btn--secondary" @click="copyInstall">复制命令</button>
              </div>
            </div>
          </div>
        </div>

        <div class="setup-foot">
          <button class="btn btn--ghost" @click="goStep(2)">跳过</button>
          <span class="spacer" />
          <button class="btn btn--primary btn--lg" @click="goStep(2)">下一步</button>
        </div>
      </template>

      <!-- ================= ② 模型供应商 ================= -->
      <template v-else-if="step === 2">
        <h1 class="setup-title">配置模型供应商</h1>
        <p class="setup-sub">
          内置引擎直接调模型 API（OpenAI Chat Completions 或 Anthropic Messages），没有子进程。
          配好之后内置引擎在运行时列表里变为可用，Bot 不需要装任何 CLI。
        </p>

        <div v-if="hasProvider" class="setup-card" style="padding: 8px 20px; margin-bottom: 16px">
          <div v-for="p in providers.providers" :key="p.id" class="probe-row">
            <span class="state state--done" style="padding: 0; width: 22px; justify-content: center">
              <span class="state-dot" style="--s: var(--state-done)" />
            </span>
            <div style="flex: 1; min-width: 0">
              <div class="nm">{{ p.name }} <span v-if="p.isDefault" class="chip" style="cursor: default">默认</span></div>
              <div class="sub u-mono">{{ p.protocol }} · {{ p.baseUrl }} · {{ p.model }}</div>
            </div>
            <button class="btn btn--sm btn--ghost" :disabled="providerBusy" @click="testProviderRow(p)">测试</button>
          </div>
        </div>

        <div v-if="providerTested" class="banner" :style="{ borderColor: providerTested.ok ? 'var(--color-success)' : 'var(--color-danger)' }">
          <span class="state-dot" :style="{ '--s': providerTested.ok ? 'var(--state-done)' : 'var(--state-blocked)' }" />
          <span>{{ providerTested.text }}</span>
        </div>

        <div class="setup-card" style="padding: 20px">
          <div class="field">
            <label class="u-label" for="setup-protocol">协议</label>
            <select id="setup-protocol" v-model="providerForm.protocol" class="select">
              <option value="openai-chat">OpenAI Chat Completions（含兼容网关）</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </div>
          <div class="field">
            <label class="u-label" for="setup-base-url">API 地址</label>
            <input
              id="setup-base-url"
              v-model="providerForm.baseUrl"
              class="input u-mono"
              placeholder="例如：https://api.openai.com/v1"
              autocomplete="off"
              @input="providerErr = ''"
            />
            <div class="hint">填根地址，不带 /chat/completions 或 /v1/messages。</div>
          </div>
          <div class="field">
            <label class="u-label" for="setup-api-key">API Key</label>
            <input
              id="setup-api-key"
              v-model="providerForm.apiKey"
              class="input u-mono"
              type="password"
              placeholder="sk-…"
              autocomplete="off"
              @input="providerErr = ''"
            />
            <div class="hint">只保存在本机 ~/.agentbot/providers.json（权限 0600），接口只回掩码。</div>
          </div>
          <div class="field">
            <label class="u-label" for="setup-model">模型名</label>
            <input
              id="setup-model"
              v-model="providerForm.model"
              class="input u-mono"
              placeholder="例如：gpt-4o-mini"
              autocomplete="off"
              @input="providerErr = ''"
            />
            <div class="hint">填供应商文档里的模型 id；上下文窗口等能力可在设置页补。</div>
          </div>
          <div class="field">
            <label class="u-label" for="setup-provider-name">显示名（可选）</label>
            <input id="setup-provider-name" v-model="providerForm.name" class="input" placeholder="例如：主力网关" />
          </div>
          <div v-if="providerErr" class="field-err" role="alert">{{ providerErr }}</div>
          <div style="display: flex; gap: 8px; margin-top: 8px">
            <button class="btn btn--primary" :class="{ 'is-loading': providerBusy }" :disabled="providerBusy" @click="saveProvider">
              {{ providerBusy ? "保存并测试…" : "保存并测试连接" }}
            </button>
            <button class="btn btn--ghost" @click="openProviderForm">清空</button>
          </div>
        </div>

        <div class="setup-foot">
          <button class="btn btn--secondary" @click="goStep(1)">上一步</button>
          <button class="btn btn--ghost" @click="goToBot">跳过</button>
          <span class="spacer" />
          <button class="btn btn--primary btn--lg" @click="goToBot">下一步</button>
        </div>
      </template>

      <!-- ================= ③ Bot ================= -->
      <template v-else-if="step === 3">
        <h1 class="setup-title">创建你的第一个 Bot</h1>
        <p class="setup-sub">
          Bot 是主角，运行时只是它当前绑定的机器。建议第一个创建<b>管理员</b>：它能按你的要求
          创建更多 Bot，之后换运行时人格与记忆都留着。
        </p>

        <div v-if="adminExists" class="banner">
          <span class="state-dot" style="--s: var(--state-done)" />
          <span>已经有一个管理员 Bot 了。你也可以再建一个普通 Bot，或直接进入下一步。</span>
        </div>

        <div class="setup-card" style="padding: 20px">
          <div class="field">
            <label class="u-label" for="setup-name">名称</label>
            <input
              id="setup-name"
              v-model="botForm.name"
              class="input"
              maxlength="32"
              placeholder="例如：管理员"
              :aria-invalid="botErr ? 'true' : 'false'"
              @input="botErr = ''"
            />
            <div v-if="botErr" class="field-err" role="alert">{{ botErr }}</div>
            <div v-else class="hint">1–32 个字符，工作区内唯一。</div>
          </div>

          <div class="field">
            <label class="u-label" for="setup-persona">人格</label>
            <textarea id="setup-persona" v-model="botForm.persona" class="textarea" rows="3" />
          </div>

          <div class="field">
            <label class="radio">
              <input v-model="botForm.asAdmin" type="checkbox" />
              设为管理员（多一个 create_bot 工具，不自动获得完全访问权限）
            </label>
          </div>

          <div v-if="usableRuntimes.length > 0" class="field">
            <label class="u-label">默认运行时</label>
            <div class="pick-list">
              <label
                v-for="r in usableRuntimes"
                :key="r.id"
                class="pick"
                :class="{ 'is-on': botForm.runtimeId === r.id }"
              >
                <input
                  type="radio"
                  name="setup-rt"
                  :value="r.id"
                  :checked="botForm.runtimeId === r.id"
                  style="accent-color: var(--color-primary)"
                  @change="botForm.runtimeId = r.id"
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
            <div class="hint">
              能力值来自运行时上报。显示「未知」表示它没有声明，不代表不支持。
            </div>
          </div>
          <div v-else class="banner" style="margin-top: 4px">
            <span class="state-dot" :style="{ '--s': 'var(--color-warning)' }" />
            <span>没有可绑定的运行时。可以先去上一步配模型供应商（内置引擎），或稍后在设置页装一个 CLI。</span>
          </div>
        </div>

        <div class="setup-foot">
          <button class="btn btn--secondary" @click="goStep(2)">上一步</button>
          <button class="btn btn--ghost" @click="goStep(4)">跳过</button>
          <span class="spacer" />
          <button
            class="btn btn--primary btn--lg"
            :class="{ 'is-loading': creating }"
            :disabled="creating"
            @click="createSetupBot"
          >{{ creating ? "创建中" : "创建并继续" }}</button>
        </div>
      </template>

      <!-- ================= ④ 默认工作区（可选） ================= -->
      <template v-else-if="step === 4">
        <h1 class="setup-title">给 Bot 一个默认工作区</h1>
        <p class="setup-sub">
          内置引擎的所有文件读写与命令都在这个目录里执行，越界会被拒绝。可以跳过：
          不设置时按「会话 → 渠道 → Bot 默认 → 服务进程目录」回退。
        </p>

        <div class="setup-card" style="padding: 20px">
          <div v-if="!workspaceTarget" class="banner">
            <span class="state-dot" :style="{ '--s': 'var(--color-warning)' }" />
            <span>还没有 Bot。先建一个 Bot 才能把工作区挂在它身上。</span>
          </div>
          <template v-else>
            <div class="hint" style="margin-bottom: 10px">
              将设置到 <b>{{ workspaceTarget.name }}</b>
              <span v-if="workspaceTarget.defaultWorkspace" class="u-mono">
                （当前：{{ workspaceTarget.defaultWorkspace }}）
              </span>
            </div>
            <div class="field">
              <label class="u-label" for="setup-workspace">目录路径</label>
              <input
                id="setup-workspace"
                v-model="workspace"
                class="input u-mono"
                placeholder="例如：D:/workspace/my-project"
                :aria-invalid="workspaceErr ? 'true' : 'false'"
                @input="workspaceErr = ''"
              />
              <div v-if="workspaceErr" class="field-err" role="alert">{{ workspaceErr }}</div>
              <div v-else class="hint">必须是存在且可写的绝对路径；不要求是 git 仓库。</div>
            </div>
          </template>
        </div>

        <div class="setup-foot">
          <button class="btn btn--secondary" @click="goStep(3)">上一步</button>
          <button class="btn btn--ghost" @click="goStep(5)">跳过</button>
          <span class="spacer" />
          <button
            class="btn btn--primary btn--lg"
            :disabled="workspaceBusy || !workspaceTarget"
            @click="saveWorkspace"
          >{{ workspace.trim().length === 0 ? "跳过并继续" : workspaceBusy ? "保存中…" : "保存并继续" }}</button>
        </div>
      </template>

      <!-- ================= ⑤ 基础技能（可选） ================= -->
      <template v-else-if="step === 5">
        <h1 class="setup-title">装上基础技能</h1>
        <p class="setup-sub">
          基础技能包是 4 份 SKILL.md（读写文件 / 执行命令 / 查找 / 联网），随代码分发，
          首次启动已自动装到技能目录。模型只在需要时读取正文，不占额外上下文。
        </p>

        <div class="setup-card" style="padding: 20px">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
            <span class="u-label" style="margin: 0">技能目录</span>
            <span class="u-mono" style="color: var(--color-text-secondary); word-break: break-all">
              {{ skills.dir || setup.state?.skillsDir || "~/.agentbot/skills" }}
            </span>
            <span class="spacer" />
            <span class="chip" style="cursor: default">{{ skills.skills.length }} 个技能</span>
          </div>

          <div v-if="skills.status === 'loading'" style="display: grid; gap: 10px; margin-top: 12px">
            <div v-for="i in 4" :key="i" class="sk" style="height: 44px" />
          </div>
          <div v-else-if="skills.status === 'empty'" style="margin-top: 12px">
            <p class="hint">还没有技能。点下面的按钮安装内置基础技能包。</p>
          </div>
          <div v-else style="margin-top: 12px; display: grid; gap: 8px">
            <div
              v-for="s in skills.skills"
              :key="s.dirName"
              style="display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--color-border)"
            >
              <span class="state-dot" style="--s: var(--state-done); margin-top: 6px" />
              <div style="flex: 1; min-width: 0">
                <div style="font-size: var(--font-size-body-sm); font-weight: var(--weight-semibold)">
                  {{ s.name }}
                  <span v-if="s.builtin" class="cap cap--scope">内置</span>
                </div>
                <div style="font-size: var(--font-size-caption); color: var(--color-text-muted)">{{ s.description }}</div>
              </div>
            </div>
          </div>

          <div v-if="skillMessage" class="hint" style="color: var(--color-success-ink); margin-top: 10px">
            {{ skillMessage }}
          </div>
          <div style="display: flex; gap: 8px; margin-top: 12px">
            <button class="btn btn--secondary" :disabled="skillBusy" @click="installSkills">
              {{ skillBusy ? "安装中…" : "安装 / 补装基础技能包" }}
            </button>
          </div>
        </div>

        <div class="setup-foot">
          <button class="btn btn--secondary" @click="goStep(4)">上一步</button>
          <button class="btn btn--ghost" @click="goStep(6)">跳过</button>
          <span class="spacer" />
          <button class="btn btn--primary btn--lg" @click="goStep(6)">完成，试试发消息</button>
        </div>
      </template>

      <!-- ================= ⑥ 发第一条消息（演练） ================= -->
      <template v-else>
        <h1 class="setup-title">发第一条消息</h1>
        <p class="setup-sub">
          <template v-if="chatBot">
            {{ chatBot.name }} · {{ chatBot.runtime?.displayName ?? "未绑定运行时" }} ·
            {{ chatBot.executionLocation === "worktree" ? "worktree" : "local" }}
            {{ chatBot.effectivePath ?? "" }}
          </template>
          <template v-else>还没有 Bot —— 回到上一步建一个，或稍后在 Bot 页面创建。</template>
        </p>

        <div class="setup-card" style="padding: 16px 20px; min-height: 220px">
          <section v-if="streamText || streaming || finished" class="turn" :style="setupBotVars">
            <header class="turn-head" style="position: static">
              <BotAvatar
                :name="chatBot?.name ?? 'Bot'"
                :color-index="chatBot?.colorIndex ?? 1"
                :avatar="chatBot?.avatar ?? null"
                :size="24"
              />
              <span class="turn-name">{{ chatBot?.name }}</span>
              <span class="rt-chip">
                {{ chatBot?.runtime?.displayName }}<template v-if="chatBot?.runtime"> · {{ chatBot.runtime.protocol }}</template>
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
                  :name="chatBot?.name ?? 'Bot'"
                  :color-index="chatBot?.colorIndex ?? 1"
                  :avatar="chatBot?.avatar ?? null"
                  :size="32"
                />
                <div class="msg-col">
                  <div class="msg-name">{{ chatBot?.name }}</div>
                  <div class="bubble bubble--bot" style="min-height: 48px">
                    <template v-if="streamText">{{ streamText }}</template>
                    <span v-else-if="streaming" class="wait-line">等待运行时返回 · 已 {{ (elapsedMs / 1000).toFixed(1) }}s</span>
                    <span v-if="streaming && streamText" class="cursor-stream" />
                  </div>
                </div>
              </div>

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
            <p>比如：用一句话介绍你自己。</p>
          </div>
        </div>

        <div v-if="sendError" class="err-block" style="margin-top: 16px">
          <div class="err-msg">{{ sendError }}</div>
          <div class="err-actions">
            <button class="btn btn--sm btn--primary" @click="sendFirst">重发</button>
            <button class="btn btn--sm btn--secondary" @click="goStep(3)">改 Bot / 运行时</button>
          </div>
        </div>

        <div style="display: flex; gap: 8px; margin-top: 16px">
          <input
            v-model="draft"
            class="input"
            :placeholder="`给 ${chatBot?.name ?? 'Bot'} 发消息…`"
            :disabled="streaming || !chatBot"
            @keydown.enter.prevent="sendFirst"
          />
          <button
            class="btn btn--primary btn--lg"
            :disabled="streaming || draft.trim().length === 0 || !chatBot"
            @click="sendFirst"
          >发送</button>
        </div>

        <div class="setup-foot">
          <button class="btn btn--secondary" @click="goStep(5)">上一步</button>
          <span class="spacer" />
          <span v-if="finished && !sendError" class="setup-done-hint">完成，进入工作台</span>
          <button class="btn btn--primary btn--lg" @click="finish">进入工作台</button>
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
