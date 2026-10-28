---
name: agentbot-project-state
description: agentbot（本地多 Bot 工作台）全流程走完并交付可用——10 页 Vue 3 前端 + Node/Fastify/SQLite 后端 + 四条运行时通道（含内置引擎）；含 CLI 通道强制 worktree 安全裁定、服务端登录页 + 持久 HttpOnly cookie、以及几处实测契约坑
metadata:
  node_type: memory
  type: project
  originSessionId: session_b526ef72bb09d3babef30cecf1380d7c
---

`D:\workspace\Agent WorkSpace\agentbot` —— 用 product-forge 全流程（brief→prd→ux→ui→prototype→architecture→build→review）做完的**本地 Web 多 Bot 工作台**，2026-10-25 交付可试用。`.forge/state.json` 已 `phase: done`，八个 gate 全 approved。

**产品定位**：类 DS Bot / Grok Bot 的群聊式 Bot 工具，但底层驱动真实 agent 运行时（ZCode / Codex / Claude Code / Gemini / DSH）。Bot 有名字、人格、身份色、记忆、权限边界；运行时只是它当前绑定的"机器"。

**技术栈（架构 §1，用户明确要求 Vue）**：Node 22 + TypeScript ESM + Fastify 5 + better-sqlite3(WAL) + SSE；前端 Vue 3 + Pinia + Vue Router（history 模式）+ @tanstack/vue-virtual。核/adapters 物理分离，`check-boundaries.mjs` 强制：core 不得出现协议字符串、adapters 不得 import 数据库。

**启动方式**：`npm run build && npm run start:local`（`scripts/start-local.mjs` 自动把本机 ZCode 的 `zcode.cjs` 路径填进 `AGENTBOT_BIN_ZCODE`，否则 ZCode 显示"未安装"）。控制台打印登录页地址（另附一条带 token 的链接，2026-10-28 起登录页 + 持久 HttpOnly cookie，见文末）。状态全在 `~/.agentbot`（db/token/providers/mcp/skills/wt/）。

**用户裁定的一条安全底线（重要）**：CLI 通道的运行时（ZCode/DSH，`permission.channel: none`）**强制在 git worktree 里跑**。原因是它们不发权限请求，产品层无法拦截——M10 实测时 ZCode 真的改了仓库 `package.json` 并新建了文件。实现：`core/permissions/worktree-guard.ts` + `core/process/session-cwd.ts`；worktree 未就绪返回 409 `worktree_not_ready`，**绝不静默降级 local**；用户可改回 local 但需 `confirmRisk: true` 二次确认。

**几处踩过的坑（改代码前先看这里）**：
- **虚拟列表不能用 `transform: translateY()` 定位行**——transform 给后代创建包含块，会把 `.turn-head` 的 `position: sticky` 关死在行内，表现为滚动到底时 Turn 头跑到正文下方。改用 `top` 定位。
- **CLI 通道的人格/记忆注入**：`newSession(h, opts.systemPrompt)` 的 systemPrompt 必须存下来并**前置拼进 prompt 文本**（ZCode 没有 system 参数）。丢掉它会让人格记忆完全失效。
- **CLI 每轮进程 exit 0 是正常的**，不能一律判 crashed。判据：`code === 0 && 无进行中 Turn` → `idle`；否则才是 crashed。判错会导致每轮新建 Session 且跳过上下文重建。
- **"有没有历史"要看 `messages` 表，不是 `runtime_session_id`**——CLI 的占位 id 一直在但上下文早没了；判错则第二轮模型不知道刚才说过什么。
- **`messages` 排序不能只靠 `created_at`**——user/assistant 常同毫秒插入，用 `ORDER BY created_at DESC, rowid DESC`（rowid 是 SQLite 隐式单调列，零 schema 变更）。
- **发送后必须立刻建 pending Turn**。只乐观插入用户消息的话，CLI 一轮 15–30s 期间界面完全静止，用户以为没发出去。pending 要带秒表 + 非流式等待文案 + 发送键变停止，首条事件用同一 turnId 合并。
- **最新一轮不要自动折叠**（`isCollapsed` 对 done 一律收起的规则要放过最新一条），否则用户等完 15s 答案立刻缩成一行摘要。

