#!/usr/bin/env node
/**
 * 分离铁律检查（架构 §2）：
 *
 *   core/      不得出现协议字符串（session/update、--output-format、acp、jsonrpc、
 *              codex-app-server）。核心只认统一事件模型，协议细节必须关在 adapters 里。
 *   adapters/  不得 import core/db 或 better-sqlite3。通道驱动不碰数据库，
 *              否则换运行时就要动持久化。
 *
 * src/server/http/** 不在检查范围：HTTP 层天然要序列化 DTO，不属于核心语义。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.cwd());
const SERVER_DIR = join(ROOT, "src", "server");
const CORE_DIR = join(SERVER_DIR, "core");
const ADAPTERS_DIR = join(SERVER_DIR, "adapters");

/** 协议字符串：在 core 里出现即视为协议细节泄漏。短词加词边界，避免误伤普通单词。 */
const CORE_FORBIDDEN = [
  { label: "session/update", re: /session\/update/gi },
  { label: "--output-format", re: /--output-format/gi },
  { label: "acp", re: /\bacp\b/gi },
  { label: "jsonrpc", re: /\bjsonrpc\b/gi },
  { label: "codex-app-server", re: /\bcodex-app-server\b/gi },
];

/** adapters 里禁止的 import 目标。 */
const ADAPTER_FORBIDDEN_IMPORTS = ["core/db", "better-sqlite3"];

const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"]);

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i) : "";
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walk(full));
    } else if (entry.isFile() && SOURCE_EXT.has(extOf(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function display(file) {
  return relative(ROOT, file).split(sep).join("/");
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

const violations = [];

// ---- core：禁协议字符串（含注释，注释里的泄漏同样是泄漏）----
for (const file of walk(CORE_DIR)) {
  const text = readFileSync(file, "utf8");
  for (const rule of CORE_FORBIDDEN) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      violations.push({
        file: display(file),
        line: lineOf(text, m.index),
        message: `core/ 出现协议字符串 "${rule.label}"，应关在 adapters/ 内`,
      });
      if (m[0].length === 0) rule.re.lastIndex += 1;
    }
  }
}

// ---- adapters：禁 import core/db 与 better-sqlite3 ----
const IMPORT_RE =
  /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

for (const file of walk(ADAPTERS_DIR)) {
  const text = readFileSync(file, "utf8");
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    for (const bad of ADAPTER_FORBIDDEN_IMPORTS) {
      const hit =
        bad === "better-sqlite3" ? spec === bad || spec.startsWith(`${bad}/`) : spec.includes(bad);
      if (hit) {
        violations.push({
          file: display(file),
          line: lineOf(text, m.index),
          message: `adapters/ 不得依赖 "${bad}"（通道驱动不访问数据库）`,
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log("✓ 分离铁律检查通过：core/ 无协议字符串，adapters/ 无数据库依赖");
  process.exit(0);
}

console.error(`✗ 发现 ${violations.length} 处违规：`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.message}`);
}
process.exit(1);
