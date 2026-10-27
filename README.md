# AgentBot

本机运行的 Web 工作台：把多个 Bot 编排到可插拔的 agent 运行时上（ACP / Codex app-server / OpenCode / Claude SDK / CLI 兜底）。

单进程本地服务：Node 22 + TypeScript（ESM）+ Fastify 5 + SQLite（better-sqlite3，WAL）+ SSE；前端 Vue 3 + Pinia + Vue Router。

## 换设备继续开发

```bash
git clone https://github.com/liyunxuanyu/agentbot.git
cd agentbot
git checkout continue-dev
npm install
npm run build && npm run start:local     # 控制台会打印带 token 的访问 URL
```

**两批待办已于 2026-10-28 全部完成**（分支 `continue-dev`）：

- [`.forge/agentbot-18-fix-list.md`](.forge/agentbot-18-fix-list.md) —— 7 条待修缺口：R8 缓存未上报 / R3 群聊记忆共享 / G7 群聊写锁 / R5 auto 越界口径 / R5-c MCP 计划模式裁剪 / G3 切 plan 系统块落库 / R7 压缩条数进流。
- [`.forge/agentbot-19-new-requirements.md`](.forge/agentbot-19-new-requirements.md) —— N1 初始化引导 / N2 基础技能包 / N3-1 技能热插拔 / N3-2 MCP 热插拔 / N4 技能按需加载。

两批唯一的文件交集 `migrate.ts` 的 v4 合并成一次：`usage_records.cache_reported` + `bots.enabled_skills`。

首次在新机器上要做的两件事（现在有引导页，打开就会带你走）：

1. **确认运行时**：`npm run start:local` 会自动把本机 ZCode 的路径填进 `AGENTBOT_BIN_ZCODE`（见 `scripts/start-local.mjs`，路径写死为 Windows 默认安装位置，换系统或换安装位置要改这个文件）。其它运行时（Codex / Claude Code / Gemini / DSH）靠 PATH 探测。
2. **配模型供应商**：内置引擎需要至少一个 provider（OpenAI chat-completions 或 Anthropic messages）。首次打开会自动进 `/setup` 五步引导；之后从设置页页头的「初始化引导」可随时回去。

**先读这几处再动代码**：

- [`.forge/agentbot-18-fix-list.md`](.forge/agentbot-18-fix-list.md) —— 7 条缺口（已修完，留作验收口径）。依据是 [`.forge/agentbot-17-requirements-audit.md`](.forge/agentbot-17-requirements-audit.md)。
- [`.forge/agentbot-19-new-requirements.md`](.forge/agentbot-19-new-requirements.md) —— N1 初始化引导 / N2 基础技能 / N3 热插拔 / N4 技能按需加载（已实现）。
- [`.forge/agentbot-14-handoff.md`](.forge/agentbot-14-handoff.md) —— 上一轮的交接记录：迁移 v3 SQL、模块文件归属、验收门槛（已完成，留作参考）。口径源头是 [`.forge/agentbot-11-requirements-align.md`](.forge/agentbot-11-requirements-align.md)。
- [`docs/memory/agentbot-project-state.md`](docs/memory/agentbot-project-state.md) —— 项目全貌 + 7 处真机踩过的坑（虚拟列表 transform 毁 sticky、CLI 人格注入、exit 0 误判 crashed、messages 同毫秒排序、pending Turn、最新轮不自动折叠…）。重复踩一遍要几个小时。
- [`.forge/`](.forge/) —— 产品文档全在这里：`agentbot-00-brief` / `01-prd` / `02-ux` / `03-ui` / `tokens.css` / `05-architecture` / `06-builtin-engine`（内置引擎设计）/ `07-review`（验收报告），以及 `agentbot-prototype-v2/index.html`（视觉权威原型）。

**验证命令**（CI 与本地都用这四条）：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vue-tsc/bin/vue-tsc.js -p tsconfig.json --noEmit
node scripts/check-boundaries.mjs
node node_modules/vitest/vitest.mjs run
```

## 安装

```bash
npm install
```

需要 Node >= 22（`package.json` 的 `engines` 已声明）。`better-sqlite3` 是原生模块，Windows 上装预编译包，通常不需要本地编译工具链。

## 运行

开发态（后端 tsx watch + 前端 Vite HMR，两个进程）：

```bash
npm run dev
```

生产态（先构建，再单进程启动）：

```bash
npm run build:web        # 产出 dist/web（index.html + assets）
npm run build:server     # 产出 dist/server.js
npm start                # 等价于 node dist/server.js，静态资源由 Fastify 直接提供
```

启动后控制台会打印带 token 的访问地址：

```
  用浏览器打开（含 token，仅本机可访问）：
  http://127.0.0.1:8787/?t=<token>
```

打开一次即可，token 会写成 HttpOnly + SameSite=Strict cookie，之后刷新不用再带 `?t=`。

开发态前端跑在 5173（Vite HMR），`/api` 由 Vite 代理到后端 8787。两边都要起：

```bash
npm run dev              # concurrently：dev:server + dev:web
```

首次开发访问需要带 token，否则 `/api/meta` 会 401：从后端控制台复制 `?t=<token>`，
拼到 `http://localhost:5173/?t=<token>`。token 会存进 sessionStorage 并从地址栏抹掉，
之后刷新不用再带（见下文「前端 token 引导」）。

## 前端

Vue 3（Composition API + `<script setup>`）+ Pinia + Vue Router 4，构建用 Vite。

```
src/web/
  main.ts                 入口：bootstrapToken → createApp → pinia → 主题 → router
  App.vue                 应用壳：240 侧栏 + 顶栏 + 主区（右面板属于 /chat 自己）
  index.html              Vite 的 root 模板（vite.config.ts 里 root = src/web）
  router/index.ts         10 条路由，history 模式
  pages/                  10 页全部接真实端点（见下表）
  components/
    common/               AppIcon / EmptyState / AppModal / Toast / CapBadge
    bot/                  BotCard / BotAvatar / BotStateChip / BotCapabilityBadges
    chat/                 TurnItem / MessageBubble / EventRow / EventBlock
                          PermissionCard / PermissionBlock / Composer
                          SessionDivider / RoundFence / ActivityRow / StreamRowItem
  stores/                 bots / channels / runtimes / sessions / events / permissions / ui
  composables/            useSseStream / useVirtualList / useHotkeys
  net/                    client.ts（REST）+ stream.ts（SSE）+ types.ts（DTO 契约）
  lib/                    turnModel.ts（事件→渲染模型）/ format.ts / botVars.ts / icons.ts
  styles/                 tokens.css（令牌）+ base.css（全局样式，逐字照抄原型）
```

### 页面与数据来源

