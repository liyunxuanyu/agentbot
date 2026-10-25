# AgentBot 内置引擎技术方案（N1–N6）

> 输入：`agentbot-05-architecture.md`（现有架构）、用户裁定（并存 + 自带工具/MCP/技能 + 全协议 provider）。
> 本文只解决「怎么搭」，业务实现归 builder。
> 一句话：**新增一个不启动进程的 runtime——agent loop 跑在服务进程内，直连模型 API；工具调用发生在自己的循环里，所以每个写/执行都能事前拦下来问你。**

---

## 1. 为什么做（实测依据）

| 指标 | ZCode CLI（现状） | pix-deepseek 直连（实测） |
|---|---|---|
| 一轮耗时 | 13–16s（整段返回，无流式） | 非流式 4.2s；流式首 token 4.4s / 总 5.5s |
| prompt token | 68,104（ZCode 自带系统提示） | 324 |
| 权限拦截 | 无（`permission.channel: none`） | 每个工具调用前由我们裁决 |
| 执行位置 | 被迫强制 worktree | 有真实门禁，`local` 可安全使用 |

provider 能力已实测：`openai-chat-completions` + `tool_calls`（`finish_reason: "tool_calls"`，arguments 为 JSON 字符串）+ SSE 流式 + usage 字段。

**已知坑**：pix 网关会掐掉过长的流式请求 → 流中断必须能降级（见 §8.1）。

## 2. 与现有架构的关系

**加法，不是重写。** 现有三条通道（`acp` / `cli` / `native`）完全不动。内置引擎是第四条通道 `builtin`：

- `SessionHandle.pid` 类型是 `number | null`，`supervisor.ts` 只在 `pid !== null` 时注册进程 → 无进程驱动直接可接
- 权限走**现有** `core/permissions/resolver.ts`：驱动 `onPermission` 上报 → orchestrator 交 resolver → 用户决策 → `respondPermission` 回传。与 ACP 同构，零新管线
- 事件走**现有** `core/events/ingest.ts`：只产出 `CanonicalEvent`
- 记忆/上下文重建/用量落库全部复用现有模块

## 3. 目录与依赖方向

```
src/server/
├─ core/agent/                        ← 不含任何协议字符串
│  ├─ provider.ts         ProviderClient / ChatMessage / ProviderDelta 等类型（纯接口）
│  ├─ loop.ts             agent loop：调模型 → 执行工具 → 回灌 → 循环
│  ├─ prompt.ts           系统提示装配（人格 + 记忆 + 技能索引 + 工具说明预算）
│  ├─ tools/
│  │  ├─ registry.ts      注册表（内置 + MCP 同一张表）
│  │  └─ builtin/         read_file write_file edit_file list_dir grep run_shell web_fetch read_skill
│  ├─ skills.ts           技能扫描、frontmatter 解析、索引生成
│  └─ limits.ts           迭代/工具/输出上限常量
├─ adapters/
│  ├─ providers/          ← 唯一出现线上协议的地方
│  │  ├─ contract.ts      ProviderClient 的实现契约（与 core/agent/provider.ts 对齐）
│  │  ├─ openai-chat.ts   POST {baseUrl}/chat/completions（stream + tools）
│  │  ├─ anthropic.ts     POST {baseUrl}/v1/messages（stream + tool_use）
│  │  └─ index.ts         createProvider(config) 工厂
│  ├─ mcp/
│  │  ├─ client.ts        stdio JSON-RPC：initialize / tools/list / tools/call
│  │  └─ config.ts        ~/.agentbot/mcp.json 读写与校验
│  └─ channels/builtin/
│     └─ driver.ts        ChannelDriver 实现（无进程）
└─ http/routes/
   ├─ providers.ts        /api/providers CRUD + test
   ├─ mcp.ts              /api/mcp CRUD + 探测
   └─ skills.ts           /api/skills 列表 + 重扫
```

