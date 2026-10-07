// 守卫判定核心（规格第 9 节）。上层只从这里取东西。
// 本模块不接任何运行时：把判定接进子进程的 tool_call 在 07 号票，时序规则检查在 05 号票。
export * from "./disposition.ts";
export * from "./types.ts";
export { judgeToolCall, judgementExecutes } from "./judge.ts";
export { DEFAULT_GRANT_VALIDITY_MS, grantExpiresAt, validateGrantChange, type GrantChangeResult } from "./grants.ts";
export type { ShellEnv } from "./paths.ts";
export type { TemporalRule, TemporalRuleHit } from "./temporal-rules.ts";
export * from "./tool-registry.ts";
export * from "./watch-categories.ts";
export { loadWatchCategorySettings } from "./watch-category-store.ts";
export { SECRET_PATTERNS, findSecretShapes, type SecretPattern } from "./secrets.ts";