| 页面 | 主要端点 | 四态 |
|---|---|---|
| `/setup` | `GET /api/runtimes` · `POST /api/bots` · `POST /api/channels` · `POST /api/messages` + SSE | 逐项探测骨架 / 全未安装给安装指引 / 探测失败横幅 / 正常 |
| `/bots` | `GET /api/bots` · `POST /api/bots` | 6 张骨架 / 引导建第一个 Bot / 读取失败重试 / 正常 |
| `/bots/:id` | `GET /api/bots/:id` · `GET/POST/PATCH/DELETE …/memory` · `POST …/memory/summarize` · `PATCH /api/bots/:id` | 标签局部骨架 / 各标签独立空态 / 运行时不可用横幅 / 正常 |
| `/chats` | `GET /api/channels` · `POST /api/channels` | 5 行骨架 / 「还没有会话」/ 重试条 / 群聊 + 私聊分组 |
| `/chat/:id` | `GET /api/channels/:id` · SSE · `GET /api/permissions` | 顶部历史骨架 / 人格 + 示例提问 / 断线横幅 / 正常 |
| `/assignments` | `GET /api/assignments` · `POST /api/assignments` | 分组骨架 / 「任务从会话里创建」/ 重试条 / 状态 chips + 表格 |
| `/assignments/:id` | `GET /api/assignments/:id` · SSE 回放 | 排队等待原因 / 报告生成中骨架 / 失败原因 + 最后 50 条事件 / 报告四节 |
| `/schedules` | `GET/POST/PATCH/DELETE /api/schedules` | 行骨架 / 「还没有定时任务」/ 调度器异常横幅 / 列表 |
| `/usage` | `GET /api/usage` · `GET /api/usage/export.csv` | 表格骨架 / 「还没有可统计的调用」/ 查询失败（筛选保留）/ 行 + 合计 |
| `/settings` | `GET /api/runtimes` · `GET/POST /api/token*` · `POST /api/admin/purge` · `GET /api/permissions` | 逐行骨架 / 无运行时给安装指引 / 单项失败只标该行 / 四个分区 |

**群聊的 SSE 要按 Session 分别建连**：一轮里每个发言人各有一个 Session，主连接只覆盖
一个；`ChatPage` 为其余 Session 各开一条只读连接（`extraConns`），游标用 0 从头回放。
渠道级的 `lastEventId` 是「所有 Session 的最大 events.id」，直接拿它当群聊游标会把
主 Session 的事件整段跳过（实测踩到）。

**目录名是 `net/` 而不是 `api/`**：Vite 的 dev 代理把 `/api` 前缀整体转发给后端，
源码模块 URL 一旦落在 `/api/*` 下（`/api/client.ts`）就会被代理吞掉并返回 401。
请求路径仍是 `/api/...`，只是源码目录不能叫 `api`。

### 路由为什么用 history 而不是 hash

原型是 hash 模式（它要能在 `file://` 下双击打开）。生产后端已经对非 `/api` 的未知
路径回落到 `index.html`（`src/server/http/server.ts` 的 `serveStatic`），history 不需要
额外配置；URL 也更干净（`/chat/g1` 而不是 `#/chat/g1`，`#` 在多数 Markdown 里会被截断）。

### 前端 token 引导（P0-14）

`src/web/net/bootstrap.ts` 是 `main.ts` 的第一个 import，它在 `createWebHistory()`
捕获初始地址之前把 `?t=` 存进 sessionStorage 并从地址栏抹掉。**不能**把这段逻辑写在
`main.ts` 的函数体里 —— ESM import 求值早于模块体，router 会把 token 带进
`/bots?t=...`（实测踩到）。

之后每个 REST/SSE 请求都把 token 作为 `?t=` 附在 URL 上：后端 `extractToken()`
只认 `?t=` 与 `agentbot_token` cookie，自定义 header 会被忽略；而开发态 HTML 由 Vite
提供，cookie 种不下来，所以 URL 携带是两种环境都能用的方式。cookie 仍会在第一次
带 `?t=` 的 API 请求后种下，作为双保险。

### 事件流与性能

- `GET /api/stream?sessionId=` 走 `EventSource`，**首连总是显式带 `lastEventId`**（含 0）：
  服务端只有收到游标才回放历史，不传就只推新事件。
- 重连由浏览器带 `Last-Event-ID`；客户端再按 `events.id` 去重一次，重连不会重复渲染。
- 事件表在 Pinia 里是 `shallowRef<Map<turnId, RawEvent[]>>` + 手动 `triggerRef`，
  不进深代理（20–50 事件/秒时深代理会卡）。
- `meta` 事件不进渲染流，只生成 Session 分隔条。
- 会话流 >20 行走 `@tanstack/vue-virtual`，只渲染可视区 ±5。

### `messages.content` 是正文唯一权威副本

页面加载时先用 `GET /api/channels/:id` 拿 `messages`（权威正文）与 `lastEventId`，
再建 SSE 连接补增量。正常路径**不用事件累积重建正文**。只有该端点尚未实现
（M3 阶段 404 `{"error":"not_found"}`）时才降级为事件累积，并在右面板明示端点待接入。

## 状态目录

所有可变状态都在 `~/.agentbot`（可用 `AGENTBOT_HOME` 覆盖）。`vitest.config.ts` 在收集
测试文件前把 `AGENTBOT_HOME` 指向临时目录，所以跑测试不会往你的真实 home 里写 worktree。

| 文件 | 用途 |
|---|---|
| `agentbot.db` | SQLite 主库（WAL，伴随 `-wal` / `-shm`） |
| `token` | 本地访问 token，权限收紧为仅当前用户 |
| `providers.json` | 内置引擎的模型供应商（含 apiKey，权限 0600；接口只回掩码） |
| `mcp.json` | MCP stdio server 配置（命令、参数、env、enabled） |
| `skills/` | 技能目录：`<name>/SKILL.md`，索引进系统提示、全文由 `read_skill` 按需读取。首次启动自动装 4 个内置技能（`file/shell/search/web-basics`），带 `.agentbot-builtin` 标记 |
| `secrets.json` | 自定义运行时 env（尚未落地） |
| `wt/` | git worktree 根目录（`executionLocation=worktree` 的 Bot 在这里各有一个目录） |

