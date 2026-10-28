# AgentBot 内置引擎变更影响分析（impact）

> 输入：`.forge/agentbot-06-builtin-engine.md`、`.forge/agentbot-09-change-spec.md`、`.forge/agentbot-08-existing/backend.md`
> 结论：**加法式改动**，不改既有通道协议；风险集中在四处契约扩展、一处迁移、一处无进程生命周期。
> **历史文档（2026-10-26）**：其中「内置工具 8 个」在 2026-10-28 已增至 10 个（+`list_skills`、`create_bot`），
> 设置页也从三个分区扩到八个。当前状态以 README 为准。

## 1. 改动模块

| 模块 | 新增 | 修改 |
|---|---|---|
| 供应商 | `core/agent/provider.ts`、`adapters/providers/{store,http,openai-chat,anthropic,index}.ts`、`http/routes/providers.ts` | `config.ts`（providersPath） |
| Agent loop | `core/agent/{loop,prompt,limits}.ts` | — |
| 工具 | `core/agent/tools/{registry,paths,truncate}.ts`、`tools/builtin/*`（8 个） | — |
| 技能 | `core/agent/skills.ts`、`http/routes/skills.ts` | — |
| MCP | `adapters/mcp/{client,config,manager}.ts`、`http/routes/mcp.ts` | — |
| 内置通道 | `adapters/channels/builtin/driver.ts`、`adapters/builtin-runtime.ts` | `adapters/{contract,factory,custom,registry}.ts`、`core/process/supervisor.ts`、`main.ts` |
| 数据 | 迁移 v2 | `core/db/{schema.sql,migrate.ts}`、`http/dto.ts`、`http/routes/bots.ts`、`http/server.ts`、`http/routes/{index,runtimes}.ts` |
| 前端 | `stores/{providers,mcp,skills}.ts` | `net/{types,client}.ts`、`pages/{SettingsPage,BotsPage,BotDetailPage}.vue` |
| 测试/脚本 | 7 个单测文件、`scripts/smoke-builtin.mjs` | `package.json`（smoke 脚本） |

## 2. 契约扩展（向后兼容）

| 契约 | 变更 | 兼容性 |
|---|---|---|
| `ProtocolKind` | 追加 `"builtin"` | 旧声明/自定义运行时不受影响；`custom.ts` 的 `PROTOCOL_KINDS` 不暴露 builtin，用户不能手动添加 |
| `PermissionChannel` | 追加 `"internal"` | `requiresWorktree()` 只认 `"none"`，内置引擎允许 local；旧通道判定不变 |
| `SpawnContext` | 追加可选 `botId` / `providerId` | 可选字段；ACP/CLI/native 驱动忽略 |
| `bots` 表 | 追加可空 `provider_id` | 迁移 v2；旧行 NULL；旧 INSERT 不写该列仍合法 |
| `BotDto` | 追加 `providerId` | 前端类型同步；旧字段不变 |

## 3. 关键集成点与结论

1. **运行时注册**：`main.ts` 把内置声明加入 `declarationById`，但**过滤出 `probeAll`**；单独用 `persistProbe` 写 ready/unhealthy。`resolveRuntime` 只接受 `health_status === "ready"`，内置引擎额外检查 `listProviders().length > 0`，避免手改文件后状态陈旧。
2. **无进程生命周期**：`supervisor` 已容忍 `pid === null`（不登记 pid registry、kill 跳过树杀、仍会 dispose）。内置驱动**不主动发 onExit**，managed 条目保留到 idle reap / 关服；`dispose` 负责取消本轮、拒绝挂起权限、丢历史。
3. **历史恢复**：`resumeStrategy: "native"`；`resumeSession` 只在内存 history 存在时返回 true，否则 false → supervisor 走 `buildRebuildContext` + `newSession(systemPrompt)`。adapters 不 import `core/db`，边界不破。
4. **权限回传**：驱动 `askPermission` 生成 `builtin_perm_<n>` → `onPermission` → main 的 supervisor listener → `permissions.handle` → resolver 裁决 → `supervisor.respondPermission` → `driver.respondPermission`。与 ACP 同构，零新管线。
5. **事件**：驱动只产 `CanonicalEvent`；`message_delta` 的 start/delta/end 由驱动发，正文由 ingest 追加到 `messages.content`；`tool_call` / `tool_result` / `thought` / `usage` / `done` / `error` 复用现有 payload。
6. **用量**：每次 provider 调用发一条 `usage{cumulative:false}`；orchestrator 收集样本，recorder 按增量求和。
7. **Bot 绑定**：`POST/PATCH /api/bots` 校验 `providerId` 存在；`providerId` 为空回退默认供应商；删除供应商后 `onProvidersChanged` 刷新内置运行时可用性。
8. **边界脚本**：`core/agent/**` 不含被禁协议字符串（`chat/completions` 等只在 adapters/providers）；`adapters/**` 不 import `core/db`。实测 boundaries 通过。

## 4. 风险与取舍

| 风险 | 影响 | 处置 |
|---|---|---|
| 迁移 v2 | 老库升级 | 可空列、PRAGMA 判重、事务内 step+版本；单测覆盖 v1→v2 与重复执行 |
| 无进程驱动不发 onExit | managed 条目留到 idle reap | 与 CLI 不同但可接受；关服 dispose；不影响发送/权限（isAlive 看 managed） |
| MCP 启动连接慢 | 启动最多等 20s/server（并行） | 单 server 失败隔离；状态可重连；后续可改为后台连接 |
| 流式网关不支持 `stream_options` | 流失败 → 降级非流式 | loop 已实现降级；不会丢已产出文本 |
| 工具输出撑爆上下文 | prompt 膨胀 | 统一 64KB/2000 行截断；loop 上下文溢出裁剪重试 |
| 内置引擎允许 local | 模型可直接写用户目录 | 每个写/exec/network 都事前问权限；边界默认只读；`allowDirs` 白名单 |
| 前端供应商明文 | 泄漏 | 后端只回掩码；前端密码框；日志不打印 |
| 既有 7 个 Windows 环境失败 | 无法全绿 | 验收口径改为「不新增失败」；本轮新增 36 测试全绿 |

## 5. 回归验证计划

- 既有契约：`tests/contract/{acp,cli,native}.test.ts` 全绿（不变）。
- 既有单元：ingest/repo/sse/turn/process/permissions/lifecycle/context/group/assignment/http-* 全绿（除基线 7 个环境失败）。
- 新增单元：provider store/protocol、agent loop、tools/paths/truncate/skills、builtin driver、MCP client/manager、builtin runtime/migration。
- 集成：`npm run smoke:builtin`（假 OpenAI 网关 → 建 Bot → 发消息 → 权限卡批准 → 工具落盘 → 事件链）。
- 构建：`npm run build:web` + `npm run build:server`。
- 边界：`node scripts/check-boundaries.mjs`。
