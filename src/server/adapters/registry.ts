import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { EVENT_TYPES } from "../../shared/events.js";
import type { AdapterDeclaration } from "./contract.js";

/**
 * 声明文件加载与校验。
 *
 * 复杂度只在这里一次：新增一个运行时 = 往 declarations/ 丢一个 YAML。
 * 校验失败要报出是哪个文件哪个字段，否则用户只看到「运行时列表空了」。
 */

const tri = z.union([z.boolean(), z.literal("unknown")]);

const declarationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  displayName: z.string().min(1),
  protocol: z.enum(["acp", "codex-app-server", "opencode-http", "claude-sdk", "cli-stdio", "builtin"]),
  launch: z.object({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  detect: z.object({
    command: z.string().optional(),
    versionArgs: z.array(z.string()),
    versionPattern: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
  minVersion: z.string().optional(),
  capabilities: z.object({
    plan: tri,
    permissionRequest: tri,
    resume: tri,
    images: tri,
    streaming: tri,
    contextWindow: z.number().int().positive().nullable(),
  }),
  eventCapabilities: z.array(z.enum(EVENT_TYPES)),
  permission: z.object({
    channel: z.enum(["acp-reverse", "jsonrpc-approval", "none", "internal"]),
    defaultTimeoutPolicy: z.enum(["reject", "hold"]),
  }),
  resumeStrategy: z.enum(["acp", "native", "process-lifetime", "none"]),
  executionLocations: z.array(z.enum(["local", "worktree"])).min(1),
  modes: z
    .object({
      headless: z.boolean(),
      multiplierHint: z.number().positive().optional(),
    })
    .optional(),
  protocolOptions: z.record(z.unknown()).optional(),
});

export interface LoadedDeclaration {
  declaration: AdapterDeclaration;
  file: string;
}

export interface LoadResult {
  loaded: LoadedDeclaration[];
  errors: { file: string; message: string }[];
}

/** 默认声明目录：打包后与产物同目录，开发态在 src 下。 */
export function defaultDeclarationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "declarations"),
    join(here, "../../../src/server/adapters/declarations"),
    join(process.cwd(), "src/server/adapters/declarations"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[1] ?? candidates[0] ?? "declarations";
}

/**
 * 读目录下所有 *.yaml / *.yml。
 * 目录不存在返回空结果（M4/M8/M9 落地前是常态），不抛错。
 */
export function loadDeclarations(dir: string = defaultDeclarationsDir()): LoadResult {
  if (!existsSync(dir)) return { loaded: [], errors: [] };

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const loaded: LoadedDeclaration[] = [];
  const errors: LoadResult["errors"] = [];
  const seen = new Set<string>();

  for (const name of files) {
    const file = resolve(dir, name);
    try {
      const raw = parseYaml(readFileSync(file, "utf8"));
      const parsed = declarationSchema.safeParse(raw);
      if (!parsed.success) {
        errors.push({ file, message: formatIssues(parsed.error.issues) });
        continue;
      }
      const declaration = parsed.data as AdapterDeclaration;
      if (seen.has(declaration.id)) {
        errors.push({ file, message: `声明 id 重复：${declaration.id}` });
        continue;
      }
      seen.add(declaration.id);
      loaded.push({ declaration, file });
    } catch (err) {
      errors.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { loaded, errors };
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.message}`)
    .join("; ");
}
