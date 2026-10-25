#!/usr/bin/env node
/**
 * 内置引擎端到端冒烟（不依赖真实模型）。
 *
 * 链路：假 OpenAI 网关 → 启动 agentbot → 建 Bot（runtime=builtin）→ 建私聊
 *      → 发消息 → 模型要求 write_file → 权限卡批准 → 工具落盘 → 第二轮文本收口。
 *
 * 运行：node scripts/smoke-builtin.mjs
 * 退出码 0 = 全链路通过。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "agentbot-smoke-"));
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let providerHits = 0;

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`等待超时：${label}${lastError ? `（最后错误：${lastError.message}）` : ""}`);
}

async function jsonFetch(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 300)}`);
  return body;
}

// ---- 假 OpenAI 网关：第一轮要工具，第二轮给最终文本 ----
const provider = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    providerHits += 1;
    const first = providerHits === 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (first) {
      const args = JSON.stringify({ path: "hello.txt", content: "hello from builtin" });
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_smoke",
                    function: { name: "write_file", arguments: args },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        })}\n\n`,
      );
    } else {
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "已写入 hello.txt。" } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 8 },
        })}\n\n`,
      );
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = provider.address().port;

writeFileSync(
  join(home, "providers.json"),
  `${JSON.stringify(
    {
      defaultId: "fake",
      providers: [
        {
          id: "fake",
          name: "冒烟网关",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${providerPort}`,
          apiKey: "sk-smoke-test",
          model: "smoke-model",
          contextWindow: 100000,
          supportsTools: true,
          supportsStreaming: true,
        },
      ],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const server = spawn(
  process.execPath,
  [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/server/main.ts")],
  {
    cwd: home,
    env: { ...process.env, AGENTBOT_HOME: home, AGENTBOT_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
server.stdout.on("data", (c) => (serverLog += c.toString()));
server.stderr.on("data", (c) => (serverLog += c.toString()));

let exitCode = 1;
try {
  await waitFor(async () => {
    const res = await fetch(`${base}/api/health`);
    return res.ok;
  }, "服务启动");
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const q = `?t=${encodeURIComponent(token)}`;
  log(`服务已启动 ${base}`);

  const meta = await jsonFetch(`/api/meta${q}`);
  const builtin = meta.runtimes.find((r) => r.id === "builtin");
  if (!builtin) throw new Error("运行时列表里没有 builtin");
  if (builtin.healthStatus !== "ready") throw new Error(`builtin 不是 ready：${builtin.healthStatus}`);
  log("builtin 运行时已注册且 ready");

  const created = await jsonFetch(`/api/bots${q}`, {
    method: "POST",
    body: JSON.stringify({
      name: "冒烟 Bot",
      persona: "你是冒烟测试 Bot。",
      runtimeId: "builtin",
      providerId: "fake",
      executionLocation: "local",
    }),
  });
  const bot = created.bot;
  if (!bot || bot.providerId !== "fake") throw new Error("Bot 创建失败或 providerId 未绑定");
  // 默认边界是只读：把冒烟目录加进 allowDirs，写操作才会走到「权限卡」而不是直接边界拒绝
  await jsonFetch(`/api/bots/${bot.id}${q}`, {
    method: "PATCH",
    body: JSON.stringify({ allowDirs: [home] }),
  });
  log(`Bot 已创建并授权目录 ${bot.id}`);

  const channelRes = await jsonFetch(`/api/channels${q}`, {
    method: "POST",
    body: JSON.stringify({ type: "dm", participantBotIds: [bot.id] }),
  });
  const channelId = channelRes.channel.id;

  const sent = await jsonFetch(`/api/messages${q}`, {
    method: "POST",
    body: JSON.stringify({ channelId, text: "请把内容写进 hello.txt" }),
  });
  const sessionId = sent.sessionId;
  log(`消息已发送 session=${sessionId}`);

  const permission = await waitFor(async () => {
    const res = await jsonFetch(`/api/permissions?sessionId=${encodeURIComponent(sessionId)}${q.replace("?", "&")}`);
    return res.permissions.find((p) => p.status === "pending") ?? null;
  }, "权限卡出现");
  log(`权限卡出现：${permission.action} ${permission.target}`);
  await jsonFetch(`/api/permissions/${encodeURIComponent(permission.id)}/decision${q}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approve" }),
  });
  log("已批准");

  const detail = await waitFor(async () => {
    const res = await jsonFetch(`/api/channels/${encodeURIComponent(channelId)}${q}`);
    const assistant = res.messages.filter((m) => m.role === "assistant");
    const last = assistant[assistant.length - 1];
    return last && last.status !== "streaming" ? res : null;
  }, "助手消息收口");
  const assistant = detail.messages.filter((m) => m.role === "assistant").at(-1);
  if (assistant.status !== "done") throw new Error(`助手消息状态是 ${assistant.status}`);
  if (!assistant.content.includes("已写入")) throw new Error(`正文不符合预期：${assistant.content}`);
  log(`助手回复：${assistant.content}`);

  const target = join(home, "hello.txt");
  if (!existsSync(target)) throw new Error("工具没有写出 hello.txt");
  const content = readFileSync(target, "utf8");
  if (content !== "hello from builtin") throw new Error(`文件内容不符：${content}`);
  log("工具落盘校验通过");

  const events = await jsonFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/events?afterSeq=0&limit=5000${q.replace("?", "&")}`,
  );
  const types = new Set(events.events.map((e) => e.type));
  for (const required of ["tool_call", "tool_result", "usage", "done"]) {
    if (!types.has(required)) throw new Error(`缺少事件：${required}（实际：${[...types].join(",")}）`);
  }
  const done = events.events.find((e) => e.type === "done");
  if (done?.payload?.stopReason !== "end") throw new Error(`done.stopReason=${done?.payload?.stopReason}`);
  log("事件链完整：tool_call / tool_result / usage / done(end)");

  exitCode = 0;
  log("端到端冒烟通过");
} catch (err) {
  console.error(`[smoke] 失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  console.error(`[smoke] 服务日志：\n${serverLog.slice(-4000)}`);
} finally {
  server.kill("SIGTERM");
  await sleep(500);
  provider.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // 忽略
  }
}
process.exit(exitCode);