删除 `token` 后重启会重新生成，旧 token 立即失效。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENTBOT_HOME` | `~/.agentbot` | 状态目录 |
| `AGENTBOT_PORT` | `8787` | 监听端口（host 固定 `127.0.0.1`） |
| `AGENTBOT_IDLE_REAP_MS` | `600000` | 空闲会话进程保留时长 |
| `AGENTBOT_MAX_HELD` | `5` | 同时挂起的权限请求上限 |
| `AGENTBOT_BIN_<ID>` | — | 指定某运行时的可执行文件（不在 PATH 时用），如 `AGENTBOT_BIN_ZCODE` |
| `AGENTBOT_GROUP_DECISION_MS` | `20000` | 群聊主持人决策超时（真实 CLI 一轮 20s+，见下文） |

权限的两个时间窗口写在 `config.ts` 的 `timeouts` 里，不开放环境变量：
`permissionRejectMs`（120s）、`permissionHoldMaxMs`（24h）、`grantTtlMs`（12h）。
它们对应 board 的产品决定，改动属于产品决策而不是部署参数。

## 事件层

运行时事件统一走 `src/server/core/events/ingest.ts` 的 `ingestEvent(ctx, event)`，它是落库的唯一入口：

1. **能力掩码**：`event.type` 不在该运行时的 `eventCapabilities` 里且不是 `meta` → 直接丢弃，不落库、不推送。
2. **`meta` 特判**：不受掩码约束，永远落库（重启后 Session 分隔条靠它恢复），但不进渲染流。
3. **正文累积**：`message_delta` 的 `start`/`delta` 追加进 `messages.content`，`end` 收口并把状态置 `done`。**`messages.content` 是正文唯一权威副本**，重连时前端拿它整体覆盖，不用事件累积重建。
4. **降级**：payload 缺必填字段时不丢事件——填安全默认值、`raw` 保留原始 JSON、记 warning，前端渲染为「未知事件」折叠块。
5. **落库 → 广播**：正文追加与事件写入在同一事务内；提交后才推 SSE。

`seq` 是会话内计数（`sessions.seq_counter` 在写事务里递增后读回，单写者保证），只用于 UI 排序；SSE 重连游标是全局自增的 `events.id`。

`plan` 是全量替换：每次都是独立事件行，但 payload 带 `replace: true`，前端整块覆盖计划区而不是追加。

## 接口

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/health` | 否 | 探活，只返回 `{"ok":true}` |
| `GET /api/meta` | 是 | 服务版本、schema 版本、已探测运行时列表 |
| `GET /api/stream?sessionId=` | 是 | SSE 事件流，按 `events.id` 续推 |
| `GET /api/runtimes` | 是 | 运行时列表（含能力三态与事件掩码），读探测缓存 |
| `GET /api/bots` | 是 | Bot 列表，运行时**内联展开** |
| `GET /api/channels` | 是 | 渠道列表 |
| `POST /api/channels` | 是 | 新建渠道：`{type:"dm"\|"group", participantBotIds, name?, hostBotId?}` → 201 `{channel}`。私聊**幂等**（同一 Bot 只有一条 dm，重复调用返回已有那条）；群聊限 2–5 个参与者，主持人必须在参与者里 |
| `GET /api/channels/:id` | 是 | 渠道 + Session + 消息 + SSE 首连游标 `lastEventId` |
| `POST /api/messages` | 是 | 私聊：立刻返回 `{messageId, turnId, sessionId}`，锁被占则 `queued:true`。**群聊**：主持人决策后返回 `{speakers, calls, skipReason, degraded, notice, warnings}`，派发在后台依次执行 |
| `POST /api/sessions/:id/cancel` | 是 | 中断当前轮（`{turnId}`）；运行时 1s 内不响应则树杀进程 |
| `GET /api/bots/:id` | 是 | Bot 详情 + 权限边界 + 预授权列表 |
| `POST /api/bots` | 是 | 新建 Bot：`{name, persona?, runtimeId?, executionLocation?, repoPath?}` → 201。**绑定无权限通道的运行时**（`requiresWorktree`）时执行位置强制 `worktree` 且 `repoPath` 必填，否则 `400 invalid_bot` |
| `PATCH /api/bots/:id` | 是 | 改边界（`allowDirs`/`allowShell`/`allowNetwork`/`autoApproveWrite`）、运行时（`runtimeId`）与执行位置（`executionLocation`/`repoPath`）；校验失败回 400 + 字段级错误。**把无权限通道的运行时放到 local** 必须带 `confirmRisk:true`，否则 `400 risk_confirmation_required` |
| `GET /api/permissions?sessionId=` | 是 | 该会话的权限记录（待批 + 已决），含超时策略与截止时间 |
| `POST /api/permissions/:id/decision` | 是 | `{decision:"approve"\|"reject"\|"remember_session"\|"remember_bot"}` → 204；已决回 409 |
| `GET /api/assignments?status=&botId=&channelId=` | 是 | 任务列表 + 各状态计数 `counts` |
| `GET /api/assignments/:id` | 是 | 任务详情（含报告、事件数、改动文件） |
| `POST /api/assignments` | 是 | `{channelId, sourceMessageId?, title, deliverable, botId}` → 201；队列满回 `409 queue_full` |
| `GET /api/assignments/:id/report.md` | 是 | 报告 Markdown 原文（`text/markdown`）；未结束回 `409 report_not_ready` |
| `GET /api/schedules` | 是 | 定时任务列表（含 `nextRunAt`/`lastResult`/`status`/`autoPaused`）+ `schedulerRunning` + `minIntervalMinutes` |
| `POST /api/schedules` | 是 | `{name, botId, channelId, prompt, triggerType, delayMinutes?\|intervalMinutes?\|atTime?}` → 201；周期 <5 分钟回 `400 interval_too_small` |
| `PATCH /api/schedules/:id` | 是 | `{enabled?, name?, prompt?}`；暂停清 `nextRunAt`，恢复重算下次触发并清失败计数 |
| `DELETE /api/schedules/:id` | 是 | 删除 → 204；不存在回 404 |
| `GET /api/token` | 是 | 当前 token 状态：`{preview, url, activeStreams}`（脱敏预览 + 带 token 的完整地址 + 活跃 SSE 连接数） |
| `POST /api/token/reset` | 是 | 重置 token → `{token, url, closedStreams}`。**先删 token 文件再生成**（否则 `ensureToken()` 会读回旧值），随后 `closeAllStreams()` 主动断开所有 SSE。旧 token 立刻 401 |
| `POST /api/admin/purge` | 是 | 全量删除：`{confirm:"删除全部数据"}` → `{ok, deleted:{每表行数}, closedStreams}`。确认短语不符回 `400 confirm_required`；保留 `runtime_definitions`（探测缓存）与 `schema_meta` |

其余所有请求（含静态资源）都要过 token 校验：无 token 或错误 token 返回 `401 {"error":"unauthorized"}`，响应体不含任何业务数据；同一来源连续 10 次失败后 60s 内返回 `429`。

