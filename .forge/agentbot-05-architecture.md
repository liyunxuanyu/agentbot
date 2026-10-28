# AgentBot 技术方案

> 输入：`agentbot-ref-research.md`（C1–C7）、`agentbot-01-prd.md`、`agentbot-02-ux.md`、`agentbot-03-ui.md`、`board/product-positioning/03-decisions.md`。本文只解决「怎么搭」，业务实现归 builder。

**一句话**：Node 22 + TypeScript 单进程本地服务（Fastify + better-sqlite3 + SSE）+ Vue 3 前端；核心（编排/权限/存储）与 adapter（通道驱动 + 声明文件）物理分离，新增 ACP 运行时 = 加一个 YAML。

---

## 1. 技术选型

| 层 | 选择 | 理由 | 代价 |
|---|---|---|---|
| 语言/运行时 | Node 22 LTS + TypeScript(ESM) | 前后端同语言；ACP 与 `claude-code-acp` 生态在 npm；`child_process` 对长驻子进程支持成熟 | 单线程 CPU，大 JSON 解析放 worker |
| Web 框架 | Fastify 5 | 内置 schema 校验、路由快；SSE 用 `reply.raw`，无中间件黑箱 | 插件生态小于 Express，本项目用不到 |
| 前端框架 | **Vue 3**（Composition API + `<script setup>`） | 用户明确要求（不熟 React）；Vue 在国内生态成熟、中文文档完善、上手门槛低于 React；本项目会话视图是「流式事件 + 大列表」，Vue 响应式系统配合 `shallowRef` 足够，不需要 React 的并发特性 | 生态里 AI 组件库（如 TDesign AI Chat、Element-Plus-X）虽可用但定制成本要评估；团队若更熟 React 需权衡（本项目单人主导，不构成阻碍） |
| 前端状态 | **Pinia** | Vue 官方推荐、devtools 支持好、模块化 store 适合「bots / sessions / events / permissions」分域；REST 结果与 SSE 增量统一入 store | 高频事件表须绕开深代理（§7）；跨 store 组合逻辑自己写 |
| 路由 | Vue Router 4 | 10 页 + 会话只读透镜（`?session=`）需要嵌套路由与滚动位置恢复 | 无 SSR 需求，不引入 Nuxt |
| 数据库 | SQLite（better-sqlite3，WAL） | 需要 `session_id,seq` 分页、`bot×runtime` 聚合 ≤2s、级联删除、保留期批删，文件存储做不到；同步 API 免连接池 | 原生模块（Windows 靠预编译）；写入须单写者串行 |
| 进程管理 | `child_process.spawn` + 自建 Supervisor | 一 Session 一进程，需精确 pid 追踪、树杀、僵尸清扫（§5）；PTY 非必需 | Windows 无进程组，必须 `taskkill /T /F` |
| 流式传输 | SSE（服务端→客户端）+ HTTP POST（客户端→服务端） | 事件严格单向；`EventSource` 原生重连 + `Last-Event-ID` 直接兑现 P0-04 | P0-14 写的是 WebSocket——等价落为「SSE 握手 token 校验失败即 401 断开」 |
| 构建 | Vite 5 + `@vitejs/plugin-vue`（前端）+ tsup（后端单文件 ESM） | HMR 快；`node dist/server.js` 启动，无 ts-node 运行时开销 | 原生模块需 `external` |
| 组件库 | **不引入整套组件库**（可选按需引入 TDesign Vue Next 的 Dialog / Dropdown / Tooltip） | 核心组件（Bot 卡片、Turn、事件折叠块、权限卡片、消息气泡）高度定制，套组件库反而要覆盖大量默认样式；仅少数边界场景用现成基础件 | 可选依赖，样式冲突就退回自研；不引入 Element Plus 全套 |
| 测试 | Vitest（单元 + 契约回放）+ 端到端冒烟脚本 `scripts/smoke-builtin.mjs` | 契约测试是 PRD 硬要求，Vitest 对 JSONL fixture 回放最轻；冒烟用假 [OI] 网关跑全链路，不依赖真实 key 与真实 CLI | **未引入 Playwright**（架构初稿写过，实际没落地）；浏览器侧靠真机手测 |

**明确不引入**：Redis/队列（单进程内存队列够）、ORM（12 张表手写 SQL 更透明）、Electron、Docker/K8s、WebSocket 库、状态机库（3 个状态机手写更可控）。

---

## 2. 目录结构

```
agentbot/
├─ src/server/
│  ├─ main.ts        启动：状态目录 → 迁移 → 内置技能安装 → token → 探测 → MCP
│  │                 → 管理员种子 → 权限 → 清扫 → 编排器 → Assignment → 调度器 → HTTP
│  ├─ config.ts      ~/.agentbot 路径、默认值、保留策略
│  ├─ http/{auth,login,sse}.ts + http/routes/*     鉴权/登录页、SSE 重放、REST
│  ├─ core/                        ← 不含任何协议字符串
│  │  ├─ db/{schema.sql,db.ts,migrate.ts} + repo/*（每实体一文件，纯 SQL）
│  │  ├─ agent/{loop,prompt,skills,limits}.ts + agent/skills/{install.ts,builtin/*}
│  │  │                                           + agent/tools/（registry + builtin/*）
│  │  ├─ bots/{create,seed,runtime-lookup}.ts
│  │  ├─ events/{model,ingest,bus}.ts        统一事件、掩码过滤、落库+广播
│  │  ├─ orchestrator/{turn,session-lock,context}.ts
│  │  ├─ process/{supervisor,kill-tree,pid-registry,session-cwd}.ts
│  │  ├─ permissions/{boundary,resolver,policy,grants,worktree-guard}.ts
│  │  ├─ memory/{assembler,summarizer}.ts
│  │  ├─ group/{host,dispatcher,notices,write-lock}.ts
│  │  ├─ assignment/{runner,report,worktree}.ts
│  │  ├─ scheduling/{scheduler,triggers}.ts
│  │  └─ usage/{recorder,aggregate}.ts + maintenance/{retention,sweeper}.ts
│  └─ adapters/                    ← 唯一允许出现协议细节的地方
│     ├─ contract.ts               Adapter/ChannelDriver 类型（唯一契约）
│     ├─ registry.ts               加载 declarations/、校验、热载
│     ├─ probe.ts                  探测与能力合并
│     ├─ builtin-runtime.ts        内置引擎的声明（不参与 PATH 探测）
│     ├─ providers/*               模型供应商：store / openai-chat / anthropic / models
│     ├─ mcp/{client,manager,config}.ts
│     ├─ channels/{acp,native,cli,builtin}/*   四通道驱动
│     └─ declarations/*.yaml       每运行时一个声明
├─ src/web/                        Vue 3
│  ├─ main.ts                      bootstrapToken → createApp + router + pinia
│  ├─ App.vue                      应用壳（rail + side + main）+ 首启跳转 + 退出登录
│  ├─ router/index.ts              10 个页面路由 + 根重定向 + 404 兜底
│  ├─ pages/                       每页一个 .vue（含 SetupPage / SettingsPage）
│  ├─ components/{bot,chat,common}/
│  ├─ stores/                      bots channels runtimes providers mcp skills setup
│  │                               sessions events permissions ui
│  ├─ composables/                 useSseStream useVirtualList useHotkeys
│  └─ net/                         client.ts（REST）+ stream.ts（SSE）+ types.ts
├─ src/shared/       前后端共用：事件类型、DTO、错误码
├─ fixtures/         录制的原始协议样本（契约测试）
└─ tests/{contract,unit}/
```

