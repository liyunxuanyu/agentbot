<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { ApiError } from "../net/client";
import type { ChannelDto } from "../net/types";
import { useBotsStore } from "../stores/bots";
import { useChannelsStore } from "../stores/channels";
import { useUiStore } from "../stores/ui";
import { agoText, dayTimeText } from "../lib/format";
import AppIcon from "../components/common/AppIcon.vue";
import BotAvatar from "../components/bot/BotAvatar.vue";
import EmptyState from "../components/common/EmptyState.vue";
import AppModal from "../components/common/AppModal.vue";

/**
 * /chats —— 渠道索引（UX §4.1，群聊在上、私聊在下）。
 *
 * 四态：
 *   加载 = 5 行骨架
 *   错误 = 重试条（保留页头与新建入口）
 *   空   = 「还没有会话」+ 去看 Bot / 新建群聊
 *   正常 = 群聊组 + 私聊组
 *
 * `task` 类型渠道（Assignment 的内部会话）不出现：它不是用户发起的地方，
 * 出现在列表里只会让人以为「我没建过这个群」。任务有自己的页面。
 */
const router = useRouter();
const bots = useBotsStore();
const channels = useChannelsStore();
const ui = useUiStore();
const { groups, dms, status, errorText } = storeToRefs(channels);

const groupOpen = ref(false);
const groupName = ref("");
const selected = ref<string[]>([]);
const hostId = ref("");
const groupError = ref("");
const creating = ref(false);

/** 参与者候选：所有活跃 Bot（运行时不可用的也可以进群，只是发不出消息）。 */
const candidateBots = computed(() => bots.bots);

/** 主持人候选 = 已选参与者。 */
const hostCandidates = computed(() =>
  candidateBots.value.filter((b) => selected.value.includes(b.id)),
);

function openGroupModal(): void {
  groupName.value = "";
  selected.value = [];
  hostId.value = "";
  groupError.value = "";
  groupOpen.value = true;
}

function toggleParticipant(id: string): void {
  const next = selected.value.includes(id)
    ? selected.value.filter((x) => x !== id)
    : [...selected.value, id];
  selected.value = next;
  // 主持人被取消勾选后自动落到第一个参与者，避免出现「主持人不在群里」
  if (hostId.value && !next.includes(hostId.value)) hostId.value = next[0] ?? "";
  if (!hostId.value && next.length > 0) hostId.value = next[0] ?? "";
  groupError.value = "";
}

async function createGroup(): Promise<void> {
  if (creating.value) return;
  const name = groupName.value.trim();
  if (name.length === 0) {
    groupError.value = "群名不能为空。";
    return;
  }
  if (selected.value.length < 2) {
    groupError.value = "至少选 2 个 Bot（群聊的意义在于多个 Bot 协作）。";
    return;
  }
  if (selected.value.length > 5) {
    groupError.value = "最多选 5 个 Bot。";
    return;
  }
  if (!hostId.value) {
    groupError.value = "请指定一个主持人。";
    return;
  }
  creating.value = true;
  try {
    const channel = await channels.createGroup({
      name,
      participantBotIds: selected.value,
      hostBotId: hostId.value,
    });
    groupOpen.value = false;
    void router.push(`/chat/${channel.id}`);
  } catch (err) {
    groupError.value =
      err instanceof ApiError
        ? (err.messageText() ?? `创建失败（${err.code}）`)
        : "创建失败，请重试。";
  } finally {
    creating.value = false;
  }
}

/** 行内展示：群聊取前三个参与者头像叠加，私聊用单个 Bot 头像。 */
function participantsOf(c: ChannelDto) {
  return c.participantBotIds
    .map((id) => bots.findBot(id))
    .filter((b): b is NonNullable<typeof b> => b !== undefined);
}

function rowTitle(c: ChannelDto): string {
  return c.name || (c.type === "dm" ? "私聊" : "群聊");
}

function rowSub(c: ChannelDto): string {
  if (c.lastMessagePreview) return c.lastMessagePreview;
  return c.type === "dm" ? "还没有消息，发第一条开始" : "还没有消息";
}