未注册的 `/api/*` 统一返回 `404 {"error":"not_found"}`。前端用这个 code（而不是任意 404）
判断「端点还没实现」并降级为空态；已实现端点查不到资源时应回更具体的 code
（如 `channel_not_found`），前端会走错误态。

### 前端期望的 REST 形状（M4/M5/M6 按此实现）

类型定义在 `src/web/net/types.ts`，字段名 camelCase、时间 epoch ms、「未上报」用 `null`。

```jsonc
// GET /api/bots
{ "bots": [{
  "id": "b1", "name": "研究助手", "persona": "…", "avatar": null, "colorIndex": 1,
  "runtime": { "id": "gemini", "displayName": "Gemini CLI", "protocol": "ACP",
               "version": "0.14.2", "healthStatus": "ready", "capabilitiesSource": "probed",
               "capabilities": { "plan": true, "permission": true, "resume": true,
                                 "contextWindow": 1000000, "streaming": true } },
  "executionLocation": "worktree", "effectivePath": "~/.agentbot/wt/research",
  "worktreeState": "ready", "status": "active",
  "state": "idle", "stateSince": null, "pendingPermissions": 1,
  "lastActiveAt": 1761200000000, "createdAt": 1761100000000
}]}

// GET /api/channels/:id  —— 首屏一次拿全，lastEventId 作为 SSE 首连游标
{ "channel": { "id": "g1", "type": "group", "name": "发布前评审",
               "participantBotIds": ["b1","b2"], "hostBotId": "b6",
               "lastMessagePreview": "…", "lastMessageAt": 0, "unread": 0, "createdAt": 0 },
  "sessions": [{ "id": "s1", "channelId": "g1", "botId": "b1", "runtimeId": "gemini",
                 "resumeState": "rebuilt", "status": "idle",
                 "startedAt": 0, "endedAt": null, "messageCount": 4,
                 "tokensIn": 1204, "tokensOut": 388 }],
  "messages": [{ "id": "m1", "sessionId": "s1", "channelId": "g1", "turnId": "t-1",
                 "role": "assistant", "content": "…", "contentVersion": 3,
                 "status": "done", "tokensIn": 1204, "tokensOut": 388, "createdAt": 0 }],
  "lastEventId": 1234 }

// GET /api/permissions?sessionId=  —— 事件的 permission_request 不带超时策略与截止时间，
// 卡片要显示 120s 倒计时 / 「已挂起 1h 20m」必须靠这个端点
{ "permissions": [{ "id": "P-0140", "sessionId": "s1", "botId": "b1", "turnId": "t-2",
                    "action": "write", "target": "/abs/path.md", "boundaryVerdict": "pending",
                    "timeoutPolicy": "reject", "status": "pending",
                    "heldSince": null, "expiresAt": 1761200120000,
                    "decision": null, "decidedBy": null, "decidedAt": null,
                    "createdAt": 1761200000000 }] }

// POST /api/messages
// 请求 { "channelId": "g1", "text": "…", "mentionBotIds": ["b1"]? }
// 响应 { "messageId": "u9", "turnId": "t-9", "sessionId": "s1",
//        "queued": false, "position": 0 }

// POST /api/permissions/:id/decision
// 请求 { "decision": "approve" | "reject" | "remember_session" | "remember_bot" }
```

**Turn 归属**：SSE 帧的 payload 带 `botId`（M4 起）。群聊里主持人 ≠ 发言人，
只靠主持人兜底会让 Turn 头写错名字，所以归属由服务端在出帧时补齐
（`http/dto.ts` 的 `createBotIdEnricher`）。前端优先用 `payload.botId`，
缺失时退回「消息 → Session → Bot」两跳（见 `ChatPage.resolveBotId`）。

为什么在出帧时补而不落库：`ingest`（M2 定稿）会把 payload 规整成「已知字段」，
额外键会被丢掉；而归属是确定的（一个 Session 只属于一个 Bot），按 `sessionId`
查一次并缓存即可，不值得为它改事件模型。

### 事件流（SSE）

`GET /api/stream?sessionId=<id>` 返回 `text/event-stream`，帧格式：

```
id: 123
event: message_delta
data: {"id":123,"sessionId":"…","turnId":"…","type":"message_delta","seq":7,"payload":{…},"raw":null,"createdAt":…}
```

- `id` 是全局自增的 `events.id`，浏览器 `EventSource` 重连时自动带 `Last-Event-ID`，服务端只推它之后的帧，不重复也不漏（P0-04）。
- `event:` 是事件类型；`meta` 也会推送（前端靠它生成 Session 分隔条），只是不渲染。
- 心跳为注释行 `: ping`，每 15s 一次，不占用 `id`。
- 首连可带 `?lastEventId=` 补上「REST 拉历史 → 建立连接」之间的空隙。
- 会话不存在返回 `404`，缺 `sessionId` 返回 `400`，鉴权失败由前置钩子返回 `401` 且不建立连接。
- 客户端断开自动退订；重置 token 时调 `closeAllStreams()` 断开全部连接。

## 运行时接入（Adapter 层）

三个通道驱动 + 每个运行时一个 YAML 声明。新增一个原生 ACP 运行时 = 放一个 YAML，
不改核心代码（S4）。

```
src/server/adapters/
  contract.ts              ChannelDriver / AdapterDeclaration 类型（唯一契约）
  registry.ts              YAML 加载 + zod 校验
  launch.ts                可执行文件解析（Windows .cmd 外壳、AGENTBOT_BIN_* 覆盖）
  probe.ts                 并发探测 + 能力合并 + 缓存读写
  factory.ts               协议 → 通道驱动
  turn-context.ts          编排层给驱动注入 turnId / messageId
  channels/
    acp/{transport,driver,mapping}.ts   JSON-RPC 传输 / 驱动 / §3.5 映射表
    cli/driver.ts                       CLI 兜底（按行启发式，ZCode / DSH）
    native/{driver,mapping}.ts          原生通道（Codex app-server；传输复用 acp/transport）
  declarations/*.yaml                   gemini-cli / claude-code / codex / zcode / dsh
```

### 探测状态词表

两层，不要混用：

| 层 | 字段 | 取值 |
|---|---|---|
| 契约层 | `ProbeResult.healthStatus` | `healthy` / `unhealthy` / `unprobed` |
| 展示层 | `RuntimeSummary.healthStatus` / `availability` | `ready` / `missing` / `timeout` / `unhealthy` / `unprobed` |

判定顺序：命令不存在 → `missing`；版本命令超时 → `timeout`；版本低于 `minVersion`
→ `unhealthy`（文案「需要 ≥ x.y」）；启动命令不存在 → `missing`（例：claude-code
的 ACP 桥接包没装，但 `claude` 本体在）；`initialize` 失败 → `unhealthy`；全通过 → `ready`。

