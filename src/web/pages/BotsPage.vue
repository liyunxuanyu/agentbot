<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { ApiError, api } from "../net/client";
import { useBotsStore } from "../stores/bots";
import { useProvidersStore } from "../stores/providers";
import { useRuntimesStore } from "../stores/runtimes";
import { useUiStore } from "../stores/ui";
import type { BotState, ExecutionLocation } from "../net/types";
import BotCard from "../components/bot/BotCard.vue";
import EmptyState from "../components/common/EmptyState.vue";
import AppIcon from "../components/common/AppIcon.vue";
import AppModal from "../components/common/AppModal.vue";

/**
 * /bots —— Bot 总览（UX §4.2，S3 硬指标）。
 *
 * 四态齐备（缺一不可）：
 *   加载 → 6 张同尺寸骨架卡（320×200，加载完不跳动）
 *   错误 → 顶部错误条 + 保留导航与骨架，可重试
 *   空   → 「创建你的第一个 Bot」大号引导（不是错误）
 *   正常 → 汇总条 + 筛选 + 卡片网格
 * 另加第五种：筛选无结果（「没有符合条件的 Bot」+ 清除筛选，**不复用**空态引导）。
 *
 * 数据来源：`/api/bots`；该端点未落地时（M3 阶段）按空态处理，
 * 运行时种类仍来自 `/api/meta`（M1 已有），所以汇总条不会全 0。
 */
const bots = useBotsStore();
const runtimesStore = useRuntimesStore();
const providersStore = useProvidersStore();
const ui = useUiStore();
const router = useRouter();
const { bots: list, status, errorText, workingCount, pendingCount, readyRuntimeCount, runtimes } =
  storeToRefs(bots);

const filters = ref<{
  runtime: string;
  state: string;
  location: string;
}>({ runtime: "all", state: "all", location: "all" });

/** 运行时筛选的可选项：来自真实探测结果，不写死。 */
const runtimeOptions = computed(() => [
  { key: "all", label: "全部" },
  ...runtimes.value.map((r) => ({ key: r.id, label: r.displayName })),
]);

const stateOptions: { key: BotState | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "idle", label: "空闲" },
  { key: "thinking", label: "思考" },
  { key: "working", label: "工作" },
  { key: "waiting", label: "等待" },
  { key: "blocked", label: "受阻" },
  { key: "done", label: "完成" },
];

const locationOptions: { key: ExecutionLocation | "all"; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "local", label: "local" },
  { key: "worktree", label: "worktree" },
];

const filtered = computed(() =>
  list.value.filter((b) => {
    if (filters.value.runtime !== "all" && b.runtime?.id !== filters.value.runtime) return false;
    if (filters.value.state !== "all" && b.state !== filters.value.state) return false;
    if (filters.value.location !== "all" && b.executionLocation !== filters.value.location) return false;
    return true;
  }),
);

const hasFilter = computed(
  () =>
    filters.value.runtime !== "all" ||
    filters.value.state !== "all" ||
    filters.value.location !== "all",
);

function clearFilters(): void {
  filters.value = { runtime: "all", state: "all", location: "all" };
}

/** 新建 Bot：接真实 `POST /api/bots`（P0-03）。 */
const newBotOpen = ref(false);
const newBotName = ref("");
const newBotNameErr = ref("");
const newBotPersona = ref("负责把技术结论改写成非技术同事能读的段落，不改动代码。");
const newBotRuntime = ref("");
const newBotProvider = ref("");
const newBotLocation = ref<ExecutionLocation>("local");
const newBotRepo = ref("");
const newBotRepoErr = ref("");
const creating = ref(false);

const readyRuntimes = computed(() =>
  runtimesStore.runtimes.filter(
    (r) => r.healthStatus === "ready" || r.healthStatus === "unprobed",
  ),
);

/**
 * 选中运行时是否强制 worktree。
 *
 * `/api/meta` 的精简 RuntimeSummary 不带 `requiresWorktree`，但 `/api/runtimes`
 * 带。这里按 id 从 runtimes store 里查；查不到就按 false 处理，让后端的 400
 * 字段错误兜底（不猜一个「强制 worktree」吓用户）。
 */
const newBotMustWorktree = computed(() => runtimesStore.find(newBotRuntime.value)?.requiresWorktree === true);
/** 内置引擎需要选模型供应商（不选则用默认供应商）。 */
const newBotIsBuiltin = computed(
  () => runtimesStore.find(newBotRuntime.value)?.protocol === "builtin",
);
const newBotEffectiveLocation = computed<ExecutionLocation>(() =>
  newBotMustWorktree.value ? "worktree" : newBotLocation.value,
);