**目录名是 `net/` 而不是 `api/`**（历史遗留的硬约束）：Vite dev 代理把 `/api` 前缀整体
转发给后端，源码模块 URL 一旦落在 `/api/*` 下就会被代理吞掉并返回 401。

**分离铁律**：`core/` 不得出现协议字符串（`session/update`、`--output-format`）；`adapters/` 不得访问数据库。CI 用 lint 规则禁止反向 import。

---

## 3. Adapter 层（核心）

### 3.1 核心思想：通道承担复杂度，声明只提供参数

S4 要求「≤200 行、零核心改动」。若每个运行时写一个类，这个目标不成立。因此把复杂度收敛到 **3 个通道驱动**（ACP / 原生 / CLI），由它们承载协议解析与事件映射；**声明文件只填参数**。新增 ACP 运行时 = 写 YAML，因为 ACP 映射是通道级共享的，与具体 agent 无关。

### 3.2 契约类型

```ts
// adapters/contract.ts —— 核心只认这三个类型
export type EventType =
  | 'message_delta' | 'thought' | 'tool_call' | 'tool_result' | 'plan'
  | 'permission_request' | 'usage' | 'done' | 'error';   // 9 类可渲染事件

export type Tri = boolean | 'unknown';                    // C3：未知 ≠ 不支持

export interface CanonicalEvent<T = unknown> {
  type: EventType; turnId: string; ts: number;
  payload: T;              // 见 §3.4
  raw?: unknown;           // 已声明类型但字段解析失败时保留原始 JSON
}

export interface AdapterDeclaration {
  schemaVersion: 1;
  id: string; displayName: string;
  protocol: 'acp' | 'codex-app-server' | 'opencode-http' | 'claude-sdk' | 'cli-stdio';
  launch: { command: string; args: string[]; env?: Record<string,string>; cwd?: string };
  detect: { command?: string; versionArgs: string[]; versionPattern: string; timeoutMs?: number };
  minVersion?: string;
  capabilities: { plan: Tri; permissionRequest: Tri; resume: Tri; images: Tri;
                  streaming: Tri; contextWindow: number | null };
  eventCapabilities: EventType[];                       // 03-decisions 的硬要求
  permission: { channel: 'acp-reverse' | 'jsonrpc-approval' | 'none';
                defaultTimeoutPolicy: 'reject' | 'hold' };
  resumeStrategy: 'acp' | 'native' | 'process-lifetime' | 'none';
  executionLocations: ('local' | 'worktree')[];
  modes?: { headless: boolean; multiplierHint?: number };  // 用量页 ×N 提示
  protocolOptions?: Record<string, unknown>;            // 通道私有，原样透传
}

export interface ChannelDriver {              // 三个通道各实现一次
  start(decl: AdapterDeclaration, ctx: SpawnCtx): Promise<Handle>;
  initialize(h: Handle): Promise<ProbeResult>;          // 失败不致命
  newSession(h: Handle, o: { cwd: string; systemPrompt?: string }): Promise<{ runtimeSessionId: string }>;
  resumeSession(h: Handle, id: string): Promise<{ ok: boolean; reason?: string }>;
  prompt(h: Handle, s: { runtimeSessionId: string; text: string }): Promise<void>;
  cancel(h: Handle): Promise<void>;
  respondPermission(h: Handle, requestId: string, decision: Decision): Promise<void>;
  onEvent(h: Handle, cb: (e: CanonicalEvent) => void): void;
  onPermission(cb: (req: RuntimePermissionRequest) => void): void;
  onExit(cb: (i: { code: number | null; signal?: string; stderrTail: string }) => void): void;
  dispose(h: Handle): Promise<void>;
}
```

**声明字段数：31 个（含嵌套），必填 13 个。**

### 3.3 一个完整的 ACP 声明（新增 Gemini CLI 的全量成本）

```yaml
schemaVersion: 1
id: gemini-cli
displayName: Gemini CLI
protocol: acp
launch: { command: gemini, args: ["--experimental-acp"] }
detect:
  command: gemini
  versionArgs: ["--version"]
  versionPattern: '(?<version>\d+\.\d+\.\d+)'
  timeoutMs: 3000
minVersion: "0.20.0"
capabilities:            # 探测成功则以实测覆盖；失败则用此值并标 source=declared
  plan: true
  permissionRequest: true
  resume: true
  images: unknown
  streaming: true
  contextWindow: null
eventCapabilities: [message_delta, thought, tool_call, tool_result, plan,
                    permission_request, usage, done, error]
permission: { channel: acp-reverse, defaultTimeoutPolicy: reject }
resumeStrategy: acp
executionLocations: [local, worktree]
modes: { headless: true }
```

