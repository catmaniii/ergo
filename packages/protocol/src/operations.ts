// 运营方案（130 号票，ADR-0028）的名字和纯函数，守护进程和 Web 共用，不引用 TypeBox（schema 在 operations-schema.ts）：
// - 运营方案：项目转入使用后怎么运转。由项目的维护者起草（propose_operations），用户在卡上确认一次就全部生效——确认就是授权，
//   之后照方案跑，不再逐项问。建设期间交的出现在"首版做完了"卡上（主按钮"确认并转入使用"）；使用中的项目交新的一份，
//   运行时比出差异出"运营方案变更"卡，确认后照差异生效；
// - 一份方案由若干条组成，每一条用一种运营手段。手段做成登记表（守护进程的 operations/means.ts：校验、给人看的说法、生效、撤销、
//   暂停和恢复），"运营模式不限"靠它落实：二狗现在能做的全部登记上（定时触发的任务、事件触发的任务），以后有新的往表里加；
//   还做不了的（公网入口，第二阶段）也登记着、标成要用户手动，卡上写明，不假装生效；项目自己的服务 133 号票起能上线到 LSM 了
//   （运营手段"服务"，这一条带 service，下面 OPERATION_SERVICE_MEANS 起的几个名字）；
// - 每一条写明名字、手段、触发、每次做什么（交给维护者的工单内容）、要的能力、失败时怎样。要的能力（联网、bash、skill、MCP、
//   给秘书发消息）不能超出项目的工具包（capabilitiesBeyond）。
// 卡上的说法、按钮的字、流程的确认事项在运营方案卡上怎么记，都在这里，守护进程和 Web 用同一份。
import { followLocale, t, tTable } from "./i18n/runtime.ts";
import type { ToolkitShape } from "./projects.ts";
import { capabilityText, type ToolkitCapability, toolkitAdded } from "./toolkit.ts";
import { workflowConfirmationItems } from "./workflow.ts";
import type { WorkflowReview, WorkflowStepView } from "./workflow-schema.ts";

/**
 * 每一条怎么做（和任务的做法同名）：普通任务（每次运行由维护者照"每次做什么"直接做）、流程（带它的固定计划，
 * 用户确认方案时一起授权，每次运行照步骤核对）
 */
export const OPERATION_APPROACHES = ["plain", "workflow"] as const;
export type OperationApproach = (typeof OPERATION_APPROACHES)[number];

export const OPERATION_APPROACH_LABEL: Readonly<Record<OperationApproach, string>> = tTable({
  plain: "protocol.operations.approach.plain",
  workflow: "protocol.operations.approach.workflow",
});

/** 一条要的能力（形状同 schema 的 OperationCapabilities）：都不写是什么额外的能力都不要 */
export interface OperationCapabilitiesShape {
  network?: boolean | undefined;
  bash?: boolean | undefined;
  skills?: readonly string[] | undefined;
  mcp?: readonly string[] | undefined;
  tellSecretary?: boolean | undefined;
}

/** 要的能力写成工具包的样子（给秘书发消息、发附件只在要时算开着）：和项目的工具包比用它 */
export function capabilitiesToolkit(c: OperationCapabilitiesShape): ToolkitShape {
  return {
    skills: [...new Set(c.skills ?? [])],
    mcp: [...new Set(c.mcp ?? [])],
    bash: c.bash === true,
    network: c.network === true,
    tellSecretary: c.tellSecretary === true,
    sendAttachment: false,
  };
}

/** 要的能力一样样列出来 */
export function capabilityList(c: OperationCapabilitiesShape): ToolkitCapability[] {
  return toolkitAdded({ skills: [], mcp: [], bash: false, network: false, tellSecretary: false, sendAttachment: false }, capabilitiesToolkit(c));
}

/** 要的能力写成一句话："联网、bash、skill notes-style、给<名字占位>发消息"；什么都不要是"不用额外的能力" */
export function capabilitiesText(c: OperationCapabilitiesShape): string {
  const list = capabilityList(c).map(capabilityText);
  return list.length > 0 ? list.join(t("protocol.common.listSep")) : t("protocol.operations.noCapabilities");
}

/** 要的能力里超出项目工具包的那几样（skill 也算：项目的工具包里没有的 skill 维护者在运行时用不上） */
export function capabilitiesBeyond(c: OperationCapabilitiesShape, toolkit: ToolkitShape): ToolkitCapability[] {
  return toolkitAdded(toolkit, capabilitiesToolkit(c));
}

// 下面四句跟着当前语言（followLocale）
/** "首版做完了"卡带着运营方案时的主按钮（转入使用 + 方案里每一条生效，一次做完） */
export let OPERATIONS_PUT_IN_USE_LABEL = "";

/** "首版做完了"卡上运营方案那一节的标题 */
export let OPERATIONS_SECTION_TITLE = "";

/** 确认就是授权（卡上、纯文本降级里都写） */
export let OPERATIONS_GRANT_TEXT = "";

/** 要用户手动的那一条在卡上、项目页上的说法开头 */
export let OPERATIONS_MANUAL_PREFIX = "";

followLocale(() => {
  OPERATIONS_PUT_IN_USE_LABEL = t("protocol.operations.putInUse");
  OPERATIONS_SECTION_TITLE = t("protocol.operations.sectionTitle");
  OPERATIONS_GRANT_TEXT = t("protocol.operations.grantText");
  OPERATIONS_MANUAL_PREFIX = t("protocol.operations.manualPrefix");
});