**本机运行时实测**：ZCode 0.17.0 ready（`D:/Program software/ZCode/resources/glm/zcode.cjs`，一轮 15–22s 非流式）；DSH 0.1.1 ready 但缺 `DEEPSEEK_API_KEY` 时 `exit 1`；Codex 0.163.0 协议可握手但本机未登录；Claude Code 的 `claude-code-acp` 桥未装；Gemini 未安装。

**已知遗留**：`permission_requests` 缺 `runtime_request_id` 列（用 `#n` 后缀绕）；`assignments` 缺 `source_message_id`（多任务回贴会落到同一 Session 末尾）；Codex 6 类事件只有 fixture 回放；群聊主持人决策 20s（PRD 已从 5s 改口径）、Assignment 并发 1（与架构原文 2 冲突已按 PRD 改）。

**Why**：这是当前主力在做的新产品，跨会话还会继续迭代；上面的坑全部是真机实测踩出来的，重复踩一遍要花几个小时。
**How to apply**：改这块代码前先看"几处踩过的坑"；跑验证用 `npm run build && npm run start:local`，真实对话用 ZCode（注意每轮 15–30s）。原型与视觉权威是 `.forge/agentbot-prototype-v2/index.html`（4691 行，UI 改动照它做）。验收报告在 `.forge/agentbot-07-review.md`。相关流程见 [[product-forge-plugin]]。

---

## 2026-10-26：内置引擎（builtin 通道）已落地

**分支**：`continue-dev`（未合并 main）。新增第四条运行时通道 `builtin`：agent loop 跑在服务进程内，直连模型 API，不启动子进程。

**关键文件**
- 供应商：`src/server/core/agent/provider.ts`、`src/server/adapters/providers/*`、`src/server/http/routes/providers.ts`
- 循环与提示：`src/server/core/agent/{loop,prompt,limits}.ts`
- 工具：`src/server/core/agent/tools/**`（registry / paths / truncate / builtin 八个工具；2026-10-28 增至十个，加 `list_skills` 与 `create_bot`）
- 技能：`src/server/core/agent/skills.ts` + `routes/skills.ts`
- MCP：`src/server/adapters/mcp/*` + `routes/mcp.ts`
- 驱动：`src/server/adapters/channels/builtin/driver.ts`、`adapters/builtin-runtime.ts`
- 迁移 v2：`bots.provider_id`；`supervisor` 把 botId/providerId 传给驱动
- 前端：`stores/{providers,mcp,skills}.ts`、SettingsPage 三个新分区、BotsPage/BotDetailPage 供应商选择

**状态目录新增**：`~/.agentbot/providers.json`（0600，含 apiKey）、`mcp.json`、`skills/<name>/SKILL.md`。

**新的坑 / 注意点**
- 内置引擎的权限是 `internal` 通道：`requiresWorktree()` 只认 `none`，所以它允许 local；每个 write/exec/network 都在 loop 里事前问权限。
- 默认边界是只读：`allowDirs` 为空时写操作会直接被边界拒绝（不弹卡）。要测权限卡必须先给 Bot 授权目录。
- 无进程驱动不发 `onExit`，managed 条目留到 idle reap；`dispose` 负责 abort + 拒绝挂起权限 + 丢历史。
- 重启后 `resumeSession` 必然失败（内存历史没了），supervisor 用 messages 表重建并走 `newSession(systemPrompt)`。
- 网关可能不支持 `stream_options` 或掐流：loop 会降级一次非流式；已产出文本保留。
- MCP 工具默认 `exec`，名字 `mcp__<server>__<tool>`；单 server 失败隔离。
- `grep` 不能用带 `g` 的正则 `.test()`（lastIndex 会跳行）。
- 冒烟：`npm run smoke:builtin`（假 OpenAI 网关，不碰真实 key）。

**验收**：365 passed / 7 failed（7 个与基线同一批 Windows 环境假设）；tsc/vue-tsc/boundaries/build 通过；`smoke:builtin` 通过。报告：`.forge/agentbot-07-review-builtin-engine.md`；变更日志：`.forge/agentbot-10-change-log.md`。

## 新需求：初始化引导 / 基础技能 / 热插拔 / 技能按需加载（2026-10-28）

