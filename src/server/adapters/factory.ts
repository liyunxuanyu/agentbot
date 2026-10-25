import type { AdapterDeclaration, ChannelDriver } from "./contract.js";
import { createAcpDriver } from "./channels/acp/driver.js";
import { createCliDriver } from "./channels/cli/driver.js";
import { createNativeDriver } from "./channels/native/driver.js";
import { createBuiltinDriver } from "./channels/builtin/driver.js";

/**
 * 协议 → 通道驱动。
 *
 * 为什么这个映射必须放在 adapters/ 而不是 core/：核心不允许出现协议名
 * （`scripts/check-boundaries.mjs` 会拦 `\bacp\b` 之类）。核心只调
 * `createDriverFor(declaration)`，拿到的是一个不透明的 `ChannelDriver`。
 *
 * 新增一个运行时不需要动这里：协议是声明字段，通道是有限集合。
 * 新增一个**通道**（例如 OpenCode HTTP）才在这里加一行。
 */

const acpDriver = createAcpDriver();
const cliDriver = createCliDriver();
const nativeDriver = createNativeDriver();
/**
 * 内置引擎驱动由装配层配置（它需要 MCP 管理器与供应商存储）。
 * 未配置时给一个空驱动，避免 `createDriverFor` 在启动早期返回 undefined。
 */
let builtinDriver: ChannelDriver = createBuiltinDriver();

export function configureBuiltinDriver(driver: ChannelDriver): void {
  builtinDriver = driver;
}

export function createDriverFor(decl: AdapterDeclaration): ChannelDriver {
  switch (decl.protocol) {
    case "acp":
      return acpDriver;
    case "cli-stdio":
      return cliDriver;
    case "builtin":
      return builtinDriver;
    case "codex-app-server":
      // M9 前是骨架：initialize 返回 unhealthy + detail，探测会如实置灰
      return nativeDriver;
    case "opencode-http":
    case "claude-sdk":
      // 声明存在但驱动未落地：交给 native 骨架给出「未实现」的明确答案，
      // 而不是让上层拿到 undefined 崩溃
      return nativeDriver;
    default: {
      // 穷尽检查：新增协议时这里会编译报错，提醒补驱动
      const never: never = decl.protocol;
      return never;
    }
  }
}

/** 测试用：注入假传输的 ACP / CLI 驱动。 */
export { createAcpDriver, createCliDriver, createNativeDriver, createBuiltinDriver };
