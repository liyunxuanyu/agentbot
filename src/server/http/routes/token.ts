import { existsSync, rmSync } from "node:fs";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../../config.js";
import { accessUrl } from "../server.js";
import type { ServerContext } from "../server.js";
import { currentToken, resetToken } from "../auth.js";
import { activeStreamCount, closeAllStreams } from "../sse.js";

/**
 * token 管理（P0-14「手动重置 token：10s 内断开所有已连接客户端并要求用新 URL」）。
 *
 *   `GET  /api/token`        → `{ preview, url, activeStreams }`
 *   `POST /api/token/reset`  → `{ token, url, closedStreams }`
 *
 * 为什么需要一个读端点：设置页要显示「当前连接数」与脱敏后的访问地址。
 * 这两项都是**本进程的运行时状态**（活跃 SSE 连接集合 + 内存里的 token），
 * `/api/meta` 是静态元信息，塞进去会让它的语义变脏。
 *
 * 重置语义（顺序不可颠倒）：
 *   ① 删掉 token 文件 → `resetToken()`：它会清内存缓存并让 `ensureToken()` 重新生成。
 *      为什么必须删文件：`ensureToken()` 在缓存为空时会**先读已有文件**，只要文件里
 *      还是旧的 32 字节 token，`resetToken()` 就会把同一个 token 原样返回（实测）。
 *      删除文件是本层唯一能保证「真的换了一个」的做法，且不必改 auth.ts。
 *   ② `closeAllStreams()` 主动断开所有 SSE —— 否则已建立的连接会继续推数据，
 *      直到下一次心跳超时（最长 45s），违背「10s 内断开」；
 *   ③ 返回新 URL，前端整页提示「请用新地址重新打开」。
 *
 * 注意：**不**在这里种新 cookie。重置的意图就是「当前会话失效、必须换地址」，
 * 自动把新 token 种回去等于让重置形同虚设（任何拿到旧标签页的人都能继续用）。
 */

interface TokenStatusResponse {
  /** 脱敏：只露前 4 后 4，够用户核对「是不是换了一个」。 */
  preview: string;
  /** 带 token 的完整访问地址；没有 token 时为 null（理论上不会发生）。 */
  url: string | null;
  activeStreams: number;
}

function json(reply: FastifyReply, code: number, body: unknown): FastifyReply {
  return reply.code(code).header("content-type", "application/json; charset=utf-8").send(body);
}

function previewOf(token: string | null): string {
  if (!token) return "—";
  if (token.length <= 10) return `${token.slice(0, 2)}••••`;
  return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
}

export function registerTokenRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get("/api/token", async (): Promise<TokenStatusResponse> => {
    const token = currentToken();
    return {
      preview: previewOf(token),
      url: token ? accessUrl(token) : null,
      activeStreams: activeStreamCount(),
    };
  });

  app.post("/api/token/reset", async (_req, reply: FastifyReply) => {
    // 先删文件：见文件头 ① 的说明，否则 resetToken() 会把旧 token 原样返回
    try {
      if (existsSync(config.tokenPath)) rmSync(config.tokenPath, { force: true });
    } catch (err) {
      console.error(
        `[agentbot] 无法删除旧 token 文件：${err instanceof Error ? err.message : String(err)}`,
      );
      return json(reply, 500, { error: "token_reset_failed" });
    }

    const token = resetToken();
    const closedStreams = closeAllStreams("token_reset");
    console.log(`[agentbot] token 已重置，断开 ${closedStreams} 个实时连接`);
    // 新 token 必须完整返回：用户的旧标签页已经 401，只能靠这条响应里的 URL 回去
    return json(reply, 200, { token, url: accessUrl(token), closedStreams });
  });
}
