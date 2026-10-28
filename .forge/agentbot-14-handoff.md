# 交接：会话控制 / 记忆隔离 / 管理员 Bot

> 写于 2026-10-27。给「换一台设备接着做」的人看：现状、要做什么、按什么顺序、哪里会踩坑。
> 口径源头是 [`agentbot-11-requirements-align.md`](agentbot-11-requirements-align.md)；本文是执行视角的拆解。
> **历史文档**：本文的「现状」只覆盖 2026-10-27 那一轮。2026-10-28 之后又落地了
> 18 号 7 条缺口、19 号四条需求与登录页/持久 cookie，当前状态请看 README 与
> [`docs/memory/agentbot-project-state.md`](../../docs/memory/agentbot-project-state.md)。

## 1. 现在在哪

| 项 | 状态 |
|---|---|
| 分支 | `continue-dev` |
| 已完成 | M1–M14 全部 P0、内置引擎 N1–N6、三轮试用修复、5 个交互问题、消息顺序 bug、grep 路径 POSIX 化 |
| 本轮 | **已完成并验收**（迁移 v3 → M1/M2/M3/M5），证据见 [`agentbot-15-change-log-session-control.md`](agentbot-15-change-log-session-control.md) |
| 待办 | 无。本文保留作实现记录与验收清单 |

上一轮遗留的两个环境性结论，别再重查：

- 回答慢不是产品问题：ZCode 每轮自带 68k prompt token，单跑 `-p "回答一个字：好"` 也要 14–16 秒。
- `%TEMP%` 和家目录都在一个 git 仓库里，涉及「往上找祖先仓库」的测试要用 `it.skipIf`，别用 `GIT_CEILING_DIRECTORIES`（会破坏同文件另一条测试）。

## 2. 本轮要做什么

用户原话五条 + 补充三条，拆成 R1–R8，验收锚点见 [`agentbot-11`](agentbot-11-requirements-align.md) §4。

| 编号 | 需求 | 一句话验收 |
|---|---|---|
| R1 | 创建 Bot 不要求项目地址 | 内置引擎 Bot 不填路径能建、能立刻聊 |
| R2 | 会话/群聊指定工作区 | 会话头部可改；不填走回退链；路径坏了明确报错 |
| R3 | 记忆按会话隔离 | 同一 Bot 在 A 会话的记忆不出现在 B 会话 |
| R4 | 会话内切模型 | 供应商 + 模型两级；只影响后续轮次 |
| R5 | 会话内切四档权限 | 输入区常显胶囊，切换立即生效 |
| R6 | 管理员 Bot | `role=admin` + `create_bot` 工具，可多个 |
| R7 | 上下文压缩 | 流内可见标记、可手动触发、阈值可配 |
| R8 | 缓存命中率 | `usage_records` 记缓存 token，`/usage` 展示 |

## 3. 已拍板（不要重新讨论）

- **Q15 工作区**：会话/群聊级（`channels.workspace_path`），群聊共用；Bot 的 `repo_path` 降级为可空「默认工作区」。
- **Q15 补充**：同一 Bot 在不同会话/群聊的记忆必须隔离；要上下文压缩；要缓存命中率。
- **Q16 管理员**：普通 Bot + `role='admin'`，可多个，可删可改名；首次启动若已配模型就种一个。
- **Q17 四档**：confirm（默认）/ auto（边界内写自动批 + 审计）/ plan（只读）/ full（绕过边界但写审计）。
- **Q18 模型切换**：供应商 + 模型都可切；仅内置引擎；跨协议提示建议新开会话。
- **Q19 缺口默认值**：`agentbot-11` §6 的 G1–G10，实现时按它走，冲突先改文档。

## 4. 范围边界（重要）

**只做内置引擎**。ACP / Codex native / CLI 兜底三条通道本轮完全不动：

- 它们的 Bot 创建仍然要求 `repoPath`（`routes/bots.ts:205,274` 保持原样）。
- 它们的模型与权限控件在前端显示禁用态，tooltip 说明「该运行时由 CLI 自身管理权限」。
- 内置引擎没有 worktree，工作区就是进程 cwd；`assignment/worktree.ts`、`process/supervisor.ts` 的 cwd 逻辑不动。

## 5. 执行顺序

```
Wave 0  地基：迁移 v3 + 共享类型 + DTO（串行，一个人做）
   ↓
Wave 1  四模块并行（文件归属互不重叠）
   M1 工作区与记忆隔离   M2 模型与权限模式   M3 管理员 Bot   M5 前端
   ↓
Wave 2  集成 + 三路独立验收（工作区/记忆、模型/权限、管理员/前端）
   ↓
文档同步：PRD / UX / 架构 / README / docs/memory
```