### 3.4 统一事件模型（payload）

| type | payload 关键字段 | 语义 |
|---|---|---|
| `message_delta` | `{ messageId, phase:'start'\|'delta'\|'end', text }` | 助手正文，增量追加，`end` 收口落库 |
| `thought` | `{ phase, text }` | 推理过程，UI 折叠 |
| `tool_call` | `{ callId, name, kind, input, status:'pending'\|'running' }` | 工具开始 |
| `tool_result` | `{ callId, status:'ok'\|'error', output, exitCode?, truncated }` | 按 callId 挂到调用下 |
| `plan` | `{ entries: [{ content, status:'pending'\|'in_progress'\|'done' }] }` | **全量替换**，非增量 |
| `permission_request` | `{ requestId, action, target, boundaryVerdict }` | 运行时请求授权 |
| `usage` | `{ inputTokens, outputTokens, reported, cumulative? }` | 只信上报，缺失即 `reported:false` |
| `done` | `{ stopReason:'end'\|'cancelled'\|'max_tokens'\|'error', durationMs }` | 轮次终止 |
| `error` | `{ code, message, detail?, fatal }` | `fatal` 决定 Turn 是否失败 |

非渲染的协议状态（slash commands、config option、context compaction）落 `events.type='meta'`：不进渲染流、不计入 9 类、不占 `eventCapabilities`；UI 只消费 `meta.compaction` 生成 Session 分隔条。

### 3.5 ACP → 统一事件映射表（`channels/acp/mapping.ts`，所有 ACP 运行时共用）

| `session/update` 子类型 | 统一事件 | 说明 |
|---|---|---|
| `agent_message_chunk` | `message_delta` | 首个 chunk 补 `phase:'start'`，`done` 时补 `end` |
| `agent_thought_chunk` | `thought` | 同 phase 规则 |
| `tool_call` | `tool_call` | `toolCallId`→callId，`title`→name，`kind` 透传 |
| `tool_call_update`(in_progress) | `tool_call` | 按 callId 覆盖状态 |
| `tool_call_update`(completed/failed) | `tool_result` | `content`/`rawOutput`→output，`exitCode` 透传 |
| `plan` | `plan` | 全量替换 |
| `session/request_permission`（反向请求） | `permission_request` | 通道层不直接应答，交核心裁决（§6） |
| prompt 响应 resolve / `stopReason` | `done` | |
| 传输错误、进程退出 | `error` | `fatal:true` |
| `available_commands_update` / `config_option_update` / `current_mode_update` | `meta` | 驱动 slash 面板，不渲染 |
| `context_compaction` | `meta.compaction` | 生成「已压缩上下文」分隔条 |
| `user_message_chunk` | 丢弃 | 用户消息由产品层写入 |
| 未知 discriminator | `meta.unknown`（仅 debug 日志） | 不抛致命错误 |

用量：ACP 若在 `prompt` 响应或 `_meta` 里带 usage 则映射为 `usage`，否则不发该事件且 `eventCapabilities` 不含它——这正是掩码存在的意义。

### 3.6 原生通道映射

| 通道 | 关键通知 | 映射 |
|---|---|---|
| Codex app-server（JSONL/JSON-RPC） | `item/started`/`item/completed`（reasoning / commandExecution / fileChange / mcpToolCall / agentMessage）、`turn/completed`、`thread/tokenUsage/updated` | reasoning→thought；command/file/mcp→tool_call(+result)；agentMessage→message_delta；tokenUsage→usage；turn/completed→done |
| Codex approvals | `item/*/requestApproval` / `execCommandApproval` / `applyPatchApproval` | permission_request，应答走 JSON-RPC response |

**初稿列过 OpenCode（HTTP+SSE）与 Claude Agent SDK（进程内库）两行，均未实现**：当前实际接入的
运行时是 ACP（gemini-cli / claude-code）、原生（codex app-server）、CLI（zcode / dsh）与内置引擎
（`builtin`，无进程）。要接这两者需要新增通道驱动，不是改声明就能完成。

### 3.7 CLI 兜底（ZCode）——诚实的能力降级

```yaml
id: zcode
protocol: cli-stdio
launch: { command: zcode, args: ["--headless"] }
capabilities: { plan: unknown, permissionRequest: unknown, resume: unknown,
                images: unknown, streaming: unknown, contextWindow: null }
eventCapabilities: [message_delta, done, error]      # 只声明能稳定拿到的
permission: { channel: none, defaultTimeoutPolicy: reject }
resumeStrategy: process-lifetime
```

驱动约 120 行：stdout 按行读 → 合法 JSON 且命中已知字段则启发式映射，否则整行当 `message_delta.text` 累积；stderr 留末 8KB 供错误详情；exit 0 → `done`，非 0 → `error(fatal)`。**未声明类型在 ingest 处直接丢弃**，因此 UI 不出现空块，整轮自动降级为「仅最终文本 + 原始 stdout 折叠」（P0-05 边界）。

### 3.8 能力探测与降级（C3 落地点）

```
并发探测所有声明（互不阻塞，单项 3s 超时）
  ① detect：spawn versionArgs → 正则取 version → semver 比较 minVersion
  ② health：通道 start + initialize（10s 超时）
     成功 → 能力合并 probed ?? declared ?? 'unknown'，source='probed'
     失败/超时 → healthStatus='unhealthy'，用 declared，source='declared'
```
- `Tri` 三态直接映射 UI 徽标三态（支持/不支持/未知虚线）——**探测失败 ≠ 不支持**。
- 版本低于 `minVersion` → 置灰「需要 ≥ x.y」，绑定时阻止保存。
- 探测结果缓存进 `RuntimeDefinition.capabilities`（JSON），渲染只读缓存，不在渲染时探测。
- 发送前校验 `healthStatus==='healthy' && version>=minVersion`，否则禁用并给改绑入口（P0-02）。

### 3.9 为什么这个抽象不会漏

