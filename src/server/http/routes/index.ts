import type { FastifyInstance } from "fastify";
import { eventBus } from "../../core/events/bus.js";
import { createBotIdEnricher } from "../dto.js";
import { registerSseRoutes } from "../sse.js";
import type { ServerContext } from "../server.js";
import { registerBotRoutes } from "./bots.js";
import { registerChannelRoutes } from "./channels.js";
import { registerEventRoutes } from "./events.js";
import { registerMessageRoutes } from "./messages.js";
import { registerPermissionRoutes } from "./permissions.js";
import { registerRuntimeRoutes } from "./runtimes.js";
import { registerAssignmentRoutes } from "./assignments.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerUsageRoutes } from "./usage.js";
import { registerScheduleRoutes } from "./schedules.js";
import { registerTokenRoutes } from "./token.js";
import { registerAdminRoutes } from "./admin.js";
import { registerProviderRoutes } from "./providers.js";

/**
 * 路由注册入口。
 *
 * 全部注册在这里完成，从而统一继承 `http/server.ts` 的 token 鉴权钩子——
 * 鉴权失败时钩子先 401 并结束响应，handler 根本不会执行，SSE 也就不会建立
 * （P0-14「实时推送连接握手时校验 token，失败即 401 并立即断开」）。
 *
 * 未实现的端点**故意不注册**：`server.ts` 的 setNotFoundHandler 会统一回
 * `404 {"error":"not_found"}`，前端靠这个码区分「没实现 → 空态」与
 * 「实现了但查不到 → 错误态」。所以不要给未实现端点注册占位 handler。
 */
export function registerRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // 免鉴权：只回 ok，绝不带业务数据
  app.get("/api/health", async () => ({ ok: true }));

  // 需鉴权：服务版本与已探测到的运行时概览
  app.get("/api/meta", async () => ({
    version: process.env["npm_package_version"] ?? "0.1.0",
    schemaVersion: ctx.schemaVersion,
    startedAt: ctx.startedAt,
    runtimes: ctx.runtimes,
  }));

  registerRuntimeRoutes(app, ctx);
  // 内置引擎的模型供应商（N1）：apiKey 只回掩码
  registerProviderRoutes(app, ctx);
  registerBotRoutes(app, ctx);
  registerChannelRoutes(app, ctx);
  // P0-04/P0-05：刷新后重建事件流（含 meta 与用量），SSE 只负责增量
  registerEventRoutes(app, ctx);
  registerMessageRoutes(app, ctx);
  registerPermissionRoutes(app, ctx);
  registerAssignmentRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerUsageRoutes(app, ctx);
  registerScheduleRoutes(app, ctx);
  // P0-14：token 状态 / 重置（设置页「安全与 token」）
  registerTokenRoutes(app, ctx);
  // P0-12 边界：全量删除（需确认短语）
  registerAdminRoutes(app, ctx);

  // SSE 事件流：总线是进程级单例，ingest 落库后 publish，这里订阅推送
  registerSseRoutes(app, {
    db: ctx.db,
    bus: eventBus,
    // 出帧时补 botId（ingest 会丢掉额外字段，见 dto.ts 的说明）
    enrichPayload: createBotIdEnricher(ctx.db),
  });
}