工作流草稿在 [`.forge/workflows/session-control-admin-bot.dwf.ts`](workflows/session-control-admin-bot.dwf.ts)，用 `CreateWorkflow` 的 `path` 提交即可（不要内联，pix 网关会掐长流式请求）。

## 6. 模块待办清单

### Wave 0 地基（串行）

- [ ] `src/server/core/db/migrate.ts` 加 v3：执行第 7 节 SQL
- [ ] `src/server/core/db/schema.sql` 同步新列（全新库直接建对）
- [ ] 共享类型：`SpawnContext` 增加 `workspacePath? / providerId? / model? / permissionMode?`
- [ ] `PermissionAction` 增加 `'admin'`
- [ ] DTO：`SessionDTO`、`ChannelDTO`、`BotDTO` 带新字段
- [ ] 迁移单测：v2 库升 v3 后数据不丢、默认值正确

### M1 工作区与记忆隔离

独占文件：`core/repo/memory.ts`、`core/orchestrator/*`、`http/routes/channels.ts`、`http/routes/bots.ts`

- [ ] cwd 解析顺序：`sessions.workspace_path → channels.workspace_path → bots.repo_path → process.cwd()`
- [ ] `PATCH /api/channels/:id { workspacePath }`，用 `validateWorkingDir` 校验（存在/是目录/可写，不要求 git）
- [ ] 群聊所有 Bot 共用渠道工作区
- [ ] `memory_entries` 加 `scope` + `channel_id`；注入与摘要按作用域过滤
- [ ] 历史记忆回填 `scope='bot'`（默认值已覆盖，确认迁移后行数不变）
- [ ] 上下文压缩：70% 阈值、手动端点、`meta.compaction` 事件（UI 归 M5）
- [ ] Bot 创建 `repoPath` 可选（内置引擎）
- [ ] 单测：cwd 优先级、记忆隔离、压缩触发与裁剪量

### M2 会话内模型与权限模式

独占文件：`adapters/channels/builtin/driver.ts`、`adapters/providers/store.ts`、`adapters/contract.ts`、`core/agent/{loop,prompt,limits}.ts`、`core/agent/tools/registry.ts`、`core/permissions/{policy,resolver,boundary}.ts`、`http/routes/permissions.ts`

- [ ] 会话级模型覆盖：`sessions.provider_id / model` 优先于 Bot 默认值；**每次 prompt 读取**，不要固化在 `newSession`
- [ ] 四档裁决插在 `ToolContext.askPermission` **之前**（唯一入口，见 `core/agent/tools/registry.ts:20-30`）
- [ ] confirm：沿用现有「边界 → 授权 → 用户」
- [ ] auto：边界内写自动批 + 审计；`shell/network` 仍问
- [ ] plan：写类工具从 tools 列表裁掉（不是调用时才拒），模型收到「当前是计划模式，只能读取」
- [ ] full：绕过 Bot 边界，全部执行但逐条写审计
- [ ] 生成中切模式：只影响未裁决的调用；切 plan 时把挂起写请求置 `rejected`
- [ ] `PATCH /api/sessions/:id/controls { providerId?, model?, permissionMode? }` + 审计
- [ ] 跨协议切换不静默转换，返回「建议新开会话」
- [ ] 单测：四档 × 四类动作矩阵、auto 审计、plan 工具裁剪、full 边界绕过、模型热切换

### M3 管理员 Bot

独占文件：新建 `core/bots/create.ts`、`core/agent/tools/builtin/create_bot.ts` + `index.ts`、`main.ts`（种子）、`http/routes/admin.ts`

- [ ] 创建逻辑从路由抽到 `core/bots/create.ts`，路由与工具共用同一份校验
- [ ] `create_bot` 工具：参数 `name / persona / runtimeId / providerId / workspacePath?`，权限标 `'admin'`，每次创建走确认 + 审计
- [ ] 种子：`bots` 表为空 **且** 至少有一个 provider 时，种一个 `role=admin` 的 Bot；没有 provider 跳过并写日志
- [ ] `GET /api/admin/bots`、`PATCH /api/bots/:id` 支持 role 切换 + 审计
- [ ] 单测：create_bot 走确认、种子只执行一次、role 切换

### M5 前端

独占文件：`src/web/**`

