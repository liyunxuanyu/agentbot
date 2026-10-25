---
name: user-language-context-habits
description: 用户用中文交流；曾因会话上下文超限遇到 413 报错，宜控制读入体量
metadata:
  node_type: memory
  type: user
  originSessionId: sess_a9b6cda7-a6ab-4546-9ef0-22412309204a
---

用户以中文交流，回复应使用中文。曾遇到 ZCode 会话因历史累积过大触发服务商 `moderation_input_limit_exceeded` (413) 报错（provider=pix-gpt，retryable=false），导致旧会话无法继续。处理此类报错时：先解释 413 的含义（输入超审核上限、重试无效），建议 `/compact` 或换新会话并拉取交接摘要。

**How to apply:** 大型调研/架构任务优先定向读取文件、用子代理带回结论而非原文，避免上下文爆掉；相关案例见 [[novel-forge-context-limit]]。
