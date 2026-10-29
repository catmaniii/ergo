// 个人档案（281 号票）的事件：守护进程内部的频道 personal_files（不是前端协议的频道，前端订阅不了；档案页经 HTTP 取），
// 一类事件 personal_file，按 change 分几种。照内核的规矩事件溯源：派生视图（view.ts）从这里归并，彻底删除时字段级改写。
// - 一次写一个字段一条 field_set（旧值不删：视图里记成"到某天为止"）；本人的姓名就是"我的名字"（config/user-name.json 是真相），
//   field_set 里不带值，只留痕；
// - 每次写都留痕（trail）：谁写的、经谁转达、根据哪句话（用户那条消息的编号；原话不抄进来，档案页按编号现取——彻底删除那条消息时
//   不用连带改写档案）。经秘书转达的另记快速动作的编号、卡片、会话：彻底删除档案里的值时据此找到核对卡、操作记录、提议它的那次调用；
// - 忘掉、彻底删除（field_forgotten、note_forgotten、person_forgotten）只记删了什么、哪种删法，不带原话；彻底删除另外在同一事务里
//   把带原值的事件改写掉（purge.ts），改写函数登记在组合根的改写函数表里（personalFilePurge）。
// 283 号票加了：
// - 生日、纪念日的每年提醒（reminder_set 开或改提前几天、reminder_cleared 关、reminder_linked 记下对应的是哪条提醒——
//   提醒本身在提醒插件里，字段改了、删了由 annual.ts 跟着改、删）；
// - 记忆管理员攒的候选（candidate_added：一个人被提到、或者他的一条固定信息；candidates_carded：合进了哪张候选核对卡；
//   candidates_resolved：写了、没写、出处被删了作废）。候选带着值，彻底删除时照样改写；
// - 留痕多了 curator：记忆管理员提议（每晚整理攒的候选、284 号票的访谈）、用户在候选核对卡上点了才写。
// 285 号票加了 group_set：用户给档案里的人选的分组（家人、重要的人、其他人）；没选过的按关系猜，不记事件。分组不是原话，彻底删除不改写它。
import { PURGED_TEXT, type PersonalFileDeleteMode, type PersonGroup, type PersonalSuggestOrigin, type QuickActionBasis } from "@ergo/protocol";
import type { NewEvent } from "../events/event-store.ts";
import type { PurgeRewriter } from "../events/purge.ts";

/** 守护进程内部的频道：个人档案的事件 */
export const PERSONAL_FILES_CHANNEL = "personal_files";
/** 事件类型（一类，按 change 分） */
export const PERSONAL_FILE_EVENT = "personal_file";

/**
 * 留痕：经谁转达、凭什么写的、根据哪句话。page：用户在档案页里直接改的（改了就算确认）；secretary：秘书提议、用户原话里明说了
 * （basis explicit）或者在核对卡上确认（confirmed）；curator 有两种：
 * - 283 号票：记忆管理员提议的候选、用户在候选核对卡（personal_file_suggest）上点了——带 origin，没有 actionId；
 * - 284 号票：记忆管理员在了解你访谈里记下、收尾时合成的档案核对卡（interview_files）上逐条确认的——经快速动作 personal_file 的执行器写，
 *   字段和 secretary 一样（带 actionId：操作记录、卡片、记下它的调用按它找）。两种按有没有 actionId 分
 */
export type PersonalFileTrail =
  | { via: "page" }
  | {
      via: "secretary" | "curator";
      basis: QuickActionBasis;
      /** 根据哪句话：秘书当时在处理的那条用户消息 */
      messageId?: string;
      /** 快速动作、它的卡片（核对卡或"已执行"卡）、所在的会话：彻底删除时据此找到卡片、操作记录、提议它的那次调用 */
      actionId: string;
      cardId: string;
      conversation: string;
    }
  | {
      via: "curator";
      basis: "confirmed";
      /** 候选核对卡：彻底删除时连它的每个版本一起改写 */
      cardId: string;
      /** 候选从哪来：每晚整理、访谈（284）、秘书直接写以后问的一句 */
      origin: PersonalSuggestOrigin;
      /** 根据哪句话（访谈里用户答的那句；每晚整理的候选没有，原话在素材里） */
      messageId?: string;
    };

/** 候选的结局：写了、没写（用户在卡上没勾、点了"都不用"）、作废（同一个人同一字段来了更新的候选，或者出处的话被删了） */
export type CandidateOutcome = "accepted" | "rejected" | "dropped";