**依赖方向（硬约束）**：
```
core/agent/loop.ts  ──依赖──> core/agent/provider.ts（接口）
                                       ▲
adapters/providers/*  ──实现───────────┘
adapters/channels/builtin/driver.ts ──构造──> adapters/providers/index.ts
                                    ──构造──> core/agent/tools/registry.ts
```
`core/` 里不出现 `chat/completions`、`anthropic`、`tools/call` 等协议字符串。`adapters/` 不 import `core/db`。

## 4. 关键类型（builder 照抄）

```ts
// core/agent/provider.ts —— 纯接口，无协议细节
export type ProviderProtocol = "openai-chat" | "anthropic-messages";

export interface ProviderConfig {
  id: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number | null;
  supportsTools: boolean;
  supportsStreaming: boolean;
  /** 额外请求头（如某些网关要 x-title）。 */
  headers?: Record<string, string>;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** 已解析的参数对象；解析失败时为 null，rawArguments 保留原文。 */
  args: Record<string, unknown> | null;
  rawArguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** assistant 消息可能带工具调用。 */
  toolCalls?: ToolCall[];
  /** role === "tool" 时必填。 */
  toolCallId?: string;
  /** 提供方回传的推理文本（有则进 thought 事件）。 */
  reasoning?: string;
}

export interface ProviderRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export type ProviderDelta =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "usage"; inputTokens: number; outputTokens: number; reported: boolean }
  | { kind: "finish"; reason: "stop" | "tool_calls" | "length" | "error" };

export interface ProviderClient {
  readonly protocol: ProviderProtocol;
  stream(req: ProviderRequest): AsyncIterable<ProviderDelta>;
  /** 流被掐时的降级路径。 */
  complete(req: ProviderRequest): Promise<{
    text: string;
    reasoning: string;
    toolCalls: ToolCall[];
    usage: { inputTokens: number; outputTokens: number; reported: boolean } | null;
    finish: "stop" | "tool_calls" | "length" | "error";
  }>;
}
```

```ts
// core/agent/tools/registry.ts
export type ToolPermission = "read" | "write" | "exec" | "network" | null;

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** 权限门禁：requiresPermission 非 null 时由 loop 调用，返回是否允许。 */
  askPermission(req: { action: Exclude<ToolPermission, null>; target: string; detail?: unknown }): Promise<boolean>;
  /** MCP 工具调用入口（内置工具不用）。 */
  callMcp?(server: string, tool: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  permission: ToolPermission;
  source: "builtin" | "mcp";
  /** MCP 工具才有的来源标记。 */
  mcp?: { server: string; tool: string };
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolResult {
  ok: boolean;
  output: string;      // 回灌给模型的文本（已截断）
  error?: string;
  truncated?: boolean;
  durationMs: number;
}
```

## 5. 工具集

| 工具 | 权限 | 关键约束 |
|---|---|---|
| `read_file` | read | 只读；超过 64KB 截断并注明「已截断，剩余 N 行」 |
| `write_file` | **write** | 相对路径按 cwd 解析；realpath 后必须仍在 cwd 内（防 `..` 与符号链接逃逸）；自动建父目录 |
| `edit_file` | **write** | 要求 `oldText` 在文件中**唯一**，否则报错让模型重试；不做正则 |
| `list_dir` | read | 深度 1；返回 `name/type/size`；隐藏文件标注 |
| `grep` | read | 优先 `rg`，无 `rg` 则 Node 遍历；上限 200 条匹配 / 64KB |
| `run_shell` | **exec** | 默认超时 120s；输出上限 64KB；取消时树杀（复用 `core/process/kill-tree.ts`）；**cwd 固定为会话 cwd** |
| `web_fetch` | **network** | 仅 GET；超时 20s；HTML 转文本；上限 64KB；拒绝非 http(s) |
| `read_skill` | read | 按 name 读取 `~/.agentbot/skills/<name>/SKILL.md` 全文 |

