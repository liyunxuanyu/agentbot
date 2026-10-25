import { chromium } from "file:///D:/workspace/Agent%20WorkSpace/AI-Novel-Writing-Assistant/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
const EXE = "C:/Users/liyunxuanyu/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const token = readFileSync("C:/Users/liyunxuanyu/.agentbot/token", "utf8").trim();
const CHANNEL = "dm_45cd37e5-1b8b-427a-b57d-8f06add875c0";
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "agentbot_token", value: token, domain: "127.0.0.1", path: "/" }]);
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:8792/chat/${CHANNEL}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".stream .msg", { timeout: 15000 });
await page.waitForTimeout(600);
const info = await page.evaluate(() => {
  const inner = document.querySelector(".stream-inner");
  const walk = (el, depth) => {
    const out = [];
    for (const c of el.children) {
      const r = c.getBoundingClientRect();
      out.push({ depth, tag: c.tagName, cls: c.className, top: Math.round(r.top), h: Math.round(r.height), kids: c.children.length });
      if (depth < 3 && c.children.length) out.push(...walk(c, depth + 1));
    }
    return out;
  };
  return {
    innerChildren: walk(inner, 0),
    turns: [...document.querySelectorAll(".turn")].map((t) => ({ collapsed: t.classList.contains("is-collapsed"), top: Math.round(t.getBoundingClientRect().top), h: Math.round(t.getBoundingClientRect().height) })),
    msgs: [...document.querySelectorAll(".msg")].map((m) => ({ cls: m.className, top: Math.round(m.getBoundingClientRect().top), h: Math.round(m.getBoundingClientRect().height), hoverH: Math.round(m.querySelector(".msg-hover")?.getBoundingClientRect().height ?? -1), tools: !!m.querySelector(".msg-tools") })),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
