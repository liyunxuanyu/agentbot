import { AGENT_LIMITS } from "../limits.js";

/**
 * 统一截断。工具输出是最容易把上下文撑爆的部分，必须让模型知道「还有更多」。
 *
 * 按行与按字节双上限；先切行再切字节，避免一个 10 万行的日志先被读进内存。
 */

export interface TruncateOptions {
  maxBytes?: number;
  maxLines?: number;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  omittedLines: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function truncateText(text: string, opts: TruncateOptions = {}): TruncateResult {
  const maxBytes = opts.maxBytes ?? AGENT_LIMITS.maxToolOutputBytes;
  const maxLines = opts.maxLines ?? AGENT_LIMITS.maxToolOutputLines;

  const lines = text.split("\n");
  let truncated = false;
  let omittedLines = 0;
  let kept = text;

  if (lines.length > maxLines) {
    omittedLines = lines.length - maxLines;
    kept = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }

  if (byteLength(kept) > maxBytes) {
    // 逐字符累计字节，避免把多字节字符切成半个
    let used = 0;
    let cut = 0;
    for (const ch of kept) {
      const size = byteLength(ch);
      if (used + size > maxBytes) break;
      used += size;
      cut += ch.length;
    }
    const dropped = kept.slice(cut);
    omittedLines += dropped.length === 0 ? 0 : dropped.split("\n").length;
    kept = kept.slice(0, cut);
    truncated = true;
  }

  if (!truncated) return { text, truncated: false, omittedLines: 0 };

  const note = omittedLines > 0
    ? `\n…（已截断，省略 ${omittedLines} 行；如需更多请缩小范围或用 grep 定位）`
    : "\n…（已截断；如需更多请缩小范围）";
  return { text: `${kept}${note}`, truncated: true, omittedLines };
}