| 未来接入 | 改哪里 | 核心改动 |
|---|---|---|
| Cline / Copilot CLI / Qwen Code（原生 ACP） | 新增 `declarations/cline.yaml` | **0** |
| ACP v2 新增一种 update（如 diff 预览） | `acp/mapping.ts` 加一个 case | 0 |
| 某 agent 只有私有 HTTP API（如 Aider 新协议） | 新增 `channels/aider/driver.ts`（≈300 行）+ 声明 | 0 |
| 运行时开始支持图片输入 | 声明 `capabilities.images:true` | 0（capabilities 是 JSON 列，无 schema 变更） |
| 某 ACP 运行时权限语义不同 | 声明 `permission.channel` / `protocolOptions` | 0 |

唯一会触及核心的变更只有一类：**新增第 10 种可渲染事件类型**——这本来就是产品语义变更，理应改核心。

### 3.10 契约测试

`fixtures/<adapter>/<scenario>.jsonl` 存**原始协议行**（ACP 的 JSON-RPC、Codex 的 JSONL、ZCode 的 stdout 行），与 `<scenario>.expected.json`（规范化事件序列）成对。Vitest 用 `FakeTransport` 喂给 `ChannelDriver`，断言：① 事件序列深度相等（忽略 ts）；② 产出类型 ⊆ `eventCapabilities`；③ 插入垃圾行后仍不抛错（变异测试）。三个参考通道各 ≥3 场景（正常 / 权限 / 崩溃）。

**没有 `npm run record` 录制脚本**（初稿提过，未落地）：fixture 是手工整理 + 少量真实录制，换样本时直接替换 `fixtures/` 下的文件。

---

## 4. 数据模型

12 张主表 + `permission_grants` + `schema_meta`（共 14 张，见 `core/db/schema.sql`）。全部带 `created_at INTEGER`(epoch ms)。
下面是**初版**表结构；v2/v3/v4 追加的列见文末「迁移 v3 / v4」两节（`bots.provider_id/role/
permission_mode/enabled_skills`、`sessions.workspace_path/provider_id/model/permission_mode`、
`channels.workspace_path`、`memory_entries.scope/channel_id`、`usage_records.cache_reported` 等）。

```sql
bots(id TEXT PK, name TEXT UNIQUE, persona TEXT, avatar TEXT, default_runtime_id TEXT,
     execution_location TEXT, repo_path TEXT, worktree_path TEXT, worktree_state TEXT,
     status TEXT, created_at, updated_at)
runtime_definitions(id TEXT PK, adapter_name TEXT UNIQUE, source TEXT /*builtin|custom*/,
     version TEXT, command TEXT, protocol TEXT, capabilities TEXT /*JSON*/,
     event_capabilities TEXT /*JSON*/, min_version TEXT, health_status TEXT, last_probe_at INTEGER)
runtime_bindings(id TEXT PK, bot_id REF bots, runtime_id REF runtime_definitions,
     location TEXT, worktree_path TEXT, bound_at, unbound_at)
channels(id TEXT PK, type TEXT /*dm|group|task*/, name TEXT, participant_bot_ids TEXT /*JSON*/,
     host_bot_id TEXT, created_at)
sessions(id TEXT PK, bot_id, channel_id, runtime_session_id TEXT, resume_state TEXT,
     status TEXT, process_pid INTEGER, process_started_at INTEGER,
     seq_counter INTEGER DEFAULT 0, started_at, ended_at)
messages(id TEXT PK, session_id, channel_id, turn_id TEXT, role TEXT, content TEXT,
     content_version INTEGER DEFAULT 0, status TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at)
events(id INTEGER PK AUTOINCREMENT, session_id, message_id, turn_id, type TEXT,
     seq INTEGER, payload TEXT /*JSON*/, raw TEXT, created_at)
assignments(id TEXT PK, title TEXT, deliverable TEXT, bot_id, source_channel_id,
     session_id, worktree_path TEXT, status TEXT, queue_pos INTEGER, report TEXT, started_at, ended_at)
memory_entries(id TEXT PK, bot_id, content TEXT, source_session_id, kind TEXT /*manual|summary*/,
     injected INTEGER, version INTEGER, updated_at)
schedules(id TEXT PK, name TEXT, bot_id, channel_id, prompt TEXT, trigger_type TEXT,
     interval_minutes INTEGER, delay_minutes INTEGER, at_time TEXT, next_run_at INTEGER,
     last_result TEXT, last_run_at INTEGER, fail_count INTEGER, enabled INTEGER)
permission_requests(id TEXT PK, session_id, bot_id, turn_id, action TEXT, target TEXT,
     boundary_snapshot TEXT /*JSON*/, boundary_version INTEGER, timeout_policy TEXT,
     status TEXT, held_since INTEGER, expires_at INTEGER, decided_by TEXT, decided_at INTEGER)
usage_records(id TEXT PK, bot_id, runtime_id, session_id, mode TEXT,
     input_tokens INTEGER, output_tokens INTEGER, reported INTEGER, created_at)
permission_grants(id TEXT PK, bot_id, session_id, action_key TEXT, scope TEXT /*session|bot*/,
     expires_at INTEGER, created_at)
```

**关键索引**：`events(session_id, seq) UNIQUE`（会话内分页/虚拟滚动）、`events(session_id, id)`（重连游标）、`events(type, created_at)`（保留期批删）、`usage_records(bot_id, runtime_id, created_at)`（聚合，10 万行 SUM <100ms）、`messages(channel_id, created_at)`（首屏分页）、`permission_requests(status, expires_at)`（超时扫描）、`schedules(enabled, next_run_at)`（调度轮询）。

**seq 双游标**：`events.id`（全局 AUTOINCREMENT）做 SSE 游标，跨会话单调、重连无歧义；`seq` 是会话内计数，由持锁的 `turn-queue` 递增，用于 UI 排序。写入事务里 `UPDATE sessions SET seq_counter=seq_counter+1` 并读回，避免 `MAX(seq)+1` 的并发竞争。

**用量聚合**：不建物化视图，`GROUP BY bot_id, runtime_id` 走覆盖索引。删除 Bot 后 `usage_records.bot_id` 保留（不级联），靠左连接显示「已删除 Bot」。

