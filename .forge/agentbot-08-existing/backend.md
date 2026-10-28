# AgentBot 后端集成面现状（backend）

> 只读考古。运行验证：`npx tsc --noEmit` exit 0；`node scripts/check-boundaries.mjs` exit 0（2026-10-26，未安装依赖、未启动服务）。
> 本文只记录现状；每节“gap”对照 `.forge/agentbot-06-builtin-engine.md`。
> **注意：这是 2026-10-26 开工前的快照**，其中「未找到 / 假设不成立」多数已随后落地
> （`/api/providers`、`/api/mcp`、`/api/skills`、`/api/setup/state`、`builtin` 协议与
> `internal` 权限通道、`core/agent/prompt.ts` 等）。当前状态以 README 为准。

## 1. Adapter 契约（contract.ts）

### 现状事实
- `Tri = boolean | "unknown"`（contract.ts:4）。
- `ProtocolKind = "acp" | "codex-app-server" | "opencode-http" | "claude-sdk" | "cli-stdio"`（contract.ts:6-11）；`ExecutionLocation = "local" | "worktree"`（13）。
- `TimeoutPolicy = "reject" | "hold" | "preauth"`（15）；`PermissionChannel = "acp-reverse" | "jsonrpc-approval" | "none"`（17）；`ResumeStrategy = "acp" | "native" | "process-lifetime" | "none"`（19）。
- `LaunchSpec{command,args,env?,cwd?}`（21-26）；`DetectSpec{command?,versionArgs,versionPattern,timeoutMs?}`（28-34）。
- `CapabilitySet{plan,permissionRequest,resume,images,streaming: Tri; contextWindow: number|null}`（36-43）。
- `PermissionSpec{channel: PermissionChannel; defaultTimeoutPolicy: Exclude<TimeoutPolicy,"preauth">}`，即只能是 `reject|hold`（45-48）。
- `AdapterModes{headless: boolean; multiplierHint?: number}`（50-54）。
- `AdapterDeclaration` 精确字段：`schemaVersion:1`、`id`、`displayName`、`protocol`、`launch`、`detect`、`minVersion?`、`capabilities`、`eventCapabilities: EventType[]`、`permission`、`resumeStrategy`、`executionLocations`、`modes?`、`protocolOptions?: Record<string,unknown>`（60-77）。
- `HealthStatus = "healthy" | "unhealthy" | "unprobed"`（79）；`ProbeResult{capabilities, source:"probed"|"declared", version:string|null, healthStatus, detail?}`（81-88）。
- `SpawnContext{cwd,sessionId,env?}`（90-95）；`SessionHandle{sessionId:string; pid:number|null; runtimeSessionId:string|null}`（97-101）。
- `RuntimePermissionRequest{requestId:string; action:"write"|"read"|"exec"|"network"; target:string; detail?:unknown}`（103-109）。
- `ExitInfo{code:number|null; signal?:string; stderrTail:string}`（111-115）；`PermissionDecision = {kind:"approve",scope:"once"|"session"|"bot"} | {kind:"deny"}`（117-119）。
- `ChannelDriver`：`protocol` + `start/initialize/newSession/resumeSession/prompt/cancel/respondPermission/onEvent/onPermission/onExit/dispose`（124-141）；`metaEvent(turnId,kind,data)` 产出 `{type:"meta",turnId,ts,payload:{kind,data}}`（144-146）。

无进程驱动需要满足的既有契约：
- `pid` 允许 null；`initialize` 仍会被 probe 调用并受 10s 超时，必须返回 `ProbeResult`（probe.ts:315-329）。
- 事件必须带 `turnId` 和 `messageId`；驱动从 `getTurnContext(handle)` 取（turn-context.ts:23-35；CLI 示例 cli/driver.ts:268-270）。
- 必须通过 `onExit` 报告退出；supervisor 用 `code===0 && 无活跃 Turn` 判定“预期退出”（supervisor.ts:411, 436）。
- `respondPermission` 必须按驱动自己的原始 requestId 找到 pending（contract.ts:134；resolver 回传时用快照里的 `runtimeRequestId`，resolver.ts:229-235）。
- `dispose` 会被空闲回收调用，即使 `pid===null`（supervisor.ts:263-276, 300）。

### 与 06 的 gap
- **已验证**：`SessionHandle.pid` 可为 null，`ChannelDriver` 方法集、事件/权限/退出回调形状与文档 §2/§6 一致。
- **假设不成立**：`ProtocolKind` 没有 `"builtin"`，`PermissionChannel` 没有 `"internal"`（contract.ts:6-11, 17）；文档 §10 要求的两处扩展均未落地。
- **未找到**：`src/server/adapters/channels/builtin/driver.ts`；`adapters/channels` 下只有 acp/cli/native。唯一 `pid:null` 的驱动是 CLI，但它每轮 spawn 子进程（cli/driver.ts:164-173, 282-289），不是无进程实现。

## 2. 注册与探测（factory / registry / probe / main）