function openChannel(c: ChannelDto): void {
  void router.push(`/chat/${c.id}`);
}

function dmBotOf(c: ChannelDto) {
  return bots.findBot(c.participantBotIds[0] ?? "");
}

/** 最近活动（页脚一句，给人「这里有多新」的感知）。 */
const latestAt = computed(() => {
  const all = [...groups.value, ...dms.value]
    .map((c) => c.lastMessageAt)
    .filter((t): t is number => typeof t === "number");
  return all.length > 0 ? Math.max(...all) : null;
});

onMounted(async () => {
  ui.setCrumb([{ text: "会话" }]);
  if (bots.bots.length === 0) void bots.load();
  await channels.load();
});
</script>

<template>
  <div>
    <div class="page-head enter" :style="{ '--i': 0 }">
      <div>
        <h1 class="page-title">会话</h1>
        <p class="page-desc">
          私聊直接找一个 Bot；群聊由主持人决定本轮谁回答，未被点名的 Bot 不产生任何运行时调用。
        </p>
      </div>
      <div class="spacer" />
      <button class="btn btn--primary" @click="openGroupModal">
        <AppIcon name="plus" :size="14" />新建群聊
      </button>
    </div>

    <!-- 加载态：5 行骨架 -->
    <div v-if="status === 'loading' || status === 'idle'" class="rows">
      <div v-for="i in 5" :key="i" class="row-item" aria-hidden="true">
        <span class="sk" style="width: 32px; height: 32px; border-radius: 8px" />
        <div class="row-main">
          <span class="sk sk-line" style="width: 120px; display: block" />
          <span class="sk sk-line" style="width: 60%; display: block; margin-top: 8px; height: 8px" />
        </div>
      </div>
    </div>

    <!-- 错误态 -->
    <div v-else-if="status === 'error'" class="banner">
      <span class="state-dot" :style="{ '--s': 'var(--state-blocked)' }" />
      <span>读取会话失败{{ errorText ? `：${errorText}` : "。" }}</span>
      <span class="spacer" />
      <button class="btn btn--sm" @click="channels.load()">重试</button>
    </div>

    <!-- 空态 -->
    <EmptyState
      v-else-if="status === 'empty'"
      title="还没有会话"
      description="从任一 Bot 卡片开始私聊，或者新建一个群聊把几个 Bot 放在一起。"
    >
      <template #icon><AppIcon name="chats" :size="24" /></template>
      <template #actions>
        <RouterLink class="btn btn--primary" to="/bots">去看 Bot</RouterLink>
        <button class="btn btn--secondary" @click="openGroupModal">新建群聊</button>
      </template>
    </EmptyState>

    <!-- 正常态：群聊 / 私聊两组 -->
    <template v-else>
      <div v-if="groups.length > 0">
        <div class="u-label" style="margin: 0 0 8px 12px">群聊</div>
        <div class="rows">
          <a
            v-for="(c, i) in groups"
            :key="c.id"
            class="row-item enter"
            :style="{ '--i': Math.min(i + 1, 5) }"
            :href="`/chat/${c.id}`"
            @click.prevent="openChannel(c)"
          >
            <span class="av-stack">
              <BotAvatar
                v-for="p in participantsOf(c).slice(0, 3)"
                :key="p.id"
                :name="p.name"
                :color-index="p.colorIndex"
                :avatar="p.avatar"
                :size="32"
                :state="p.state"
              />
            </span>
            <div class="row-main">
              <div class="row-title">
                {{ rowTitle(c) }}
                <span class="rt-chip">群聊 · {{ c.participantBotIds.length }} 人</span>
              </div>
              <div class="row-sub">{{ rowSub(c) }}</div>
            </div>
            <div class="row-time">
              {{ c.lastMessageAt ? dayTimeText(c.lastMessageAt) : "—" }}
              <div v-if="c.unread > 0" style="margin-top: 4px">
                <span class="unread">{{ c.unread }}</span>
              </div>
            </div>
          </a>
        </div>
      </div>

      <div v-if="dms.length > 0">
        <div
          class="u-label"
          :style="{ margin: groups.length > 0 ? '24px 0 8px 12px' : '0 0 8px 12px' }"
        >私聊</div>
        <div class="rows">
          <a
            v-for="(c, i) in dms"
            :key="c.id"
            class="row-item enter"
            :style="{ '--i': Math.min(i + 2, 5) }"
            :href="`/chat/${c.id}`"
            @click.prevent="openChannel(c)"
          >
            <BotAvatar
              v-if="dmBotOf(c)"
              :name="dmBotOf(c)!.name"
              :color-index="dmBotOf(c)!.colorIndex"
              :avatar="dmBotOf(c)!.avatar"
              :size="32"
              :state="dmBotOf(c)!.state"
            />
            <span v-else class="av av--32" style="--bc: var(--color-surface-2)" aria-hidden="true">?</span>
            <div class="row-main">
              <div class="row-title">{{ rowTitle(c) }}</div>
              <div class="row-sub">{{ rowSub(c) }}</div>
            </div>
            <div class="row-time">
              {{ c.lastMessageAt ? dayTimeText(c.lastMessageAt) : "—" }}
              <div v-if="c.unread > 0" style="margin-top: 4px">
                <span class="unread">{{ c.unread }}</span>
              </div>
            </div>
          </a>
        </div>
      </div>

      <p class="hint" style="margin-top: 20px">
        私聊入口在 Bot 卡片上：点卡片进详情，详情页「进入会话」直接开聊。
        当前 {{ groups.length + dms.length }} 个会话<template v-if="latestAt"> · 最后一次 {{ agoText(latestAt) }}</template>
      </p>
    </template>

    <!-- 新建群聊 -->
    <AppModal v-model:open="groupOpen" title="新建群聊">
      <div class="field">
        <label class="u-label" for="grp-name">群名</label>
        <input
          id="grp-name"
          v-model="groupName"
          class="input"
          placeholder="例如：发布前评审"
          @input="groupError = ''"
        />
      </div>
      <div class="field">
        <label class="u-label">参与者（2–5 个）</label>
        <div class="pick-list">
          <label
            v-for="b in candidateBots"
            :key="b.id"
            class="pick"
            :class="{ 'is-on': selected.includes(b.id) }"
          >
            <input
              type="checkbox"
              :checked="selected.includes(b.id)"
              style="accent-color: var(--color-primary)"
              @change="toggleParticipant(b.id)"
            />
            <BotAvatar :name="b.name" :color-index="b.colorIndex" :avatar="b.avatar" :size="24" />
            <span style="font-size: var(--font-size-caption)">{{ b.name }}</span>
            <span class="spacer" />
            <span class="rt-chip">{{ b.runtime?.displayName ?? "未绑定" }}</span>
          </label>
          <p v-if="candidateBots.length === 0" class="hint">
            还没有 Bot。先去 <RouterLink to="/bots">创建一个 Bot</RouterLink>，群聊才有参与者。
          </p>
        </div>
      </div>
      <div class="field">
        <label class="u-label" for="grp-host">主持人</label>
        <select id="grp-host" v-model="hostId" class="select" :disabled="hostCandidates.length === 0">
          <option v-if="hostCandidates.length === 0" value="">先选参与者</option>
          <option v-for="b in hostCandidates" :key="b.id" :value="b.id">
            {{ b.name }}（{{ b.runtime?.displayName ?? "未绑定" }}）
          </option>
        </select>
        <div class="hint">主持人决定本轮谁来回答；未被点名的 Bot 不产生运行时调用。</div>
      </div>
      <div v-if="groupError" class="field-err" role="alert">{{ groupError }}</div>
      <template #footer>
        <span class="hint" style="margin: 0">默认依次执行，减少文件冲突</span>
        <span class="spacer" />
        <button class="btn btn--secondary" @click="groupOpen = false">取消</button>
        <button
          class="btn btn--primary"
          :class="{ 'is-loading': creating }"
          :disabled="creating"
          @click="createGroup"
        >{{ creating ? "创建中" : "创建群聊" }}</button>
      </template>
    </AppModal>
  </div>
</template>