**保留策略**：`maintenance/retention.ts` 启动时 + 每 24h 执行，按 `created_at < cutoff` 分批 `DELETE ... LIMIT 5000` 循环（避免长事务锁住 WAL）；只影响 `messages/events/usage_records/permission_requests`，`memory` 与 `assignment.report` 不自动删。

---

## 5. 会话与进程生命周期

**决定：一个 Session 一个运行时进程**（不是一进程多会话）。理由：各 CLI 的多路复用语义不一致（并发 prompt 未定义），进程隔离让崩溃只影响一个 Session。代价：新 Session 有 0.5–2s 启动延迟，用「空闲不立即杀、保留 10 分钟」抵消。

```
                  ┌──────── spawn 失败/exit≠0 ────────┐
created → starting → ready → running ⇄ waiting_permission │
                        │        │            │          ▼
                        │        │            └→(超时/退出) failed
                        │        └→ idle ─(10min 空闲)→ reaped(杀进程，留 runtimeSessionId)
                        │               └─(新消息)→ running（进程在则复用，否则 spawn+resume）
                        └→ crashed(exit N) ─(重发)→ starting（新 Session，旧 Session 只读）
任意态 ─(用户结束 / Bot 改绑 / 删除)─→ ended
```

| 转移 | 条件 | 副作用 |
|---|---|---|
| `created→starting` | 首轮消息 | 建 worktree（如需）、`spawn`、记录 pid+startTime |
| `starting→ready` | `initialize`+`newSession` 成功 | 写 `runtime_session_id`，`resume_state='fresh'` |
| `ready→running` | `prompt` 发出 | 建 assistant `message`（status=streaming） |
| `running→waiting_permission` | 收到权限请求 | 写 `permission_requests`、推卡片、起超时定时器 |
| `waiting_permission→running` | 已应答 | 清定时器、写审计 |
| `running→idle` | 收到 `done`/`error` | 收口 message、写 usage、释放会话锁 |
| `idle→reaped` | 10min 无消息且无待批 | `killTree(pid)`，保留 `runtime_session_id` |
| `idle→running` | 新消息 | 进程在则 prompt；已回收则 spawn + `resume` |
| 任意→`crashed` | `onExit` 且非主动 | 未决权限→`invalidated`、Turn 标失败（带 exit code）、写 error |
| 服务重启 | 启动扫描 | `running/waiting_permission` 全置 `failed`，未决权限置 `invalidated`（进程已不存在） |

**resume 与产品层真相（P0-15）**：`messages` 是唯一真相，`runtime_session_id` 只是加速器。新 Session 首轮：支持 resume → 尝试并标 `resumed`；失败/不支持 → `ContextAssembler` 重建（人格 + 注入记忆 + 最近 20 条消息），标 `rebuilt`，发 `meta.session_rebuilt` 驱动 UX 分隔条。`process-lifetime`（ZCode）下进程活着上下文就在，回收后即重建——诚实降级，不向用户报错。

**Windows 进程治理**：`kill-tree.ts` 分平台——POSIX `detached:true` + `kill(-pid)`；Windows `taskkill /pid <pid> /T /F`。pid 记入 `pid-registry` 与 `sessions.process_pid + process_started_at`；启动时比对真实进程创建时间，避免 PID 复用误杀。`SIGINT/exit` 统一清扫，`windowsHide:true`。

**hold 的进程策略**：挂起期间**保活**（进程阻塞在 stdio 读，RSS 20–40MB）。24h 上限由 `sweeper.ts` 每 5min 扫 `expires_at`，超时转拒绝并杀进程。同时挂起数 >5 时最老的转「已失效」——防僵尸进程拖垮本机。

**并发与隔离**

| 场景 | 机制 |
|---|---|
| 同一 Bot 双标签页发消息（P0-15） | `session-lock.ts` 内存互斥 + `sessions.status` 落库；第二个请求返回 `202 {queued:true, position}`，前端显示「排队中」，前一 Turn 结束自动放行；重启后锁由 `status` 重建 |
| 群聊多 Bot 并发 | 默认**顺序执行**（03-decisions Q3）：`dispatcher` 串行调度，同一 worktree 同时只有一个写者；显式 @ 多个 Bot 时并行，并行期间的写类工具由**渠道级写锁**（`core/group/write-lock.ts`）串行化 —— 同渠道的 write/exec/network/admin 排队执行，读类不排队，第二个写者能看到第一个的结果（G7） |
| 文件冲突（C7） | 优先 worktree 隔离；`local` 目录多 Bot 靠顺序执行 + 每轮前后 `git status --porcelain` 快照对比，报告列出「本轮改动文件」 |
| worktree 生命周期 | 创建：Bot 首次 Session / 首个 Assignment 时 `git worktree add`；复用：同 Bot 后续 Session 复用同一路径（P0-13）；Assignment 用独立子 worktree 保证不干扰主会话；清理：删除后保留 7 天再提示，**永不自动删用户文件** |
| Assignment 队列 | 同 Bot 最多 **1 个**执行中（与 PRD P0-07 对齐：local 模式下并发写同目录有真实冲突风险），队列上限 5，超出 409；`queue_pos` 持久化，重启后按序恢复 |

---

## 6. 权限系统

**判定顺序：先边界，后运行时，最后用户。**

```
运行时抛出请求
 ① 归一化：action ∈ {write, read, exec, network}（+ 管理员工具的 admin）；target 解析为绝对路径
 ①' 四档权限模式在边界之前裁决（R5）：
      plan   → 读自动批准；写类直接拒绝（工具在注册表里已裁掉，这里是兜底）
      full   → 绕过边界，全部批准并写审计（mode:full）
      auto   → 边界内 **write** 自动批准并写审计；shell/network/admin 仍走下面流程
      confirm→ 不参与，直接走下面流程
 ② 边界判定（用 boundary_snapshot + version，不受后续修改影响）
      越界 → 直接 deny 应答运行时 + 写审计 + 推「超出 Bot 边界」（不弹卡、不占 120s）
 ③ 授权命中：preauth 且动作 ∈ 预授权集合 → 自动批准 + 审计
      或 60s 内同 action_key 已有 grant（session/bot 域）→ 自动批准 + 审计
 ④ 生成卡片，按 timeout_policy 计时
```

