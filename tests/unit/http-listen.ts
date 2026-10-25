import type { FastifyInstance } from "fastify";

/**
 * 在随机端口上监听，并返回**能被 fetch 使用**的 base URL。
 *
 * 为什么要重试：`port: 0` 由系统分配，偶尔会落在 Node `fetch`（undici）的
 * 「禁用端口」名单里（6000 / 6665–6669 / 10080 / 100 等，防 DNS rebinding）。
 * 此时服务本身监听正常，但每个请求都抛 `TypeError: fetch failed`，
 * cause 是 `Error: bad port` —— 与业务逻辑无关的偶发失败（实测约 1/5）。
 *
 * 处理：探测 `/api/health`，失败就关掉重听。最多 8 次，概率上足够
 * （禁用端口占全部端口的比例很小，连续 8 次都命中的概率可以忽略）。
 *
 * 注意：调用方必须自己 `app.close()`；本函数只在重试时关掉再打开同一个实例。
 */
export async function listenEphemeral(app: FastifyInstance): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    try {
      await fetch(`${base}/api/health`);
      return base;
    } catch {
      await app.close();
    }
  }
  throw new Error("找不到可用的测试端口（连续 8 次落在 fetch 禁用端口）");
}