> **已全部实现**（N1 / N2 / N3-1 / N3-2 / N4），落地细节见本文末「2026-10-28：18 号 7 条缺口 + 19 号四条需求全部落地」。
> 下面是开工前的现状梳理，保留作背景。

四条新需求整理在 [.forge/agentbot-19-new-requirements.md](../../.forge/agentbot-19-new-requirements.md)。

- N1 初始化引导：现有 /setup 只有 3 步（探测运行时→建 Bot→发消息），缺供应商、管理员、工作区、技能；需扩到 5 步 + 首启判定 + 可重入
- N2 基础技能：8 个内置工具已存在，缺的是做成 4 份 SKILL.md 并首次安装到 ~/.agentbot/skills/
- N3 热插拔：供应商已能热插拔，MCP 需重启，运行时不能；建议先做技能 + MCP
- N4 技能按需加载：索引已只放 name+描述（≤800 字符），建议默认只装基础 4 个 + list_skills 发现其余

建议顺序 N2 → N4 → N1 → N3。与 agentbot-18 的唯一文件交集是 migrate.ts 的 v4，合并一次做。

## 待修：7 条部分落地的需求（2026-10-28）

> **7 条已全部修完**（R3 走方案 A、R5 走方案 B），验收项见 [.forge/agentbot-18-fix-list.md](../../.forge/agentbot-18-fix-list.md)。
> 下面是当时的审计结论，保留作背景。

需求审计完成（24 条：17 对齐 / 7 部分 / 0 未做）。待修清单在 [.forge/agentbot-18-fix-list.md](../../.forge/agentbot-18-fix-list.md)，每条有文件位置与验收标准。

摘要：R8 缓存未上报被算成 0%；R3 群聊记忆未跨 Bot 共享；G7 群聊写类工具无串行；R5 auto 越界不弹卡；R5-c MCP 工具在 plan 下未裁；G3 切 plan 的系统块刷新后消失；R7 压缩条数/字数未进流。

开工前需拍板：R3 走共享还是不共享（建议共享）、R5 走弹卡还是直接拒绝（建议直接拒绝）。

## 会话控制 / 记忆隔离 / 管理员 Bot（2026-10-27 完成）

R1–R8 已实现并验收：迁移 v3、会话/渠道工作区、记忆作用域、会话级模型覆盖、四档权限（confirm/auto/plan/full）、管理员 Bot 与 `create_bot`、上下文压缩、缓存命中率。证据：`.forge/agentbot-15-change-log-session-control.md`；口径：`.forge/agentbot-11-requirements-align.md`；交接与待办：`.forge/agentbot-14-handoff.md`。

门禁：tsc / vue-tsc / boundaries 全绿，vitest 409 passed，`smoke-builtin.mjs` 全链路通过。

本轮修掉两处 Windows 环境假失败：`%TEMP%` 落在祖先 git 仓库导致「无法统计」用例走错分支；8.3 短名（`LIYUNX~1`）与反斜杠导致路径比较不等（统一 `realpathSync.native` + `/` + 小写）。

## 2026-10-28：18 号 7 条缺口 + 19 号四条需求全部落地

**分支**：`continue-dev`（未合并 main）。迁移 v4（`usage_records.cache_reported` + `bots.enabled_skills`）。

**18 号（7 条）**
- R8：两协议缓存字段缺失留 undefined；`cache_reported` 落库；聚合命中率分母只算缓存已上报的请求
- R3 方案 A：`scope='channel'` 只按 channel_id 过滤（跨 Bot 共享）；`listByBot` 用 `json_each` 带上本 Bot 参与的群聊；DTO 带 `sourceBotId/sourceBotName`，同群 Bot 可停用/删除
- G7：`core/group/write-lock.ts` 按 channelId 串行化写类工具（进程级单例，经 `SpawnContext.channelId` 下发）；读不排队
- R5 方案 B：auto 越界直接拒绝（代码本就如此，改需求与 UX 文案）
- R5-c：`mcp.json` 支持 `permission`（缺省 exec）；驱动合并内置 + MCP 后统一按 plan 裁剪
- G3：切 plan 时审计 meta 带 `rejectedPending + modeSwitchedTo`；前端不再本地插块
- R7：`dividerText(kind, data)` 输出「已压缩 N 条 → 摘要 M 字」；`pushMeta` 传 `payload.data`

