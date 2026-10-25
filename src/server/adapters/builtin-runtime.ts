import type { AdapterDeclaration } from "./contract.js";
import { EVENT_TYPES } from "../../shared/events.js";

/**
 * 内置引擎的运行时声明。
 *
 * 它不是 PATH 里的可执行文件，所以不走 YAML / 探测流程：
 * `main.ts` 直接把它注册进 `runtime_definitions`，可用性取决于是否配置了供应商。
 *
 * `permission.channel = "internal"`：权限请求不经过外部协议，而是 loop 在
 * 执行工具前回调产品层的权限裁决器。`requiresWorktree()` 只认 `"none"`，
 * 因此内置引擎允许 local —— 这正是它的价值（有真实门禁，不必隔离到 worktree）。
 */
export const BUILTIN_RUNTIME_ID = "builtin";

export function builtinDeclaration(): AdapterDeclaration {
  return {
    schemaVersion: 1,
    id: BUILTIN_RUNTIME_ID,
    displayName: "内置引擎",
    protocol: "builtin",
    launch: { command: "(内置)", args: [] },
    detect: { versionArgs: [], versionPattern: "(?<version>\\d+\\.\\d+)" },
    capabilities: {
      plan: true,
      permissionRequest: true,
      resume: true,
      images: false,
      streaming: true,
      contextWindow: null,
    },
    eventCapabilities: [...EVENT_TYPES],
    permission: { channel: "internal", defaultTimeoutPolicy: "reject" },
    resumeStrategy: "native",
    executionLocations: ["local", "worktree"],
    modes: { headless: true },
  };
}