### 现状事实
- `factory.ts` 模块级单例 `acpDriver/cliDriver/nativeDriver`（17-19）；`createDriverFor` switch：`acp→acpDriver`、`cli-stdio→cliDriver`、`codex-app-server/opencode-http/claude-sdk→nativeDriver`，default 用 `never` 穷尽检查（21-41）。
- `registry.ts` 用 zod 校验 YAML：`protocol` 枚举 5 值（22）、`eventCapabilities` 枚举 `EVENT_TYPES`（44）、`permission.channel` 枚举 3 值（46）、`resumeStrategy` 4 值（49）、`executionLocations` 至少 1（50）。`loadDeclarations` 读目录下 `*.yaml/*.yml`、按文件名排序、单文件失败进 `errors` 不抛（88-121）；重复 id 记错（109-112）。
- 内置声明目录 `src/server/adapters/declarations/` 实有 5 个文件：claude-code.yaml、codex.yaml、dsh.yaml、gemini-cli.yaml、zcode.yaml。
- 启动流程：`loadDeclarations()`（main.ts:77）→ `readCustomDeclarations(db)`（84）→ 合并，同名内置优先（85-89）→ 每个声明 `createDriverFor` 组成 ProbeInput（91-94）→ `probeAll`（95）→ `persistProbe`（98-105，`source` 按 `builtinIds` 判定）→ `listRuntimes` 生成启动快照（107-115）。
- `resolveRuntime`：SQL join `bots.default_runtime_id = runtime_definitions.id`（128-135）；声明先查启动表，缺失再 `readCustomDeclaration(db,row.id)` 并回填表（144-151）；`health_status !== "ready"` 返回 null（154-155）；返回 `{runtimeId, declaration, driver:createDriverFor(decl)}`（157）。
- 探测顺序（probe.ts:241-340）：`detectVersion` 先 `resolveCommand`，不存在→`found:false`（94-103）；spawn `versionArgs` 用 `shell:false`（120-124），默认 3000ms（64, 91）；正则取 `groups.version` 或第一个捕获组（179-181）；有 `minVersion` 才比较（192-193）。随后：missing（258-261）→ timeout（263-266）→ 低于 minVersion（268-276）→ launch 命令不存在（278-291）→ 无 driver 只留 unprobed（293-296）→ `start` 10s（298-313）→ `initialize` 10s（315-329）→ `dispose`（337-339）。`probeAll` 用 `Promise.all`，单项异常兜底 unhealthy（360-383）。
- `runtime_definitions` 列：`id` PK、`adapter_name` UNIQUE、`display_name`、`source CHECK(builtin|custom)`、`version`、`command`、`protocol`、`capabilities` JSON、`event_capabilities` JSON、`min_version`、`health_status`、`probe_detail`、`last_probe_at`、`created_at`（schema.sql:12-27）。
- `persistProbe` 用 `INSERT ... ON CONFLICT(adapter_name) DO UPDATE`（probe.ts:469-485）；`id` 与 `adapter_name` 都写 `decl.id`（487-488）；`command` 写 `decl.launch.command`（492）；`health_status` 写 `outcome.availability`（497，即展示层词表）。capabilities JSON = CapabilitySet + `_probe{availability,executable,meetsMinVersion,source,permissionChannel}`（454-464），custom 额外带 `_declaration`（466）。`listRuntimes` 读回时剥掉保留键（600-672），`availabilityOf` 把 `healthy` 映射成 `ready`（678-691）。

### 与 06 的 gap
- **已验证**：factory 只有 3 个驱动、5 个协议映射；registry 的 YAML 校验；probeAll 并发探测；`runtime_definitions` 形状与 upsert 语义。
- **假设不成立**：文档 §10 称 `main.ts` 注册内置运行时对象；实际 main.ts 没有该字面量，声明来源只有 `loadDeclarations()` 与 `readCustomDeclarations()`（main.ts:77, 84-89），两者全部进入 `probeAll`（91-95）。
- **假设不成立**：文档称内置引擎“不参与 PATH 探测”；代码没有按 id 跳过探测的分支。无 detect 命令→`missing`（probe.ts:94-103, 258-261），无 launch 命令→`missing/unhealthy`（278-291）；且 `resolveRuntime` 只接受 `health_status==="ready"`（main.ts:154-155）。因此没有可执行文件的声明无法用于发送。
- **假设不成立/未找到**：zod、factory、custom HTTP 均不接受 `builtin` 协议或 `internal` 权限通道（registry.ts:22, 46；factory.ts:35-39；custom.ts:28-34；routes/runtimes.ts:239-245）。
- **事实**：`ON CONFLICT` 不更新 `source`/`created_at`（probe.ts:475-485），已有行的 builtin/custom 身份由首次写入决定。
- **已验证**：`requiresWorktree()` 只判 `permission.channel === 'none'`（worktree-guard.ts:26-28），所以非 `none` 的新通道不会被强制 worktree；但 DTO 判定用的是缓存里的 `permissionChannel`，该键缺失时为 null，同样不强制（dto.ts:85-87）。

## 3. Supervisor 与 pid===null（process/supervisor.ts）

