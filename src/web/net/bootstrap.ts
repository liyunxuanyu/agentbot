import { bootstrapToken } from "./client";

/**
 * 副作用模块：必须在 `router` 之前被 import。
 *
 * 原因（实测踩到）：`createWebHistory()` 在模块求值时就捕获了 `window.location`，
 * 而 ESM 的 import 求值早于 main.ts 的函数体。若把 `bootstrapToken()` 写在
 * main.ts 里，router 已经把 `?t=<token>` 记成初始地址，`/` 的 redirect 会带着它
 * 走到 `/bots`，token 就永远留在地址栏（违背架构 §8「`?t=` 立即抹除」）。
 *
 * 所以把它做成一个最先被 import 的副作用模块，保证抹除发生在 router 初始化之前。
 */
bootstrapToken();