/** "运营方案变更"卡上的几组：加了、改了、去掉、重新开起来（照旧没跑着的：上次没生效、或者被取消了） */
export const OPERATION_CHANGE_KINDS = ["added", "changed", "removed", "restored"] as const;
export type OperationChangeKind = (typeof OPERATION_CHANGE_KINDS)[number];

export const OPERATION_CHANGE_LABEL: Readonly<Record<OperationChangeKind, string>> = tTable({
  added: "protocol.operations.change.added",
  changed: "protocol.operations.change.changed",
  removed: "protocol.operations.change.removed",
  restored: "protocol.operations.change.restored",
});

/**
 * 生效之后每一条的结局（卡上、项目上记着）：建成了内部任务、就地改了时间、撤了重建、取消了（方案里去掉了）、照旧、要用户手动、没生效（附原因）
 */
export const OPERATION_OUTCOMES = ["created", "rescheduled", "recreated", "cancelled", "kept", "manual", "failed"] as const;
export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

export const OPERATION_OUTCOME_LABEL: Readonly<Record<OperationOutcome, string>> = tTable({
  created: "protocol.operations.outcome.created",
  rescheduled: "protocol.operations.outcome.rescheduled",
  recreated: "protocol.operations.outcome.recreated",
  cancelled: "protocol.operations.outcome.cancelled",
  kept: "protocol.operations.outcome.kept",
  manual: "protocol.operations.outcome.manual",
  failed: "protocol.operations.outcome.failed",
});

/** 流程的一条确认事项在运营方案卡上的 key：哪一条（运营方案里的 key）+ 流程计划卡上的 key */
export const operationConfirmationKey = (itemKey: string, key: string): string => `${itemKey}/${key}`;

/** 运营方案里带流程的那几条，审查要你逐项确认的事项（照流程计划卡：一次确认不等于默认同意它们，勾完才能确认） */
export function operationsConfirmationItems(
  items: ReadonlyArray<{ key: string; name: string; workflow?: { review: Pick<WorkflowReview, "confirmations" | "actions" | "status">; steps: ReadonlyArray<Pick<WorkflowStepView, "id" | "title" | "outside">> } | undefined }>,
): Array<{ key: string; itemKey: string; text: string }> {
  return items.flatMap((item) =>
    item.workflow ? workflowConfirmationItems(item.workflow.review, item.workflow.steps).map((c) => ({ key: operationConfirmationKey(item.key, c.key), itemKey: item.key, text: t("protocol.operations.confirmationItem", { name: item.name, text: c.text }) })) : [],
  );
}

/** 一条写成一行（卡的纯文本降级、交给维护者的通知、秘书列待办时看到的）："日报（每天 08:00，普通任务）"；要用户手动的写明；服务的就是它的说法 */
export function operationLine(item: { name: string; triggerText: string; approach: OperationApproach; automatic: boolean; manual?: string | undefined; service?: unknown }): string {
  if (!item.automatic) return t("protocol.operations.lineManual", { name: item.name, prefix: OPERATIONS_MANUAL_PREFIX, manual: item.manual ?? item.triggerText });
  if (item.service !== undefined) return item.triggerText;
  return t("protocol.operations.line", { name: item.name, trigger: item.triggerText, approach: OPERATION_APPROACH_LABEL[item.approach] });
}

// ---- 运营手段"服务"（133 号票）：项目做成一个服务，确认后到 LSM 上线，有网页的经二狗转发、项目卡片上有入口 ----

/** 运营手段"服务"的编号（登记表里的 id，方案里每一条的 means 写的） */
export const OPERATION_SERVICE_MEANS = "service";

/** 上线后在 LSM 里的名字、转发的应用名："<项目编号>-<服务名>"（p-1-web） */
export const serviceAppName = (projectId: string, serviceName: string): string => `${projectId}-${serviceName}`;

/** 服务那一条的说法（卡上、项目页上）："上线服务「简报站」（端口 8899，开机自启）"，开了挂了自动重启的再写一句（关着的不写） */
export function serviceTriggerText(title: string, service: { port: number; autostart?: boolean | undefined; autoRestart?: boolean | undefined }): string {
  return t("protocol.operations.service.trigger", {
    title,
    port: service.port,
    autostart: service.autostart === false ? t("protocol.operations.service.noAutostart") : t("protocol.operations.service.autostart"),
    restart: service.autoRestart === true ? t("protocol.operations.service.autoRestart") : "",
  });
}

/** 一个环境变量写成给人看的样子："PORT=8899"、"OPENAI_API_KEY（密钥：openai-api-key.txt）"、"HF_HOME（用户环境变量）" */
export function serviceEnvText(env: { name: string; value?: string | undefined; secret?: string | undefined; userEnv?: boolean | undefined; optional?: boolean | undefined }): string {
  const tail = env.optional ? t("protocol.operations.service.envOptional") : "";
  if (env.secret !== undefined) return t("protocol.operations.service.envSecret", { name: env.name, secret: env.secret, tail });
  if (env.userEnv) return t("protocol.operations.service.envUser", { name: env.name, tail });
  return `${env.name}=${env.value ?? ""}`;
}