**路径安全统一实现**（`tools/paths.ts`）：`resolveInside(cwd, p)` → `{ok, abs}`；任何工具都不得绕过。

**输出截断统一实现**（`tools/truncate.ts`）：`truncate(text, {maxBytes, maxLines})` → `{text, truncated, omittedLines}`，并在文本尾部写明省略量——模型需要知道「还有更多」。

## 6. 权限门禁时序（本次核心）

```
loop 收到模型返回的 toolCalls
  for each call:
    tool = registry.get(call.name)
    if (!tool) → tool_result{ok:false, "未知工具"}  → 继续下一个
    if (tool.permission === null || tool.permission === "read")
        → 直接 execute
    else
        allowed = await ctx.askPermission({action: tool.permission, target: describe(call)})
        if (!allowed)
            → tool_result{ok:false, "用户拒绝了这个操作（或超出 Bot 边界）。请换一种做法，或直接说明需要什么权限。"}
        else
            → execute
    → 把 ToolResult 作为 role:"tool" 消息追加进 history
    → 发 tool_call / tool_result 事件
  回到循环顶部，把 history 再交给模型
```

`askPermission` 的实现（driver 侧）：

```ts
// 1) loop 调 askPermission → driver 生成 requestId，存 pending Promise
// 2) driver 触发 onPermission 回调（与 ACP 完全同构）
// 3) orchestrator 已把 onPermission 接到 resolver.handle(...)
// 4) resolver 内部：越界 → denied；grant 命中 → allowed；否则落 pending + 发事件
// 5) resolver 裁决后调 deps.respond(sessionId, requestId, decision)
//    → driver.respondPermission(h, requestId, decision) → resolve pending Promise
// 6) loop 拿到 boolean 继续
```

**复用现有三档超时**（`permissions/policy.ts`）：交互会话 `reject` 120s、Assignment/定时 `hold` 24h、`preauth` 自动批准。内置引擎不需要新策略。

**模型收到拒绝后的话术**必须可操作，不能是空字符串——否则模型会重试同一个调用直到 `maxIterations`。

## 7. 系统提示与上下文预算

`core/agent/prompt.ts` 组装顺序（总预算 **≤ 4000 token**，按 3.5 字符/token 估算字符上限）：

| 段 | 来源 | 上限 |
|---|---|---|
| 人格 | `bots.persona` | ≤4000 字符（PRD 既定） |
| 记忆 | `core/memory/assembler.ts` | 与人格合计 ≤6000 字符（PRD 既定） |
| 技能索引 | `skills.ts` | 每项 `name + 一行描述`，总量 ≤800 字符 |
| 工具说明 | 由 registry 生成（模型侧 tools 字段，不占系统提示） | — |
| 运行规则 | 固定短文本：工作目录、禁止越出 cwd、遇到权限拒绝怎么办 | ≤300 字符 |

**历史裁剪**：沿用现有策略（超窗口 70% 从最早丢），但内置引擎多一层「工具结果优先截断」——工具输出是最容易爆上下文的部分，见 §5。

**用量**：一次 Turn 可能多次调 provider。**每次调用发一条 `usage` 事件**（`cumulative: false`），由 `usage/recorder.ts` 累加；UI 的「本轮用量」显示合计。这样单次调用异常也能看出来。

## 8. 失败与边界

### 8.1 流被掐（pix 已知问题）
`stream()` 抛错且已产出部分文本 → **重试一次 `complete()`**（非流式）。
- 重试成功 → 用 complete 的结果，发一条 `meta`（`kind: 'unknown_protocol'`, `data: {fallback:'non-stream'}`）便于排查
- 重试也失败 → `error{fatal:true, code:'stream_interrupted'}`，已产出文本保留（P0-04）

### 8.2 provider 429 / 5xx
退避重试 2 次（1s、3s）。仍失败 → `error{fatal:true, code:'provider_unavailable'}`，detail 带状态码。

