// 快速动作（规格第 14 节）对外的东西。别的模块只从这里取：
// - 登记一种动作（22 号票的任务控制、27 号票的 MCP 调用）：defineQuickAction（参数 schema、规范化、"明确点了"的判定用
//   explicit.ts 的辅助函数、关注、执行），在 daemon.ts 里 quickActionRegistry.register(...)；
// - 守护进程装配：QuickActionRegistry、createQuickActionService、quickActionCardType、proposeQuickActionTool；
// - 彻底删除时操作记录的改写函数：operationRecordPurge。
export {
  type AsyncQuickActionExecutor,
  defineQuickAction,
  isAsyncQuickAction,
  type NormalizedQuickAction,
  type ProposalCard,
  type QuickActionContext,
  type QuickActionExecutor,
  type QuickActionOutcome,
  type QuickActionPerformed,
  QuickActionRegistry,
  type QuickActionWatch,
  type SyncQuickActionExecutor,
} from "./registry.ts";
export {
  bareText,
  clausesOf,
  commandTails,
  type ExplicitFinding,
  foundIn,
  isQuestion,
  mentionsRef,
  type NamedRef,
  NEGATIONS,
  normalizeForMatch,
  ownWords,
  type OwnWordsSource,
  sentencesOf,
  type UserTurn,
} from "./explicit.ts";
export { type QuickActionGuard, quickActionToolName } from "./judge.ts";
export {
  actionContext,
  createQuickActionService,
  operationRecordKey,
  operationRecordPurge,
  quickActionCardType,
  type QuickActionService,
  readUserTurn,
} from "./quick-actions.ts";
export { PROPOSE_QUICK_ACTION, proposeQuickActionTool } from "./tool.ts";
