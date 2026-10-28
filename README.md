# AgentBot

本机运行的 Web 工作台：把多个 Bot 编排到可插拔的 agent 运行时上（ACP：Gemini CLI / Claude Code · Codex app-server · CLI 兜底：ZCode / DSH · 自带的内置引擎）。

单进程本地服务：Node 22 + TypeScript（ESM）+ Fastify 5 + SQLite（better-sqlite3，WAL）+ SSE；前端 Vue 3 + Pinia + Vue Router。

## 换设备继续开发

```bash
git clone https://github.com/liyunxuanyu/agentbot.git
cd agentbot
git checkout continue-dev
npm install
npm run build && npm run start:local     # 控制台会打印登录页地址与带 token 的链接
```

启动后打开 `http://127.0.0.1:8787/login`，输入 `~/.agentbot/token` 里的令牌即可；
登录成功会种下 30 天的 HttpOnly cookie（见下文「运行」与「登录与登录态」）。

**已完成的批次**（分支 `continue-dev`，最新为 2026-10-28 的移动端/公网修复与浏览器控制）：

- **移动端/公网修复 + 浏览器控制**（2026-10-28）：
  - 权限确认框不再被静默拒绝（未配置允许目录时 confirm 模式弹卡）；
  - 公网隧道下事件不落地 → 加 REST 兜底轮询（cloudflared 会缓冲 SSE 响应体）；
  - 会话里可看文件内容与改动 diff（`GET /api/files`、`/api/files/tree`、`/api/files/changes`）；
  - Bot 可控制浏览器：接入 Playwright MCP（headless），`npm run setup:browser` 一键装。
  详见下文「移动端 / 公网访问」与「浏览器控制（Playwright MCP）」。
- 登录页与持久 HttpOnly cookie：`GET/POST /login`、`POST /logout`、`POST /api/auth/logout`，见下文「登录与登录态」。
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
- [`docs/memory/agentbot-project-state.md`](docs/memory/agentbot-project-state.md) —— 项目全貌 + 真机踩过的坑（虚拟列表 transform 毁 sticky、CLI 人格注入、exit 0 误判 crashed、messages 同毫秒排序、pending Turn、最新轮不自动折叠…）。重复踩一遍要几个小时。
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
# 可选：给 Bot 装「浏览器控制」（Playwright MCP，headless）
npm run setup:browser
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

启动后控制台会打印登录页地址：

```
  用浏览器打开（仅本机可访问）：
  http://127.0.0.1:8787/login
```

在登录页输入访问令牌（`~/.agentbot/token` 里的那串字符）即可。登录成功后服务端种下
**持久 HttpOnly cookie**（30 天、SameSite=Strict；HTTPS/生产环境自动加 Secure，
可用 `AGENTBOT_COOKIE_SECURE=1|0` 强制开关），之后刷新、重开浏览器都不再需要 token。
右上角的退出按钮会清除 cookie 并回到登录页。

旧的 `?t=<token>` 方式仍然有效：打开一次就会种下同一枚持久 cookie，之后可正常使用。

开发态前端跑在 5173（Vite HMR），`/api`、`/login`、`/logout` 由 Vite 代理到后端 8787。
两边都要起：

```bash
npm run dev              # concurrently：dev:server + dev:web
```

首次开发访问打开 `http://localhost:5173/login` 输入 token 即可（也可以沿用
`http://localhost:5173/?t=<token>`；token 会存进 sessionStorage 并从地址栏抹掉，
见下文「前端 token 引导」）。

## 前端

Vue 3（Composition API + `<script setup>`）+ Pinia + Vue Router 4，构建用 Vite。

```
src/web/
  main.ts                 入口：bootstrapToken → createApp → pinia → 主题 → router
  App.vue                 应用壳：240 侧栏 + 顶栏 + 主区（右面板属于 /chat 自己）；
                          挂载后读 /api/setup/state 做首启跳转，顶栏右侧是退出登录
  index.html              Vite 的 root 模板（vite.config.ts 里 root = src/web）
  router/index.ts         10 个页面路由（含 /setup）+ 根重定向与 404 兜底，history 模式
  pages/                  10 页全部接真实端点（见下表）
  components/
    common/               AppIcon / EmptyState / AppModal / Toast / CapBadge
    bot/                  BotCard / BotAvatar / BotStateChip / BotCapabilityBadges
    chat/                 TurnItem / TurnBodyItem / MessageBubble / EventRow / EventBlock
                          PermissionCard / PermissionBlock / Composer
                          SessionDivider / RoundFence / ActivityRow / StreamRowItem
  stores/                 bots / channels / runtimes / providers / mcp / skills / setup
                          / sessions / events / permissions / ui
  composables/            useSseStream / useVirtualList / useHotkeys
  net/                    client.ts（REST）+ stream.ts（SSE）+ types.ts（DTO 契约）
  lib/                    turnModel.ts（事件→渲染模型）/ format.ts / botVars.ts
                          / runtime.ts / icons.ts
  styles/                 tokens.css（令牌）+ base.css（全局样式，逐字照抄原型）
```

### 页面与数据来源