**探测失败 ≠ 不支持**：能力值三态是 `true` / `false` / `unknown`，没测出来一律
`unknown`（UI 画虚线徽标），绝不猜成 `false`。

探测结果写进 `runtime_definitions`（能力 JSON 里带一个 `_probe` 保留键存
availability / executable / meetsMinVersion），渲染只读缓存，不在渲染时探测。

### 运行时不在 PATH 时怎么接

ZCode 桌面版只带内置 CLI、不在 PATH 上。用环境变量指定可执行文件（不需要改声明）：

```bash
AGENTBOT_BIN_ZCODE="D:/Program software/ZCode/resources/glm/zcode.cjs" npm run dev:server
```

变量名规则：`AGENTBOT_BIN_<声明 id 大写、非字母数字转下划线>`，例如
`AGENTBOT_BIN_GEMINI_CLI`、`AGENTBOT_BIN_CLAUDE_CODE`。`.cjs` 会用当前 node 跑，
Windows 的 `.cmd` 外壳会被静态解析成它真正的目标（不经 `cmd.exe`，避免参数被 shell 解释）。

### 事件能力掩码

每个声明有 `eventCapabilities`，只写该运行时**确实能稳定产出**的类型。
`ingest` 会丢弃未声明的可渲染类型（不落库、不推送），因此 UI 不出现空块。

| 运行时 | 掩码 |
|---|---|
| gemini-cli / claude-code（ACP） | 全 9 类 |
| codex（app-server） | 8 类（无 plan） |
| zcode（CLI） | message_delta / usage / done / error |
| dsh（CLI） | message_delta / done / error |

### 契约测试

`fixtures/<channel>/<scenario>.jsonl` 存**原始协议行**，配 `<scenario>.expected.json`
（规范化事件序列，`$MESSAGE_ID` / `$STDERR_TAIL` 是占位符）。测试用
`FakeTransport` 喂给驱动，断言三件事：事件序列深度相等（忽略 ts）、产出类型
⊆ `eventCapabilities`、插入垃圾行后仍不抛错。

```bash
npx vitest run tests/contract
```

ACP fixture 是按架构 §3.5 映射表手写的协议样本（本机没有 Gemini CLI）；CLI fixture
是 zcode 0.17.0 的真实输出形态；Codex fixture 里 `normal/permission/crash/garbage`
按 0.163.0 的 JSON Schema 手写，`real-session.jsonl` 是真实 app-server 录制
（未登录账号：握手/开会话/重试错误是真的，模型输出不是）。换真实录制样本时断言不用改。

### Codex 通道（codex app-server）

线格式与 ACP 同为「一行一个 JSON-RPC 2.0 消息」，传输层直接复用
`channels/acp/transport.ts`（逐行切分、stderr 尾窗、id 关联、退出时 failAll）。
协议语义独立在 `channels/native/mapping.ts`：

| app-server 通知（0.163.0） | 统一事件 |
|---|---|
| `item/started`/`item/completed`（`reasoning`） | `thought` |
| `item/reasoning/textDelta`、`summaryTextDelta` | `thought`（增量） |
| `item/started`/`item/completed`（`commandExecution` / `fileChange` / `mcpToolCall`） | `tool_call` + `tool_result` |
| `item/started`/`item/completed`（`agentMessage`）、`item/agentMessage/delta` | `message_delta` |
| `thread/tokenUsage/updated`（取 `tokenUsage.last`） | `usage`（轮末发一条） |
| `turn/completed` | `done`（`status=failed` → fatal `error`） |
| `error`（`willRetry:true`） | `error(fatal:false)` |
| `item/*/requestApproval`、`execCommandApproval`、`applyPatchApproval` | `permission_request` |
| `userMessage` item | 丢弃（用户消息由产品层写入） |

点式名（`item.started` / `turn.completed` / `token_count`，架构 §3.6 的早期写法）
与斜杠式都认。审批请求**只上报不应答**：核心裁决后调 `respondPermission`，
应答体按方法分三种（`accept/decline`、`approved/denied`、权限档案）。

`prompt()` 等到 `turn/completed` 才 resolve —— `turn/start` 只是「已受理」，
提前返回会让编排层立刻补 done，后续流式事件全被丢掉。

沙箱与审批策略走声明的 `protocolOptions`（默认 `workspace-write` + `on-request`），
改行为不用动代码。探测（`initialize`）只证明「进程活着且说 JSON-RPC」，
`permissionRequest` / `resume` / `streaming` 是协议内置能力可置 `true`，
`plan` / `images` / `contextWindow` 留 `unknown` 由声明兜底。

## 内置引擎（builtin 通道）

除了三条外部运行时通道，产品自带一个**不启动子进程**的运行时：agent loop 跑在服务进程内，直连模型 API（OpenAI Chat Completions / Anthropic Messages）。它解决两件事：

- 外部 CLI 一轮 15–20s、prompt 6 万 token 且没有权限通道；内置引擎每轮几百 token，且每个工具调用都能事前拦截。
- 工具、MCP、技能都在自己的循环里执行，权限判定走**现有** `core/permissions/resolver.ts`（边界 → 授权 → 用户），与 ACP 同构，没有第二条管线。

```
src/server/
  core/agent/
    provider.ts        纯接口（ChatMessage / ToolCall / ProviderDelta / ProviderClient）
    loop.ts            调模型 → 执行工具 → 回灌 → 循环（maxIterations 20 / maxToolCalls 40）
    prompt.ts          人格记忆（编排层已拼好）+ 运行规则 + 技能索引
    skills.ts          ~/.agentbot/skills/<name>/SKILL.md 扫描与索引
    tools/             registry + paths（realpath 防逃逸）+ truncate + builtin 八个工具
  adapters/providers/  openai-chat / anthropic / providers.json 读写
  adapters/mcp/        stdio JSON-RPC 客户端 + 管理器 + mcp.json
  adapters/channels/builtin/driver.ts   无进程 ChannelDriver
```

**可用性**：内置引擎在运行时列表里常驻首位；没有配置任何供应商时置灰（`probeDetail` 提示去设置页添加），配置后立即变为 ready。它**不参与 PATH 探测**。

**工具与权限**：`read_file` / `list_dir` / `grep` / `read_skill` 只读；`write_file` / `edit_file`（write）、`run_shell`（exec）、`web_fetch`（network）执行前必须经权限裁决。MCP 工具统一按 `exec` 处理，名字为 `mcp__<server>__<tool>`。用户拒绝后回灌的话术明确要求模型换做法，不会让它死循环重试同一调用。

