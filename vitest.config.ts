import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 测试隔离：`config.worktreeRoot` 默认落在 `~/.agentbot/wt`。
 *
 * 为什么必须在这里改：`config` 在模块加载时读 `AGENTBOT_HOME`，
 * 所以环境变量要在收集测试文件**之前**设好（vitest.config 满足这一点）。
 * 不改的话，任何调用 `ensureWorktreeForBot` 的测试都会往用户真实目录里
 * 写 worktree，留下几十个 `无仓库-xxxx` 目录，还会因为残留目录让后续
 * 运行报 `already exists`（实测踩到）。
 */
process.env["AGENTBOT_HOME"] ??= mkdtempSync(join(tmpdir(), "agentbot-test-home-"));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@server": fileURLToPath(new URL("./src/server", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
  },
});