| 页面 | 主要端点 | 四态 |
|---|---|---|
| `/setup` | `GET /api/setup/state` · `GET /api/runtimes` · `POST /api/providers` · `POST /api/providers/:id/test` · `POST /api/bots`（可带 `role`）· `PATCH /api/bots/:id`（工作区）· `POST /api/skills/rescan` · `POST /api/channels` · `POST /api/messages` + SSE | 逐项探测骨架 / 全未安装给安装指引 / 探测失败横幅 / 正常；5 步 + 第 6 步演练，每步可跳过 |
| `/bots` | `GET /api/bots` · `POST /api/bots` | 6 张骨架 / 引导建第一个 Bot / 读取失败重试 / 正常 |
| `/bots/:id` | `GET /api/bots/:id` · `GET/POST/PATCH/DELETE …/memory` · `POST …/memory/summarize` · `PATCH /api/bots/:id`（边界 / 运行时 / `role` / `permissionMode` / `enabledSkills`）· `DELETE /api/bots/:id` | 标签局部骨架 / 各标签独立空态 / 运行时不可用横幅 / 正常 |
| `/chats` | `GET /api/channels` · `POST /api/channels` | 5 行骨架 / 「还没有会话」/ 重试条 / 群聊 + 私聊分组 |
| `/chat/:id` | `GET /api/channels/:id` · `GET /api/sessions/:id/events` · SSE · `GET /api/permissions` · `PATCH /api/channels/:id` · `PATCH /api/sessions/:id/controls` · `POST /api/sessions/:id/compact` · `POST /api/sessions/:id/cancel` | 顶部历史骨架 / 人格 + 示例提问 / 断线横幅 / 正常 |
| `/assignments` | `GET /api/assignments` · `POST /api/assignments` | 分组骨架 / 「任务从会话里创建」/ 重试条 / 状态 chips + 表格 |
| `/assignments/:id` | `GET /api/assignments/:id` · SSE 回放 | 排队等待原因 / 报告生成中骨架 / 失败原因 + 最后 50 条事件 / 报告四节 |
| `/schedules` | `GET/POST/PATCH/DELETE /api/schedules` | 行骨架 / 「还没有定时任务」/ 调度器异常横幅 / 列表 |
| `/usage` | `GET /api/usage` · `GET /api/usage/export.csv` | 表格骨架 / 「还没有可统计的调用」/ 查询失败（筛选保留）/ 行 + 合计 |
| `/settings` | `GET/POST/PATCH/DELETE /api/runtimes*` · `GET/POST/PATCH/DELETE /api/providers*`（含 catalog / models）· `GET/POST/PATCH/DELETE /api/mcp*` · `GET /api/skills` · `POST /api/skills/rescan` · `GET /api/token` · `POST /api/token/reset` · `GET/POST /api/admin/{bots,tidy}` · `POST /api/admin/purge` · `GET /api/permissions` | 逐行骨架 / 无运行时给安装指引 / 单项失败只标该行 / 八个分区 |

**设置页是八个分区**（`SettingsPage.vue` 的 `TABS`）：运行时 / 模型供应商 / 模型映射表 /
MCP / 技能 / 安全与 token / 数据与保留 / 权限审计。页头另有常驻的「初始化引导」入口（N1）。

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

之后每个 REST/SSE 请求仍会把 sessionStorage 里的 token 作为 `?t=` 附在 URL 上：
后端 `tokenCandidates()` 认 `?t=` 与 `agentbot_token` cookie，自定义 header 会被忽略。
登录页种下的持久 cookie 是主凭证，URL 携带只是「同一标签页里 cookie 被清掉」时的兜底。
两者都校验，**任一有效即放行** —— 这样 sessionStorage 里残留的旧 token 不会把有效的
cookie 拖成 401。收到 401 时前端会清掉本地副本并整页跳到 `/login`（token 重置流程除外）。

### 登录与登录态

- `GET /login` 是服务端渲染的表单页（免鉴权、`no-store`、不回显任何 token）；未登录的
  浏览器导航会被 302 到 `/login?next=<原路径>`。登录成功 303 回原路径。
- `POST /login` 校验失败沿用鉴权限流（同来源 10 次 / 60s），锁定期间表单禁用。
- `next` 只接受站内绝对路径，且剥掉 `?t=`、拒绝指回 `/login` 与 `/logout`（防开放重定向与回跳死循环）。
- cookie：`HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`，HTTPS 或
  `NODE_ENV=production` 时加 `Secure`（`AGENTBOT_COOKIE_SECURE=1|0` 可覆盖）。
- 退出：`POST /api/auth/logout`（204，清 cookie，前端按钮用）、`POST /logout`
  （303 回登录页，无 JS 兜底）。两者都免鉴权 —— 只删凭证、不读数据。
- 为什么登录页不是 Vue 路由页：鉴权钩子覆盖所有路径（含静态资源），未登录时
  SPA 的 index.html 与 JS 包都拿不到，前端路由页没有机会渲染。

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
再用 `GET /api/sessions/:id/events` 分页拉事件（含 `meta`），最后建 SSE 连接补增量。
正常路径**不用事件累积重建正文**；事件端点只负责把 thought / tool_call / usage 这些非正文块补回来。
（首连游标优先用事件回放返回的 `lastEventId`，群聊另按 Session 各开一条连接。）

## 状态目录

