import type { ProviderClient, ProviderConfig } from "../../core/agent/provider.js";
import { createAnthropicClient } from "./anthropic.js";
import { createOpenAiChatClient } from "./openai-chat.js";

/** 协议 → 客户端。新增一种线上协议只改这里与 factory 的穷尽检查。 */
export function createProviderClient(cfg: ProviderConfig): ProviderClient {
  switch (cfg.protocol) {
    case "openai-chat":
      return createOpenAiChatClient(cfg);
    case "anthropic-messages":
      return createAnthropicClient(cfg);
    default: {
      const never: never = cfg.protocol;
      throw new Error(`未知的供应商协议：${String(never)}`);
    }
  }
}

export { createAnthropicClient, createOpenAiChatClient };