**auto 档口径（R5 方案 B，2026-10-28 定稿）**：越界写直接拒绝、**不弹卡** —— auto 的语义是
「别烦我」，弹卡等于退回 confirm。需求与 UX 文案已按此口径改齐。

**路径解析与目录穿越防护**（`permissions/resolver.ts`）：

1. `path.resolve(sessionCwd, raw)`；结果非绝对路径 → 拒绝（P0-09「无法解析即拒绝」）。
2. 逐段向上找最近**存在**的祖先，`fs.realpathSync.native()` 解符号链接，再拼回未存在段。
3. Windows：先剥离 `\\?\` 前缀、拒绝盘符相对路径（`C:foo`）与 UNC，再 `toLowerCase()` 比较。
4. `isInside(root, t)`：`t === root || t.startsWith(root + sep)`，`..` 无法逃逸。
5. 允许目录在保存时也做 realpath 归一化；`write` 额外检查父目录可写。
6. shell 动作**不做命令解析**（不可靠）：边界只有 `allowShell` 布尔，完整命令交给人在卡片上判断——不写一个会被绕过的正则。

**三档超时状态机**

```
pending ──approve/deny/remember──→ decided
   ├─ reject, 120s ─────────────→ denied_timeout（审计「超时自动拒绝」）
   ├─ hold ─────────────────────→ held（无倒计时，记 held_since）
   │     ├─ 用户决策 ───────────→ decided
   │     ├─ 24h ────────────────→ denied_hard_timeout（审计「挂起超时」）
   │     └─ 进程退出 ───────────→ invalidated（不占满 24h）
   └─ 任意 pending ──进程退出───→ invalidated