export type PersonalFileChange =
  /** 加了一个重要的人（称呼紧跟着一条 field_set name） */
  | { change: "person_added"; personId: string; trail: PersonalFileTrail }
  /** 写一个字段：旧值记成历史；本人的姓名不带值（"我的名字"是真相，这里只留痕） */
  | { change: "field_set"; personId: string; field: string; value?: string; trail: PersonalFileTrail }
  /** 285：用户选的分组（建人时选的、档案页上改的）；没选过的按"和我的关系"猜，不记这条 */
  | { change: "group_set"; personId: string; group: PersonGroup; trail: PersonalFileTrail }
  /** 撤销这个字段最近一次写入：回到上一个值（撤销的那个不进历史） */
  | { change: "field_undone"; personId: string; field: string; trail: PersonalFileTrail }
  | { change: "note_added"; personId: string; noteId: string; text: string; date: string; trail: PersonalFileTrail }
  /** 忘掉、彻底删除：一个字段（连同历史）、一件事、整个人；不带原话 */
  | { change: "field_forgotten"; personId: string; field: string; mode: PersonalFileDeleteMode }
  | { change: "note_forgotten"; personId: string; noteId: string; mode: PersonalFileDeleteMode }
  | { change: "person_forgotten"; personId: string; mode: PersonalFileDeleteMode }
  /** 283：生日、纪念日的每年提醒开了（或改了提前几天） */
  | { change: "reminder_set"; personId: string; field: string; daysBefore: number; trail: PersonalFileTrail }
  /** 283：每年提醒关了（用户关的带留痕；值没了、跟着删的不带） */
  | { change: "reminder_cleared"; personId: string; field: string; trail?: PersonalFileTrail }
  /** 283：每年提醒对应的是提醒插件里的哪一条（建了、重建了）；没有 reminderId 是那条删了（值认不出公历日子） */
  | { change: "reminder_linked"; personId: string; field: string; reminderId?: string }
  /**
   * 283：一条候选——一个人被提到（没有 field），或者他的一条固定信息（field、value）。personKey 认同一个人（已有档案的是档案编号，
   * 没有的是 "n:" 加称呼）；materialIds 是从哪几条素材听到的、heard 是哪几天
   */
  | {
      change: "candidate_added";
      candidateId: string;
      personKey: string;
      personId?: string;
      name: string;
      aliases: string[];
      relation?: string;
      field?: string;
      value?: string;
      materialIds: string[];
      heard: string[];
      origin: PersonalSuggestOrigin;
      /** 299：从哪个数据源来的（通讯录选人是 phone-contacts）：断开它并删已导入的时，还没写进档案的跟着删 */
      dataSource?: string;
    }
  /** 283：这几条候选合进了这张候选核对卡 */
  | { change: "candidates_carded"; cardId: string; candidateIds: string[] }
  /** 283：这几条候选的结局 */
  | { change: "candidates_resolved"; candidateIds: string[]; outcome: CandidateOutcome };

export function personalFileEvent(change: PersonalFileChange): NewEvent {
  return { channel: PERSONAL_FILES_CHANNEL, type: PERSONAL_FILE_EVENT, payload: change };
}

/** 这条事件带不带原值（彻底删除要改写的）：写字段（带值的）、记下的事、候选（283：称呼、别名、关系、值） */
export function carriesValue(change: PersonalFileChange): boolean {
  return (change.change === "field_set" && change.value !== undefined) || change.change === "note_added" || change.change === "candidate_added";
}

/**
 * 彻底删除时档案事件的改写：只把原值（字段的值、记下的事、候选的称呼和值，还没档案的人按称呼认的那个键）换成删除标记，编号、字段名、留痕原样
 * （视图重放后紧跟着的删除事件把它去掉；作废的候选不再上卡）。别的几种没有原话，原样
 */
export const personalFilePurge: PurgeRewriter = {
  eventType: PERSONAL_FILE_EVENT,
  rewrite(event) {
    const change = event.payload as PersonalFileChange;
    if (change.change === "field_set" && change.value !== undefined) return { ...change, value: PURGED_TEXT } satisfies PersonalFileChange;
    if (change.change === "note_added") return { ...change, text: PURGED_TEXT } satisfies PersonalFileChange;
    if (change.change === "candidate_added") {
      return {
        ...change,
        // 还没档案的人按称呼认（"n:王小明"）：称呼也换掉（301 号票：删除已导入的通讯录时名字不能留在这里）
        personKey: change.personKey.startsWith("n:") ? `n:${PURGED_TEXT}` : change.personKey,
        name: PURGED_TEXT,
        aliases: change.aliases.map(() => PURGED_TEXT),
        ...(change.relation === undefined ? {} : { relation: PURGED_TEXT }),
        ...(change.value === undefined ? {} : { value: PURGED_TEXT }),
      } satisfies PersonalFileChange;
    }
    return change;
  },
};