- [ ] 权限模式胶囊：输入区左侧，8px 语义点 + 模式名 + `chev`；下拉四项带说明；`Shift+Tab` 循环；切换不二次确认
- [ ] 群聊里作用于当前展开的 Bot，菜单首项「应用到本群全部 Bot」
- [ ] 切 plan 时把挂起的写类权限卡置 rejected 并插系统块
- [ ] 非内置引擎：禁用态 + tooltip
- [ ] 会话设置：工作区路径（可改）+ 模型两级下拉（供应商 → 模型）
- [ ] Bot 创建表单：路径字段改为可选「默认工作区」
- [ ] `/usage` 新增缓存命中率列（命中 / 输入，未上报显示 —）
- [ ] 记忆页显示作用域（本会话 / 全局）
- [ ] 四态齐全、暗色 ≥4.5:1、1440/1280/1024/768/375 无横向滚动

## 7. 迁移 v3 SQL（不可逆，逐条确认）

```sql
ALTER TABLE channels ADD COLUMN workspace_path TEXT;
ALTER TABLE sessions ADD COLUMN workspace_path TEXT;
ALTER TABLE sessions ADD COLUMN provider_id TEXT;
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'confirm'
  CHECK (permission_mode IN ('confirm','auto','plan','full'));
ALTER TABLE bots ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('member','admin'));
ALTER TABLE bots ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'confirm'
  CHECK (permission_mode IN ('confirm','auto','plan','full'));
ALTER TABLE memory_entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'bot'
  CHECK (scope IN ('bot','channel','session'));
ALTER TABLE memory_entries ADD COLUMN channel_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memory_scope
  ON memory_entries(scope, channel_id, injected, updated_at DESC);
ALTER TABLE usage_records ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_records ADD COLUMN model TEXT;
```

三处不可逆，做之前逐条确认：迁移 v3、管理员种子、记忆作用域回填（默认 `'bot'`，不改内容）。

## 8. 契约变更清单

| 位置 | 变更 |
|---|---|
| `SpawnContext` | 增加 `workspacePath? / providerId? / model? / permissionMode?` |
| `PermissionAction` | 增加 `'admin'` |
| `ToolContext` | 增加 `permissionMode`（裁决用） |
| `usage_records` | `cached_input_tokens / cache_write_tokens / model` |
| 新端点 | `PATCH /api/channels/:id`、`PATCH /api/sessions/:id/controls`、`GET /api/admin/bots` |

## 9. 新设备开工步骤

```bash
git clone https://github.com/liyunxuanyu/agentbot.git
cd agentbot
git checkout continue-dev
npm install
npm run build && npm run start:local     # 控制台打印登录页地址与带 token 的链接
```

打开 `http://127.0.0.1:8787/login` 输入 `~/.agentbot/token` 里的令牌即可（2026-10-28 起
支持持久 HttpOnly cookie，见 README「登录与登录态」；旧的 `?t=<token>` 链接仍有效）。

> 本文写于 2026-10-27，描述的是**上一轮（会话控制 / 记忆隔离 / 管理员 Bot）**的交接状态。
> 2026-10-28 又完成了 18 号 7 条缺口与 19 号四条需求（初始化引导 / 基础技能 / 热插拔 /
> 技能按需加载），当前状态以 README 与 `docs/memory/agentbot-project-state.md` 为准。

然后按顺序读：

1. `.forge/agentbot-11-requirements-align.md`（本轮口径）
2. `.forge/agentbot-14-handoff.md`（本文）
3. `docs/memory/agentbot-project-state.md`（项目全貌 + 7 处真机坑）

四条门禁（每次改完都跑）：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vue-tsc/bin/vue-tsc.js -p tsconfig.json --noEmit
node scripts/check-boundaries.mjs
node node_modules/vitest/vitest.mjs run
```

端到端冒烟：`node scripts/smoke-builtin.mjs`。

## 10. 已知环境坑（Windows）

- **GitHub 推送要代理**：`git config http.proxy http://127.0.0.1:7890`；`github.com:443` 直连被拦，`api.github.com` 反而通。
- **ZCode 不在 PATH**：`AGENTBOT_BIN_ZCODE="D:/Program software/ZCode/resources/glm/zcode.cjs"`。
- **npm 在 Windows 下 spawn 解析不了**：脚本里用 `node node_modules/...`，别用 `npm run`。
- **pix 网关掐长流式**：单条消息别塞整段脚本，长内容先写文件，工作流用 `path` 提交。
- **apiKey 永不出现在日志/错误/GET 响应**：`GET /api/providers` 只回 `sk-****abcd` 掩码；provider 密钥存 `~/.agentbot/providers.json`，不进仓库。

## 11. 本轮做完的定义

- 四项门禁全绿 + `smoke-builtin.mjs` 通过
- R1–R8 每条都有可复现的验收证据（截图或命令输出）
- 文档同步：PRD 差异表、UX 会话设置、架构契约、README、`docs/memory/agentbot-project-state.md`
- 三路独立验收（工作区/记忆、模型/权限、管理员/前端）没有阻断项