```
`timeout_policy` 创建时按来源自动判定：交互 Turn → `reject`；Assignment / 定时任务 → `hold`；Bot 开启「写操作自动批准」→ 边界内走 `preauth`，边界外仍按来源。

**审计写入时机**：`decided` / `denied_timeout` / `denied_hard_timeout` / `denied_boundary` / `invalidated` / 自动批准，同一事务内写 `permission_requests` 终态 + `events`（type=permission_request，payload 含 decision）。无删除路由，只导出。

---

## 7. 流式传输与前端状态

**推送**：`GET /api/stream?sessionId=` 走 SSE，`id:` = `events.id`。客户端 `EventSource` 自动带 `Last-Event-ID`；服务端先查内存环形缓冲（每会话最近 500 条），未命中回退 `WHERE session_id=? AND id>? ORDER BY id`。心跳 15s（注释行）。

**SSE 封装**：`useSseStream(sessionId)` composable 统一管理 `EventSource`、`Last-Event-ID`、重连退避（1s→30s 指数退避 + 抖动）、按 `event.id` 去重、45s 心跳超时；组件卸载时 `onUnmounted` 自动 close，避免多标签页泄漏连接。

**断线重连不重复（P0-04）**，三条规则：

1. 客户端按 `event.id` 去重，重复投递直接丢弃。
2. assistant 正文的**权威副本是 `messages.content`**，不是事件累积。服务端每 250ms 或每 2KB 把增量 flush 进 `content` 并 `content_version++`。
3. 重连时：先 `GET /messages?channelId=&after=<最后已知 messageId>`，对 `content_version` 更大的消息用服务端文本整体替换本地文本；再回放 `id > lastEventId` 的事件。消息身份由 `messageId` 保证，不会出现重复气泡。

**Pinia store 分域**：`bots`、`channels`、`runtimes`、`providers`、`mcp`、`skills`、`setup`（初始化引导状态）、`sessions`（当前会话与消息）、`events`（按 turnId 索引的事件表）、`permissions`（待批与已决）、`ui`（面板开合、主题、toast）。REST 结果落对应 store，SSE 只做增量合并；不引入 TanStack Query，避免两套缓存语义。

**性能关键**：事件以 20–50 条/秒追加，**不能用 `reactive` 深代理整个事件表**。
- `events` store 用 `shallowRef<Map<turnId, EventRow[]>>`，Map 内原地 push 后手动 `triggerRef(events)`；仅 Turn 增删时重建 Map。
- 消息正文用 `shallowRef` 持有 `message.content`，流式 flush 时按 250ms/2KB 整体替换字符串，不逐字 `+=`。
- 组件用 `computed(() => events.value.get(turnId) ?? [])` 只订阅自己那个 Turn，Turn 内按 `event.id` 做 key。
**虚拟滚动**：`@tanstack/vue-virtual`（与 React 版同源，API 类似），item 粒度 = 折叠 Turn 一行 / 展开 Turn 内单条事件，仅渲染可视区 ±50。

---

## 8. 安全

| 面 | 做法 |
|---|---|
| 本地 token | `crypto.randomBytes(32).toString('base64url')` 写入 `~/.agentbot/token`，`chmod 0600`（Windows 用 `icacls` 去继承只授当前用户，失败记 warning）；控制台打印登录页地址 `http://127.0.0.1:<port>/login`，并附一条 `?t=<token>` 链接（打开一次即种持久 cookie） |
| 登录页 | `GET /login` 服务端渲染（`http/login.ts`），免鉴权、`no-store`、`referrer-policy: no-referrer`、不回显任何 token（连脱敏预览都不显示）；`POST /login` 校验后 303 回 `next`。为什么不放 Vue 路由页：鉴权钩子覆盖所有路径（含静态资源），未登录时 SPA 的 `index.html` 与 JS 包都拿不到，前端路由页没机会渲染 |
| 会话凭据 | 登录成功或首次带有效 `?t=` 访问后种 `agentbot_token`：**HttpOnly + SameSite=Strict + Path=/ + Max-Age=30 天**（持久，重开浏览器仍在）。`Secure` 在 HTTPS 或 `NODE_ENV=production` 时自动加，可用 `AGENTBOT_COOKIE_SECURE=1\|0` 强制开关 —— 本地 http 加 Secure 会让浏览器丢弃 cookie（登录看似成功、刷新又回登录页）。`?t=` 由前端 `history.replaceState` 立即抹除 |
| 凭据优先级 | 服务端 `tokenCandidates()` 返回 `?t=` → cookie 两个候选，**逐个校验、任一通过即放行**：前端 sessionStorage 里残留的旧 token 不会把有效 cookie 拖成 401。登录页反过来以 cookie 优先（有效 cookie 直接放行），并在页面脚本里清掉前端残留副本 |
| `next` 校验 | 只接受站内绝对路径（拒绝 `//evil.com`、`\`、CR/LF）；剥掉 `?t=`；拒绝指回 `/login` 与 `/logout`（防开放重定向与回跳死循环） |
| 登出 | `POST /api/auth/logout`（204，清 cookie，前端按钮用）与 `POST /logout`（303 回登录页，无 JS 兜底），**都免鉴权** —— 只删凭证、不读业务数据 |
| 401/429 | 鉴权前置钩子；`/api/*` 与 fetch/EventSource 失败返回 `401 {"error":"unauthorized"}` 无业务字段；浏览器导航（`Accept` 含 `text/html` 且非 `/api/*`）改为 302 到 `/login?next=<原路径>`；按来源计数，10 次失败 → 60s 内 `429`（人读的请求回登录页 + `retry-after`，程序读的回 JSON）；重置 token 时 `closeAllStreams()` 断开所有 SSE |
| 不代管凭据 | 从不读取/存储/记录用户 API Key。子进程继承 `process.env`（用户自己的环境，不落库）。P1-01 自定义 env 写 `~/.agentbot/secrets.json`（0600），API 只返回 `{key, set:true}`，日志全局脱敏 `/(key\|token\|secret\|authorization)/i` |
| 命令注入 | 一律 `spawn(cmd, args, {shell:false, windowsHide:true})`，args 来自声明数组，**永不字符串拼接**。自定义命令串用白名单分词器（拒绝 `\| & ; > < $ ( ) \`` 与换行） |
| 越权读写 | §6 路径解析 + 边界；服务自身只读写 `~/.agentbot/` 与用户显式允许的目录 |

---

## 9. 关键风险与取舍

| # | 风险 | 影响 | 缓解 | 不能缓解的后果 |
|---|---|---|---|---|
| 9.1 | **ZCode headless 无公开 schema** | CLI 通道可能只有纯文本，9 类实际只有 3 类 | 掩码 + 行级启发式 + 「仅最终文本 + 原始 stdout」降级；契约测试锁住「未知行不崩」 | ZCode Bot 退化为黑盒文本 agent，无工具/计划可视化 |
| 9.2 | **Windows ConPTY / 非 TTY** | 某 CLI 检测到非 TTY 会改格式或拒跑 | 首版全走管道，启动前用 `--version`/`initialize` 验证；`protocolOptions.needsPty` 预留 | 需引入 `node-pty`（原生编译），S1 ≤60s 受威胁 |
| 9.3 | **ACP v2 演进** | `session/update` 改名会让所有 ACP 运行时同时失效 | 映射集中在一个文件；未知 discriminator 降级 `meta.unknown`；fixture 覆盖当前版本 | 新版需一次集中升级，属可接受维护成本 |
| 9.4 | **掩码导致 UI 分支爆炸** | 组合式渲染路径，测试矩阵失控 | UI 只按 `eventCapabilities` 做**开关**，禁止 `if adapterId`；9 类渲染器互不依赖 | 若同类事件字段差异大，须在 mapper 补齐，不得在 UI 加分支 |
| 9.5 | **worktree 磁盘占用** | 每 Bot + 每 Assignment 一个，累积 GB 级 | 保留 7 天后提示清理，不自动删；设置页显示总占用 | 用户遗忘则长期占用磁盘 |
| 9.6 | **多进程内存** | 10 个 Bot 同时跑约 0.5–1GB | 空闲 10min 回收；hold 并发上限 5；群聊默认顺序 | 8GB 机器跑 5+ Bot 会吃紧 |
| 9.7 | **resume 语义不一致** | 可能「返回成功但上下文是空的」 | 不信任返回值，重建路径始终可用；比对消息数与估算 token，异常时改标 `rebuilt` | 用户看到「已续接」但上下文变短 |

---

## 10. 实现顺序建议

| 阶段 | 模块 | 依赖 | 可并行 |
|---|---|---|---|
| M1 | 骨架：config/db/migrate/token/auth/静态服务 | — | — |
| M2 | 事件模型 + ingest + SSE + messages/events repo | M1 | 与 M3 |
| M3 | Vue 前端骨架：`main.ts` / `router` / `App.vue` / 引入 tokens / `BotsPage` + `ChatPage` 壳 | M1 | 与 M2 并行 |
| M4 | **ACP 通道** + `gemini-cli.yaml` + 探测 + 最小 Turn（打通 S4 与 P0-01/02/04/05） | M2 | — |
| M5 | 进程 Supervisor + Session 状态机 + resume/重建 | M4 | 与 M6 |
| M6 | 权限：边界解析 + 卡片 + 三档超时 + 审计 | M4 | 与 M5 |
| M7 | 记忆装配 + 上下文预算 + 摘要 | M5 | — |
| M8 | **CLI 通道（ZCode）**，验证降级路径 | M2, M5 | 与 M9 |
| M9 | **原生通道（Codex app-server）** | M2, M6 | 与 M8 |
| M10 | 群聊：主持 Bot 决策 + 顺序派发 + 调用上限 | M4, M7 | — |
| M11 | Assignment：队列、独立 Session、worktree、报告 | M9, M6 | 与 M12 |
| M12 | 定时任务：调度循环、补跑、失败暂停 | M7 | 与 M11 |
| M13 | 用量聚合 + CSV + 保留期清理 + 导出 | M2 | 与 M11/M12 |
| M14 | 设置页、token 重置、全量删除、契约测试补齐 | 全部 | — |

**并行建议**：**M3 可与 M2 并行**（Vue 前端骨架只依赖 M1）；M5/M6、M8/M9、M11/M12/M13 三组可双线；M4 是关键路径——先做它才能验证整个 adapter 抽象是否成立。

---

## 11. 为什么用 Vue 而不是 React

- **用户因素（决定性）**：用户明确说「React 我不是很懂」，要求用国内的 Vue。后续维护者是单人主导，选自己熟悉的框架比追生态潮流重要；Vue 国内主流、中文文档与社区成熟，长期维护成本更低。
- **技术因素**：本项目前端复杂度集中在「长列表 + 流式追加 + 多面板」，没有必须用 React 的场景。Vue 的响应式 + `shallowRef` 手动控制粒度完全够用，`computed` / `v-memo` 能把重渲染限制在单 Turn；React 的并发渲染、Suspense 在本项目用不上。
- **代价与风险**：① AI 聊天组件库在 Vue 侧成熟度略低于 React——TDesign Vue Next 的 Chat 组件可用，但定制深度不如 shadcn 生态；② 虚拟滚动、富文本渲染等库的 Vue 版本通常比 React 晚 1–2 个版本，升级要等依赖；③ 未来若要复用 React 生态的 AI 组件，需要重写而非直接引入。
- **明确不做**：不引入 Nuxt（纯本地 SPA，不需要 SSR/SSG，多一层构建与部署复杂度）；不引入 Element Plus 全套（体积大、默认样式强、定制成本高）。组件库只保留「可选按需引入 TDesign Vue Next 的 Dialog / Dropdown / Tooltip」这一条口子。

## 迁移 v3 与契约变更（2026-10-27）

**迁移 v3**（`core/db/migrate.ts`，全部可空或带默认值）：
`channels.workspace_path`；`sessions.workspace_path/provider_id/model/permission_mode`；`bots.role/permission_mode`；`memory_entries.scope/channel_id` + `idx_memory_scope`；`usage_records.cached_input_tokens/cache_write_tokens/model`。

**契约**：

- `SpawnContext` 增加 `workspacePath / providerId / model / permissionMode`。
- `PermissionAction` 增加 `'admin'`（create_bot）。
- `ToolContext` 增加 `permissionMode`；四档裁决在 `askPermission` 之前完成，plan 同时按模式裁剪工具表。
- 新端点：`PATCH /api/channels/:id`、`PATCH /api/sessions/:id/controls`、`POST /api/sessions/:id/compact`、`GET /api/admin/bots`。
- 记忆装配按 scope 过滤；摘要写入时带 `scope / channel_id`。

**cwd 解析**：`sessions.workspace_path` → `channels.workspace_path` → `bots.repo_path` → `process.cwd()`。内置引擎不使用 worktree；CLI 路径不变。

**并发**：同 Bot 会话并发仍为 1；群聊共用 cwd 时默认由主持人串行派发，显式 @ 多个 Bot 的并行派发由渠道级写锁（`core/group/write-lock.ts`，G7）串行化写类工具。

## 迁移 v4 与新增能力（2026-10-28）

**迁移 v4**（`core/db/migrate.ts`，合并了 18 号 R8 与 19 号 N4 的新列）：

- `usage_records.cache_reported INTEGER NOT NULL DEFAULT 0` —— 缓存字段是否真的上报（历史行回填 0，显示 `—`）。
- `bots.enabled_skills TEXT` —— 启用技能的 JSON 数组；NULL = 全部启用（迁移前的老 Bot 行为不变）、`[]` = 一个都不注入。

**技能（N2 / N3-1 / N4）**

```
core/agent/
  skills.ts             扫描 + mtime 签名缓存 + 按启用列表过滤 + 索引生成
  skills/install.ts     内置技能包安装（幂等、不覆盖用户改动、删了会补装）
  skills/builtin/*/SKILL.md   4 份随代码分发的基础技能
  tools/builtin/list_skills.ts  长尾技能发现（只读，不进系统提示）
