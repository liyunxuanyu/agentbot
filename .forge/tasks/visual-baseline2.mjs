// 基线实测（v2）：悬停工具栏布局跳变 + 输入框焦点环
import { chromium } from "file:///D:/workspace/Agent%20WorkSpace/AI-Novel-Writing-Assistant/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";

const EXE = "C:/Users/liyunxuanyu/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const token = readFileSync("C:/Users/liyunxuanyu/.agentbot/token", "utf8").trim();
const CHANNEL = "dm_45cd37e5-1b8b-427a-b57d-8f06add875c0";
const BASE = "http://127.0.0.1:8792";

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "agentbot_token", value: token, domain: "127.0.0.1", path: "/" }]);
const page = await ctx.newPage();
await page.goto(`${BASE}/chat/${CHANNEL}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".stream .msg", { timeout: 15000 });
await page.waitForTimeout(800);

async function measureMsg(label, selector) {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const before = await target.evaluate((el) => {
    const row = el.parentElement; // 虚拟化行包装
    const next = row?.nextElementSibling;
    const hov = el.querySelector(".msg-hover");
    const cs = hov ? getComputedStyle(hov) : null;
    return {
      rowTag: row ? `${row.tagName}.${row.className}` : null,
      nextTag: next ? `${next.tagName}.${next.className || "(row wrapper)"}` : null,
      nextTop: next ? next.getBoundingClientRect().top : null,
      hoverDisplay: cs?.display,
      hoverOpacity: cs?.opacity,
      hoverVisibility: cs?.visibility,
      hoverRect: hov ? { w: hov.getBoundingClientRect().width, h: hov.getBoundingClientRect().height } : null,
      msgRect: { top: el.getBoundingClientRect().top, h: el.getBoundingClientRect().height },
    };
  });
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const samples = await target.evaluate(async (el) => {
    const hov = el.querySelector(".msg-hover");
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 240) {
      const cs = getComputedStyle(hov);
      out.push({ t: Math.round(performance.now() - t0), o: Number(cs.opacity), d: cs.display });
      await new Promise((r) => setTimeout(r, 8));
    }
    return out;
  });
  await page.waitForTimeout(100);
  const after = await target.evaluate((el) => {
    const row = el.parentElement;
    const next = row?.nextElementSibling;
    const hov = el.querySelector(".msg-hover");
    const cs = hov ? getComputedStyle(hov) : null;
    return {
      nextTag: next ? `${next.tagName}.${next.className || "(row wrapper)"}` : null,
      nextTop: next ? next.getBoundingClientRect().top : null,
      hoverDisplay: cs?.display,
      hoverOpacity: cs?.opacity,
      hoverVisibility: cs?.visibility,
      hoverRect: hov ? { w: hov.getBoundingClientRect().width, h: hov.getBoundingClientRect().height } : null,
      msgRect: { top: el.getBoundingClientRect().top, h: el.getBoundingClientRect().height },
    };
  });
  const mid = samples.filter((s) => s.o > 0.01 && s.o < 0.99).slice(0, 6);
  return { label, before, after, mid, topDelta: before.nextTop === null ? null : after.nextTop - before.nextTop, msgHeightDelta: after.msgRect.h - before.msgRect.h };
}

const userMsg = await measureMsg("user", ".stream .msg.msg--user");

// 展开最后一个 Turn，让 Bot 气泡（带 .msg-tools，24px）出现
const heads = page.locator(".turn.is-collapsed > .turn-head");
const n = await heads.count();
if (n > 0) {
  await heads.nth(n - 1).click();
  await page.waitForSelector(".msg.msg--bot", { timeout: 8000 });
  await page.waitForTimeout(400);
}
const botMsg = await measureMsg("bot", ".msg.msg--bot");

// 输入框聚焦
const ta = page.locator(".composer textarea");
await ta.click();
await page.waitForTimeout(250);
const composer = await page.evaluate(() => {
  const t = document.querySelector(".composer textarea");
  const c = document.querySelector(".composer");
  const ts = getComputedStyle(t);
  const cs = getComputedStyle(c);
  return {
    textarea: { boxShadow: ts.boxShadow, borderRadius: ts.borderRadius, outline: ts.outline, background: ts.backgroundColor },
    composer: { boxShadow: cs.boxShadow, borderRadius: cs.borderRadius, transform: cs.transform },
  };
});

const widths = [];
for (const w of [1440, 1280, 1024, 768, 375]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(350);
  const r = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
  }));
  widths.push({ w, ...r, overflowX: r.scrollW - r.clientW });
}

console.log(JSON.stringify({ userMsg, botMsg, composer, widths }, null, 2));
await browser.close();