**边界**：所有文件工具走 `resolveInside(cwd, path)`，`..` 与符号链接逃逸都会被拒；`run_shell` 的 cwd 固定为会话 cwd，超时/取消走树杀；`web_fetch` 只允许 http(s) GET。

**失败处理**：流被网关掐断 → 自动降级一次非流式；429/5xx 退避 2 次（1s、3s）；工具参数不是合法 JSON → 回灌原文让模型重试；上下文溢出 → 丢掉最旧的一半重试一次；达到上限 → 非致命 error + done，用户可继续发消息接着做。

**REST**：

| 端点 | 说明 |
|---|---|
| `GET/POST /api/providers` · `PATCH/DELETE /api/providers/:id` | 供应商 CRUD；响应只含 `apiKeyMasked` |
| `POST /api/providers/:id/test` | 发一次最小请求，返回 `{ok,latencyMs,model,error?}` |
| `POST /api/providers/:id/default` | 设为默认供应商 |
| `GET/POST /api/mcp` · `PATCH/DELETE /api/mcp/:id` · `POST /api/mcp/:id/reconnect` | MCP 配置与连接状态 |
| `GET /api/skills` · `POST /api/skills/rescan` | 技能索引（带 `builtin` 标记）与重扫（顺带补装被删的内置技能） |
| `GET /api/setup/state` | 初始化引导 5 步完成度与 `needsSetup`（N1） |

**Bot 绑定**：`POST/PATCH /api/bots` 接受 `providerId`（可空，空则用默认供应商）；`GET /api/bots` 的 DTO 带 `providerId`。设置页「模型供应商 / MCP / 技能」三个分区负责配置。

**冒烟**：`npm run smoke:builtin` 会起一个假 OpenAI 网关、启动服务、建 Bot、发消息、批准权限卡、校验工具落盘与事件链，全程不访问真实模型。

## 最小 Turn 的实现要点

`core/orchestrator/turn.ts` 跑一次 Turn：建 user message → 拿/起进程 →
建 assistant message → 发 prompt → 事件经 `ingest` 落库+广播 → done/error 收口。

- **正文权威副本是 `messages.content`**：编排层不读事件重建正文，收口只改状态。
- **会话锁**（`session-lock.ts`）：同一 Session 串行。第二个请求立刻返回
  `queued:true` + `position`，前一轮收口时自动放行；排队中取消只撤出队列，
  不会去 cancel 别人正在用的进程。
- **进程复用**：一个 Session 一个进程，复用条件「同一 Session + 同一运行时 + 进程活着」。
  resume 失败就开新会话并落 `meta.session_rebuilt`（只在状态**变化**时落，避免每轮都插分隔条）。
- **取消**：`session/cancel` → 驱动产 `done(stopReason:'cancelled')` → 消息标 `interrupted`，
  已生成正文保留。
- **崩溃**：驱动或传输层报一次 fatal error（幂等，不重复报）→ 消息 `failed`、
  Session `crashed`，`exit code` 进 `detail`。

CLI 通道的进程模型是「一次 prompt 一个进程」（ZCode / DSH 的 headless 都是跑完即退），
所以上下文不跨轮保留，由产品层重建（`resumeStrategy: process-lifetime`）。

## 进程管理（M5，`core/process/`）

`supervisor.ts` 是**唯一**的进程管理者。编排层只做 `await supervisor.ensure(sessionId)`，
不再自己 spawn、记 pid、判断 resume。

| 文件 | 职责 |
|---|---|
| `supervisor.ts` | 复用或 spawn、resume/重建、空闲回收、`driver.onExit` 唯一注册点、Session 状态机 |
| `kill-tree.ts` | 树杀。Windows `taskkill /pid <pid> /T /F`，POSIX `kill(-pid)`；另含 pid 创建时间读取（防 PID 复用误杀） |
| `pid-registry.ts` | 内存登记 + `SIGINT/SIGTERM/exit` 兜底清扫 + 启动时僵尸清扫 |

**状态机**（落 `sessions.status`，与前端 `SessionDto.status` 同一套词表）：

```
created → starting → ready → running ⇄ waiting_permission
                       │        └→ idle ─(空闲 10min)→ reaped（杀进程，留 runtime_session_id）
                       └→ crashed（非预期退出）
任意态 →(用户结束 / 关服 / 改绑运行时)→ ended
```

任务书里的 `busy` 在本实现里就是 `running` —— 数据库与前端已按 running 定稿，
多造一个同义词只会让 dto 与 UI 各自猜一次。

**resume 策略（P0-15）**：先试运行时 resume（`resumeStrategy` 为 `none`/`process-lifetime`
的直接跳过，省一次必然失败的往返）；失败或不支持 → 产品层重建
（`orchestrator/context.ts`：人格 + 注入记忆 + 最近 20 条消息）。重建内容超上下文窗口时
从最早消息丢弃至估算 token < 窗口 70%，并在提示里写「已省略 N 条历史」。
`meta.session_resumed` / `meta.session_rebuilt` **只在状态变化时**落一条。

**Windows 进程治理**：`taskkill /T /F` 是硬要求。实测只杀父进程时，脱离的孙进程会变孤儿
（`只杀父进程后：父活 false 子活 true`），所以不能用 `process.kill` 假装跨平台。
启动时比对 `sessions.process_started_at` 与真实进程创建时间，对不上（PID 被复用）就**只清字段不杀**。

## 权限系统（M6，`core/permissions/`）

判定顺序：**先边界，后运行时，最后用户**。

```
运行时抛出请求
 ① 归一化：action ∈ {write, read, exec, network}；target 解析为绝对路径
 ② 边界判定（用边界快照 + version，不受后续修改影响）
      越界 → 直接 deny 应答运行时 + 写审计 + 推「超出 Bot 边界」（不弹卡、不占 120s）
 ③ 授权命中：preauth 且动作是边界内的写 → 自动批准 + 审计
      或已有 grant（session / bot 域）→ 自动批准 + 审计
 ④ 生成卡片，按 timeout_policy 计时
```

| 文件 | 职责 |
|---|---|
| `boundary.ts` | Bot 级边界：`allow_dirs` / `allow_shell` / `allow_network` / `auto_approve_write`，默认全关；路径 realpath 归一化、`..` 不可逃逸、相对路径按会话 cwd 解析、无法解析即拒绝 |
| `resolver.ts` | 边界 + 授权 + 超时的最终裁决；落 `permission_requests`、写审计事件、回传运行时 |
| `policy.ts` | 三档超时（`reject`/`hold`/`preauth`）+ 5 分钟扫描器（24h 上限、进程退出失效、挂起数上限） |
| `grants.ts` | `permission_grants` 读写；`action_key` = `动作:归一化目标` |

**三档超时（board `product-positioning/03-decisions.md` 决定 Q1）**：

