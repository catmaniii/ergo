// 秘书调使用中的项目的操作（260 号票；268 号票照用户 2026-10-13 的设计草稿补齐）的汇总导出，给测试用。280 号票起运营层
// （这里和 project-services/）照插件的纪律写：源码里别处只经入口 api.ts 用它，项目系统的组装函数经 layer.ts 装它
// （test/projects/boundary.test.ts 守着），不 import 这个文件。
// - manifest.ts：运营接口清单 ops.json（MCP tools/list 的格式 + 中文标题、用户可能怎么说、三种操作、风险标记、四种实现方式、测试）怎么读；
// - args.ts：参数的整理和校验（中文名换成值、补默认值、按 JSON Schema 校验）、参数说明本身写得对不对；
// - reply.ts：回的东西里取能念的 say 和附件、没给 say 时二狗补的那句；
// - call.ts（http）、script.ts（script）、builtin.ts（ergo：白送的通用操作，也是能绑参数的二狗自带动作）、runner.ts（按实现方式分派、
//   maintainer 转给维护者当工单）；
// - acceptance.ts（照 112 号票的自动验收：格式对、每个操作一条能跑通的测试、只读的真不写）、snapshot.ts（只读的真不写比文件）、
//   registry.ts（验收、登记、版本号）；
// - tool.ts：秘书的 project_ops 和装配（createProjectOps）；check-tool.ts：维护者的 check_ops；
// - events.ts：operations 频道上的事件；texts.ts：说法；problems.ts：清单的问题（key 加参数，用到时按语言说）；tool-names.ts：工具名。
export { type OpsCheckOp, type OpsCheckResult } from "./acceptance.ts";
export { bindPlaceholders, enumOptions, prepareArgs, schemaProblems, schemaWarnings } from "./args.ts";
export { BUILTIN_OP_NAMES, builtinOp, builtinOps, type BuiltinContext, type BuiltinJobs } from "./builtin.ts";
export { callBody, callProjectOp, OPS_TEST_META, opsUrl, type ProjectOpCallResult } from "./call.ts";
export {
  type OpsCheckBy,
  type OpsManifestCheckedPayload,
  type OpsManifestRegisteredPayload,
  PROJECT_OPS_EVENTS,
  type ProjectOpCalledPayload,
  type ProjectOpOutcome,
} from "./events.ts";
export {
  DEFAULT_OPS_PATH,
  manifestHash,
  OP_IMPL_TYPES,
  OP_KINDS,
  OP_RISKS,
  type OpImpl,
  type OpKind,
  type OpRisk,
  type OpsEndpoint,
  type OpsManifestRead,
  parseOpsManifest,
  type ProjectOp,
  readOpsManifest,
} from "./manifest.ts";
export { OPS_PROBLEM_CODES, type OpsMsg, problemForModel, problemText } from "./problems.ts";
export { fallbackSay, parseReply, type ParsedReply } from "./reply.ts";
export { type OpsChecklistView, type OpsRegistry } from "./registry.ts";
export { createProjectOps, endpointService, PROJECT_OPS_CALL_TIMEOUT_MS, PROJECT_OPS_CHECK_TIMEOUT_MS, type ProjectOps, type ProjectOpsDeps } from "./tool.ts";
export { CHECK_OPS_TOOL, PROJECT_OPS_TOOL } from "./tool-names.ts";