### 8.3 tool arguments 不是合法 JSON
不中断。`tool_result{ok:false, error:'参数不是合法 JSON，请重新调用并给出合法 JSON'}`，把原文附上。

### 8.4 工具执行抛异常
捕获 → `tool_result{ok:false, error: message}`。**不中断整轮**（模型可换做法）。

### 8.5 达到上限
`maxIterations = 20`、`maxToolCalls = 40`（`core/agent/limits.ts`）。达到时发 `error{fatal:false, code:'max_iterations'}` + `done{stopReason:'end'}`，UI 显示「已达工具调用上限，可继续发消息接着做」。

### 8.6 用户停止
`AbortController.abort()` → 中断 fetch / 子进程 → `done{stopReason:'cancelled'}`，已生成内容保留。

### 8.7 上下文溢出
provider 报 `context_length_exceeded` → 丢掉 history 里最旧的一半（保留 system + 最近 4 条）重试一次；仍失败 → `error{fatal:true, code:'context_overflow'}`。

### 8.8 并发
沿用现有 `session-lock`：同 Session 串行，第二个排队。

### 8.9 会话重建
driver 在内存里保留 history（`resumeStrategy: 'native'` 的产品层实现）。进程重启或 driver 实例丢失 → orchestrator 现有重建路径（`context.ts`）用 DB 里的 messages 重建。**内置引擎的 resume 一定成功**，因为历史在我们自己的库里。

## 9. Provider 配置与存储

`~/.agentbot/providers.json`（权限 0600，复用 `auth.ts` 的 icacls 做法）：

```json
{
  "defaultId": "pix-deepseek",
  "providers": [
    {
      "id": "pix-deepseek",
      "protocol": "openai-chat",
      "baseUrl": "https://api.ai-pixel.online/v1",
      "apiKey": "<不写进日志>",
      "model": "deepseek-v4.1-flash",
      "contextWindow": 1000000,
      "supportsTools": true,
      "supportsStreaming": true
    }
  ]
}
```

REST：
- `GET /api/providers` —— **apiKey 只回 `sk-****abcd` 掩码**，永不回明文
- `POST /api/providers` / `PATCH /api/providers/:id` / `DELETE /api/providers/:id`
- `POST /api/providers/:id/test` —— 发一次最小 chat（无工具，maxOutputTokens=8），返回 `{ok, latencyMs, model, error?}`

**Bot 与 provider 的绑定**：需要 `bots.provider_id` 列。**不改 `schema.sql`**，用迁移：

```sql
-- migration v2
ALTER TABLE bots ADD COLUMN provider_id TEXT;
```

`core/db/migrate.ts` 已支持按版本增量执行，builder 加一条 v2 迁移即可。

## 10. 运行时注册

`main.ts` 注册内置运行时（不进 `declarations/`，它没有可执行文件）：

```ts
{
  id: "builtin",
  displayName: "内置引擎",
  protocol: "builtin",              // ProtocolKind 需扩展
  capabilities: { plan: true, permissionRequest: true, resume: true,
                  images: false, streaming: true, contextWindow: null },
  eventCapabilities: [...9 类],
  permission: { channel: "internal", defaultTimeoutPolicy: "reject" },  // PermissionChannel 需扩展
  resumeStrategy: "native",
  executionLocations: ["local", "worktree"],
}
```

`requiresWorktree()` 只判 `channel === 'none'`，所以内置引擎**允许 local**——这正是用户要的。

## 11. MCP

- 配置 `~/.agentbot/mcp.json`：`{ "servers": [{ "id":"anysearch", "command":"npx", "args":["-y","..."], "env":{}, "enabled":true }] }`
- 客户端（`adapters/mcp/client.ts`）：`spawn` → `initialize`（protocolVersion + clientInfo）→ `tools/list` → 缓存 schema → `tools/call`
- 工具命名 `mcp__<server>__<tool>`，`source: 'mcp'`，**默认权限 `exec`（要问）**——MCP 工具能做的事无法预判
- 启动时机：driver `start()` 时按配置并发连接（单个失败不影响其他，标 `unavailable`）
- 生命周期：随服务进程；关服时 `dispose`
- 健康：`GET /api/mcp` 返回每个 server 的连接状态与工具数；`POST /api/mcp/:id/reconnect`