| 场景 | 超时行为 | 判定依据 |
|---|---|---|
| 交互会话（用户刚发消息） | `reject`：120s 后拒绝，标「超时自动拒绝」 | `StartTurnInput.source = 'interactive'`（默认） |
| Assignment / 定时任务 | `hold`：不拒绝不继续，挂起最长 24h；超 24h 转拒绝 | `source = 'assignment' \| 'schedule'` |
| 用户显式开启「写操作自动批准」 | `preauth`：边界内写自动批准只写审计；边界外仍按来源走 hold/reject | `bots.auto_approve_write = 1` |

场景**自动判定**，不需要用户配置（按触发来源）。扫描器每 5 分钟兜底一次；
reject 的 120s 由内存定时器精确触发。`hold` 期间进程保活（不参与空闲回收）；
进程退出时该会话的待批卡片直接转 `invalidated`，不占满 24h。

**审计**：`permission_requests` 是唯一权威（`status` / `decision` / `decided_by` / `decided_at` /
`boundary_snapshot` / `boundary_version`）。事件的 `permission_request` payload 定稿为 4 个字段，
只负责通知前端刷新，不含决定。

**requestId 的两个坑（都已处理）**：
1. ACP 的 `requestId` 是 JSON-RPC id，**每个运行时进程都从 1/1000 重数**。直接拿它当主键，
   进程回收重建后的第二张卡会被当成「重复上报」静默丢掉。落库时重名加 `#n` 后缀，
   原始 id 记进 `boundary_snapshot.runtimeRequestId`，回传运行时用它。
2. 驱动自己也会 emit 一条 `permission_request`。编排层因此**不落库**这类事件
   （`turn.ts` 里直接 return），权威的那条由权限层裁决后发出 —— 否则流里会出现
   同一 requestId 的两张卡（pending 占位 + 已决）。

## 群聊主持与派发（M10，`core/group/`）

群聊里一条用户消息可能触发多个 Bot，但**绝不允许全员回复**（P0-06）。链路：

```
POST /api/messages（type=group）
  → host.decideSpeakers()   主持人 Bot 跑一轮 Turn，要求返回 {speakers:[{botId,reason}], skipReason?}
                            + 解析 / 丢弃不存在的 Bot / 合并 @ / 截断到 3
  → HTTP 立刻回名单（派发在后台）
  → dispatcher.dispatchSpeakers()  每个发言人一个独立 Session，默认串行
```

| 约束 | 落地 |
|---|---|
| 未被点名的 Bot 0 次运行时调用 | dispatcher 只遍历 `speakers`，名单外不建 Session、不 spawn、不 prompt |
| @ 必被包含且优先 | `applyMentions()` 把 @ 的 Bot 提到最前，主持人无法剔除 |
| 单条消息 ≤3 次 Bot 调用 | `parseHostReply()` 截断 + warning；@ 超过 3 个也只保留前 3 |
| 不存在的 BotId | 丢弃该项 + warning + 群内系统提示 |
| 空名单 | 响应 `speakers: []` + `skipReason`（前端显示「本轮无 Bot 发言」+「指定 Bot 回复」） |
| 主持人不可用/超时/非 JSON | 降级为「@ 谁谁回」+ 群内系统提示；非 JSON 另有正则/文本匹配兜底 |

**默认依次执行**（board 03-decisions Q3）：阅读顺序稳定、同一 worktree 只有一个写者。
仅当用户**显式 @ 多个 Bot** 时并行。某一轮失败不阻塞后续发言人。

主持人决策超时默认 20s（`AGENTBOT_GROUP_DECISION_MS`）：PRD 写「5s 内」是产品感知目标，
真实 CLI 一轮就要 20s+，按 5s 截断会让主持人永远超时。

群聊里用户消息只落**一条**（主持人那一轮的 Turn 记录用户原文，发言人 Turn 传
`recordUserMessage:false`），否则会话流会出现 N 个一样的用户气泡。

## 任务委派（M11，`core/assignment/`）

```
POST /api/assignments → runner.create()  入队 + 在原会话贴「已排队」卡片
                     → pump()            并发上限内取出，execute()
execute:
  ① worktree.ts   确保执行位置就绪（P0-13）；未就绪直接标失败并给原因
  ② 建 task 渠道（独立线程）+ 独立 Session，source='assignment' → 权限走 hold
  ③ 等 messages.status 离开 streaming；30 分钟没有 → 标超时（保留已有产出）
  ④ report.ts     生成 Markdown（执行摘要 / 改动文件 / 用量 / 失败时最后 50 条事件）
  ⑤ 报告整段写回原会话（role='system'，不是 assistant —— 不产生假 Turn）
```

| 约束 | 落地 |
|---|---|
| 独立线程、聊天流只有状态卡片 | 每个任务一个 `type='task'` 渠道 + 自己的 Session；原会话只写 `role='system'` 消息 |
| 执行中会话可继续聊天 | 任务用独立 Session，不占原会话的会话锁 |
| 第二个任务排队 | 同 Bot 执行并发 = 1（PRD 口径），第二个 `queued` + 卡片写「等待前序任务（队列 2/5）」 |
| 队列上限 5 | 只算 `queued`（执行中的不占名额）；超出创建时 `409 queue_full` |
| 30 分钟无结束事件 | 标 `timeout`，`fail_reason` 写明，报告附已有产出 |
| 运行时崩溃 | 标 `failed`，报告附最后 50 条事件（`REPORT_TAIL_LIMIT`） |
| 重启恢复 | 残留 `running` 一律标失败（进程已不在），`queued` 按 `queue_pos` 恢复 |

执行位置（P0-13，`worktree.ts`）：

- 选 worktree 必须填**仓库根**：用 `git rev-parse --show-toplevel` 校验，并要求它
  与填写值一致（`not_repo_root`）——只判「在某个仓库内」会把落在父级仓库里的临时目录误判为合法。
- 路径由 `botId + botName` 决定（`~/.agentbot/wt/<name>-<id尾8>`），同一 Bot 后续 Session 复用；
  两个 Bot 指向同一仓库各自独立。
- 创建失败（磁盘满/权限）→ Bot 可保存，标 `worktree_state='failed'`，发送/执行时被阻止并给原因。
- `listChangedFiles()` 的 `git status` **限定 pathspec `-- .`**：执行目录若在某个巨大仓库内，
  不带 pathspec 会扫全仓库（实测 60s+，把收口卡死）。
- 「目录还在但 `worktree_path` 被清空」（改成 local 后再切回）→ 认领已有 worktree 而不是
  重跑 `git worktree add`（否则会永久报 `already exists`）。认领前用
  `rev-parse --git-common-dir` 比对，**只复用属于同一仓库的目录**，绝不删用户文件。