### 现状事实
- 状态词表：`created|starting|ready|running|waiting_permission|idle|reaped|crashed|ended`（105-114）；`KillReason` 的状态映射：`cancel→idle`、`idle→reaped`、`runtime_switch→ended`、`shutdown→ended`（179-184）。
- `ensure`：disposed 拒绝（643）；并发 ensure 合并（645-646, 688-693）；无 Session 行抛错（649-650）；`resolveRuntime` 失败抛错（652-653）；已有同 runtime 条目直接复用（655-670）；runtime 改绑先 `kill("runtime_switch")` 并清空 `runtime_session_id`、`resume_state='fresh'`（673-684）。
- `spawn`：`resolveSessionCwd` 决定 cwd（504）；`setStatus("starting")`（511）；`driver.start` 失败置 crashed 并抛（514-519）；`managed.set` + `wire`（532-533）；**只有 `handle.pid !== null` 才 `registry.register`**（534）；`initialize` 失败被吞（537）；resume/重建（547-605）；写 `runtime_session_id/resume_state/status='ready'/process_pid/process_started_at`（607-618）；仅当 `resumeState` 变化且非 fresh 时发 meta（620-622）；启动 idle 计时（626）。
- `pid===null` 的 ensure 结果：`process_pid` 写 NULL；不登记 pid registry；其余 resume/newSession/status 流程与有进程驱动相同；返回 `pid:null`（628-639）。
- `pid===null` 的 kill/reap：`kill` 先 `managed.delete`、`held.delete`（288-291）；`pid===null` 时跳过 `killImpl` 与 `registry.unregister`（295-299），但仍 `driver.dispose`（300），并把 `process_pid/process_started_at` 置 NULL、状态写 `KILL_STATUS[reason]`（302-310）。空闲计时到期调用 `kill("idle")`（263-276），因此无进程驱动也会被 `dispose` 回收。
- `pid===null` 的 exit：`onProcessExit` 无条件删 managed/held、unregister（414-422）；`intentional = entry.closing || current !== entry`；`expected = !intentional && code===0 && 无活跃 Turn`（436）；预期退出→status `idle` + 清进程字段（451-464）；否则→status `crashed` + `ended_at`（465-479）；订阅者收到 `crashed = !intentional && !expected`（482-489）。
- `pid===null` 的 cancel：`cancel` 在无 managed 条目时直接 return；有则只调 `driver.cancel`，异常吞掉（703-711）；不杀进程。编排层 1s 后另行 `kill("cancel")`（turn.ts:621-633）。
- `isAlive` 只看 `managed.has(sessionId)`，不看 pid（715-717）；`respondPermission` 在无 managed 条目时返回 false，否则调 `driver.respondPermission`（778-790）。
- resumeStrategy 实际判定：`previousRuntimeSessionId !== null && strategy !== "none" && strategy !== "process-lifetime" && capabilities.resume !== false`（547-552）；`acp` 与 `native` 行为相同，都调 `resumeSession`；成功→`resumed`，失败→日志后转重建（554-563）。
- 状态写入点：`setStatus`（236-243）、`beginTurn→running`（738-743）、`endTurn→waiting_permission（有 held/pending）或 idle`（745-756）、`setHeld(true)→waiting_permission`、`setHeld(false)→running/idle`（762-776）、`finish(crashed)→crashed`（turn.ts:407-417）、`dispose` 全部 `kill("shutdown")`（799-809）。

### 与 06 的 gap
- **已验证**：`pid===null` 不登记 registry（534）；kill 跳过树杀（295-299）；isAlive 看 managed（715-717）；cancel 走 driver.cancel（703-711）；空闲回收仍会 dispose（263-276, 300）。
- **假设不成立/未端到端验证**：文档称“supervisor 只在 pid!==null 时注册进程 → 无进程驱动直接可接”；注册环节成立，但 `ensure` 仍要求 `sessions` 行、可解析的 runtime 且 `health_status==="ready"`（649-653；main.ts:154-155），且不存在任何无进程驱动实现，因此“直接可接”未验证。
- **事实**：无进程驱动若从不发 `onExit`，managed 条目会一直保留到 idle reap 或 `dispose`；若在 Turn 进行中发 `onExit`，即使 code 0 也按 crashed 处理（436）。
- **未找到**：无进程驱动的 `dispose` 实现（需释放内存历史/取消信号等）；`KillReason` 没有“用户结束”值，注释里的“任意态→ended（用户结束）”没有对应枚举（116, 179-184）。

## 4. Turn 调用顺序与接线（orchestrator / turn-context）

