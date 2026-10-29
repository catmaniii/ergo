// 运营方案（130 号票，ADR-0028）：对外的入口，别处只从这里取。
// - means.ts：运营手段登记表（校验、给人看的说法、生效、撤销、就地改、暂停和恢复；插件经插件宿主登记）；
// - builtin-means.ts：内核登记的——定时触发的任务、事件触发的任务（生效成项目的内部任务），公网入口（要用户手动）；项目自己的服务（133 号票）在 project-services/，组合根插在事件触发后面；
// - operations.ts：交运营方案的工具、逐条校验、建设期间交的等"首版做完了"卡、确认并转入使用时每一条生效、使用中的出"运营方案变更"卡并照差异生效；
// - diff.ts：和现在生效的比出差异；events.ts / views.ts：operations 频道上的事件和派生视图；texts.ts：说法；tool-names.ts：工具名；
// - deletion.ts：删项目时运营方案的那一份（"删除参与方"登记表，279 号票）。
export { builtinOperationMeans, runSummary } from "./builtin-means.ts";
export { registerOperationsDeletion } from "./deletion.ts";
export { OPERATIONS_CHANNEL, OPERATIONS_EVENTS, type OperationsDecidedPayload, type OperationsProposedPayload } from "./events.ts";
export { type OperationApplyContext, type OperationBinding, type OperationCheckContext, type OperationMeans, OperationMeansRegistry } from "./means.ts";
export { createOperations, type Operations, operationsChangeCardType, operationsDecisionSource, operationsPurges, type PutInUseOperations, purgedItem, purgedProjectOperations } from "./operations.ts";
export { planSectionText } from "./texts.ts";
export { PROPOSE_OPERATIONS_TOOL } from "./tool-names.ts";
export { operationsOfProject, operationsView } from "./views.ts";