所有可变状态都在 `~/.agentbot`（可用 `AGENTBOT_HOME` 覆盖）。`vitest.config.ts` 在收集
测试文件前把 `AGENTBOT_HOME` 指向临时目录，所以跑测试不会往你的真实 home 里写 worktree。

| 文件 | 用途 |
|---|---|
| `agentbot.db` | SQLite 主库（WAL，伴随 `-wal` / `-shm`） |
| `token` | 本地访问 token，权限收紧为仅当前用户 |
| `providers.json` | 内置引擎的模型供应商（含 apiKey，权限 0600；接口只回掩码） |
| `mcp.json` | MCP stdio server 配置（命令、参数、env、enabled） |
| `skills/` | 技能目录：`<name>/SKILL.md`，索引进系统提示、全文由 `read_skill` 按需读取。首次启动自动装 4 个内置技能（`file-basics` / `shell-basics` / `search-basics` / `web-basics`），目录里带 `.agentbot-builtin` 标记 |
| `model-catalog.json` | 模型能力表的**用户覆盖层**（可选）；与内置 `model-catalog.json` 合并，用户表优先命中 |
| `secrets.json` | 自定义运行时 env（尚未落地，`config.ts` 只定义了路径） |
| `wt/` | git worktree 根目录（`executionLocation=worktree` 的 Bot 在这里各有一个目录） |

删除 `token` 后重启会重新生成，旧 token 立即失效（已登录的浏览器也会在下一次请求时 401 → 回登录页）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `AGENTBOT_HOME` | `~/.agentbot` | 状态目录 |
| `AGENTBOT_PORT` | `8787` | 监听端口（host 固定 `127.0.0.1`） |
| `AGENTBOT_IDLE_REAP_MS` | `600000` | 空闲会话进程保留时长 |
| `AGENTBOT_MAX_HELD` | `5` | 同时挂起的权限请求上限 |
| `AGENTBOT_BIN_<ID>` | — | 指定某运行时的可执行文件（不在 PATH 时用），如 `AGENTBOT_BIN_ZCODE` |
| `AGENTBOT_GROUP_DECISION_MS` | `20000` | 群聊主持人决策超时（真实 CLI 一轮 20s+，见下文） |
| `AGENTBOT_COMPACTION_RATIO` | `0.7` | 上下文占用比达到该值时自动压缩（0–1） |
| `AGENTBOT_COMPACTION_KEEP_RECENT` | `12` | 压缩时保留的最近消息条数 |
| `AGENTBOT_CONTEXT_WINDOW` | `128000` | 供应商未上报上下文窗口时的兜底值 |
| `AGENTBOT_COOKIE_SECURE` | 自动 | 登录 cookie 的 `Secure` 开关：`1` 强制开（反代终止 TLS）、`0` 强制关（本机 `NODE_ENV=production` 跑 http）；不设时 HTTPS 或 `NODE_ENV=production` 才开 |