### 现状事实
- `start` 顺序：`summarizer.retryPending(botId)`（turn.ts:426-432）→ `resolveRuntime`，失败抛 `runtime_not_bound`（436-439）→ `resolveSessionCwd` 预检，`WorktreeNotReadyError` 转 `worktree_not_ready`（444-451）→ 选/建 Session（453-462）→ 写 user message（468-480，`recordUserMessage===false` 时不写）→ 写 assistant message `status='streaming'`（482-491）→ `lock.tryAcquire`（494）；拿不到则 `lock.wait` 入队并立即返回 `{queued:true,position}`（511-535）；拿到则 `active.set` 并后台 `run`（537-543）。
- Session 选择：显式 `sessionId` 且非 `forceNewSession` 时校验存在（454-457）；否则 `findSessionId` 查同 bot/channel 且状态不在 `ended/crashed/failed` 的最近 Session（187-196），没有则插入 `status='created'` 的新行（198-206）。
- `run`：`sup.ensure(sessionId,{excludeTurnId})`（553）→ `sup.beginTurn` 登记 `turnId/messageId/botId/source` 并置 running（555-561）→ `setTurnContext(handle,{turnId,messageId,botId})`（564-568）→ `driver.prompt(handle,{text})`（571）→ finally 清 turn context；若 prompt 已返回但仍未 settled，合成 `done{stopReason: cancelled|end}`（572-587）。
- 事件接线：orchestrator 向 supervisor 注册 listener（168-181）；`onEvent` 只处理 `active` 中未 settled 的 Turn；`onExit(crashed)` 调 `settleFailure`。`handleDriverEvent`：**丢弃 `permission_request`**（250-255），其余事件补 `botId`（257），以声明的 `eventCapabilities` 调 `safeIngest`（258-266）；`usage` 额外收集样本（267-288）；终态判定 `done` 或 `error.fatal !== false`（292-298）。
- 收口：`settleFromEvent` 按 `done.stopReason` 决定 `done/interrupted/failed`，`messagesRepo.finalize`、`recordUsage`、`summarizer.maybeSummarize`，最后 `finish`（339-365）；`finish` 先 `lock.release` 再 `sup.endTurn` 或 `setStatus("crashed")`（407-417）。`settleFailure` 补一条 `error{runtime_crashed,fatal:true}`、消息置 failed、记用量、摘要，再 `finish(crashed)`（373-405）。
- 权限接线：驱动 `onPermission` → supervisor listener（main.ts:199-227）→ 用 `activeTurn(sessionId)` 取 `turnId/botId/source`，无活跃 Turn 时用 `sessionBotId` 兜底、source 缺省 `interactive`（200-214）→ `permissions.handle`。回传链：resolver 的 `deps.respond`（main.ts:192-193）→ `supervisor.respondPermission`（supervisor.ts:778-790）→ `driver.respondPermission`。orchestrator 本身不处理权限事件。
- `turn-context.ts` 用 `WeakMap<SessionHandle,TurnContext>` 存 `{turnId,messageId,botId}`（23-35），因为契约的 `prompt(h,{text})` 不接受 turnId（contract.ts:132）。
- 取消：排队中的 Turn 直接撤出队列、消息置 interrupted（594-605）；活跃 Turn 先 `sup.cancel`，最多等 1s，仍未 settled 则 `sup.kill("cancel")` 并合成 `done{cancelled}`（612-633）。
- 会话锁：内存 Map，`tryAcquire` 返回 `{ok}` 或 `{ok:false,position}`；`release` 把锁交给队首未取消者；`wait` 返回 `granted` Promise 与 `cancel`；进程级单例（session-lock.ts:55-111, 127-128）。
- 重启/重建触发：服务重启后 `managed` 为空，首次 Turn 走 `spawn`；只有 `runtime_session_id` 非空且策略允许时才 `resumeSession`（547-552）。resume 失败或无 id 时：`sessionHasHistory` 查 `messages` 中 `role='user'` 且排除本轮 turn（334-351），有历史→`buildRebuildContext` 并作为 `newSession.systemPrompt`（576-585, 593-598）；无历史→`buildBootstrapContext` 只带人格+记忆（589-591）。`context.ts`：估算 token 为字符数/2（27-30）；消息窗口默认 20（129）；`contextWindow` 为 null 不做 token 裁剪（167-192）；预算为窗口的 0.7（169）；超预算从最早消息开始丢并写“已省略 N 条”（173-187）；查询按 `created_at DESC,rowid DESC`，再反转（139-153）；记忆装配委托 assembler（86-93）。

### 与 06 的 gap
- **已验证**：Turn 顺序、会话锁、事件/权限接线、1s 后树杀与 `done{cancelled}`、重启后 `ensure→resume→重建` 路径均存在。
- **假设不成立**：文档 §8.9 称“driver 在内存里保留 history（resumeStrategy:'native' 的产品层实现）”；实际 supervisor 在 `resumeSession` 成功后不再注入任何历史（547-563），只有失败/无 id 才用 `context.ts` 重建（572-605）。不存在内置驱动，“内置引擎的 resume 一定成功”未找到实现。
- **事实/推断**：`resumeSession` 只收 `(handle, runtimeSessionId)`（contract.ts:131），且 adapters 被禁止 import `core/db`（check-boundaries.mjs:31）；内置驱动若要在重启后恢复历史，不能直接读 `messages`，只能自持久化或让 resume 失败走 `newSession(systemPrompt)` 重建（推断）。
- **未找到**：`core/agent/{loop,prompt,limits}.ts`、`adapters/channels/builtin/*`、provider loop、`maxIterations/maxToolCalls`、AbortController、工具执行与 askPermission 门禁；文档 §8.1-8.7 的失败处理（stream 降级、429 退避、工具参数 JSON、上下文溢出）均未找到。

## 5. 权限裁决（resolver / policy）

