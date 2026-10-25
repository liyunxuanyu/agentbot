import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { ChannelDto } from "../net/types";

/**
 * 渠道列表（`GET /api/channels`）与新建渠道（`POST /api/channels`）。
 *
 * 分组规则（UX §4.1 `/chats`）：群聊在上、私聊在下。
 * `task` 类型的渠道（Assignment 内部会话）**不出现**在会话列表里 —— 它不是用户
 * 发起的地方，出现在这里只会让人以为「我没建过这个群」。任务有自己的页面。
 *
 * 四态：`loading | ready | empty | error`；空 = 还没有任何会话（给「去看 Bot」引导）。
 */
export type ChannelsStatus = "idle" | "loading" | "ready" | "empty" | "error";

export const useChannelsStore = defineStore("channels", () => {
  const channels = ref<ChannelDto[]>([]);
  const status = ref<ChannelsStatus>("idle");
  const errorText = ref("");

  /** 用户可发起的会话：dm + group。 */
  const visible = computed(() => channels.value.filter((c) => c.type === "dm" || c.type === "group"));
  const groups = computed(() => visible.value.filter((c) => c.type === "group"));
  const dms = computed(() => visible.value.filter((c) => c.type === "dm"));

  function find(id: string | null | undefined): ChannelDto | null {
    if (!id) return null;
    return channels.value.find((c) => c.id === id) ?? null;
  }

  async function load(signal?: AbortSignal): Promise<void> {
    status.value = "loading";
    errorText.value = "";
    try {
      const res = await api.channels(signal);
      channels.value = res.channels;
      status.value = res.channels.length === 0 ? "empty" : "ready";
    } catch (err) {
      if (isMissingEndpoint(err)) {
        channels.value = [];
        status.value = "empty";
        return;
      }
      channels.value = [];
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : "读取会话失败";
    }
  }

  /**
   * 打开某个 Bot 的私聊：已有就复用，没有就建。
   *
   * 后端对 dm 做了幂等，所以这里可以直接调用；返回渠道 id 供页面跳转。
   * 失败时抛出（页面决定是 toast 还是内联报错）。
   */
  async function openDm(botId: string): Promise<string> {
    const existing = dms.value.find((c) => c.participantBotIds[0] === botId);
    if (existing) return existing.id;
    const res = await api.createChannel({ type: "dm", participantBotIds: [botId] });
    const channel = res.channel;
    if (!channels.value.some((c) => c.id === channel.id)) {
      channels.value = [channel, ...channels.value];
    }
    if (status.value === "empty") status.value = "ready";
    return channel.id;
  }

  async function createGroup(input: {
    name: string;
    participantBotIds: string[];
    hostBotId: string;
  }): Promise<ChannelDto> {
    const res = await api.createChannel({ type: "group", ...input });
    const channel = res.channel;
    channels.value = [channel, ...channels.value.filter((c) => c.id !== channel.id)];
    if (status.value === "empty") status.value = "ready";
    return channel;
  }

  return { channels, visible, groups, dms, status, errorText, find, load, openDm, createGroup };
});
