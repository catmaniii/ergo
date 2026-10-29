// 秘书调使用中的项目的操作（260 号票；268 号票补了验收、登记、版本号）在事件日志里的事件：守护进程内部的 operations 频道（和运营方案、
// 项目的服务放在一起——删除项目时这个项目在 operations 频道上的事件整条换成"已删除"标记，这几种跟着一起，不用另登记）。
// 前端不订阅，聊天里看到的是工具调用记录，时间线上另有一条 project_op。
// - project_op_called：秘书经 project_ops 调了一次（真的发出去了才记：服务回了、连不上、等不到、脚本跑了、动作做了、建了工单；
//   找不到项目、参数不对、服务关着、清单没登记这些没发出去的不记）。记着用的是清单第几版（通用操作没有版本）、种类、风险标记
//   （只记不做）、实现方式、能念的那句和是不是二狗补的；参数里像密钥的擦掉（发给实现的是原参数）。
// - ops_manifest_checked：验收了一份清单（内容的指纹 hash），全过或没过（等服务上线的不记：服务起来以后再验）。同一份内容验过就不再自动验，
//   维护者用 check_ops、转入使用的请求会重验。
// - ops_manifest_registered：登记了一版清单（使用中的项目：转入使用时、之后档案里的改了验收全过时），版本号从 1 起每登记一次加一，
//   带着读出来的操作（秘书用的是登记着的这一份，档案里的再改也不影响，直到新的一份验收过了登记）。
import type { OpsCheckOp } from "./acceptance.ts";
import type { OpKind, OpImplType, OpRisk, OpsEndpoint, ProjectOp } from "./manifest.ts";
import type { OpsMsg } from "./problems.ts";

export const PROJECT_OPS_EVENTS = {
  called: "project_op_called",
  checked: "ops_manifest_checked",
  registered: "ops_manifest_registered",
} as const;

/** 调到了（实现回了、没说出错）/ 没做成（实现报错、连不上、等不到） */
export type ProjectOpOutcome = "done" | "failed";

export interface ProjectOpCalledPayload {
  projectId: string;
  projectName: string;
  /** 操作名（ops.json 里 tools[].name，或通用操作的名字） */
  op: string;
  /** 用的是运营接口清单第几版（268）；通用操作是 null */
  version: number | null;
  /** 通用操作（白送的） */
  builtin: boolean;
  kind: OpKind;
  /** 只读（kind 是 query；260 号票起就有的字段，留着） */
  readOnly: boolean;
  /** 风险标记（只记不做） */
  risk?: OpRisk;
  impl: OpImplType;
  /** 发过去的参数（像密钥的擦掉了；补过默认值、中文名换成了值） */
  args: Record<string, unknown>;
  why?: string;
  /** http：发到哪个服务（LSM 里的名字）、哪个地址；script：哪个脚本；ergo：哪个动作；maintainer：建的任务 */
  app?: string;
  url?: string;
  script?: string;
  action?: string;
  taskId?: string;
  outcome: ProjectOpOutcome;
  /** 能念的那句；sayFilled 是实现没给、二狗按结果补的 */
  say: string;
  sayFilled: boolean;
  /** 实现回的附件（压成一行、截短） */
  result: { ok: boolean; text: string };
  /** 谁调的：现在只有秘书 */
  by: "secretary";
  time: string;
}

/** 谁要的验收：维护者用 check_ops、转入使用的请求和确认、秘书用到时（档案里的改了）、守护进程自己 */
export type OpsCheckBy = "maintainer" | "go_live" | "secretary" | "system";

export interface OpsManifestCheckedPayload {
  projectId: string;
  projectName: string;
  /** 清单内容的指纹 */
  hash: string;
  outcome: "passed" | "failed";
  problems: OpsMsg[];
  warnings: OpsMsg[];
  ops: OpsCheckOp[];
  by: OpsCheckBy;
  time: string;
}

export interface OpsManifestRegisteredPayload {
  projectId: string;
  projectName: string;
  /** 第几版（从 1 起） */
  version: number;
  hash: string;
  endpoint: OpsEndpoint;
  ops: ProjectOp[];
  /** 什么时候登记的：转入使用时、之后改了验收过了 */
  via: "go_live" | "changed";
  time: string;
}