### 现状事实
- 请求/决策字段见 contract.ts:103-119（`requestId/action/target/detail?`；approve scope once|session|bot 或 deny）。
- `handle` 主流程（resolver.ts:434-604）：
  - disposed 直接返回（435）。
  - 同一 Turn 内相同 `requestId` 视为驱动重放：只重发事件、不重复落库（444-451，`findByRuntimeId` 415-428）。
  - 落库 id 用 `uniqueId`，冲突加 `#2` 后缀；原始 id 存进 `boundary_snapshot.runtimeRequestId`（453, 213-221, 477-482）；回传时用 `runtimeRequestIdOf` 取原始 id（229-235）。
  - `readBoundary` 失败（Bot 不存在）→ `rejectOutOfBoundary`（455-472）。
  - `checkBoundary(boundary, action, target, cwd)`（475-476）；`denied` → 写 `denied_boundary`、先落库再 `respond({kind:"deny"})`、发 `boundaryVerdict:"denied"` 事件（484-494, 607-664）。
  - `actionKeyOf` + `decideTimeoutPolicy`（497-503）；`findGrant` 命中→`autoApprove`（505-516）；`preauth`→`autoApprove`（517-527）。`autoApprove` 写 `status='decided'`、`decision='approve'`、`decided_by='system'`，回传 `{kind:"approve",scope:"once"}`（667-711）。
  - 进程已不在→写 `invalidated` 行并发事件，不回传（530-554）。
  - 否则算 deadlines、写 `pending`、发事件、`syncHold`；仅 `reject` 策略挂内存定时器（556-603）。
- `policy.decideTimeoutPolicy`（policy.ts:51-62）：`autoApproveWrite && action==="write" && boundaryVerdict==="allowed"`→`preauth`；`source==="assignment"|"schedule"`→`hold`；其余→`reject`。
- deadlines（policy.ts:72-92）：`reject`→`now+config.timeouts.permissionRejectMs`（120000ms）；`hold`→`now+permissionHoldMaxMs`（24h）且 `heldSince=now`；`preauth`→两者均 null。配置见 config.ts:67-69。
- 超时执行：`reject` 由内存 `setTimeout` 精确触发（resolver.ts:384-400）；`hold` 由 `sweep` 兜底（5min 间隔，policy.ts:207；main.ts:246-255）。`sweepExpired` 顺序：先 `expires_at` 到期（hold→`denied_hard_timeout`，其余→`denied_timeout`），再 `!isSessionAlive`→`invalidated`，最后同时挂起数超 `maxHeldPermissions`（默认 5）时最老的转 `invalidated`（policy.ts:138-204；config.ts:32）。
- 用户决策 `decide`：非 pending 返回 `already_decided`；`remember_session/remember_bot` 先写 grant 再回传（713-736）；回传用 `runtimeRequestIdOf`，approve 固定 `scope:"once"`、否则 deny（738-744）；回传失败（进程已退出）→ 行转 `invalidated` 并返回 `{ok:true,status:"invalidated"}`（747-765）；成功→`decided` + 事件 + `syncHold`（767-785）。
- 回传驱动：resolver 不 import 驱动，`deps.respond` 由 main.ts:192-193 注入 `supervisor.respondPermission`，后者调 `driver.respondPermission`（supervisor.ts:778-790）。
- `source` 来源：`supervisor.activeTurn` 里 `beginTurn` 存入的 `source`；无活跃 Turn 时 main.ts:213 缺省 `interactive`；Turn 输入缺省 `interactive`（turn.ts:466）。
- 失效：`invalidateSession` 把该会话所有 pending 转 `invalidated` 并 `setHeld(false)`（799-837）；进程退出监听在 main.ts:221-226。
- 观察到的细节：`settleBySystem`、`invalidateSession`、`sweep` 发事件时固定传 `boundaryVerdict:"allowed"`（resolver.ts:373, 828, 853），不是原始裁决。

### 与 06 的 gap
- **已验证**：三档策略与数值（120s/24h/preauth）、越界先落库再 deny、grant/preauth 自动批准、超时/失效回传 deny、`respond` 经 supervisor 到驱动，均存在。
- **已验证**：source 按 `interactive/assignment/schedule` 决定 `reject/hold`，`preauth` 只在 `autoApproveWrite && write && allowed` 时成立（policy.ts:51-62）。
- **假设不成立/事实**：policy 注释称“读操作不需要批准，不产生卡片”（policy.ts:49），但 resolver 对 `read` 且 boundary allowed 的请求没有短路，仍会走 `pending` 卡片（resolver.ts:484-603；boundary.ts:258-266 对 read 返回 allowed）。文档 §6 的 loop 对 read 不调 `askPermission`，因此 loop 正确时不会触发；若驱动上报 read，则会弹卡。
- **未找到**：驱动侧 `askPermission` 的 pending Promise 实现、拒绝后给模型的可操作话术、`internal` 权限通道；无内置驱动。
- **事实**：超时/失效事件把 `boundaryVerdict` 固定成 `allowed`（resolver.ts:373, 828, 853），前端若按该字段渲染会看到与终态不符的裁决。

## 6. 事件模型与 ingest（events/ingest / shared/events）

### 现状事实
- 9 类 `EVENT_TYPES`：`message_delta/thought/tool_call/tool_result/plan/permission_request/usage/done/error`（shared/events.ts:8-18）；`MetaEventKind` 6 种：`compaction/session_rebuilt/session_resumed/commands_update/config_update/unknown_protocol`（23-29）；`StoredEventType = EventType | "meta"`（31）。
- payload 精确字段：
  - `message_delta{messageId, phase:"start"|"delta"|"end", text}`（33-37）。
  - `thought{phase,text}`（39-42）。
  - `tool_call{callId,name,kind?,input?,status:"pending"|"running"}`（44-50）。
  - `tool_result{callId,status:"ok"|"error",output,exitCode?,truncated?}`（52-58）。
  - `plan{entries:[{content,status:"pending"|"in_progress"|"done"}]}`，全量替换（60-68）。
  - `permission_request{requestId,action,target,boundaryVerdict:"allowed"|"denied"|"pending"}`（70-80）。
  - `usage{inputTokens,outputTokens,reported,cumulative?}`（82-88）。
  - `done{stopReason:"end"|"cancelled"|"max_tokens"|"error",durationMs}`（90-93）。
  - `error{code,message,detail?,fatal}`（95-101）。
  - `meta{kind,data?}`（103-106）；`CanonicalEvent{type,turnId,ts,payload,raw?}`（125-131）。
