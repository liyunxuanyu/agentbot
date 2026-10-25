---
name: pix-deepseek-thinking-leak
description: deepseek-v4.1-flash 经 pix
  网关（api.ai-pixel.online）时部分请求把思维写进正文（<thinking> 前缀）；证据链与报障要点
metadata:
  node_type: memory
  type: project
  originSessionId: sess_b4417f02-c8ff-4133-83dc-ff4023dd0a57
---

2026-10-18 排查结论：ZCode 中部分助手消息正文以 `<thinking>` 开头（英文推理 + 中文状态混排），成因在 **provider 侧（pix 网关），不是 ZCode 展示层问题，也不是模型有意把推理当正文写**。

**Why:** 该泄漏会让内部推理出现在用户可见消息和存档中，并随历史回传（历史里以带 `<thinking>` 前缀的 content 字符串发给模型，可能自我强化）；同时它与同一网关的另一已知问题（长流式请求被掐、`model_request_failed` 流错误）同源同厂商。

**证据链（可复现）：**
- 存储：`~/.zcode/cli/db/db.sqlite` 的 `part` 表。泄漏回合的 thinking 在普通 `text` part 中（不是 `reasoning` part）；全库正文以 `<thinking>` 开头的 text part 共 69 处 / 14 个会话（sess_f1e15251 7 处，含 16:28 重启说明；sess_b4417f02 11 处）。查询：`select ... where json_extract(data,'$.type')='text' and json_extract(data,'$.text') like '<thinking>%'`。
- 流日志：`~/.zcode/cli/rollout/model-io-sess_*.jsonl`。dirty 回合 `response.reasoningText` 为空、`response.text` 含 `<thinking>`、`usage.reasoningTokens=0`；clean 回合 reasoning 正常分流。两类请求参数完全一致（`thinking:{type:enabled}`、`reasoning_effort:max`、stream=true），响应头也一致（nginx/1.18.0）。
- ZCode 客户端 `resources/app.asar` 中无 `<thinking>` 标签处理代码 → 原样显示。
- 比例：本会话 49 次模型调用中 11 次 dirty（约 22%），间歇发生，无固定触发条件（与输入长度、耗时、full/tail 上下文模式均不相关）。

**报障要点（pix / api.ai-pixel.online）：** model=deepseek-v4.1-flash，POST /v1/chat/completions，stream=true，thinking enabled，reasoning_effort=max；间歇性把思考内容放进 `delta.content`（以 `<thinking>` 开头、常无闭合标签），而非 `delta.reasoning_content`；同响应 `usage.reasoning_tokens=0`。样例 x-request-id：e6843b7e-05c6-4db8-93c3-b8fd59785252、6ae67a7f-36d6-4a0d-a9ff-ce403d2c6721、7e2fc180-9efd-40ba-9138-e098fd1c20f3、4bea18cf-4965-4019-a0dc-3bf7a2372b34、be7c582a-9e74-40d0-8ba0-25d2fc964a04。

**How to apply:** 用户再提到"你把思考输出了"时，直接引用本诊断（问题在 pix 链路，非输出习惯）；如要规避，可考虑换 provider 对照、调低 reasoning effort 观察频率，或推动 ZCode 增加剥离逻辑。相关 [[feedback-no-thinking-in-output]]、[[env-npm-claude-code-removed]]。