`NODE_ENV` 也参与判定：`production` 下默认给登录 cookie 加 `Secure`。

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
| `GET /api/meta` | 是 | 服务版本、schema 版本、启动时间、已探测运行时列表（启动快照） |
| `GET /api/stream?sessionId=` | 是 | SSE 事件流，按 `events.id` 续推 |
| `GET /api/runtimes` | 是 | 运行时列表（含能力三态与事件掩码），读探测缓存 |
| `POST /api/runtimes` | 是 | 手动添加自定义运行时 `{id, displayName, protocol, command, args?, env?, cwd?, detect?}` → 201；重复可执行文件回 `409 already_exists` + `existingId` |
| `POST /api/runtimes/:id/probe` | 是 | 只重探这一个运行时。内置引擎不跑 PATH 探测，而是按「有没有配供应商」刷新可用性；声明找不到回 `409 declaration_missing` |
| `GET /api/bots` | 是 | Bot 列表，运行时**内联展开**；含 `providerId` / `role` / `enabledSkills` |
| `GET /api/channels` | 是 | 渠道列表 |
| `POST /api/channels` | 是 | 新建渠道：`{type:"dm"\|"group", participantBotIds, name?, hostBotId?, workspacePath?}` → 201 `{channel}`；私聊命中已有渠道时回 200 + 已有那条。私聊**幂等**（同一 Bot 只有一条 dm）；群聊限 2–5 个参与者，主持人必须在参与者里（缺省取第一个），参与者必须存在且未归档 |
| `GET /api/channels/:id` | 是 | 渠道 + Session + 消息 + SSE 首连游标 `lastEventId` |
| `PATCH /api/channels/:id` | 是 | `{workspacePath}`：渠道级工作区；字符串需存在/是目录/可写（不要求 git），`null`/空串清除回退链 |
| `POST /api/messages` | 是 | 私聊：立刻返回 `{messageId, turnId, sessionId}`，锁被占则 `queued:true`。**群聊**：主持人决策后返回 `{speakers, calls, skipReason, degraded, notice, warnings}`，派发在后台依次执行 |
| `GET /api/sessions/:id/events?afterSeq=&limit=` | 是 | 事件回放（含 `meta`），`{events, hasMore, lastEventId}`；`lastEventId` 可直接当 SSE 首连游标 |
| `PATCH /api/sessions/:id/controls` | 是 | `{providerId?, model?, permissionMode?, workspacePath?}`：会话级覆盖；切 `plan` 时挂起的写类请求直接拒绝并回 `rejectedPending`；跨协议切换回 `warning` |
| `POST /api/sessions/:id/compact` | 是 | 手动压缩（仅内置引擎）`{force?}`（缺省 true）；进程不在/通道不支持回 `409 compact_unavailable` |
| `POST /api/sessions/:id/cancel` | 是 | 中断当前轮（`{turnId}`）；运行时 1s 内不响应则树杀进程 |
| `GET /api/bots/:id` | 是 | Bot 详情 + 权限边界 + 预授权列表 |
| `POST /api/bots` | 是 | 新建 Bot：`{name, persona?, runtimeId?, providerId?, role?, executionLocation?, repoPath?}` → 201。**绑定无权限通道的运行时**（`requiresWorktree`）时执行位置强制 `worktree` 且 `repoPath` 必填，否则 `400 invalid_bot` |
| `PATCH /api/bots/:id` | 是 | 改边界（`allowDirs`/`allowShell`/`allowNetwork`/`autoApproveWrite`）、运行时（`runtimeId`）、执行位置（`executionLocation`/`repoPath`）、`providerId`、`role`、`permissionMode`、`persona`、`enabledSkills`（`null`=全部启用 / `[]`=全停 / 数组=白名单）；校验失败回 400 + 字段级错误。**把无权限通道的运行时放到 local** 必须带 `confirmRisk:true`，否则 `400 risk_confirmation_required` |
| `DELETE /api/bots/:id` | 是 | `{confirmName, mode:"cascade"\|"archive"}`；名称不符 `400 name_mismatch`，模式缺失 `400 mode_required`。`archive` 只改 `status`；`cascade` 按外键序清理，但**保留** `usage_records` |
| `GET /api/bots/:id/memory?sessionId=` | 是 | 记忆条目；群聊 `scope='channel'` 跨 Bot 共享，带 `sourceBotId` / `sourceBotName` |
| `POST /api/bots/:id/memory` | 是 | `{content, kind?, injected?, sourceSessionId?, scope?, channelId?}` |
| `PATCH /api/bots/:id/memory/:memId` · `DELETE …` | 是 | `{content?, injected?}`；删除 → 204 |
| `POST /api/bots/:id/memory/summarize` | 是 | 立即摘要 `{sessionId?}` |
| `GET /api/files?botId=&sessionId=&path=` | 是 | 读工作区文本文件（≤512KB，拒二进制）。路径统一过 `resolveInside`，越界回 `403 path_outside_workspace` |
| `GET /api/files/tree?botId=&sessionId=&path=` | 是 | 工作区目录树（跳过 `.git` / `node_modules`，上限 500 项） |
| `GET /api/files/changes?botId=&sessionId=` | 是 | 改动列表（`git status`）；非 git 目录如实回 `{git:false}`，不编造改动 |
| `GET /api/files/changes?botId=&sessionId=&path=` | 是 | 单文件 unified diff；未跟踪文件按「全文新增」合成 |
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
| `GET /api/usage` · `GET /api/usage/export.csv` | 是 | 用量聚合与 CSV 导出（含缓存命中率，未上报为 `null`） |
| `DELETE /api/usage?botId=` | 是 | 按 Bot 删除用量记录；缺 `botId` 回 `400 bot_id_required`（全量删除走 purge） |
| `GET/POST /api/providers` · `PATCH/DELETE /api/providers/:id` | 是 | 模型供应商 CRUD；响应只含 `apiKeyMasked` |
| `POST /api/providers/:id/test` · `POST /api/providers/:id/default` | 是 | 连通性测试 / 设为默认供应商 |
| `GET /api/providers/available` | 是 | `{count, defaultId}`（引导页判断有没有配过供应商） |
| `GET/PUT /api/providers/catalog` · `POST /api/providers/catalog/test` | 是 | 模型能力表：读内置表 + 用户覆盖表 / 整表替换用户表（≤200 条）/ 试算一条规则是否命中模型名 |
| `POST /api/providers/models` | 是 | 用表单里正在填的 `protocol`/`baseUrl`/`apiKey` 拉模型清单（编辑已有供应商只传 `id`），返回上下文窗口与最大输出默认值 |
| `GET/POST /api/mcp` · `PATCH/DELETE /api/mcp/:id` · `POST /api/mcp/:id/reconnect` | 是 | MCP server 配置与连接状态；增删改**只动受影响的那一个连接**（N3-2 热插拔），`mcp.json` 支持 `permission`（缺省 `exec`） |
| `GET /api/skills` · `POST /api/skills/rescan` | 是 | 技能索引（带 `builtin` 标记）与重扫（顺带补装被删的内置技能，返回 `installed[]`） |
| `GET /api/setup/state` | 是 | 初始化引导 5 步完成度、`needsSetup`、`skillCount`、`skillsDir`（N1） |
| `GET /login` | 否 | 登录表单页（服务端渲染，`no-store`，不回显 token）。已登录时 303 回 `next`；带有效 `?t=` 时种持久 cookie 后放行 |
| `POST /login` | 否 | 表单 `{token, next?}` → 303 回原路径并种 `agentbot_token`（持久 HttpOnly cookie）；失败 401 重渲染表单，锁定 429 |
| `POST /api/auth/logout` | 否 | 清 cookie → 204（只删凭证，不读业务数据） |
| `POST /logout` | 否 | 清 cookie → 303 到 `/login`（无 JS 兜底） |
| `GET /api/token` | 是 | 当前 token 状态：`{preview, url, activeStreams}`（脱敏预览 + 带 token 的完整地址 + 活跃 SSE 连接数） |
| `POST /api/token/reset` | 是 | 重置 token → `{token, url, closedStreams}`。**先删 token 文件再生成**（否则 `ensureToken()` 会读回旧值），随后 `closeAllStreams()` 主动断开所有 SSE。旧 token 立刻 401 |
| `GET /api/admin/bots` | 是 | 管理员 Bot 列表 + `totalBots` |
| `GET /api/admin/tidy` · `POST /api/admin/tidy` | 是 | 孤儿数据预览 / 按 `targets` 整理（`channels`/`orphanSessions`/`memories`/`orphanUsage`，默认不含用量）；执行需 `confirm:true` |
| `POST /api/admin/purge` | 是 | 全量删除：`{confirm:"删除全部数据"}` → `{ok, deleted:{每表行数}, closedStreams}`。确认短语不符回 `400 confirm_required`；保留 `runtime_definitions`（探测缓存）与 `schema_meta` |