- ingest 顺序（ingest.ts:10-21）：① 能力掩码过滤——`isRenderableType(type) && !ctx.eventCapabilities.includes(type)` 直接 `{dropped:true,reason:"not_declared"}`，不落库（53-56）；② meta 不受掩码（54）；③ 字段校验降级（209-343）；④ `message_delta` 在事务内追加 `messages.content`（68-81, 119-158）；⑤ 落库；⑥ 广播（87-90）。
- `message_delta` 的 messageId：payload 里有就用它，否则用 `ctx.messageId`；其余类型一律挂 `ctx.messageId`（100-110）。`phase=end` 时追加残余文本并把消息置 `done`（150-158）。
- 字段降级：每种类型给默认值并记 `warnings`；`degraded = missing.length>0`；`raw` 优先用驱动给的 `event.raw`，否则降级时存原 payload（209-356）。
- usage：ingest 只把每条 `usage` 当独立事件落库（292-300），不做累加。Turn 层收集本轮所有样本（turn.ts:267-288）；`turn.tokens` 只保留**最后一条** `reported:true` 的数值（274-280）。收口时 `usageRecorder.record` 一次性写一条 `usage_records`：增量样本求和；只有累计值时用“本次累计 − 内存基线”；同时有两者以增量为准，差值 >10% 记 warning（usage/recorder.ts:95-146, 153-183；基线 106-131）。
- meta 特判：不受能力掩码；落库但不渲染（`isRenderableType` 133-135）；历史回放与 SSE 都返回 meta（dto.ts:498-532；routes/events.ts 头注释）。
- botId：turn.ts 在 ingest 前给 payload 加 `botId`（257），但 ingest 的 `normalizePayload` 只保留已知字段（209-343），该键会被丢弃；SSE 与历史回放由 dto 的 `createBotIdEnricher` 按 sessionId 重新补（dto.ts:460-478, 517-532）。

### 与 06 的 gap
- **已验证**：9 类 payload 字段、能力掩码丢弃未声明可渲染类型、meta 永不过滤且落库、message_delta 正文累积、usage 逐条落库 + recorder 按增量求和。
- **假设不成立/事实**：文档 §7 称“每次调用发一条 usage 事件（cumulative:false），由 recorder 累加”；recorder 的求和机制成立，但消息行的 `tokens_in/tokens_out` 用最后一条上报样本，不是累加（turn.ts:274-280）；“本轮用量”来自 `usage_records`，不是消息行。
- **未找到**：`unknown_protocol` + `{fallback:'non-stream'}` 的生产者；9 类事件的 builtin 生产者；`max_iterations`/`context_overflow`/`provider_unavailable` 等文档错误码。
- **事实**：ingest 会丢掉 payload 里的额外键（包括 turn.ts 加的 botId），出帧时再补；两条路径依赖 dto 的 enricher 保持一致。

## 7. Schema 与迁移（db/schema.sql / migrate.ts）

### 现状事实
- `schema_meta(key,value)` 存版本（schema.sql:7-10）；`SCHEMA_VERSION = 1`（migrate.ts:14）；`currentSchemaVersion` 缺表/缺行返回 0（50-58）；`setSchemaVersion` upsert（60-64）。
- `STEPS` 只有一步：`version:1, name:"v1 初始 schema（12 张主表 + permission_grants）", run: db.exec(loadSchemaSql())`（72-80）。`migrate` 逐 step 执行，每个 step 与版本写入同一事务（86-105）；全新库无 applied 且版本为 0 时补写版本（99-102）。迁移写法：向 `STEPS` 追加 `{version,name,run}`，run 内执行增量 SQL；schema.sql 全部 `CREATE TABLE IF NOT EXISTS`（schema.sql 全文）。
- `bots` 表列：`id`、`name UNIQUE`、`persona`、`avatar`、`default_runtime_id REFERENCES runtime_definitions(id) ON DELETE SET NULL`、`execution_location CHECK(local|worktree)`、`repo_path`、`worktree_path`、`worktree_state`、`status CHECK(active|archived)`、`allow_dirs` JSON、`allow_shell`、`allow_network`、`auto_approve_write`、`created_at`、`updated_at`（schema.sql:29-47）。**没有 `provider_id` 列**（grep `provider_id|providerId` 无结果）。
- `runtime_definitions`（12-27）、`sessions`（69-84，`resume_state CHECK(fresh|resumed|rebuilt)`，`status` 无 CHECK）、`messages`（86-100，`status streaming|done|interrupted|failed`）、`events`（102-118，`seq` 会话内唯一）、`permission_requests`（170-189）、`permission_grants`（191-200）、`usage_records`（202-214）。
- `runtime_definitions.capabilities` 不是纯 CapabilitySet：还含 `_probe` 与（custom）`_declaration` 保留键（probe.ts:454-467）；`health_status` 列实际存展示层 `availability`（probe.ts:497；listRuntimes 再映射 678-691）。