## CLI 运行时强制 worktree（安全底线）

`zcode` / `dsh` 的声明是 `permission.channel: none` —— 它们**不会**发权限请求，
产品层的边界判定与卡片拦截根本没有机会发生（M10 实测：ZCode 直接改了仓库的
`package.json` 并新建了 `tsconfig.server.json`）。用户裁定：这类运行时的 Bot 默认强制 worktree。

判定与文案集中在 `core/permissions/worktree-guard.ts`，三处落地：

| 位置 | 行为 |
|---|---|
| `POST /api/bots` | 绑定这类运行时 → `execution_location` 强制 `worktree`；缺 `repoPath` 直接 `400`，文案说明「该运行时不提供权限请求」 |
| `PATCH /api/bots/:id` | 换成这类运行时、或把执行位置改成 `local` → 必须带 `confirmRisk:true`，否则 `400 {"error":"risk_confirmation_required","message":"<风险文案>"}`。只改边界字段（`allowDirs` 等）不受影响，历史数据仍可编辑 |
| Session 启动 / 发送前 | `core/process/session-cwd.ts` 的 `resolveSessionCwd`：即使 Bot 配的是 `local` 也**强制**在 worktree 里跑；worktree 未就绪抛 `WorktreeNotReadyError` → 发送被阻止并回 `409 {"error":"worktree_not_ready","message":...}`，**绝不静默降级** |

`GET /api/bots`、`GET /api/bots/:id`、`GET /api/runtimes` 的 runtime 里都有
`requiresWorktree: boolean`，前端据此显示提示与二次确认。
（`permission.channel` 存在探测缓存的 `capabilities._probe` 保留键里，零 schema 变更。）

## 定时任务（P0-11）

`core/scheduling/{triggers,scheduler}.ts` + `http/routes/schedules.ts`。

| 约束 | 落地 |
|---|---|
| 三种触发 | `once`（延迟 N 分钟）/ `interval`（每 N 分钟）/ `daily`（每日 `HH:MM`，**本地时区**）；`triggers.ts` 是纯函数，创建与执行后共用 |
| 周期最小间隔 5 分钟 | 保存时校验，更小回 `400 interval_too_small`（`config.limits.minScheduleIntervalMinutes`） |
| 不常驻轮询 | 只在「最早的下一次触发」上挂一个 `setTimeout`，触发后重排；启动时按 `next_run_at` 重建（不用 `setInterval` 扫库） |
| 错过触发补跑 1 次 | 启动时 `next_run_at` 已过期 → 补跑并标「补跑」（写进 `last_result` 前缀 + 系统块）。**执行前**先推进 `next_run_at`，所以重启不会补第二次 |
| 连续失败 3 次自动暂停 | `fail_count` 落库，达阈值置 `enabled=0` 并把原因写进 `last_result`；DTO 的 `autoPaused` 供前端显示「已自动暂停」+「恢复」 |
| 一次性任务执行后完成 | `next_run_at` 置 NULL、`enabled=0`，**记录保留**（不删行）；`status='completed'` |
| 结果回贴 | 触发与结果各写一条 `role='system'` 消息到原会话，Bot 的真实回复是它自己的 Turn（不造假 Turn）。首次触发若该渠道还没有 Session，会补建一条空 Session 作锚点 |
| 权限走 hold | `source:'schedule'` → `permissions/policy` 自动选 `hold`（无人值守不被 120s 打断） |

状态没有独立列（`schedules` 表由 M2 定稿），全部由 `enabled` / `next_run_at` /
`last_result` / `fail_count` 推导（`scheduleStatusOf`）：`active` / `paused` / `completed` / `bot_archived`。

## 校验脚本

```bash
npm run typecheck          # vue-tsc --noEmit（含 .vue，检查 props/emits）
npm run typecheck:tsc      # 裸 tsc --noEmit（靠 types/vue-shims.d.ts 认识 .vue）
npm run lint:boundaries    # 分离铁律：core/ 无协议字符串，adapters/ 不碰数据库
npm test                   # vitest（单元 + 契约回放）
npx vitest run tests/contract   # 只跑三个通道的契约测试
```

`npm run lint:boundaries` 是架构 §2 的机器化检查：`src/server/core/**` 出现 `session/update`、`--output-format`、`jsonrpc`、`codex-app-server`、`acp` 即失败；`src/server/adapters/**` import `core/db` 或 `better-sqlite3` 即失败。违规会打印 `file:line` 并非零退出。

## 目录约定

```
src/server/
  main.ts              启动序：状态目录 → 迁移 → token → 声明探测 → Supervisor + 权限
                       → 僵尸清扫 → 编排器 → 调度器 → HTTP
  config.ts            路径、默认值、超时与保留策略
  http/                鉴权钩子、SSE、REST 路由、DTO 装配、静态资源
  core/                编排/权限/存储，不含任何协议字符串
    orchestrator/      turn.ts（一轮完整流程）+ session-lock.ts（同 Session 串行）
                       + context.ts（resume 失败时的产品层重建）
    process/           supervisor.ts（进程唯一管理者）+ kill-tree.ts（树杀）+ pid-registry.ts
    permissions/       boundary.ts（Bot 边界）+ resolver.ts（裁决）+ policy.ts（三档超时）
                       + grants.ts（授权记忆）
    group/             host.ts（主持人决策 + @ 合并 + 截断）+ dispatcher.ts（依次/并行派发）
                       + notices.ts（群内系统提示）
    assignment/        runner.ts（队列 + 独立线程执行）+ report.ts（Markdown 报告）
                       + worktree.ts（local/worktree 校验、创建、改动统计）
  adapters/            唯一允许出现协议细节的地方；声明 YAML 放 declarations/
src/shared/            前后端共用的事件类型与 DTO
src/web/               Vue 3 前端（见上文「前端」）
fixtures/              契约测试用的原始协议样本
tests/contract/        三个通道的契约回放（FakeTransport + fixture）
tests/unit/            ingest/repo/sse/turn/process/permissions/lifecycle/context/http-permissions
                       /group/assignment/http-group/http-assignments
```

新增一个 ACP 运行时 = 往 `src/server/adapters/declarations/` 放一个 YAML，不改核心代码。

## 会话控制（2026-10-27）

内置引擎会话内可切**四档权限**（计划模式 / 变更前确认 / 自动模式 / 完全访问）与**模型**（供应商 + 模型），工作区下沉到会话/群聊，记忆按会话隔离，支持上下文压缩与缓存命中率统计；管理员 Bot 持 `create_bot` 工具。详见 [`.forge/agentbot-15-change-log-session-control.md`](.forge/agentbot-15-change-log-session-control.md)。
