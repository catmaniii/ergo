// agent 的活动状态（规格术语"活动状态"）：agent 此刻在做什么——休眠、干活中（附带在做什么）、等你、排队（子进程满了，等名额）。
// 和任务状态、项目状态分开：互不改写。agent 管家报变化，守护进程在活动状态频道上记 activity 事件（12 号票）；
// "等你"、说明、干活中在做什么、看板和项目列表上的小圆点在 25 号票。
// 说明是带种类的结构化数据（ActivityDetail），给人看的文字由 activityDetailText 按表生成（守护进程不写中文文案进事件）。
import { type Static, Type } from "typebox";
import { t, tTable } from "./i18n/runtime.ts";

export const ACTIVITY_STATES = ["sleeping", "working", "waiting_for_user", "queued"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

export const ACTIVITY_STATE_LABEL: Readonly<Record<ActivityState, string>> = tTable({
  sleeping: "protocol.activity.state.sleeping",
  working: "protocol.activity.state.working",
  waiting_for_user: "protocol.activity.state.waitingForUser",
  queued: "protocol.activity.state.queued",
});

/**
 * 说明的种类：
 * - 干活中：被唤起（拉起了、还没交来输入）、处理一条输入；此刻在做什么（临时的进度）：思考、写回复、调用某个工具；
 * - 等你：等你批准（审批）、等你回答（澄清：提问卡）、等你启用它用的运行时插件（286 号票：维护者有活却拉不起来，plugin 是插件给人看的名字）、
 *   等你收回（290 号票：接管来的会话交还给运行时了，维护者有活也不拉起，runtime 是运行时给人看的名字）、在官方 App 里（292 号票：
 *   会话交给官方 App 了，维护者有活也不拉起，收回到二狗后接着）；
 * - 休眠：空闲（子进程还在、没有输入）、闲置退出。
 */
export const ACTIVITY_DETAIL_KINDS = ["woken", "handling_input", "thinking", "replying", "calling_tool", "approval", "clarification", "runtime_off", "handed_back", "in_remote", "idle", "idle_exit"] as const;
export type ActivityDetailKind = (typeof ACTIVITY_DETAIL_KINDS)[number];

/** 活动状态的说明（不含用户的原话和工具参数：活动状态事件落盘，彻底删除不改写它） */
export const ActivityDetail = Type.Object({
  kind: Type.Enum(ACTIVITY_DETAIL_KINDS),
  /** 工具的中文名：调用某个工具、等你批准某个工具 */
  tool: Type.Optional(Type.String()),
  /** 已经写了多少字：思考、写回复 */
  chars: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 没启用的运行时插件给人看的名字（286 号票：等你启用它） */
  plugin: Type.Optional(Type.String()),
  /** 接管来的会话交还给了哪个运行时（290 号票：等你收回；292 号票：交给了哪个运行时的官方 App），给人看的名字 */
  runtime: Type.Optional(Type.String()),
});
export type ActivityDetail = Static<typeof ActivityDetail>;

/** 每种说明给人看的文字（守护进程和 Web 共用这一张表） */
const ACTIVITY_DETAIL_TEXT: Readonly<Record<ActivityDetailKind, (d: ActivityDetail) => string>> = {
  woken: () => t("protocol.activity.detail.woken"),
  handling_input: () => t("protocol.activity.detail.handlingInput"),
  thinking: (d) => t("protocol.activity.detail.thinking", { count: d.chars ?? 0, chars: d.chars ?? 0 }),
  replying: (d) => t("protocol.activity.detail.replying", { count: d.chars ?? 0, chars: d.chars ?? 0 }),
  calling_tool: (d) => t("protocol.activity.detail.callingTool", { tool: d.tool ?? t("protocol.activity.detail.someTool") }),
  approval: (d) => (d.tool ? t("protocol.activity.detail.approvalOf", { tool: d.tool }) : t("protocol.activity.detail.approval")),
  clarification: () => t("protocol.activity.detail.clarification"),
  runtime_off: (d) => t("protocol.activity.detail.runtimeOff", { plugin: d.plugin ?? "" }),
  handed_back: (d) => t("protocol.activity.detail.handedBack", { runtime: d.runtime ?? "" }),
  in_remote: (d) => t("protocol.activity.detail.inRemote", { runtime: d.runtime ?? "" }),
  idle: () => t("protocol.activity.detail.idle"),
  idle_exit: () => t("protocol.activity.detail.idleExit"),
};

/** 说明的文字（不认识的种类——更新的守护进程发来的——没有文字） */
export function activityDetailText(detail: ActivityDetail): string {
  return Object.hasOwn(ACTIVITY_DETAIL_TEXT, detail.kind) ? ACTIVITY_DETAIL_TEXT[detail.kind](detail) : "";
}

/**
 * `activity` 事件（活动状态频道，落盘）：某个 agent 的活动状态变了，连同说明（干活中是被唤起、处理一条输入；
 * 等你是等你批准某个工具、等你回答提问；休眠是空闲、闲置退出）
 */
export const ActivityEventPayload = Type.Object({
  agentId: Type.String(),
  state: Type.Enum(ACTIVITY_STATES),
  since: Type.String(),
  detail: Type.Optional(ActivityDetail),
});
export type ActivityEventPayload = Static<typeof ActivityEventPayload>;

/**
 * `activity_progress` 事件（活动状态频道，临时：只推送、不落盘、不补发）：干活中的 agent 此刻在做什么
 * （思考了多少字、写回复写了多少字、调用哪个工具），每个 agent 每 ACTIVITY_PROGRESS_INTERVAL_MS 最多一条。
 * 下一条 activity 事件（状态变了）之后，前端以那条为准
 */
export const ActivityProgressEventPayload = Type.Object({ agentId: Type.String(), detail: ActivityDetail });
export type ActivityProgressEventPayload = Static<typeof ActivityProgressEventPayload>;

/** 同一个 agent 两条进度之间的最短间隔（毫秒）：进度事件的节流（规格第 5 节） */
export const ACTIVITY_PROGRESS_INTERVAL_MS = 100;

/**
 * agent 这一轮出错时会话里留的那条系统说明里的固定字样（守护进程写进去，Web 认它）。172 号票起按写的时候的语言写，
 * 认的时候中文的（以前存下的）和当前语言的都认
 */
const TURN_FAILED_MARK_ZH = "这次没能回复："; // @i18n-ignore fixed：认以前存下的中文说明

/**
 * agent 这一轮出错（模型调用失败、超时……）时会话里留的那条系统说明："<名字>这次没能回复：<原因>"（守护进程的 agent 会话写）。
 * Web 的阶段详情把它算成"要你看一眼"的一件状况（60 号票：出错归"要你看一眼"）
 */
export function turnFailedNote(name: string, reason: string): string {
  return t("protocol.activity.turnFailed", { name, reason });
}

/** 一条系统说明是不是 agent 这一轮出错时留的那条（turnFailedNote） */
export function isTurnFailedNote(text: string): boolean {
  return text.includes(TURN_FAILED_MARK_ZH) || text.includes(t("protocol.activity.turnFailedMark"));
}
