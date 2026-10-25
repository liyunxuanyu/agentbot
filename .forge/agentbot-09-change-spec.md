# AgentBot 变更规格：内置引擎（N1–N6）

> 模式：change（既有代码库新增功能模块） · 难度：T4 · 日期：2026-10-26
> 输入：`.forge/agentbot-06-builtin-engine.md`、README、`.forge/agentbot-08-existing/backend.md`
> 本文定义「做什么、怎么算完成、明确不做什么」；实现细节以 06 号设计文档与代码为准。

## 1. 目标

在现有三条外部运行时通道（ACP / Codex app-server / CLI）之外，新增**第四条通道 `builtin`**：agent loop 跑在服务进程内，直连模型 API。它必须满足：

- 不启动子进程，`SessionHandle.pid === null`；
- 每个写/执行/联网工具调用**执行前**走现有权限裁决器（边界 → 授权 → 用户）；
- 工具、MCP、技能都可在循环内使用；
- 复用现有事件、用量、记忆、Session、SSE、群聊、任务委派管线，不新增第二条管线。

## 2. 范围（P0）

| 编号 | 能力 | 验收标准 |
|---|---|---|
| B-P0-01 | 供应商配置 | `providers.json` 支持 OpenAI Chat Completions 与 Anthropic Messages；CRUD 接口；apiKey 只回掩码；文件权限 0600 |
| B-P0-02 | 供应商连通性 | `POST /api/providers/:id/test` 发一次最小请求，返回 `{ok,latencyMs,model,error?}`，不泄露密钥 |
| B-P0-03 | 内置运行时注册 | 运行时列表常驻「内置引擎」；不参与 PATH 探测；无供应商时置灰并给出原因；有供应商时 ready |
| B-P0-04 | Bot 绑定 | Bot 可绑定 `providerId`；为空时回退默认供应商；供应商删除后回退默认；无任何供应商时发送被阻止 |
| B-P0-05 | Agent loop | 流式文本、推理文本、工具调用、usage、finish 全链路；最多 20 轮模型调用 / 40 次工具调用 |
| B-P0-06 | 内置工具 | `read_file` / `write_file` / `edit_file` / `list_dir` / `grep` / `run_shell` / `web_fetch` / `read_skill` 八个工具可用 |
| B-P0-07 | 路径安全 | 所有文件工具经 `resolveInside`：拒绝 `..`、外部绝对路径、符号链接逃逸；`run_shell` cwd 固定会话 cwd |
| B-P0-08 | 权限门禁 | write/exec/network 工具执行前调用 `askPermission`；拒绝后回灌可操作话术；只读工具不弹卡 |
| B-P0-09 | 权限复用 | 内置引擎权限走现有 resolver 三档（reject 120s / hold 24h / preauth），不新增策略 |
| B-P0-10 | MCP | `mcp.json` 配置 stdio server；initialize → tools/list → tools/call；工具名 `mcp__<server>__<tool>`，默认权限 exec；单 server 失败隔离 |
| B-P0-11 | 技能 | 扫描 `~/.agentbot/skills/<name>/SKILL.md`；索引 ≤800 字符进系统提示；`read_skill` 按需读全文 |
| B-P0-12 | 设置页 | 模型供应商 / MCP / 技能三个分区；空/加载/错误态齐备；供应商测试、设默认、编辑、删除 |
| B-P0-13 | Bot 表单 | 新建 Bot 选内置引擎时可选供应商；Bot 详情可改绑供应商并显示当前供应商 |
| B-P0-14 | 失败处理 | 流中断降级非流式；429/5xx 退避 2 次；工具参数 JSON 非法回灌原文；上下文溢出裁剪重试；上限非致命收口 |
| B-P0-15 | 回归 | 既有 ACP/CLI/native 契约、HTTP 路由、SSE、权限、worktree guard、boundaries 不回归 |

## 3. 明确不做（本期）

- 图片/多模态输入（`images: false`）；
- MCP 的 HTTP/SSE 传输、resources / prompts / sampling；
- 供应商 apiKey 进系统凭据库（沿用文件 + 0600）；
- 内置引擎的多 provider 负载均衡/自动切换；
- 前端可视化工具调用参数编辑器（只读展示现有事件）；
- 真实模型供应商的 CI 测试（用假网关 + 本地 mock 验证协议）。

## 4. 关键决定

| 决定 | 取值 | 理由 |
|---|---|---|
| 迁移方式 | 迁移 v2：`ALTER TABLE bots ADD COLUMN provider_id TEXT`（可空，不重写旧数据） | 最小侵入；全新库 schema.sql 已含该列，v2 用 PRAGMA 判重 |
| 协议扩展 | `ProtocolKind` 增 `builtin`；`PermissionChannel` 增 `internal` | 联合类型追加，旧声明不受影响；`requiresWorktree()` 只认 `none`，内置引擎允许 local |
| Bot→供应商 | `bots.provider_id`，空则默认供应商 | 符合设计 §9；删除供应商时自动回退，不阻塞发送 |
| 权限请求 id | 驱动生成 `builtin_perm_<n>`，resolver 落库时仍走 `#n` 去重逻辑 | 与 ACP 同构；回传用原始 id |
| 历史恢复 | 内存 history + 重启后 `newSession(systemPrompt)` 重建 | adapters 禁止 import core/db；产品层 messages 表是真相 |
| 流中断 | 已产出文本保留，降级一次非流式；仍失败则 fatal `stream_interrupted` | pix 网关已知会掐流 |
| 上下文溢出 | 丢最旧一半（保留 system + 最近 4 条）重试一次 | 设计 §8.7 |
| MCP 权限 | 默认 `exec`，每次问 | 无法预判 MCP 工具行为 |

## 5. 边界处理

- 供应商文件损坏/不存在 → 空配置 + 警告，不阻断启动；
- 供应商 4xx（非 429）不重试，避免无意义等待；
- MCP 单 server 连接失败 → `unavailable` + 错误尾窗，其它 server 正常；
- 技能 frontmatter 缺失 → 用目录名 + 首行描述兜底；
- 工具输出统一 64KB / 2000 行截断，并在尾部注明省略量；
- 权限挂起期间 Session 保活；进程退出/关服时挂起请求转失效；
- 用户拒绝后话术明确要求「换做法或说明需要什么权限，不要重复同一调用」。

## 6. 验收命令

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vue-tsc/bin/vue-tsc.js -p tsconfig.json --noEmit
node scripts/check-boundaries.mjs
node node_modules/vitest/vitest.mjs run
npm run build:server && npm run build:web
npm run smoke:builtin
```

基线口径：改动前 329 通过 / 7 失败（Windows 环境假设）。本次验收要求「新增测试全绿且不新增失败」；最终 365 通过 / 7 失败。
