// 修复后实测：悬停占位 / 过渡中间值 / 输入框焦点环 / 五宽度 / 亮暗截图
import { chromium } from "file:///D:/workspace/Agent%20WorkSpace/AI-Novel-Writing-Assistant/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs";
import { readFileSync, mkdirSync } from "node:fs";

const EXE = "C:/Users/liyunxuanyu/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const token = readFileSync("C:/Users/liyunxuanyu/.agentbot/token", "utf8").trim();
const CHANNEL = "dm_45cd37e5-1b8b-427a-b57d-8f06add875c0";
const BASE = "http://127.0.0.1:8792";
const SHOTS = "D:/workspace/Agent WorkSpace/agentbot/.forge/tasks/shots";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await ctx.addCookies([{ name: "agentbot_token", value: token, domain: "127.0.0.1", path: "/" }]);
const page = await ctx.newPage();
await page.goto(`${BASE}/chat/${CHANNEL}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".stream .msg", { timeout: 15000 });
await page.waitForTimeout(900);

const snapshot = (el) => {
  const row = el.parentElement;
  const next = row?.nextElementSibling;
  const hov = el.querySelector(".msg-hover");
  const cs = hov ? getComputedStyle(hov) : null;
  const r = el.getBoundingClientRect();
  return {
    nextTop: next ? next.getBoundingClientRect().top : null,
    nextTag: next ? `${next.tagName}.${next.className || "(row)"}` : null,
    msgTop: r.top,
    msgHeight: r.height,
    hover: cs && {
      display: cs.display,
      opacity: cs.opacity,
      visibility: cs.visibility,
      transform: cs.transform,
      transitionProperty: cs.transitionProperty,
      transitionDuration: cs.transitionDuration,
      transitionDelay: cs.transitionDelay,
      pointerEvents: cs.pointerEvents,
      height: hov.getBoundingClientRect().height,
    },
  };
};

async function measure(label, selector) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  const before = await target.evaluate(snapshot);
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const samples = await target.evaluate(async (el) => {
    const hov = el.querySelector(".msg-hover");
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 240) {
      const cs = getComputedStyle(hov);
      out.push({ t: Math.round(performance.now() - t0), o: Number(cs.opacity) });
      await new Promise((r) => setTimeout(r, 8));
    }
    return out;
  });
  await page.waitForTimeout(120);
  const after = await target.evaluate(snapshot);
  const mid = samples.filter((s) => s.o > 0.01 && s.o < 0.99).slice(0, 6);
  return {
    label,
    before,
    after,
    mid,
    topDelta: before.nextTop === null ? null : Number((after.nextTop - before.nextTop).toFixed(3)),
    heightDelta: Number((after.msgHeight - before.msgHeight).toFixed(3)),
  };
}

// ---- 用户消息（仅时间戳，17.6px 高） ----
const userMsg = await measure("user", ".stream .msg.msg--user");

// ---- 展开最后一个 Turn，测 Bot 消息（带 .msg-tools，24px 高） ----
const heads = page.locator(".turn.is-collapsed > .turn-head");
const n = await heads.count();
if (n > 0) {
  await heads.nth(n - 1).click();
  await page.waitForSelector(".msg.msg--bot", { timeout: 8000 });
  await page.waitForTimeout(500);
}
const botMsg = await measure("bot", ".msg.msg--bot");

// ---- 输入框聚焦 ----
const ta = page.locator(".composer textarea");
await ta.click();
await page.waitForTimeout(260);
const composer = await page.evaluate(() => {
  const t = document.querySelector(".composer textarea");
  const c = document.querySelector(".composer");
  const ts = getComputedStyle(t);
  const cs = getComputedStyle(c);
  return {
    textarea: {
      boxShadow: ts.boxShadow,
      borderRadius: ts.borderRadius,
      outline: ts.outline,
      background: ts.backgroundColor,
    },
    composer: {
      boxShadow: cs.boxShadow,
      borderRadius: cs.borderRadius,
      transform: cs.transform,
    },
    activeElement: document.activeElement?.tagName,
  };
});

// ---- 亮色截图：Bot 消息悬停 + 输入区聚焦（鼠标停在消息上，焦点用脚本给） ----
const botBox = await page.locator(".msg.msg--bot").first().boundingBox();
await page.mouse.move(botBox.x + botBox.width / 2, botBox.y + botBox.height / 2);
await page.evaluate(() => document.querySelector(".composer textarea")?.focus());
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/light-hover-focus.png` });

// ---- 暗色截图 ----
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/dark-hover-focus.png` });

// ---- 五宽度回归（亮色） ----
await page.evaluate(() => { delete document.documentElement.dataset.theme; });
await page.mouse.move(2, 2);
const widths = [];
for (const w of [1440, 1280, 1024, 768, 375]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
  }));
  widths.push({ w, ...r, overflowX: r.scrollW - r.clientW });
}

// 375 截图（输入区 + 消息）
await page.evaluate(() => document.querySelector(".composer textarea")?.focus());
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/light-375.png` });

console.log(JSON.stringify({ userMsg, botMsg, composer, widths }, null, 2));
await browser.close();
