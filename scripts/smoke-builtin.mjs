#!/usr/bin/env node
/**
 * 内置引擎端到端冒烟（不依赖真实模型）。
 *
 * 覆盖本轮（会话控制 / 记忆隔离 / 管理员 Bot）的三条主链路：
 *   ① 工作区：Bot 不填路径可建 → 渠道设工作区 → 相对路径落在该目录 → 坏路径 400
 *   ② 权限模式：confirm 弹卡 / plan 裁掉写类工具 / auto 边界内自动批 / full 绕过边界
 *   ③ 模型：会话级模型覆盖下一轮生效；跨协议切换给「建议新开会话」提示
 * 另含：管理员种子、create_bot 走 admin 权限、记忆按渠道/会话隔离、上下文压缩、缓存命中率。
 *
 * 假网关按「最后一条用户消息」决定回什么工具调用；每次请求都记录
 * model / tools / systemPrompt，供断言「模型切换」「plan 裁工具」「记忆注入」。
 *
 * 运行：node scripts/smoke-builtin.mjs
 * 退出码 0 = 全链路通过。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "agentbot-smoke-"));
const wsA = join(home, "ws-a");
const wsB = join(home, "ws-b");
mkdirSync(wsA, { recursive: true });
mkdirSync(wsB, { recursive: true });
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
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
  return { status: res.status, body, text };
}

async function ok(path, init = {}) {
  const res = await jsonFetch(path, init);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${path} → ${res.status} ${res.text.slice(0, 400)}`);
  }
  return res.body;
}

// ---------------------------------------------------------------------------
// 假 OpenAI 网关：记录每次请求，按最后一条用户消息决定工具调用
// ---------------------------------------------------------------------------
const requests = [];

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return String(messages[i].content ?? "");
  }
  return "";
}

function planFor(messages) {
  // 工具结果已经回到模型 → 本轮收口，不再发起新的工具调用
  if (messages.at(-1)?.role === "tool") return null;
  const text = lastUserText(messages);
  // 群聊主持人：返回结构化名单，只点名冒烟 Bot（用于「同一 Bot 跨渠道隔离」）
  if (text.includes("你是这个群聊的主持人")) {
    const id = text.match(/- 冒烟 Bot（botId: ([^）]+)）/)?.[1];
    return {
      text: JSON.stringify({
        speakers: id ? [{ botId: id, reason: "冒烟指定" }] : [],
        skipReason: id ? "" : "冒烟找不到目标 Bot",
      }),
    };
  }
  const outsideWrite = text.match(/越界写\s+(\S+)/);
  if (outsideWrite) {
    return {
      name: "write_file",
      args: { path: outsideWrite[1], content: "outside boundary" },
      id: "call_outside",
    };
  }
  if (/写进 hello\.txt/.test(text)) {
    return {
      name: "write_file",
      args: { path: "hello.txt", content: "hello from builtin" },
      id: "call_hello",
    };
  }
  if (/自动写/.test(text)) {
    return {
      name: "write_file",
      args: { path: "auto.txt", content: "auto approved" },
      id: "call_auto",
    };
  }
  if (/请创建一个 Bot/.test(text)) {
    return {
      name: "create_bot",
      args: {
        name: "工具 Bot",
        persona: "你是由管理员工具创建的 Bot。",
        runtimeId: "builtin",
        providerId: "fake",
      },
      id: "call_create_bot",
    };
  }
  return null;
}

function writeSse(res, { model, tool, text, usage }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (tool) {
    res.write(
      `data: ${JSON.stringify({
        model,
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: tool.id,
                  function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                },
              ],
            },
          },
        ],
      })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        model,
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage,
      })}\n\n`,
    );
  } else {
    res.write(
      `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        model,
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage,
      })}\n\n`,
    );
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const provider = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // 摘要器也用这个网关；解析失败按空请求处理
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const tools = Array.isArray(body.tools)
      ? body.tools.map((t) => t?.function?.name).filter((n) => typeof n === "string")
      : [];
    const systemPrompt = String(messages.find((m) => m.role === "system")?.content ?? "");
    const lastMessage = messages.at(-1);
    const record = {
      model: typeof body.model === "string" ? body.model : "",
      tools,
      systemPrompt,
      lastUser: lastUserText(messages),
      lastRole: String(lastMessage?.role ?? ""),
      lastContent: String(lastMessage?.content ?? "").slice(0, 500),
    };
    requests.push(record);

    // 压缩摘要走非流式（client.complete）：按 OpenAI 非流式响应形状回
    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: record.model || "smoke-model",
          choices: [
            {
              message: { role: "assistant", content: "压缩摘要：用户要求写入文件，均已处理。" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 100 },
          },
        }),
      );
      return;
    }

    const plan = planFor(messages);
    const tool = plan && typeof plan.name === "string" ? plan : null;
    writeSse(res, {
      model: record.model || "smoke-model",
      tool,
      text: tool ? "" : (plan?.text ?? "已收到，按你的要求处理完毕。"),
      usage: {
        prompt_tokens: 200,
        completion_tokens: 8,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    });
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
        {
          id: "fake-alt",
          name: "冒烟网关（另一协议）",
          protocol: "anthropic-messages",
          baseUrl: `http://127.0.0.1:${providerPort}`,
          apiKey: "sk-smoke-alt",
          model: "smoke-alt-model",
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
    env: {
      ...process.env,
      AGENTBOT_HOME: home,
      AGENTBOT_PORT: String(port),
      // 压缩门槛调低：冒烟里用少量消息就能验证「手动压缩 + 分隔事件」
      AGENTBOT_COMPACTION_KEEP_RECENT: "2",
    },
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

  // ---- 0. 运行时 + 管理员种子 ---------------------------------------------
  const meta = await ok(`/api/meta${q}`);
  const builtin = meta.runtimes.find((r) => r.id === "builtin");
  assert(builtin, "运行时列表里没有 builtin");
  assert(builtin.healthStatus === "ready", `builtin 不是 ready：${builtin.healthStatus}`);
  log("builtin 运行时已注册且 ready");

  const adminBots = await ok(`/api/admin/bots${q}`);
  assert(adminBots.bots.length === 1, `管理员种子数量应为 1，实际 ${adminBots.bots.length}`);
  assert(adminBots.bots[0].role === "admin", "种子 Bot 的 role 不是 admin");
  const adminBot = adminBots.bots[0];
  log(`管理员已种下：${adminBot.name}（${adminBot.id}）`);

  // ---- 1. Bot 不填路径可建 -------------------------------------------------
  const created = await ok(`/api/bots${q}`, {
    method: "POST",
    body: JSON.stringify({
      name: "冒烟 Bot",
      persona: "你是冒烟测试 Bot。",
      runtimeId: "builtin",
      providerId: "fake",
    }),
  });
  const bot = created.bot;
  assert(bot, "Bot 创建失败");
  assert(bot.providerId === "fake", "providerId 未绑定");
  assert(bot.repoPath === null || bot.repoPath === undefined, `不填路径应存空，实际 ${bot.repoPath}`);
  await ok(`/api/bots/${bot.id}${q}`, {
    method: "PATCH",
    body: JSON.stringify({ allowDirs: [wsA] }),
  });
  log(`Bot 已创建（无默认路径）并授权目录 ${wsA}`);

  // ---- 2. 渠道工作区：坏路径 400 / 好路径生效 ------------------------------
  const channelA = (
    await ok(`/api/channels${q}`, {
      method: "POST",
      body: JSON.stringify({ type: "dm", participantBotIds: [bot.id] }),
    })
  ).channel;
  const bad = await jsonFetch(`/api/channels/${channelA.id}${q}`, {
    method: "PATCH",
    body: JSON.stringify({ workspacePath: join(home, "does-not-exist") }),
  });
  assert(bad.status === 400, `坏工作区应返回 400，实际 ${bad.status}`);
  assert(bad.body?.error === "invalid_workspace", `坏工作区错误码不符：${bad.body?.error}`);
  log(`坏工作区被拒：${bad.body.message}`);

  await ok(`/api/channels/${channelA.id}${q}`, {
    method: "PATCH",
    body: JSON.stringify({ workspacePath: wsA }),
  });
  log(`渠道工作区已设为 ${wsA}`);

  // ---- 3. confirm 模式：写 → 弹卡 → 批准 → 落盘到渠道工作区 ----------------
  async function sendAndWait(channelId, text, expectPermission = false) {
    const before = await ok(`/api/channels/${channelId}${q}`);
    const isGroup = before.channel?.type === "group";
    const beforeCount = before.messages.filter((m) => m.role === "assistant").length;
    const sent = await ok(`/api/messages${q}`, {
      method: "POST",
      body: JSON.stringify({ channelId, text }),
    });
    let permission = null;
    if (expectPermission) {
      // 权限卡出现即返回：此时轮次被挂起，等调用方批准后再收口
      permission = await waitFor(async () => {
        const res = await ok(
          `/api/permissions?sessionId=${encodeURIComponent(sent.sessionId)}${q.replace("?", "&")}`,
        );
        return res.permissions.find((p) => p.status === "pending") ?? null;
      }, "权限卡出现");
      return { sessionId: sent.sessionId, permission, detail: null };
    }
    const detail = await waitFor(async () => {
      const res = await ok(`/api/channels/${encodeURIComponent(channelId)}${q}`);
      const assistants = res.messages.filter((m) => m.role === "assistant");
      // 群聊一轮 = 主持人决策 + 发言人，两条助手消息；私聊只有一条
      if (assistants.length < beforeCount + (isGroup ? 2 : 1)) return null;
      return assistants.some((m) => m.status === "streaming") ? null : res;
    }, "助手消息收口");
    return { sessionId: sent.sessionId, permission, detail };
  }

  const first = await sendAndWait(channelA.id, "请把内容写进 hello.txt", true);
  assert(first.permission.action === "write", `权限动作应为 write，实际 ${first.permission.action}`);
  assert(
    first.permission.target === join(wsA, "hello.txt"),
    `权限目标应落在渠道工作区，实际 ${first.permission.target}`,
  );
  await ok(`/api/permissions/${encodeURIComponent(first.permission.id)}/decision${q}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approve" }),
  });
  const sessionA = first.sessionId;
  await waitFor(async () => {
    const res = await ok(`/api/channels/${channelA.id}${q}`);
    const last = res.messages.filter((m) => m.role === "assistant").at(-1);
    return last?.status === "done" ? last : null;
  }, "第一轮收口");
  assert(existsSync(join(wsA, "hello.txt")), "工具没有写出 hello.txt（工作区未生效？）");
  assert(
    readFileSync(join(wsA, "hello.txt"), "utf8") === "hello from builtin",
    "hello.txt 内容不符",
  );
  const firstPrompt = requests.at(-1);
  assert(
    firstPrompt.systemPrompt.includes(wsA),
    `系统提示里没有渠道工作区：${firstPrompt.systemPrompt.slice(0, 200)}`,
  );
  log("confirm：权限卡 → 批准 → 文件落在渠道工作区，系统提示 cwd 正确");

  // ---- 4. 记忆隔离：渠道作用域 + 会话作用域 --------------------------------
  // 私聊按 Bot 幂等（同一 Bot 只有一条 dm），所以「同一 Bot 的第二个渠道」用群聊：
  // 冒烟 Bot + 同伴 Bot，主持人是冒烟 Bot（假网关只点名它）。
  const peer = (
    await ok(`/api/bots${q}`, {
      method: "POST",
      body: JSON.stringify({
        name: "同伴 Bot",
        persona: "你是冒烟里的同伴 Bot。",
        runtimeId: "builtin",
        providerId: "fake",
      }),
    })
  ).bot;
  const channelB = (
    await ok(`/api/channels${q}`, {
      method: "POST",
      body: JSON.stringify({
        type: "group",
        participantBotIds: [bot.id, peer.id],
        hostBotId: bot.id,
      }),
    })
  ).channel;
  assert(channelB.id !== channelA.id, "群聊渠道不应与私聊复用");
  await ok(`/api/channels/${channelB.id}${q}`, {
    method: "PATCH",
    body: JSON.stringify({ workspacePath: wsB }),
  });

  // 渠道作用域：A 的暗号只注入 A
  await ok(`/api/bots/${bot.id}/memory${q}`, {
    method: "POST",
    body: JSON.stringify({
      content: "本渠道暗号是青鸟",
      scope: "channel",
      channelId: channelA.id,
    }),
  });
  await sendAndWait(channelA.id, "继续");
  assert(
    requests.at(-1).systemPrompt.includes("青鸟"),
    "渠道作用域记忆没有注入到 A 会话",
  );
  const beforeB = requests.length;
  await sendAndWait(channelB.id, "你好");
  assert(requests.length > beforeB, "B 渠道没有发起模型请求");
  assert(
    requests.slice(beforeB).every((r) => !r.systemPrompt.includes("青鸟")),
    "B 渠道不应看到 A 渠道的记忆（主持人/发言人都不行）",
  );

  // 会话作用域：会话中途新增的记忆，下一轮就要生效（P0-10「1s 内生效」）
  await ok(`/api/bots/${bot.id}/memory${q}`, {
    method: "POST",
    body: JSON.stringify({
      content: "本会话暗号是白鹭",
      scope: "session",
      sourceSessionId: sessionA,
    }),
  });
  await sendAndWait(channelA.id, "再说一句");
  assert(
    requests.at(-1).systemPrompt.includes("白鹭"),
    "会话作用域记忆没有在下一轮生效（内置引擎会话未刷新记忆）",
  );
  const beforeB2 = requests.length;
  await sendAndWait(channelB.id, "再说一句");
  assert(
    requests.slice(beforeB2).every((r) => !r.systemPrompt.includes("白鹭")),
    "B 渠道不应看到 A 会话的会话级记忆",
  );
  log(`记忆隔离通过：渠道/会话作用域互不串（B 渠道 ${channelB.id}）`);

  // ---- 5. 模型切换：下一轮生效 + 跨协议提示 --------------------------------
  const modelSwitch = await ok(`/api/sessions/${encodeURIComponent(sessionA)}/controls${q}`, {
    method: "PATCH",
    body: JSON.stringify({ model: "smoke-model-2" }),
  });
  assert(modelSwitch.session.model === "smoke-model-2", "模型没有写回会话");
  await sendAndWait(channelA.id, "换个模型继续");
  assert(
    requests.at(-1).model === "smoke-model-2",
    `下一轮应使用 smoke-model-2，实际 ${requests.at(-1).model}`,
  );
  log("会话级模型覆盖：下一轮即生效");

  const crossProtocol = await ok(`/api/sessions/${encodeURIComponent(sessionA)}/controls${q}`, {
    method: "PATCH",
    body: JSON.stringify({ providerId: "fake-alt" }),
  });
  assert(
    typeof crossProtocol.warning === "string" && crossProtocol.warning.includes("建议新开"),
    `跨协议切换应给出提示，实际 ${JSON.stringify(crossProtocol.warning)}`,
  );
  await ok(`/api/sessions/${encodeURIComponent(sessionA)}/controls${q}`, {
    method: "PATCH",
    body: JSON.stringify({ providerId: "fake", model: null }),
  });
  log(`跨协议切换有提示：${crossProtocol.warning}`);

  // ---- 6. 四档权限模式 -----------------------------------------------------
  // plan：写类工具从 tools 列表消失，系统提示带「计划模式」
  await ok(`/api/sessions/${encodeURIComponent(sessionA)}/controls${q}`, {
    method: "PATCH",
    body: JSON.stringify({ permissionMode: "plan" }),
  });
  await sendAndWait(channelA.id, "只读检查一下");
  const planReq = requests.at(-1);
  assert(planReq.tools.includes("read_file"), `plan 下 read_file 应保留：${planReq.tools.join(",")}`);
  for (const banned of ["write_file", "edit_file", "run_shell", "web_fetch"]) {
    assert(!planReq.tools.includes(banned), `plan 下 ${banned} 不应出现在工具列表`);
  }
  assert(planReq.systemPrompt.includes("计划模式"), "plan 下系统提示没有说明只读");
  log(`plan：工具列表 ${planReq.tools.join(",")}，写类已裁掉`);

  // auto：边界内写自动批，不弹卡，审计记 mode:auto
  await ok(`/api/sessions/${encodeURIComponent(sessionA)}/controls${q}`, {
    method: "PATCH",
    body: JSON.stringify({ permissionMode: "auto" }),
  });
  await sendAndWait(channelA.id, "自动写 auto.txt");
  assert(existsSync(join(wsA, "auto.txt")), "auto 模式没有写出 auto.txt");
  const autoPermissions = await ok(
    `/api/permissions?sessionId=${encodeURIComponent(sessionA)}${q.replace("?", "&")}`,
  );
  const autoRow = autoPermissions.permissions.find(
    (p) => p.action === "write" && p.target === join(wsA, "auto.txt"),
  );
  assert(autoRow, "auto 模式没有留下写操作审计");
  assert(autoRow.decidedBy === "mode:auto", `auto 审计来源应为 mode:auto，实际 ${autoRow.decidedBy}`);
  assert(autoRow.status === "decided", `auto 审计状态应为 decided，实际 ${autoRow.status}`);
  log("auto：边界内写自动批准并写审计（mode:auto），未弹卡");

  // full：绕过 Bot 边界，仍写审计。
  // 边界 = allowDirs，不是工作目录本身：把允许目录改成 wsB（不含 cwd=wsA），
  // 此时 wsA 内的写对 confirm/auto 是「边界外」，full 下必须直接执行。
  await ok(`/api/bots/${bot.id}${q}`, {
    method: "PATCH",
    body: JSON.stringify({ allowDirs: [wsB] }),
  });
  const fullFile = join(wsA, "full.txt");
  await ok(`/api/sessions/${encodeURIComponent(sessionA)}/controls${q}`, {
    method: "PATCH",
    body: JSON.stringify({ permissionMode: "full" }),
  });
  await sendAndWait(channelA.id, "越界写 full.txt");
  assert(existsSync(fullFile), "full 模式没有写出 Bot 边界外的文件");
  const fullPermissions = await ok(
    `/api/permissions?sessionId=${encodeURIComponent(sessionA)}${q.replace("?", "&")}`,
  );
  const fullRow = fullPermissions.permissions.find(
    (p) => p.action === "write" && p.target === fullFile,
  );
  assert(fullRow, "full 模式没有留下越界写审计");
  assert(fullRow.decidedBy === "mode:full", `full 审计来源应为 mode:full，实际 ${fullRow.decidedBy}`);
  log("full：绕过 Bot 边界执行并写审计（mode:full）");

  // 恢复允许目录与 confirm，避免影响后续
  await ok(`/api/bots/${bot.id}${q}`, {
    method: "PATCH",
    body: JSON.stringify({ allowDirs: [wsA] }),
  });
  await ok(`/api/sessions/${encodeURIComponent(sessionA)}/controls${q}`, {
    method: "PATCH",
    body: JSON.stringify({ permissionMode: "confirm" }),
  });

  // ---- 7. 上下文压缩（手动） ----------------------------------------------
  const compact = await ok(`/api/sessions/${encodeURIComponent(sessionA)}/compact${q}`, {
    method: "POST",
    body: JSON.stringify({ force: true }),
  });
  assert(compact.ok === true, `手动压缩失败：${JSON.stringify(compact)}`);
  assert(compact.result?.ok === true, `手动压缩失败：${JSON.stringify(compact)}`);
  assert(
    compact.result.removedMessages > 0,
    `压缩没有移除消息：${JSON.stringify(compact)}`,
  );
  const events = await ok(
    `/api/sessions/${encodeURIComponent(sessionA)}/events?afterSeq=0&limit=5000${q.replace("?", "&")}`,
  );
  const compaction = events.events.find(
    (e) => e.type === "meta" && e.payload?.kind === "compaction",
  );
  assert(compaction, "事件流里没有 meta.compaction");
  assert(compaction.payload.data.trigger === "manual", "压缩事件 trigger 不是 manual");
  log(`手动压缩：移除 ${compact.result.removedMessages} 条，meta.compaction 已入流`);

  // ---- 8. 用量缓存命中率 ---------------------------------------------------
  const usage = await ok(`/api/usage?range=all${q.replace("?", "&")}`);
  assert(usage.totals.requests > 0, "用量没有记录");
  assert(
    usage.totals.cacheHitRate === 50,
    `缓存命中率应为 50%（cached 100 / input 100），实际 ${usage.totals.cacheHitRate}`,
  );
  assert(
    usage.rows.every((r) => r.cachedInputTokens !== null),
    "缓存列没有落库",
  );
  log(`缓存命中率：${usage.totals.cacheHitRate}%（${usage.totals.cachedInputTokens} / ${usage.totals.inputTokens + usage.totals.cachedInputTokens}）`);

  // ---- 9. 管理员 create_bot：admin 权限 + 审计 + 真正建出 Bot --------------
  const adminChannel = (
    await ok(`/api/channels${q}`, {
      method: "POST",
      body: JSON.stringify({ type: "dm", participantBotIds: [adminBot.id] }),
    })
  ).channel;
  const adminTurn = await sendAndWait(adminChannel.id, "请创建一个 Bot", true);
  assert(
    adminTurn.permission.action === "admin",
    `create_bot 的权限动作应为 admin，实际 ${adminTurn.permission.action}`,
  );
  await ok(`/api/permissions/${encodeURIComponent(adminTurn.permission.id)}/decision${q}`, {
    method: "POST",
    body: JSON.stringify({ decision: "approve" }),
  });
  try {
    await waitFor(async () => {
      const res = await ok(`/api/channels/${adminChannel.id}${q}`);
      const last = res.messages.filter((m) => m.role === "assistant").at(-1);
      return last?.status === "done" ? last : null;
    }, "create_bot 轮次收口");
  } catch (err) {
    const adminMessages = await ok(`/api/channels/${adminChannel.id}${q}`);
    const adminPerms = await ok(
      `/api/permissions?sessionId=${encodeURIComponent(adminTurn.sessionId)}${q.replace("?", "&")}`,
    );
    console.error(
      `[smoke] 收口超时诊断：messages=${JSON.stringify(adminMessages.messages.map((m) => ({ role: m.role, status: m.status, content: String(m.content ?? "").slice(0, 200) })))} perms=${JSON.stringify(adminPerms.permissions.map((p) => ({ action: p.action, status: p.status, decidedBy: p.decidedBy })))} requests=${JSON.stringify(requests.slice(-3))}`,
    );
    throw err;
  }
  const botsAfter = await ok(`/api/bots${q}`);
  const toolBot = botsAfter.bots.find((b) => b.name === "工具 Bot");
  if (!toolBot) {
    const adminMessages = await ok(`/api/channels/${adminChannel.id}${q}`);
    console.error(
      `[smoke] create_bot 诊断：bots=${botsAfter.bots.map((b) => b.name).join(",")} messages=${JSON.stringify(adminMessages.messages.map((m) => ({ role: m.role, status: m.status, content: String(m.content ?? "").slice(0, 300) })))} requests=${JSON.stringify(requests.slice(-4))}`,
    );
  }
  assert(toolBot, "create_bot 没有真正建出 Bot");
  assert(toolBot.role === "member", `工具创建的 Bot 应为 member，实际 ${toolBot.role}`);
  const adminAudit = await ok(
    `/api/permissions?sessionId=${encodeURIComponent(adminTurn.sessionId)}${q.replace("?", "&")}`,
  );
  const adminRow = adminAudit.permissions.find((p) => p.action === "admin");
  assert(adminRow?.status === "decided", "admin 动作没有留下已决审计");
  assert(adminRow.decidedBy === "user", `admin 审计操作者应为 user，实际 ${adminRow.decidedBy}`);
  log(`create_bot：admin 权限卡 → 批准 → 建出「${toolBot.name}」（${toolBot.id}）`);

  // 普通 Bot 的工具列表里没有 create_bot
  const normalRequest = requests.find(
    (r) => !r.tools.includes("create_bot") && r.tools.includes("read_file"),
  );
  assert(normalRequest, "普通 Bot 的请求里没有找到工具列表");
  log("普通 Bot 看不到 create_bot（工具表按角色裁剪）");

  exitCode = 0;
  log("端到端冒烟全部通过");
} catch (err) {
  console.error(`[smoke] 失败：${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  console.error(`[smoke] 服务日志：\n${serverLog.slice(-6000)}`);
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
