import type { BotDto, RuntimeDetailDto, RuntimeSummary } from "../net/types";

/**
 * 运行时可用性与原因文本（P0-02）。
 *
 * 唯一口径：**原因优先用后端 `probeDetail`**（如「需要 ≥ 0.20.0，当前 0.1.0」），
 * 没有时才按 `availability` 给兜底文案。这样版本过低不会被笼统写成「健康检查失败」。
 *
 * `unprobed` 不算不可用：它只是还没探测过，不是探测失败。绑定下拉允许选它，
 * 发送时后端会再判定一次。
 */

export type RuntimeLike = RuntimeSummary | RuntimeDetailDto;

/** 展示层可用性；旧 `/api/meta` 只给 healthStatus，做一次兼容映射。 */
export function runtimeAvailability(rt: RuntimeLike | null | undefined): string {
  if (!rt) return "unbound";
  return rt.availability ?? rt.healthStatus ?? "unprobed";
}

/** 是否应禁用发送 / 置灰下拉项。 */
export function runtimeUnavailable(rt: RuntimeLike | null | undefined): boolean {
  if (!rt) return true;
  const a = runtimeAvailability(rt);
  return a !== "ready" && a !== "unprobed";
}

/** 短状态词（chip / 下拉标签用）。 */
export function runtimeStatusWord(rt: RuntimeLike | null | undefined): string {
  if (!rt) return "未绑定";
  const a = runtimeAvailability(rt);
  if (a === "ready") return "可用";
  if (a === "missing") return "未安装";
  if (a === "timeout") return "检测超时";
  if (rt.meetsMinVersion === false) return "版本过低";
  if (a === "unhealthy") return "健康检查失败";
  if (a === "unprobed") return "未探测";
  return "状态未知";
}

/**
 * 不可用的原因（人话）。可用时返回空串。
 *
 * 顺序很重要：`probeDetail` 是后端探测的真实结论，永远压过前端兜底文案。
 */
export function runtimeReason(rt: RuntimeLike | null | undefined): string {
  if (!rt) return "未绑定运行时";
  const detail = rt.probeDetail?.trim();
  if (detail && detail.length > 0) return detail;

  const a = runtimeAvailability(rt);
  if (a === "ready") return "";
  if (a === "missing") return "PATH 中未找到可执行文件";
  if (a === "timeout") return "检测超时（3s 无响应）";
  if (a === "unhealthy") {
    if (rt.meetsMinVersion === false) {
      return rt.minVersion ? `需要 ≥ ${rt.minVersion}，当前版本过低` : "版本低于最低要求";
    }
    return "健康检查失败";
  }
  if (a === "unprobed") return "尚未探测";
  return "状态未知";
}

/** 下拉选项文案：名称 · 状态（原因）。 */
export function runtimeOptionLabel(rt: RuntimeLike): string {
  const word = runtimeStatusWord(rt);
  const reason = runtimeReason(rt);
  // 「未探测（尚未探测）」这种同义重复没必要占宽度
  return reason.length > 0 && reason !== word
    ? `${rt.displayName} · ${word}（${reason}）`
    : `${rt.displayName} · ${word}`;
}

/** worktree 状态的中文短词（Bot 详情「执行位置」区）。 */
export function worktreeStateWord(state: BotDto["worktreeState"]): string {
  switch (state) {
    case "ready":
      return "worktree 就绪";
    case "missing":
      return "worktree 尚未创建";
    case "failed":
      return "worktree 创建失败";
    default:
      return "—";
  }
}

/**
 * worktree 未就绪的说明。
 *
 * 后端只持久化 `worktree_state`，没有把失败原因落库（见「待确认」），所以这里
 * 只陈述可确证的事实与需要检查的方向，不编造具体错误。
 */
export function worktreeIssue(bot: BotDto | null | undefined): string | null {
  if (!bot) return null;
  if (bot.worktreeState === "failed") {
    return "worktree 创建失败：仓库根路径不可用，或磁盘空间/目录权限不足。点「重新创建 worktree」重试。";
  }
  if (bot.worktreeState === "missing") {
    return "worktree 尚未创建：首次发送前会自动创建，也可以现在手动重试。";
  }
  return null;
}

/**
 * 发送被阻止的原因（store 层 selector，供会话页复用）。
 *
 * 返回 null 表示可以发送。规则：
 *   ① 未绑定运行时 / 运行时不可用 → 阻止（P0-02「发送按钮禁用并提示」）；
 *   ② worktree 创建失败 → 阻止（P0-13「发送时阻止并给重试」）。
 * `missing` 不阻止：首次发送时后端会创建，失败会回 409 并带原因。
 */
export function sendBlockedReason(bot: BotDto | null | undefined): string | null {
  if (!bot) return "Bot 不存在";
  if (!bot.runtime) return "运行时不可用：未绑定运行时";
  if (runtimeUnavailable(bot.runtime)) {
    return `运行时不可用：${runtimeReason(bot.runtime)}`;
  }
  if (bot.worktreeState === "failed") {
    return "发送被阻止：worktree 创建失败，请在 Bot 详情点「重新创建 worktree」";
  }
  return null;
}