### 与 06 的 gap
- **已验证**：按版本增量执行、事务内 step+setVersion、`schema_meta` 版本机制。
- **假设不成立**：文档 §9 称“builder 加一条 v2 迁移即可”；实际 `SCHEMA_VERSION=1`、`STEPS` 只有 v1（migrate.ts:14, 72-80），没有 v2；`bots` 无 `provider_id`（schema.sql:29-47）。
- **未找到**：providers 表/`~/.agentbot/providers.json` 读写/`/api/providers`；`config.secretsPath` 只定义未使用（config.ts:20）。
  - 2026-10-26 之后已落地：`providers.json` + `/api/providers*`、`mcp.json` + `/api/mcp*`、`skills/` + `/api/skills*`；`secretsPath` 仍未使用。
- **事实**：schema.sql 是 v1 的建表脚本，由迁移 step v1 执行（migrate.ts:75-78），不是独立于迁移的“当前 schema”。

## 8. HTTP 路由、404 与鉴权（routes/index / server / dto / auth）

### 现状事实
- 路由注册：`registerRoutes` 先注册 `/api/health`（免鉴权，只回 `{ok:true}`）与 `/api/meta`（需鉴权，返回 version/schemaVersion/startedAt/runtimes），再依次注册 runtime/bot/channel/event/message/permission/assignment/memory/usage/schedule/token/admin（routes/index.ts:30-56），最后注册 SSE（59-64，用进程级 `eventBus` + `createBotIdEnricher`）。
- 404 语义：未实现端点**故意不注册**（routes/index.ts:26-28）；`setNotFoundHandler` 统一回 `404 {"error":"not_found"}`（server.ts:344-346）；静态资源在 `/api/*` 未命中时返回 false 交给 404，非 API 未知路径回落 `index.html`（server.ts:243-248, 334-341）；统一错误处理回 `500 {"error":"internal_error"}`，不吐堆栈（349-355）。
- 鉴权：`onRequest` 钩子（server.ts:276-328）跳过 `/api/health`（279）；先查来源锁定，命中回 429 JSON 或 HTML（282-300）；从 `?t=` 或 cookie `agentbot_token` 取 token（auth.ts:73-83）；`verifyToken` 用 `timingSafeEqual`（64-70）；失败回 401 JSON（`/api/*`）或 HTML（非 API 且 Accept 含 text/html，server.ts:42-47, 306-320），并记失败；成功清失败计数，若请求带 `?t=` 则种 `HttpOnly; SameSite=Strict; Path=/` cookie（323-326；auth.ts:85-88）。
  - **2026-10-28 更新**：上一条已被登录页取代 —— 免鉴权路径多了 `/login`、`/logout`、`/api/auth/logout`；未登录的浏览器导航改为 **302 到 `/login?next=<原路径>`**（不再是 HTML 说明页）；cookie 变**持久**（`Max-Age=30 天`，HTTPS/生产加 `Secure`）；`?t=` 与 cookie 两个候选**逐个校验**。当前实现见 README「登录与登录态」与 `agentbot-05-architecture.md` §8。
- 限流：连续 10 次失败锁 60s（auth.ts:94-95, 105-133）；锁定期内连 token 都不比对（server.ts:282-300）。
- token 文件：`~/.agentbot/token`，32 字节 base64url；已有文件长度 ≥32 则复用；写入 mode 0600，Windows 用 icacls（auth.ts:13-30, 41-61）；`resetToken` 清缓存后重新 ensure（32-35）。
- DTO：`RuntimeDto` 含 `id/displayName/protocol/version/healthStatus/capabilitiesSource/capabilities/adapterName/command/minVersion/availability/executable/meetsMinVersion/probeDetail/lastProbeAt/eventCapabilities/requiresWorktree`（dto.ts:25-52）；`toRuntimeDto` 把 `healthStatus` 设为 `record.availability`，capabilities 映射为 `plan/permission/resume/contextWindow/streaming`（59-88）；`requiresWorktree` 用 `record.permissionChannel ?? undefined` 判定（85-87）。`BotDto`（92-108）、`SessionDto`（297-309）、`EventDto`（498-508）、`toEventDto`（517-532）均在 dto.ts。
- `/api/runtimes` 列表读 `runtime_definitions` 缓存（routes/runtimes.ts:205-207）；`/api/meta` 的 runtimes 是 main 启动时生成的快照（main.ts:107-115, 300-315），不是实时读库。

### 与 06 的 gap
- **已验证**：路由集中注册、health 免鉴权、未实现端点不注册→统一 404、token/cookie/限流、DTO 形状。
- **未找到**：文档 §9 的 `/api/providers` CRUD/test、`/api/mcp`、`/api/skills`；`src/server/http/routes/` 只有 13 个文件（admin/assignments/bots/channels/events/index/memory/messages/permissions/runtimes/schedules/token/usage），无 providers/mcp/skills，按 index 的约定会 404。
  - 2026-10-28 现状：`routes/` 已扩到 18 个文件（新增 providers / mcp / skills / setup / sessions 等；登录路由在 `http/login.ts`），上述端点均已注册。
