// 守卫判定核心（规格第 9 节）。上层只从这里取东西。
// 本模块不接任何运行时：把判定接进子进程的 tool_call、效果日志落库在 07 号票。
export * from "./disposition.ts";
export * from "./types.ts";
export { judgeToolCall, judgementExecutes } from "./judge.ts";
export { DEFAULT_GRANT_VALIDITY_MS, grantExpiresAt, validateGrantChange, type GrantChangeResult } from "./grants.ts";
export {
  absolutePathsIn,
  agentScope,
  comparable,
  fromShellDrivePath,
  historyDirOf,
  isWindowsAbsolutePath,
  isWithin,
  isWithinAny,
  PROJECT_HISTORY_DIR,
  projectHistoryOf,
  type ShellEnv,
} from "./paths.ts";
export type { TemporalRule, TemporalRuleHit } from "./temporal-rules.ts";
export { effectRecordsFor } from "./effect-log.ts";
export { normalizeArgs, replacedPaths } from "./rule-steps.ts";
export { isSecretFile } from "./secret-files.ts";
export { NETWORK_PROGRAMS } from "./shell/programs.ts";
export type { ShellOrderStep } from "./shell/split.ts";
export { v1RuleTemplates, V1_TEMPLATE_IDS } from "./rule-templates.ts";
export { validateTemporalRules, type RuleValidationOptions, type RuleValidationResult } from "./rule-validation.ts";
export * from "./tool-registry.ts";
export * from "./watch-categories.ts";
export { loadWatchCategorySettings, parseWatchCategorySettings, readWatchCategoryFile } from "./watch-category-store.ts";
export { SECRET_PATTERNS, findSecretShapes, type SecretPattern } from "./secrets.ts";
