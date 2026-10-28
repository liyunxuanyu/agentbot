#!/usr/bin/env node
/**
 * 移动端 / 公网场景的浏览器级冒烟（Playwright，headless Chromium）。
 *
 *   node scripts/e2e-mobile.mjs --base http://127.0.0.1:8787 --token <token> --channel dm_xxx
 *
 * 为什么单独一个脚本而不是 vitest 用例：它需要真实服务 + 真实模型供应商
 * （一轮对话要十几秒），放进 `npm test` 会让门禁依赖外部网络。这个脚本
 * 专门用来验证「手机上到底看不看得见 / 点不点得到」这类只有真实渲染
 * 才暴露的问题 —— 本次修的三个缺陷（权限卡盖住输入区、胶囊菜单被压住、
 * 文件面板详情看不到）全是它抓到的。
 *
 * 覆盖：
 *   ① 权限卡可见、可点，且不遮挡输入区与权限胶囊；
 *   ② 弹卡时点胶囊 → 切「完全访问」→ 挂起请求被自动批准、diff 出现；
 *   ③ 文件面板能列出改动、选中后详情在视口内、路径完整。
 *
 * 退出码：0 全过；2 权限卡没出现；3 切档后 diff 没出现；4 布局断言失败。
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * 用 `@playwright/mcp` 自带的 playwright-core（它是 MCP 的直接依赖，
 * 浏览器二进制也是它装的）。不直接 import "playwright"：那只是 MCP 的
 * 传递依赖，不是本项目的 devDependency，提版本时随时可能消失。
 */
// 从 MCP 的 cli.js 位置解析 playwright-core：`@playwright/mcp` 的 exports
// 不暴露子路径，直接从本项目 import 会报「subpath not defined」。
const require = createRequire(new URL("../node_modules/@playwright/mcp/cli.js", import.meta.url));
const { chromium } = require("playwright-core");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = arg("base", "http://127.0.0.1:8787");
const TOKEN = arg("token", "");
const CHANNEL = arg("channel", "");
const PROMPT = arg("prompt", "请用 write_file 创建 e2e-mobile.txt，内容写一行 e2e。");
const SHOTS = arg("shots", "");
if (!TOKEN || !CHANNEL) {
  console.error("用法：node scripts/e2e-mobile.mjs --base <url> --token <token> --channel <channelId>");
  process.exit(1);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  console.log(`[shot] ${name}`);
};

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const fail = async (code, message) => {
  console.error(`✗ ${message}`);
  await shot(page, `fail-${code}`);
  await browser.close();
  process.exit(code);
};

await page.goto(`${BASE}/?t=${TOKEN}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(1500);
await page.goto(`${BASE}/chat/${CHANNEL}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(2500);

// ① 发消息 → 等权限卡
await page.locator("textarea").first().fill(PROMPT);
const t0 = Date.now();
await page.locator("button.comp-send").click();
const card = page.locator(".perm[data-kind='block']").first();
try {
  await card.waitFor({ state: "visible", timeout: 60_000 });
} catch {
  await fail(2, "权限卡没有出现（确认模式 + 未配置允许目录时应弹卡）");
}
console.log(`✓ 权限卡可见（发送后 ${Date.now() - t0}ms）`);
await shot(page, "01-permission-card");

// ② 布局断言：卡片不遮挡输入区/胶囊
const layout = await page.evaluate(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), hit: at ? at.tagName : null };
  };
  return { card: rect(".perm"), capsule: rect(".perm-capsule"), textarea: rect(".composer textarea") };
});
if (!layout.card || !layout.capsule || !layout.textarea) {
  await fail(4, `布局元素缺失：${JSON.stringify(layout)}`);
}
if (layout.card.bottom > layout.capsule.top) {
  await fail(4, `权限卡底边 ${layout.card.bottom} 压住了输入区顶边 ${layout.capsule.top}`);
}
if (!["BUTTON", "SPAN"].includes(layout.capsule.hit ?? "")) {
  await fail(4, `权限胶囊被遮挡：命中 ${layout.capsule.hit}`);
}
console.log(`✓ 布局：卡片底边 ${layout.card.bottom} ≤ 胶囊顶边 ${layout.capsule.top}`);

// ③ 弹卡时切「完全访问」→ 挂起请求被自动批准
await page.locator(".perm-capsule").click();
await page.waitForTimeout(300);
if (!(await page.locator(".perm-menu").isVisible())) {
  await fail(4, "权限模式菜单被遮挡（点了胶囊但菜单不可见）");
}
await shot(page, "02-mode-menu");
await page.locator(".perm-item", { hasText: "完全访问" }).first().click();
const tSwitch = Date.now();
try {
  await page.locator(".file-diff").first().waitFor({ state: "visible", timeout: 60_000 });
} catch {
  await fail(3, "切到完全访问后 diff 没有出现（挂起请求可能没被自动批准）");
}
console.log(`✓ 切完全访问 → diff 出现（${Date.now() - tSwitch}ms）`);
await shot(page, "03-after-full");

// ④ 文件面板
await page.getByRole("button", { name: "文件", exact: true }).click();
await page.waitForTimeout(1200);
const panel = page.locator(".ws-panel");
if (!(await panel.isVisible())) await fail(4, "文件面板没有打开");
const firstFile = panel.locator(".ws-file").first();
if (!(await firstFile.isVisible().catch(() => false))) await fail(4, "改动列表为空");
await firstFile.click();
await page.waitForTimeout(1200);
const detail = await page.evaluate(() => {
  const el = document.querySelector(".ws-detail");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const path = document.querySelector(".ws-detail-path")?.textContent?.trim() ?? "";
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, path };
});
if (!detail) await fail(4, "文件详情区不存在");
if (detail.top > detail.vh) await fail(4, `选中文件后详情在视口外（top=${detail.top} vh=${detail.vh}）`);
if (detail.path.includes("…") || detail.path.endsWith("...")) {
  await fail(4, `详情里的路径被截断：${detail.path}`);
}
console.log(`✓ 文件面板：${detail.path}`);
await shot(page, "04-file-detail");

if (errors.length > 0) {
  console.log(`⚠ 控制台错误 ${errors.length} 条：${JSON.stringify(errors.slice(0, 3))}`);
}
await browser.close();
console.log("全部通过");
