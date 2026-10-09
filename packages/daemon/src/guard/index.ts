// 守卫判定核心（规格第 9 节）。上层只从这里取东西。
// 本模块不接任何运行时：把判定接进子进程的 tool_call、效果日志落库在 07 号票。
export * from "./disposition.ts";
export * from "./types.ts";
export { judgeToolCall, judgementExecutes, neverObjectsOf } from "./judge.ts";
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
export { absolutePathArgs, normalizeArgs, replacedPaths } from "./rule-steps.ts";
export { isSecretFile, secretValuesIn } from "./secret-files.ts";
export { NETWORK_PROGRAMS } from "./shell/programs.ts";
export type { ShellOrderStep } from "./shell/split.ts";
export { v1RuleTemplates, V1_TEMPLATE_IDS } from "./rule-templates.ts";
export { validateTemporalRules, type RuleValidationOptions, type RuleValidationResult } from "./rule-validation.ts";
export * from "./tool-registry.ts";
export * from "./watch-categories.ts";
export { loadWatchCategorySettings, parseWatchCategorySettings, readWatchCategoryFile } from "./watch-category-store.ts";
export { SECRET_PATTERNS, findSecretShapes, REDACTED_SECRET, redactSecretShapes, redactSecretValues, type SecretPattern } from "./secrets.ts";
// 流程（58 号票）：计划的审查修补（planguard 的规划时审查）、步骤在守卫眼里的样子（能写的工具、拆成的调用、推出的工具包和授权项）
export {
  reviewWorkflow,
  WORKFLOW_REVIEW_BUDGET_MS,
  type ReviewAction,
  type ReviewedStep,
  type ReviewFinding,
  type ReviewStatus,
  type RuleProbe,
  type StepCondition,
  type WorkflowDraftStep,
  type WorkflowReviewInput,
  type WorkflowReviewOutcome,
  type WorkflowReviewResult,
} from "./workflow-review.ts";
export {
  isUnknownArg,
  plainArgs,
  stepCalls,
  stepToolAllowed,
  workflowGrants,
  workflowStepTools,
  workflowToolkit,
  type StepCall,
  type WorkflowGrantDraft,
  type WorkflowGrantInput,
} from "./workflow-steps.ts";