- **假设不成立/事实**：`/api/meta` 的 runtimes 是启动快照（main.ts:107-115, 300-315），启动后新增/重探的运行时不会出现在这里；`GET /api/runtimes` 才读库（routes/runtimes.ts:205-207）。内置运行时若只在启动后注册，不会进入 `/api/meta`。
- **事实**：`RuntimeDto.requiresWorktree` 由缓存里的 `permissionChannel` 决定；该键为 null 时返回 false（dto.ts:85-87；worktree-guard.ts:26-28），即缓存缺 `_probe.permissionChannel` 的运行时不强制 worktree。

## 9. 人格/记忆注入（memory/assembler.ts）

### 现状事实
- 唯一注入接口：`assemble(db, botId, {charBudget?})`（assembler.ts:100-168），返回 `{text, included, truncatedCount, usedChars, budget, personaTruncated}`（27-40, 160-167）。`estimate` 只是 `assemble` 的别名（174-176）。
- 预算：默认 `config.limits.memoryCharBudget = 6000` 字符（assembler.ts:101；config.ts:42）。
- 顺序：先读 `bots.persona` 并 trim（103-106）；人格先占预算，超预算时硬截断并加 `…`，连标题都放不下则人格整体不注入（108-125）；剩余预算按 `listInjected`（`injected=1`）的 `updated_at` 倒序填记忆（128-149）；`packMemory` 遇到第一条放不下就 `break`，丢弃剩余所有更旧条目（57-87）；空内容跳过、不算截断（67-72）；预留“已省略 N 条”提示长度（74-79）。
- 输出：有内容才输出 `## 人格` / `## 记忆` 段，空段不出现（151-158）；记忆超预算时在段尾写“（记忆超出预算，已省略 N 条）”（155-156）。
- 消费方：`context.ts` 的 `assembleMemory` 调 `assemble`（86-93）；`buildBootstrapContext` 只拼人格+记忆（104-120）；`buildRebuildContext` 拼 `header + memory + 最近消息`（128-202）。`header` 固定为“你正在继续一段此前的对话……”（155-157）。

### 与 06 的 gap
- **已验证**：`assemble(db,botId,{charBudget})` 是人格+记忆的唯一注入接口；人格先占预算、记忆按 updated_at 倒序、空段不输出、6000 字符总预算；context.ts 的 bootstrap/rebuild 都调用它。
- **假设不成立**：文档 §7 的 `core/agent/prompt.ts`、人格 ≤4000 字符、技能索引 ≤800 字符、运行规则 ≤300 字符、总预算 ≤4000 token、3.5 字符/token 均未找到。实际只有“人格+记忆 ≤6000 字符”（assembler.ts:101, 108-149），token 估算用 2 字符/token（context.ts:27-30）。
- **未找到**：人格独立 4000 上限的代码（只有总预算内硬截断，assembler.ts:114-123）；技能扫描/`read_skill`/工具说明预算；`core/agent/prompt.ts`。

## 10. core/adapters 边界规则（scripts/check-boundaries.mjs）

### 现状事实
- core/ 禁止出现的协议字符串（含注释）：`session/update`、`--output-format`、`\bacp\b`、`\bjsonrpc\b`、`\bcodex-app-server\b`（check-boundaries.mjs:22-28）；扫描 core 下所有 `.ts/.tsx/.mts/.cts/.js/.mjs`（33, 74-89）。
- adapters/ 禁止 import：`core/db`、`better-sqlite3`（31）；用正则匹配 `import/export ... from`、`require()`、动态 `import()`（92-114）。
- 范围：`src/server/http/**` 不在检查内（10）；跳过 `node_modules`/`dist`（51）；根目录取 `process.cwd()`（16）。
- 结果：无违规 exit 0 并打印通过；有违规打印 `file:line` 并 exit 1（116-125）。实测 `node scripts/check-boundaries.mjs` exit 0。
- 实际规避示例：`adapters/probe.ts` 不 import core/db，改用最小 `SqlHandle` 接口接收连接（probe.ts:396-402, 392-395 注释）。
- core 实际反向 import adapters：`turn.ts` import `adapters/contract.js`、`adapters/turn-context.js`（turn.ts:4-5）；`supervisor.ts` import `adapters/contract.js`（supervisor.ts:2-9）。脚本不检查这一方向。

### 与 06 的 gap
- **已验证**：core 禁 5 个协议字符串、adapters 禁 import core/db 与 better-sqlite3；当前检查通过。
- **假设不成立**：文档 §3 称“core/ 里不出现 `chat/completions`、`anthropic`、`tools/call` 等协议字符串”；这些不在 `CORE_FORBIDDEN`（22-28），不会被拦截；`builtin`/`internal` 也不在列表。
- **假设不成立**：文档的依赖方向（`core/agent/loop.ts → core/agent/provider.ts ← adapters/providers/*`）未被脚本约束；脚本不禁止 core import adapters，实际 core 已经 import adapters（turn.ts:4-5；supervisor.ts:2-9）。
- **事实**：脚本只覆盖两条规则；`adapters/providers`、`adapters/mcp`、`core/agent` 等目录尚不存在，因此这些未来模块的边界目前没有被任何检查覆盖（推断）。
