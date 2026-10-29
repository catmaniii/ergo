// 长程任务阶段开始的回退点（152 号票：固定计划"撤回到步骤「…」开始前"、阶段认领时的撤回点）。
//
// 要是阶段开始就在会话里（agent 自己调工具开始），回退点落在那条回复之前就行；可二狗的阶段多数是
// 运行时替维护者开始的（开始执行、上一个阶段验收通过之后、一支不用再等了……），维护者从一条系统通知或者它正在调用的工具的结果里知道，
// 会话里没有一条"开始了"。所以阶段一开始，运行时往维护者的会话频道上记一条 stage_start（界面上不显示成一条），写明维护者是怎么知道的：
// - 一条交给它的通知（notice：消息 id）：回退点挂在这条通知上，撤回就是回到这条通知之前（和用户消息一样，会话树上回到这条输入之前）；
// - 它正在调用的一个工具（call：工具调用 id、工具名）：
//   - "开始阶段"（start_stage，维护者自己换去做这个阶段，即认领）：回退点挂在这次调用（和它同一条回复里说的话）上，
//     撤回就是回到这条回复之前；
//   - 别的（宣布阶段完成验收通过之后接着开始下一个、计划变更里开始的……）：阶段是在这次调用里开始的，结果里交代了新阶段，回退点挂在
//     这次调用之后的那一条上，撤回就是回到这次调用的结果之后——之前那个阶段的验收照样算数，只是新阶段回到未开始。
// 运行时替它开始、又没交代给它的（交给子 agent 的并行阶段）不记。只看守护进程记的这一条，不按时间去对看板上的事件。
//
// 153 号票：流程（58、59 号票的固定计划）每个步骤开始也记一条（stepId：哪一步，stageId 是流程唯一的那个阶段，
// title 是步骤的标题）。带 report_step、状态进行中的那条 assistant 消息之前是
// "撤回到步骤「…」开始前"——维护者调 report_step(status="in_progress") 时记，via 是这次调用（after: false：回到含这次调用的那条回复之前）。
// 定时、事件触发的流程每次运行里的步骤也记（taskId 是这个流程，一次运行是一段会话）。
import { followLocale, t } from "./i18n/runtime.ts";
import type { ConversationId } from "./schema.ts";

/** 维护者是怎么知道这个阶段开始了的：一条交给它的通知，或者它正在调用的一个工具 */
export type StageStartVia = { readonly notice: string } | { readonly call: string; readonly tool: string; readonly after: boolean };

/** stage_start 事件（维护者会话频道，落盘）：长程任务的一个阶段在这个会话里开始了 */
export interface StageStartEventPayload {
  /** 这条记号的 id（回退点按它认：RollbackTarget 的 stageStart） */
  id: string;
  conversation: ConversationId;
  taskId: string;
  stageId: string;
  /** 流程的一个步骤开始（153 号票）：哪一步（stageId 是流程唯一的那个阶段）；长程任务的阶段开始没有 */
  stepId?: string;
  /** 阶段的标题、编号（"1a"）：回退点的说法"撤回到阶段「…」开始前"；流程的是步骤的标题（"撤回到步骤「…」开始前"），没有编号 */
  title: string;
  code?: string;
  via: StageStartVia;
  time: string;
}

/** 回退点的说法（"撤回到步骤「…」开始前"） */
export function stageRollbackLabel(title: string): string {
  return t("protocol.stageStarts.rollbackStage", { title });
}

/** 流程一个步骤开始的回退点的说法（153 号票） */
export function stepRollbackLabel(title: string): string {
  return t("protocol.stageStarts.rollbackStep", { title });
}

/** 一条记号的回退点的说法：流程的步骤、长程任务的阶段 */
export function startRollbackLabel(mark: Pick<StageStartEventPayload, "stepId" | "title">): string {
  return mark.stepId === undefined ? stageRollbackLabel(mark.title) : stepRollbackLabel(mark.title);
}

/** 阶段框底部那一个（"⟲ 撤回到这一步开始前"；单位是阶段） */
export let STAGE_BOX_UNDO = "";

/** 撤回到阶段开始前的确认框里多的那一句（阶段的撤回点："撤回之后从这一步接着做"） */
export let STAGE_ROLLBACK_CONTINUES = "";