其余所有请求（含静态资源）都要过 token 校验，**免鉴权的只有** `/api/health`、`/login`、
`/logout`、`/api/auth/logout`。无 token 或错误 token 时，`/api/*` 与 fetch/EventSource 返回
`401 {"error":"unauthorized"}`（响应体不含任何业务数据），浏览器导航（`Accept` 含 `text/html`）
则 302 到 `/login?next=<原路径>`；同一来源连续 10 次失败后 60s 内一律 `429`（带 `retry-after`，
人读的请求回登录页 + 剩余秒数，程序读的回 `{"error":"too_many_requests"}`）。

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
  "providerId": null, "role": "member",
  "enabledSkills": ["file-basics", "shell-basics", "search-basics", "web-basics"],
  "state": "idle", "stateSince": null, "pendingPermissions": 1,
  "lastActiveAt": 1761200000000, "createdAt": 1761100000000
}]}

// GET /api/channels/:id  —— 首屏一次拿全，lastEventId 作为 SSE 首连游标
{ "channel": { "id": "g1", "type": "group", "name": "发布前评审",
               "participantBotIds": ["b1","b2"], "hostBotId": "b6",
               "workspacePath": null,
               "lastMessagePreview": "…", "lastMessageAt": 0, "unread": 0, "createdAt": 0 },
  "sessions": [{ "id": "s1", "channelId": "g1", "botId": "b1", "runtimeId": "gemini",
                 "resumeState": "rebuilt", "status": "idle",
                 "workspacePath": null, "providerId": null, "model": null,
                 "permissionMode": "confirm",
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

四条通道驱动 + 每个运行时一个 YAML 声明（内置引擎的声明在代码里）。新增一个原生 ACP 运行时 = 放一个 YAML，
不改核心代码（S4）。

协议取值是 `acp` / `codex-app-server` / `cli-stdio` / `builtin` 四种有驱动；`opencode-http` 与
`claude-sdk` 虽然在类型与「手动添加运行时」的下拉里存在，但**没有对应驱动** —— 它们会被交给
Codex 原生驱动，握手必然失败、探测显示不可用。要支持得新增通道驱动。

```
src/server/adapters/
  contract.ts              ChannelDriver / AdapterDeclaration 类型（唯一契约）
  registry.ts              YAML 加载 + zod 校验
  launch.ts                可执行文件解析（Windows .cmd 外壳、AGENTBOT_BIN_* 覆盖）
  probe.ts                 并发探测 + 能力合并 + 缓存读写
  factory.ts               协议 → 通道驱动
  builtin-runtime.ts       内置引擎的声明（代码里，不走 YAML / PATH 探测）
  custom.ts                用户手动添加的运行时（声明存库，协议白名单）
  turn-context.ts          编排层给驱动注入 turnId / messageId
  providers/               openai-chat / anthropic / store / models / http
  mcp/                     client / manager（热插拔）/ config
  channels/
    acp/{transport,driver,mapping}.ts   JSON-RPC 传输 / 驱动 / §3.5 映射表
    cli/driver.ts                       CLI 兜底（按行启发式，ZCode / DSH）
    native/{driver,mapping}.ts          原生通道（Codex app-server；传输复用 acp/transport）
    builtin/driver.ts                   内置引擎（无进程，agent loop 在服务进程内）
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
    skills.ts          ~/.agentbot/skills/<name>/SKILL.md 扫描 + mtime 签名缓存 + 按启用列表过滤 + 索引
    skills/install.ts  内置技能包安装（幂等、不覆盖用户改动、删了会补装）
    skills/builtin/    4 份随代码分发的 SKILL.md
    tools/             registry + paths（realpath 防逃逸）+ truncate + builtin 十个工具
  adapters/providers/  openai-chat / anthropic / providers.json 读写 / model-catalog.json
  adapters/mcp/        stdio JSON-RPC 客户端 + 管理器（支持运行期 add/replace/remove）+ mcp.json
  adapters/channels/builtin/driver.ts   无进程 ChannelDriver
```

**可用性**：内置引擎常驻运行时列表，但**不参与 PATH 探测**；没有配置任何供应商时置灰（`probeDetail` 提示去设置页添加），配置后立即变为 ready。

**工具与权限**：`read_file` / `list_dir` / `grep` / `read_skill` / `list_skills` 只读；`write_file` / `edit_file`（write）、`run_shell`（exec）、`web_fetch`（network）执行前必须经权限裁决；管理员 Bot 另有 `create_bot`（admin 动作，走权限卡）。MCP 工具名字为 `mcp__<server>__<tool>`，权限取 `mcp.json` 的 `permission`（缺省 `exec`）；计划模式下所有写类工具（含 `mcp__*`）在注册表里就被裁掉。用户拒绝后回灌的话术明确要求模型换做法，不会让它死循环重试同一调用。

**技能**：系统提示只放**已启用**技能的 `name + 一行描述`（≤800 字符、≤12 条），超限时补一句「另有 M 个，可用 `list_skills` 查看」。新建 Bot 默认启用 4 个基础技能（`enabled_skills` 写默认集合）；`null` = 全部启用（迁移前的老 Bot），`[]` = 全停。停用只影响索引，模型仍可用 `list_skills` 发现、`read_skill` 读全文。扫描按目录 mtime/size 签名缓存，文件一变下一轮即生效，不需要重启。

**边界**：所有文件工具走 `resolveInside(cwd, path)`，`..` 与符号链接逃逸都会被拒；`run_shell` 的 cwd 固定为会话 cwd，超时/取消走树杀；`web_fetch` 只允许 http(s) GET。

**失败处理**：流被网关掐断 → 自动降级一次非流式；429/5xx 退避 2 次（1s、3s）；工具参数不是合法 JSON → 回灌原文让模型重试；上下文溢出 → 丢掉最旧的一半重试一次；达到上限 → 非致命 error + done，用户可继续发消息接着做。

**REST**：供应商 / MCP / 技能 / 初始化引导的端点都在上文「接口」表里（`/api/providers*`、
`/api/mcp*`、`/api/skills*`、`/api/setup/state`）。设置页的「模型供应商 / 模型映射表 /
MCP / 技能」四个分区负责配置。

**Bot 绑定**：`POST/PATCH /api/bots` 接受 `providerId`（可空，空则用默认供应商）与 `role`；`GET /api/bots` 的 DTO 带 `providerId` / `role` / `enabledSkills`。

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
      已配置允许目录、目标在外 → 直接 deny 应答运行时 + 写审计 + 推「超出 Bot 边界」
      **未配置允许目录（新建 Bot 的默认状态）+ confirm 模式的写** → 落 pending 卡片，
        卡片标「超出边界 · 批准只放行这一次」；批准只放行一次，不批按 120s 超时拒绝
 ③ 授权命中：preauth 且动作是边界内的写 → 自动批准 + 审计
      或已有 grant（session / bot 域）→ 自动批准 + 审计
 ④ 生成卡片，按 timeout_policy 计时
```

> **为什么「未配置目录」要弹卡**（2026-10-28 真机反馈）：默认 Bot 的 `allow_dirs` 是 `[]`，
> 旧实现把写请求直接判成 `denied_boundary` 且不落 pending —— 用户在手机上只看到 Bot 说
> 「被拒绝了」，既没有确认框也不知道要去配边界。PRD P0-09 的默认口径本就是「只读 + 写需批准」，
> 所以 confirm 模式下改为一律弹卡；`auto` 仍直接拒绝（「别烦我」的语义），
> 已经配了目录却写到别处也仍直接拒绝（那是**明确的**边界）。

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

## 移动端 / 公网访问（2026-10-28）

手机上通过 cloudflared 隧道访问时踩到的问题与处理：

**① 权限确认框不出现** —— 两个独立原因，都已修：
- 服务端：默认 Bot 没有允许目录时写请求被静默拒绝（见上文「权限系统」）。
- 前端：待批请求被按 `boundaryVerdict === 'denied'` 渲染成「已自动拒绝」的审计行（没有按钮）。
  现在以 `status === 'pending'` 为准，越界信息单独用 `outOfBoundary` 标注。

**② 事件不落地（表现为「一直显示正在连接运行时 / 排队中」）**：
- **cloudflared 会缓冲 SSE 响应体**：响应头立刻回来，但 body 要攒到约 128KB 才放行，
  放行一次之后后续小帧仍然不推（本机直连完全正常，两条独立隧道 + 逐字节采样确认）。
- 处理：SSE 保留为快路径，另加 **REST 兜底轮询**（`/api/sessions/:id/events?afterSeq=`）。
  只在有进行中的 Turn 时开；SSE 健康（已 open 且 3s 内有帧）时 5s 一次，
  判定降级时 1.2s 一次；与 SSE 共用 `ingestFrame`，events store 按 id 去重。
- 另：SSE 建连后立刻写一帧 `: connected` 注释 —— 否则代理在收到首块 body 前
  不把响应头交给客户端，EventSource 要等 15s（首次心跳）才 `open`。

**③ 看不到文件内容 / diff**：新增 `/api/files*` 三组端点 + 会话页「文件」面板；
写类工具的 `tool_result` 带 `fileChange`（改动前后文本 + 行级 diff），会话流里直接渲染。

**④ 会话卡在「生成中」**：`turnModel` 的状态推导顺序改为「消息都已落库且没有 done」
优先于「思考仍在流式」—— 服务重启后 thought 缺 end 帧，旧顺序会让那一轮永远是生成中，
发送键卡在「停止」、整个会话发不出消息。

**⑤ 改成「完全访问」后还是一直等**（第二轮真机反馈）：
- 根因：卡挂起时运行时在等回传、会话锁被这一轮占着。切档路由只处理了 plan
  （拒绝挂起写请求），full 什么都不做 —— 已挂起的卡不会因为「以后都自动批准」
  而消失，只能等 120s 超时拒绝。期间新消息全部排在锁后面。
- 修法：`PermissionResolver.approvePending()`，切到 full 时逐条批准该会话的
  挂起请求并回传运行时；审计 meta 带 `approvedPending` 与 `modeSwitchedTo:'full'`，
  前端同步本地卡片并 toast「已自动批准 N 个挂起的请求」。
- 注意：**Bot 默认权限模式只影响新会话**（会话一旦建立就持有自己的值）。
  手机上改档请用会话里的权限胶囊，不是 Bot 详情页的默认值。

**⑥ 手机上弹卡时点不到权限胶囊**（浏览器级实测）：
- 阻断型权限卡在窄屏是 `position: fixed; bottom: 58px`，高 316px（390×844），
  而输入区从 y=714 起 —— 卡片把整个输入区连同权限胶囊一起盖住，用户无法
  在弹卡时切档，只能去改 Bot 默认值（而已有会话不继承，于是又回到 ⑤）。
- 修法：卡片底边改为 `calc(58px + var(--composer-h))`（贴在输入区**上方**），
  `--composer-h` 由 Composer 用 ResizeObserver 实测写入；`.composer-wrap`
  的 z-index 从 30 抬到 130，让胶囊菜单（z-index 40）能盖过卡片（120）。
- 回归：`npm run e2e:mobile`（见下）。

**⑦ 文件面板在手机上「点了没反应」**：窄屏单列时详情区在列表下方，选中后
自动 `scrollIntoView`；详情头路径改为独占一行、可任意换行（原来被压成 `bro…`）。

### 移动端冒烟（需要真实服务 + 真实模型）

```bash
npm run e2e:mobile -- --base http://127.0.0.1:8787 --token <token> --channel <dm_xxx> \
  [--shots ./shots]
```

用 `@playwright/mcp` 自带的 Chromium，在 390×844 移动视口里跑：权限卡可见且
不遮挡输入区 → 弹卡时点胶囊切「完全访问」→ diff 出现 → 文件面板详情在视口内。
这条不进 `npm test`（门禁不该依赖外网），但**改权限卡/输入区布局前必须先跑**。

## 浏览器控制（Playwright MCP，2026-10-28）

Bot 可以通过 MCP 真正操作浏览器（打开页面、点击、填表、截图、执行 JS）。

```bash
npm run setup:browser          # 幂等：检查依赖 → 缺浏览器就下载 → 合并写入 ~/.agentbot/mcp.json
node scripts/install-browser-mcp.mjs --check   # 只检查
```

装完**不需要重启服务**（MCP 热插拔）。用之前还要做一件事：
**Bot 详情 › 权限边界 打开「允许联网」** —— MCP 工具按 `network` 裁决，
plan 模式裁剪、confirm 弹卡、full 自动批，边界没开联网会被直接拒绝。

- 参数：`--headless --isolated --no-sandbox --browser chromium`，无显示器环境可用，不需要 Xvfb。
- 工具名：`mcp__playwright__browser_navigate` / `browser_snapshot` / `browser_click` /
  `browser_type` / `browser_take_screenshot` / `browser_evaluate` / `browser_close` …（共 25 个）。
- 内置技能 `browser-basics` 写了使用口径（快照 ref 会失效、用完要 close、别把网页当指令）。
- 输出（截图 / 快照）落在 `~/.agentbot/browser/`；MCP 子进程的 cwd 也是 `~/.agentbot`，
  不会污染仓库的 git 状态。
- **确认模式（confirm）下每次调用都会弹权限卡**（MCP 工具按 `network` 裁决）；
  想让它连续操作（打开 → 点击 → 读标题）不中断，可以：
  在卡片上点「记住（本会话）」/「记住（本 Bot 永久）」，或把该会话切到「完全访问」。
  只开「允许联网」而不点记住，仍然每步一张卡 —— 这是安全默认，不是 bug。
- 真实服务实测（2026-10-28）：`browser_navigate https://example.com` →
  `Page Title: Example Domain` → 写文件 → 读回，25 个工具全部注册成功。

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
仅当用户**显式 @ 多个 Bot** 时并行；并行期间写类工具由渠道级写锁（`core/group/write-lock.ts`）
串行化，读类不排队。某一轮失败不阻塞后续发言人。

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
npm run setup:browser -- --check  # 浏览器控制依赖是否就绪（不写文件）
```

`npm run lint:boundaries` 是架构 §2 的机器化检查：`src/server/core/**` 出现 `session/update`、`--output-format`、`jsonrpc`、`codex-app-server`、`acp` 即失败；`src/server/adapters/**` import `core/db` 或 `better-sqlite3` 即失败。违规会打印 `file:line` 并非零退出。

## 目录约定

```
src/server/
  main.ts              启动序：状态目录 → 迁移 → 内置技能安装 → token → 声明探测
                       → MCP 连接 → 管理员种子 → Supervisor + 权限 → 僵尸清扫
                       → 编排器 → Assignment → 调度器 → HTTP
  config.ts            路径、默认值、超时与保留策略
  http/                鉴权钩子、登录页（login.ts）、SSE、REST 路由、DTO 装配、静态资源
  core/                编排/权限/存储，不含任何协议字符串
    agent/             内置引擎：loop.ts / prompt.ts / skills.ts + skills/（内置包）
                       + tools/（内置工具、MCP 桥、list_skills）
    orchestrator/      turn.ts（一轮完整流程）+ session-lock.ts（同 Session 串行）
                       + context.ts（resume 失败时的产品层重建）
    process/           supervisor.ts（进程唯一管理者）+ kill-tree.ts（树杀）+ pid-registry.ts
    permissions/       boundary.ts（Bot 边界）+ resolver.ts（裁决）+ policy.ts（三档超时）
                       + grants.ts（授权记忆）+ worktree-guard.ts（CLI 强制 worktree）
    group/             host.ts（主持人决策 + @ 合并 + 截断）+ dispatcher.ts（依次/并行派发）
                       + notices.ts（群内系统提示）+ write-lock.ts（渠道级写锁）
    assignment/        runner.ts（队列 + 独立线程执行）+ report.ts（Markdown 报告）
                       + worktree.ts（local/worktree 校验、创建、改动统计）
    bots/              create.ts（创建与校验）+ seed.ts（管理员种子）+ runtime-lookup.ts
  adapters/            唯一允许出现协议细节的地方；声明 YAML 放 declarations/
src/shared/            前后端共用的事件类型与 DTO
src/web/               Vue 3 前端（见上文「前端」）
fixtures/              契约测试用的原始协议样本
tests/contract/        三个通道的契约回放（FakeTransport + fixture）
tests/unit/            ingest/repo/sse/turn/process/permissions/lifecycle/context/http-permissions
                       /group/assignment/http-group/http-assignments/http-login/http-auth-page
                       /skills/setup-state/write-lock/divider-text/usage-cache-reporting
                       /provider-models/worktree-guard/…
```

新增一个 ACP 运行时 = 往 `src/server/adapters/declarations/` 放一个 YAML，不改核心代码。

## 初始化引导 / 技能 / 热插拔（2026-10-28）

对应 [`.forge/agentbot-19-new-requirements.md`](.forge/agentbot-19-new-requirements.md)（N1–N4）与
[`.forge/agentbot-18-fix-list.md`](.forge/agentbot-18-fix-list.md)（R1–R8 / G1–G9）。

- **首启引导（N1）**：`GET /api/setup/state` 由服务端算五步完成度（运行时 / 供应商 / 管理员为必需，
  工作区 / 技能可选）。`needsSetup` **只看必需项**；`App.vue` 挂载后跳一次 `/setup`，
  「稍后再说」后本次会话不再自动跳，侧栏保留「初始化待完成 N」入口。
  设置页页头的「初始化引导」可随时重入。
- **基础技能包（N2）**：4 份 `SKILL.md` 随代码分发，启动时装进 `~/.agentbot/skills/`；
  已存在跳过（不覆盖用户改动）、删了会补装、目录里写 `.agentbot-builtin` 标记。
  `POST /api/skills/rescan` 也能补装。
- **技能热插拔（N3-1）+ 按需加载（N4）**：扫描按 mtime/size 签名缓存，改文件下一轮生效；
  Bot 级 `enabledSkills` 过滤索引；新建 Bot 默认启用基础 4 个；`list_skills` 让模型发现未启用的技能。
- **MCP 热插拔（N3-2）**：`McpManager` 的 `add` / `replace` / `remove` 只动受影响的连接，
  增删改后下一轮对话即可用/不可用，不需要重启服务。
- **群聊记忆跨 Bot 共享（R3 方案 A）**：`scope='channel'` 只按 `channel_id` 过滤，
  同群 Bot A 写的记忆 Bot B 也能注入；记忆页用 `sourceBotId` / `sourceBotName` 标明来源。
- **群聊写锁（G7）**：显式 @ 多个 Bot 并行派发时，`core/group/write-lock.ts` 按渠道串行化
  写类工具（write/exec/network/admin），读类不排队。
- **auto 档越界（R5 方案 B）**：边界内**写**自动批准并写审计，越界**直接拒绝**、不弹卡；
  shell / network / admin 动作在 auto 档仍然弹卡。

## 会话控制（2026-10-27）

内置引擎会话内可切**四档权限**（计划模式 / 变更前确认 / 自动模式 / 完全访问）与**模型**（供应商 + 模型），工作区下沉到会话/群聊，记忆按会话隔离，支持上下文压缩与缓存命中率统计；管理员 Bot 持 `create_bot` 工具。详见 [`.forge/agentbot-15-change-log-session-control.md`](.forge/agentbot-15-change-log-session-control.md)。
