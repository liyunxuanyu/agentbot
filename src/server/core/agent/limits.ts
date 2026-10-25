/**
 * 内置引擎的硬上限（经验值，可按实际调整）。
 *
 * 放在独立文件里是为了让 loop、工具、driver 用同一套数值；
 * 散落在各文件里的魔法数字最终一定会漂移。
 */
export const AGENT_LIMITS = {
  /** 一次 Turn 最多调多少次模型。 */
  maxIterations: 20,
  /** 一次 Turn 最多执行多少次工具。 */
  maxToolCalls: 40,
  /** 回灌给模型的单条工具输出上限。 */
  maxToolOutputBytes: 64 * 1024,
  /** 读文件上限。 */
  maxFileReadBytes: 64 * 1024,
  /** 工具输出最多保留的行数。 */
  maxToolOutputLines: 2000,
  /** run_shell 默认超时。 */
  shellTimeoutMs: 120_000,
  /** web_fetch 超时。 */
  webFetchTimeoutMs: 20_000,
  /** grep 最多返回多少条匹配。 */
  maxGrepMatches: 200,
  /** 技能索引在系统提示里的字符上限。 */
  maxSkillsIndexChars: 800,
  /** 一次 web_fetch 最多读取的字节数。 */
  maxFetchBytes: 64 * 1024,
} as const;