## 12. 技能

- 目录 `~/.agentbot/skills/<name>/SKILL.md`（与 ZCode 的约定一致，方便用户复用）
- frontmatter：`name`、`description`（必填）；其余字段忽略
- 索引进系统提示：`- <name>: <description 截到 120 字符>`，总量 ≤800 字符
- 完整内容通过 `read_skill` 工具按需读取（避免一次性塞满上下文）
- `GET /api/skills` 列表；`POST /api/skills/rescan`

## 13. 模块拆分与实施顺序

| 模块 | 负责文件 | 依赖 | 可并行 |
|---|---|---|---|
| **N1** provider 层 | `adapters/providers/*`、`core/agent/provider.ts`、`http/routes/providers.ts`、`providers.json` 读写 | — | 先做（其余都依赖它） |
| **N2** agent loop + builtin 驱动 | `core/agent/{loop,prompt,limits}.ts`、`adapters/channels/builtin/driver.ts`、迁移 v2、运行时注册、`ProtocolKind`/`PermissionChannel` 扩展 | N1 | 串行（核心） |
| **N3** 内置工具 + 权限门禁 | `core/agent/tools/**` | N2 | 与 N4/N5 并行 |
| **N4** MCP | `adapters/mcp/*`、`http/routes/mcp.ts`、registry 桥接 | N2 | 与 N3/N5 并行 |
| **N5** 技能 | `core/agent/skills.ts`、`read_skill` 工具、`http/routes/skills.ts` | N2（与 N3 同一 registry，需约定接口） | 与 N4 并行，与 N3 有 registry 交汇 |
| **N6** 前端 | Bot 表单运行时下拉 + provider 选择、Settings 三块（供应商/MCP/技能） | N1 的 API | 可在 N1 后开始 |

**并行约束**：N3 与 N5 都会动 `tools/registry.ts`。约定：N3 负责 registry 本身与内置工具；N5 只**注册**一个 `read_skill`，不改 registry 结构。若同时开工，N5 等 N3 交付 registry 后再接线。

**验收命令（每个模块通用）**
```
npx vue-tsc --noEmit
npx tsc --noEmit
node scripts/check-boundaries.mjs
npx vitest run
```

## 14. 与 PRD 的冲突（建议修订文字）

PRD P0-01 现在写「打开运行时管理页，5s 内列出 PATH 中探测到的 ZCode / Codex / Claude / Gemini / DSH 条目」。内置引擎不是 PATH 里的可执行文件，建议在该条后补一句：

> **内置引擎**：作为第 6 个内置条目常驻列表首位，不参与 PATH 探测；其可用性取决于是否配置了至少一个模型供应商（未配置时置灰，原因「未配置模型供应商」+ 跳转设置）。

P0-02 的能力上报对内置引擎恒为「支持」（除 images），不需要探测。

## 15. 待确认

1. **`bots.provider_id` 迁移**：需要新增迁移 v2。若不允许任何 schema 变更，替代方案是把 providerId 编进 `runtime_bindings.runtime_id`（形如 `builtin:pix-deepseek`）——零迁移但语义脏。
2. **provider 的 apiKey 存明文 JSON 还是用系统凭据库**：现有 `auth.ts` 用文件 + icacls，建议沿用（不引入 keytar 等原生依赖）。
3. **MCP 工具的权限默认值**：本方案取 `exec`（每次都要问）。若嫌吵，可给每个 MCP server 一个 `autoApprove: boolean`。
4. **是否支持图片输入**：本方案 `images: false`。要支持需 provider 层加 multimodal 消息体。
5. **`maxIterations=20` / `maxToolCalls=40`** 是经验值，可按实际调整。
