import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isMissingEndpoint } from "../net/client";
import type { McpServerDto, McpServerInput } from "../net/types";

/**
 * MCP server 列表（内置引擎 N4/N6）。
 *
 * `running=false` 表示后端没有注入管理器（端点存在但未启动），
 * 页面据此提示「重启服务才会连接」，不假装已连接。
 * 后端有管理器时，增删改都是热插拔（N3-2），不需要重启。
 */
export type McpStatus = "idle" | "loading" | "ready" | "empty" | "error";

export const useMcpStore = defineStore("mcp", () => {
  const servers = ref<McpServerDto[]>([]);
  const running = ref(false);
  const status = ref<McpStatus>("idle");
  const errorText = ref("");
  const busyId = ref<string | null>(null);

  const connectedCount = computed(() => servers.value.filter((s) => s.status === "connected").length);
  const toolCount = computed(() => servers.value.reduce((sum, s) => sum + s.toolCount, 0));

  async function load(signal?: AbortSignal): Promise<void> {
    status.value = "loading";
    errorText.value = "";
    try {
      const res = await api.mcpServers(signal);
      servers.value = res.servers;
      running.value = res.running;
      status.value = res.servers.length === 0 ? "empty" : "ready";
    } catch (err) {
      if (isMissingEndpoint(err)) {
        servers.value = [];
        running.value = false;
        status.value = "empty";
        return;
      }
      servers.value = [];
      status.value = "error";
      errorText.value = err instanceof Error ? err.message : "读取 MCP 配置失败";
    }
  }

  async function create(input: McpServerInput): Promise<McpServerDto | null> {
    const res = await api.createMcpServer(input);
    await load();
    return res.server;
  }

  async function update(id: string, input: Partial<McpServerInput>): Promise<McpServerDto | null> {
    const res = await api.updateMcpServer(id, input);
    await load();
    return res.server;
  }

  async function remove(id: string): Promise<void> {
    await api.deleteMcpServer(id);
    servers.value = servers.value.filter((s) => s.id !== id);
    if (servers.value.length === 0) status.value = "empty";
  }

  async function reconnect(id: string): Promise<McpServerDto | null> {
    busyId.value = id;
    try {
      const res = await api.reconnectMcpServer(id);
      await load();
      return res.server;
    } finally {
      busyId.value = null;
    }
  }

  return {
    servers,
    running,
    status,
    errorText,
    busyId,
    connectedCount,
    toolCount,
    load,
    create,
    update,
    remove,
    reconnect,
  };
});