function openNewBot(): void {
  newBotName.value = "";
  newBotNameErr.value = "";
  newBotRepo.value = "";
  newBotRepoErr.value = "";
  newBotLocation.value = "local";
  newBotRuntime.value = readyRuntimes.value[0]?.id ?? "";
  newBotProvider.value = providersStore.defaultId ?? "";
  newBotOpen.value = true;
  if (runtimesStore.runtimes.length === 0) void runtimesStore.load();
  if (providersStore.providers.length === 0) void providersStore.load();
}

/**
 * 创建（P0-03 边界：1–32 字符、工作区内唯一、重复内联报错不提交）。
 *
 * 本地先校验一遍是为了省一次往返；**唯一性的真相在后端**，所以 `400` 的
 * `fields[]` 也要读出来挂到对应输入框（用户可能在另一个标签页刚建过同名 Bot）。
 */
async function createBot(): Promise<void> {
  if (creating.value) return;
  const name = newBotName.value.trim();
  if (name.length === 0) {
    newBotNameErr.value = "名称不能为空。";
    return;
  }
  if (name.length > 32) {
    newBotNameErr.value = "名称最多 32 个字符。";
    return;
  }
  const location = newBotEffectiveLocation.value;
  const repoPath = newBotRepo.value.trim();
  if (location === "worktree" && repoPath.length === 0) {
    newBotRepoErr.value = newBotMustWorktree.value
      ? "该运行时不提供权限请求，无法拦截文件写入，必须跑在 worktree 里。请填仓库根路径。"
      : "选 worktree 时必须填仓库根路径。";
    return;
  }

  newBotNameErr.value = "";
  newBotRepoErr.value = "";
  creating.value = true;
  try {
    const res = await api.createBot({
      name,
      persona: newBotPersona.value.trim(),
      ...(newBotRuntime.value ? { runtimeId: newBotRuntime.value } : {}),
      ...(newBotIsBuiltin.value && newBotProvider.value ? { providerId: newBotProvider.value } : {}),
      executionLocation: location,
      ...(location === "worktree" ? { repoPath } : {}),
    });
    newBotOpen.value = false;
    await bots.load();
    const created = res.bot;
    ui.toast(created ? `已创建 ${created.name}` : "已创建");
    if (created) void router.push(`/bots/${created.id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const fields = err.fieldErrors();
      const nameField = fields.find((f) => f.field === "name");
      const repoField = fields.find((f) => f.field === "repoPath");
      newBotNameErr.value = nameField?.message ?? "";
      newBotRepoErr.value = repoField?.message ?? "";
      if (!newBotNameErr.value && !newBotRepoErr.value) {
        newBotNameErr.value = err.messageText() ?? "创建失败：请求未通过校验。";
      }
      return;
    }
    newBotNameErr.value = err instanceof Error ? `创建失败：${err.message}` : "创建失败。";
  } finally {
    creating.value = false;
  }
}

function openBot(id: string): void {
  void router.push(`/bots/${id}`);
}

function openDetail(id: string): void {
  void router.push(`/bots/${id}`);
}

function assignFromCard(id: string): void {
  const bot = bots.findBot(id);
  ui.toast(`派任务给 ${bot?.name ?? "Bot"} · 任务模块在 M11 接入`);
}

onMounted(() => {
  void bots.load();
});
</script>

<template>
  <div>
    <!-- 页头：汇总条是 S3 第一眼信息（4 组数字） -->
    <div class="page-head enter" :style="{ '--i': 0 }">
      <div>
        <h1 class="page-title">Bot</h1>
        <p class="page-desc">
          每个 Bot 有自己的名字、颜色、记忆和权限边界；运行时只是它当前绑定的机器。换运行时，人和记忆都留着。
        </p>
      </div>
      <div class="spacer" />
      <div class="readbar">
        <div class="read-group">
          <span class="read-num">{{ status === "empty" ? 0 : list.length }}</span>
          <span class="read-cap">个 Bot</span>
        </div>
        <div class="read-group">
          <span class="read-num">{{ readyRuntimeCount }}</span>
          <span class="read-cap">种运行时</span>
        </div>
        <div class="read-group">
          <span class="read-num is-working">{{ workingCount }}</span>
          <span class="read-cap">在干活</span>
        </div>
        <div class="read-group">
          <span class="read-num is-warning">{{ pendingCount }}</span>
          <span class="read-cap">条待批</span>
        </div>
      </div>
      <button class="btn btn--primary" @click="openNewBot">
        <AppIcon name="plus" :size="14" />新建 Bot
      </button>
    </div>

    <!-- 筛选条：空态下不显示（原型一致） -->
    <div v-if="status !== 'empty' && status !== 'error'" class="filters enter" :style="{ '--i': 1 }">
      <div class="filter-group">
        <span class="u-label">运行时</span>
        <button
          v-for="opt in runtimeOptions"
          :key="opt.key"
          class="chip"
          :class="{ 'is-on': filters.runtime === opt.key }"
          @click="filters.runtime = opt.key"
        >{{ opt.label }}</button>
      </div>
      <div class="filter-group">
        <span class="u-label">状态</span>
        <button
          v-for="opt in stateOptions"
          :key="opt.key"
          class="chip"
          :class="{ 'is-on': filters.state === opt.key }"
          @click="filters.state = opt.key"
        >{{ opt.label }}</button>
      </div>
      <div class="filter-group">
        <span class="u-label">位置</span>
        <button
          v-for="opt in locationOptions"
          :key="opt.key"
          class="chip"
          :class="{ 'is-on': filters.location === opt.key }"
          @click="filters.location = opt.key"
        >{{ opt.label }}</button>
      </div>
      <div class="spacer" />
      <span class="filter-count">{{ filtered.length }} / {{ list.length }}</span>
    </div>

    <!-- 加载态：6 张同尺寸骨架 -->
    <div v-if="status === 'loading' || status === 'idle'" class="bot-grid">
      <div
        v-for="i in 6"
        :key="i"
        class="bot-card"
        aria-hidden="true"
        :style="{ '--bc': 'var(--color-surface-2)' }"
      >
        <div class="bc-head">
          <span class="sk" style="width: 40px; height: 40px; border-radius: 8px" />
          <div class="bc-id" style="gap: 8px">
            <span class="sk sk-line" style="width: 88px" />
            <span class="sk" style="width: 56px; height: 18px; border-radius: 99px" />
          </div>
        </div>
        <div style="margin: 12px 0 14px"><span class="sk sk-line" style="width: 74%" /></div>
        <div class="bc-reads">
          <span class="sk sk-line" style="width: 40px" /><span class="sk sk-line" style="width: 62%" />
          <span class="sk sk-line" style="width: 48px" /><span class="sk sk-line" style="width: 76%" />
          <span class="sk sk-line" style="width: 44px" /><span class="sk sk-line" style="width: 54%" />
        </div>
      </div>
    </div>

    <!-- 错误态：错误条 + 骨架（保留导航，可重试） -->
    <template v-else-if="status === 'error'">
      <div class="banner">
        <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
        <span>读取 Bot 失败{{ errorText ? `：${errorText}` : "：本地服务没有响应。" }}</span>
        <span class="spacer" />
        <button class="btn btn--sm" @click="bots.load()">重试</button>
      </div>
      <div class="bot-grid">
        <div
          v-for="i in 3"
          :key="i"
          class="bot-card"
          aria-hidden="true"
          :style="{ '--bc': 'var(--color-surface-2)' }"
        >
          <div class="bc-head">
            <span class="sk" style="width: 40px; height: 40px; border-radius: 8px" />
            <div class="bc-id" style="gap: 8px">
              <span class="sk sk-line" style="width: 88px" />
              <span class="sk" style="width: 56px; height: 18px; border-radius: 99px" />
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 空态：大号引导 -->
    <EmptyState
      v-else-if="status === 'empty'"
      title="创建你的第一个 Bot"
      description="Bot 有名字、人格、记忆和权限边界。它像同事一样被认识，而不是像进程一样被列出——所以你一眼就能看出谁在什么上跑、现在在干嘛。"
    >
      <template #icon>
        <AppIcon name="bots" :size="24" />
      </template>
      <template #actions>
        <button class="btn btn--primary" @click="openNewBot">新建 Bot</button>
        <RouterLink class="btn btn--secondary" to="/setup">走一遍首次启动向导</RouterLink>
      </template>
    </EmptyState>

    <!-- 筛选无结果：与空态不同文案，且给「清除筛选」 -->
    <EmptyState
      v-else-if="filtered.length === 0"
      title="没有符合条件的 Bot"
      description="换一个运行时或状态试试。"
    >
      <template #icon>
        <AppIcon name="bots" :size="24" />
      </template>
      <template #actions>
        <button v-if="hasFilter" class="btn btn--secondary" @click="clearFilters">清除筛选</button>
      </template>
    </EmptyState>

    <!-- 正常态 -->
    <div v-else class="bot-grid">
      <BotCard
        v-for="(bot, i) in filtered"
        :key="bot.id"
        :bot="bot"
        :index="i + 2"
        @open="openBot"
        @detail="openDetail"
        @assign="assignFromCard"
      />
    </div>

    <!-- 新建 Bot 弹层 -->
    <AppModal v-model:open="newBotOpen" title="新建 Bot">
      <div class="field">
        <label class="u-label" for="nb-name">名称</label>
        <input
          id="nb-name"
          v-model="newBotName"
          class="input"
          placeholder="例如：文档助手"
          :aria-invalid="newBotNameErr ? 'true' : 'false'"
          @input="newBotNameErr = ''"
        />
        <div v-if="newBotNameErr" class="field-err" role="alert">{{ newBotNameErr }}</div>
        <div v-else class="hint">1–32 个字符，工作区内唯一。</div>
      </div>
      <div class="field">
        <label class="u-label" for="nb-persona">人格</label>
        <textarea id="nb-persona" v-model="newBotPersona" class="textarea" rows="3" />
      </div>
      <div class="field">
        <label class="u-label" for="nb-runtime">运行时</label>
        <select id="nb-runtime" v-model="newBotRuntime" class="select">
          <option v-if="readyRuntimes.length === 0" value="" disabled>还没有可用的运行时</option>
          <option v-for="r in readyRuntimes" :key="r.id" :value="r.id">
            {{ r.displayName }}{{ r.version ? ` · ${r.version}` : "" }}
          </option>
        </select>
        <div v-if="readyRuntimes.length === 0" class="hint">
          未发现可用运行时。先到「设置 › 运行时」重新探测，或走一遍首次启动向导。
        </div>
      </div>
      <div v-if="newBotIsBuiltin" class="field">
        <label class="u-label" for="nb-provider">模型供应商</label>
        <select id="nb-provider" v-model="newBotProvider" class="select">
          <option value="">使用默认供应商</option>
          <option v-for="p in providersStore.providers" :key="p.id" :value="p.id">
            {{ p.name }} · {{ p.model }}
          </option>
        </select>
        <div v-if="providersStore.providers.length === 0" class="hint" style="color: var(--color-warning-ink)">
          还没有配置模型供应商。内置引擎需要至少一个供应商，先到「设置 › 模型供应商」添加。
        </div>
        <div v-else class="hint">
          内置引擎直连模型 API；工具调用会逐个走权限卡片。当前默认：{{ providersStore.defaultProvider?.name ?? "—" }}
        </div>
      </div>
      <div class="field">
        <label class="u-label">执行位置</label>
        <div class="radio-row">
          <label class="radio">
            <input
              type="radio"
              name="nbloc"
              value="local"
              :checked="newBotEffectiveLocation === 'local'"
              :disabled="newBotMustWorktree"
              @change="newBotLocation = 'local'"
            />
            local
          </label>
          <label class="radio">
            <input
              type="radio"
              name="nbloc"
              value="worktree"
              :checked="newBotEffectiveLocation === 'worktree'"
              @change="newBotLocation = 'worktree'"
            />
            git worktree
          </label>
        </div>
        <div v-if="newBotMustWorktree" class="hint" style="color: var(--color-warning-ink)">
          该运行时不提供权限请求，产品层无法拦截文件写入，因此强制跑在 worktree 里。
        </div>
      </div>
      <div v-if="newBotEffectiveLocation === 'worktree'" class="field">
        <label class="u-label" for="nb-repo">仓库根路径</label>
        <input
          id="nb-repo"
          v-model="newBotRepo"
          class="input u-mono"
          placeholder="例如：D:/workspace/project"
          :aria-invalid="newBotRepoErr ? 'true' : 'false'"
          @input="newBotRepoErr = ''"
        />
        <div v-if="newBotRepoErr" class="field-err" role="alert">{{ newBotRepoErr }}</div>
        <div v-else class="hint">必须是 git 仓库根目录，保存时会校验。</div>
      </div>
      <template #footer>
        <button class="btn btn--secondary" @click="newBotOpen = false">取消</button>
        <span class="spacer" />
        <button
          class="btn btn--primary"
          :class="{ 'is-loading': creating }"
          :disabled="creating"
          @click="createBot"
        >{{ creating ? "创建中" : "创建" }}</button>
      </template>
    </AppModal>
  </div>
</template>
