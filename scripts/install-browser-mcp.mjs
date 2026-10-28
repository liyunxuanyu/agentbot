#!/usr/bin/env node
/**
 * 安装「浏览器控制」能力（Playwright MCP，headless）。
 *
 *   node scripts/install-browser-mcp.mjs            # 安装并写入 mcp.json
 *   node scripts/install-browser-mcp.mjs --check    # 只检查，不改任何东西
 *
 * 为什么用 Playwright MCP 而不是自建浏览器工具：
 *   - 它是 MCP 标准 server，agentbot 的 MCP 通道已经能连（`McpManager` 只管 stdio），
 *     不需要往内置引擎里再加一套浏览器协议；
 *   - `--headless` 在无显示器的 Ubuntu 上可用（本机实测），不需要 Xvfb；
 *   - 25 个工具（navigate / click / type / snapshot / screenshot / evaluate …）
 *     对模型来说语义清晰，比自己包一层 CDP 更省事。
 *
 * 这个脚本只做三件事，且都是幂等的：
 *   ① 检查 `@playwright/mcp` 是否已安装（devDependency）；
 *   ② 检查 Chromium 是否已下载，缺了就 `install-browser chrome-for-testing`；
 *   ③ 把 `playwright` 条目合并进 `~/.agentbot/mcp.json`（已有则跳过，不覆盖用户改过的参数）。
 *
 * 装完不需要重启服务：MCP 是热插拔的（`McpManager.add`），下一轮对话模型就能看到
 * `mcp__playwright__*` 工具。**还需要在 Bot 边界里打开「允许联网」** —— MCP 工具
 * 默认按 `network` 权限裁决，confirm 模式下会弹权限卡，边界没开则直接拒绝。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const HOME = process.env.AGENTBOT_HOME ?? join(homedir(), ".agentbot");
const MCP_PATH = join(HOME, "mcp.json");
const BROWSER_DIR = join(HOME, "browser");
const SERVER_ID = "playwright";
const checkOnly = process.argv.includes("--check");

function log(message) {
  console.log(`[browser-mcp] ${message}`);
}

function fail(message) {
  console.error(`[browser-mcp] ✗ ${message}`);
  process.exit(1);
}

// ---- ① 包是否装了 ---------------------------------------------------------
const pkgPath = join(ROOT, "node_modules", "@playwright", "mcp", "package.json");
if (!existsSync(pkgPath)) {
  fail("没找到 @playwright/mcp。先执行 `npm install`（它已在 devDependencies 里）。");
}
const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
const cliPath = join(ROOT, "node_modules", "@playwright", "mcp", "cli.js");
log(`@playwright/mcp ${version}（${cliPath}）`);

// ---- ② 浏览器是否装了 -----------------------------------------------------
/**
 * Playwright MCP 默认用「chrome-for-testing」，与 `npx playwright install chromium`
 * 下载的目录版本号不一定一致（实测 1247 vs 1248），所以这里用 MCP 自己的
 * `install-browser` 命令判断/安装，而不是复用 playwright 的缓存。
 */
function chromeInstalled() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return false;
  const dirs = execFileSync("ls", [cache], { encoding: "utf8" }).split("\n");
  return dirs.some((d) => d.startsWith("chromium-") && existsSync(join(cache, d, "chrome-linux64", "chrome")));
}

if (!chromeInstalled()) {
  if (checkOnly) {
    log("Chromium 未安装（--check 不执行安装）");
  } else {
    log("下载 Chrome for Testing（约 120MB，仅首次）…");
    execFileSync("node", [cliPath, "install-browser", "chrome-for-testing"], {
      stdio: "inherit",
      cwd: ROOT,
    });
  }
} else {
  log("Chromium 已安装");
}

// ---- ③ 写 mcp.json（合并，不覆盖已有条目）--------------------------------
mkdirSync(HOME, { recursive: true });
mkdirSync(BROWSER_DIR, { recursive: true });

// `command` 用 "node" 而不是 process.execPath：用户可能用 nvm / 换 Node 版本，
// 写死绝对路径会让换版本后 MCP 起不来。PATH 里的 node 才是长期正确的。
const entry = {
  id: SERVER_ID,
  command: "node",
  args: [
    cliPath,
    "--headless",
    "--isolated",
    "--no-sandbox",
    "--browser",
    "chromium",
    "--output-dir",
    BROWSER_DIR,
  ],
  enabled: true,
  // 浏览器能访问任意 URL：按 network 裁决（plan 模式裁剪、confirm 弹卡、边界需开联网）
  permission: "network",
};

let file = { servers: [] };
if (existsSync(MCP_PATH)) {
  try {
    const parsed = JSON.parse(readFileSync(MCP_PATH, "utf8"));
    if (parsed && Array.isArray(parsed.servers)) file = parsed;
  } catch {
    fail(`${MCP_PATH} 不是合法 JSON，请先修好再运行`);
  }
}

const existing = file.servers.find((s) => s.id === SERVER_ID);
if (existing) {
  log(`mcp.json 里已有 ${SERVER_ID} 条目，跳过（如需换参数请手动改 ${MCP_PATH}）`);
} else if (checkOnly) {
  log(`mcp.json 里还没有 ${SERVER_ID} 条目（--check 不写入）`);
} else {
  const next = { ...file, servers: [...file.servers, entry] };
  const tmp = `${MCP_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, MCP_PATH);
  log(`已写入 ${MCP_PATH}`);
}

log("完成。下一步：");
log("  1) 设置 › MCP 点「刷新」（= POST /api/mcp/sync，会把盘上新增的条目热接进来）");
log("     服务没在运行时直接启动即可；不要为了让它出现去重启正在跑的服务。");
log("  2) Bot 详情 › 权限边界 打开「允许联网」（否则工具调用会被边界直接拒绝）");
log("  3) 确认模式下每次浏览器调用都会弹权限卡 —— 想连续操作就在卡上点");
log("     「记住（本会话）」或把该会话切到「完全访问」。");
log("  4) 在会话里说「用浏览器打开 https://example.com 并告诉我标题」");