// ───────────────────────── 流程撤回之后等你（155 号票） ─────────────────────────
// 用户 2026-10-18 定："撤回后停在那里，等我再用，你说句话再接着做，我不说话的话，隔一分钟后提醒一次"。一次性的流程（含某个时间做一次的）
// 撤回会话、切换分支之后停在那里（运行时不交代、不自己接着做，153 号票：固定计划的做法）；你在这个任务里说一句，维护者从那一步接着做。
// 一分钟内你没在这个任务里说话，待办里一条"流程在等你"加推送（只一次），你说了话这条处理掉；这期间也不再催维护者（无进展的催促不算它）。

/** 撤回到流程一个步骤开始前的确认框里多的那一句（155 号票） */
export let WORKFLOW_ROLLBACK_WAITS = "";

/** 流程撤回之后多久你没在任务里说话就提醒你一次（155 号票：一分钟） */
export const ROLLBACK_WAIT_REMIND_MS = 60_000;

/** "流程在等你"事项的动作：知道了（只收起这条，流程照旧等你说话） */
export const ROLLBACK_WAIT_ACK = "知道了"; // @i18n-ignore fixed：事项的动作按字认

/**
 * "流程在等你"事项被系统记成处理过时写的：你说了话（或者维护者已经接着做了）、流程不在执行中了。
 * handled 记在事项的处理结果上（和动作一样按字认，不跟着语言变），note 是给你看的说明（跟着当前语言）
 */
export const ROLLBACK_WAIT_SETTLED = {
  resumed: {
    handled: "已接着做", // @i18n-ignore fixed：事项的处理结果按字认
    get note() {
      return t("protocol.stageStarts.waitSettled.resumed");
    },
  },
  voided: {
    handled: "已作废", // @i18n-ignore fixed：事项的处理结果按字认
    get note() {
      return t("protocol.stageStarts.waitSettled.voided");
    },
  },
} as const;

/** "流程在等你"事项的结构化数据：哪个流程、等的是哪一次撤回（看板上那条 rolled_back 的全局序号：重启后据此认出提醒过没有） */
export interface RollbackWaitNoticeData {
  taskId: string;
  rollbackSeq: number;
}

/**
 * "流程在等你"事项的标题和正文。标题：撤回到步骤开始前的照用户定的原话"流程「…」撤回到步骤「…」开始前，在等你说一句再接着做"；
 * 撤回到一条请求、一条分支开始前的写"撤回了会话"，切换分支的写"切换了会话分支"。正文写停在哪（撤回到的那一步开始前；别的写下一个
 * 没做完的步骤 next）、怎么接着做
 */
export function rollbackWaitNotice(flow: string, how: { step?: string | undefined; switched?: boolean | undefined; next?: string | undefined }): { title: string; body: string } {
  const what = how.switched
    ? t("protocol.stageStarts.wait.switched")
    : how.step !== undefined
      ? t("protocol.stageStarts.rollbackStep", { title: how.step })
      : t("protocol.stageStarts.wait.rolledBack");
  const where =
    how.step !== undefined
      ? t("protocol.stageStarts.wait.atStepStart", { step: how.step })
      : how.next !== undefined
        ? t("protocol.stageStarts.wait.atStep", { step: how.next })
        : t("protocol.stageStarts.wait.there");
  return {
    title: t("protocol.stageStarts.wait.title", { flow, what }),
    body: t(how.switched ? "protocol.stageStarts.wait.bodySwitched" : "protocol.stageStarts.wait.bodyRolledBack", { where }),
  };
}

/** 废弃分支上发起、还没处理的待办（等你验收、卡住求助、超预算……）作废时写的（再点旧按钮回这句；跟着当前语言） */
export let ROLLBACK_VOIDED_NOTICE = "";

// 上面几句单独的字符串跟着当前语言（followLocale）
followLocale(() => {
  STAGE_BOX_UNDO = t("protocol.stageStarts.boxUndo");
  STAGE_ROLLBACK_CONTINUES = t("protocol.stageStarts.rollbackContinues");
  WORKFLOW_ROLLBACK_WAITS = t("protocol.stageStarts.rollbackWaits");
  ROLLBACK_VOIDED_NOTICE = t("protocol.stageStarts.voidedNotice");
});