**19 号（4 条）**
- N1：`GET /api/setup/state`（5 步，必需项决定 needsSetup）；`/setup` 五步 + 第六步演练；App.vue 挂载后跳转一次；侧栏「初始化待完成 N」；设置页常驻入口；`POST /api/bots` 支持 role
- N2：`core/agent/skills/builtin/*/SKILL.md` 4 份；`skills/install.ts` 启动安装（幂等、不覆盖、删了补装、`.agentbot-builtin` 标记）；tsup 复制到 `dist/skills/builtin`
- N3-1：`scanSkills` 按 mtime/size 签名缓存；Bot 级 `enabled_skills` 过滤索引
- N3-2：McpManager `add/replace/remove`；路由只动受影响的那一个连接
- N4：新建 Bot 默认 4 个基础技能；`list_skills` 工具；索引 ≤800 字符 / ≤12 条并提示剩余

**新增的坑**
- `better-sqlite3` 里判断「JSON 数组包含某值」不要用 `LIKE '%id%'`（`bot_a` 会误中 `botX_a`），用 `json_each`
- 权限测试造 pending 需要同时满足：`allow_dirs` 覆盖目标 + `isSessionAlive: true`，否则落 `denied_boundary` / `invalidated`
- `buildSkillsIndex` 的「另有 M 个」提示行要预留预算，否则字符上限会超
- 内置技能包是运行时资源，`tsup.config.ts` 的 `onSuccess` 必须复制，否则打包后找不到源目录

**门禁**：tsc / vue-tsc / boundaries 全绿；vitest 484 passed / 1 skipped；`smoke:builtin` 全链路通过。

## 2026-10-28：服务端登录页 + 持久 HttpOnly cookie 登录态

**动机**：此前只能把控制台打印的 `?t=<token>` 拼进地址栏，换设备 / 清 cookie 后要回去翻那条 URL。

**实现**
- 新增 `src/server/http/login.ts`：`GET /login`（服务端渲染表单，免鉴权、`no-store`、不回显 token）、
  `POST /login`（校验 token → 303 回 `next`）、`POST /logout`（303 回登录页）、`POST /api/auth/logout`（204）。
- cookie：`agentbot_token`，`HttpOnly; SameSite=Strict; Path=/; Max-Age=30 天`；`Secure` 在 HTTPS 或
  `NODE_ENV=production` 时自动加，`AGENTBOT_COOKIE_SECURE=1|0` 可强制开关。
- 鉴权钩子：`isPublicPath()` 放行 `/api/health`、`/login`、`/logout`、`/api/auth/logout`；
  浏览器导航 401 → 302 `/login?next=<原路径>`（`nextFromUrl` 剥掉 `?t=`、拒绝指回登录页/登出，防死循环与开放重定向）。
- 凭据优先级：`tokenCandidates()` = `?t=` → cookie，逐个校验任一通过即放行；登录页里反过来 cookie 优先。
- 前端：`client.ts` 的 `redirectToLogin()` 清 sessionStorage 后整页跳 `/login`；`App.vue` 顶栏加退出按钮；
  `vite.config.ts` 把 `/login`、`/logout` 也代理到后端（否则 Vite SPA 兜底返回 index.html，前端没有 /login 路由 → 死循环）。
- 测试：`tests/unit/http-login.test.ts`、`http-auth-page.test.ts`。

**新增的坑**
- 登录页**不能**做成 Vue 路由页：鉴权钩子覆盖所有路径（含静态资源），未登录时 index.html 与 JS 包都拿不到。
- 本地 http 下给 cookie 加 `Secure` 会被浏览器丢弃 → 登录「成功」但刷新又回登录页。
- `?t=` 残留会拖累有效 cookie：必须「多候选逐个校验」，而不是只看第一个。
- 开发态 `/login` 必须代理到后端，否则被 SPA 兜底吞掉。

**门禁**：tsc / vue-tsc / boundaries 全绿；vitest **500 passed / 1 skipped（38 文件）**；`smoke:builtin` 通过。