```

- 安装：`main.ts` 启动时把内置包写进 `~/.agentbot/skills/`；`POST /api/skills/rescan` 也补装。目录里写 `.agentbot-builtin` 标记，技能页显示「内置」。
- 索引：系统提示只放启用的技能（≤800 字符、≤12 条）；超限或未启用时提示模型用 `list_skills` 发现、`read_skill` 读全文。
- 热插拔：扫描结果按「目录 + 各 SKILL.md 的 mtime/size」签名缓存，文件一变即失效 —— 下一轮对话生效，不需要重启。
- API：`GET /api/skills` 返回 `builtin` 标记；`POST /api/skills/rescan` 额外返回 `installed[]`；`PATCH /api/bots/:id` 接受 `enabledSkills`。

**MCP 热插拔（N3-2）**

`McpManager` 增加运行期 `add / replace / remove`，路由的 POST/PATCH/DELETE 只动受影响的那一个连接（不再全量 reload），其它 server 的工具在切换期间保持可用。`mcp.json` 的 server 支持 `permission: read|write|exec|network`（缺省 exec）；驱动在 plan 模式下按它裁剪 `mcp__*`（R5-c）。

**初始化引导（N1）**

`GET /api/setup/state` 返回 5 步完成度：运行时 / 供应商 / 管理员（必需）与工作区 / 技能（可选）。`needsSetup` 只看必需项；前端挂载后据此跳 `/setup`，每步可跳过，侧栏保留「初始化待完成 N」提示，设置页有常驻入口（可重入）。`POST /api/bots` 支持 `role`，引导可一键建管理员。

**群聊记忆（R3 方案 A）**

`scope='channel'` 的记忆只按 `channel_id` 过滤、不限 `bot_id`：同一群聊里 Bot A 写的群聊记忆，Bot B 也能注入；记忆页用 `sourceBotId/sourceBotName` 标明来源 Bot，同群 Bot 可停用/删除。

**群聊写锁（G7）**

`core/group/write-lock.ts` 按 `channelId` 串行化写类工具（write/exec/network/admin）；读类不排队。锁是进程级单例，通过 `SpawnContext.channelId` 传给内置引擎驱动。单渠道无竞争时只有一次 Map 查找，没有额外延迟。
