---
name: feedback-no-thinking-in-output
description: 用户要求思考/推理过程不得出现在给用户的输出里；2026-10-18 查明 pix-deepseek 链路会把思维塞进正文（provider 侧问题）
metadata:
  node_type: memory
  type: feedback
  originSessionId: sess_b4417f02-c8ff-4133-83dc-ff4023dd0a57
---

2026-10-18 用户反馈：在部分会话（sess_f1e15251、sess_b4417f02 等）看到思考/推理过程被当作输出内容，明确表示"按理来说不应该"。同日按用户指定会话取证，确认现象属实，并定位到成因。

**Why:** 用户要的是可直接使用的结论与交付物，不是推理叙事；推理混进正文既难读，也会把内部工作细节暴露在对话记录里。

**How to apply:**
- 输出侧自我约束：工具调用之间只写一两句进度状态，最终消息只给结论/发现/交付物，不写推理链。
- 已查明的外部成因：pix 网关（provider `new-provider` = pix-deepseek，模型 deepseek-v4.1-flash）约 1/4 请求把模型思维放进 content（文本以 `<thinking>` 开头、多不闭合、`reasoning_tokens=0`），ZCode 原样存储与显示。证据与报障要点见 [[pix-deepseek-thinking-leak]]。
- 模型侧无法控制该分流；用户看到泄漏时，正确动作是向 pix 报障，或推动 ZCode 在显示/存储层剥离开头 `<thinking>` 块。相关：[[user-language-context-habits]]。
