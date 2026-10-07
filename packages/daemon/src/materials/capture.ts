// 采集接口：一种事件类型登记成某类素材。素材只由守护进程从事件日志产生（agent 没有写素材、挑选素材的工具）。
// 采集函数是确定性的：只看事件本身，同一条事件永远产生同样的素材（重启、重建 memory.db 都一样）。
//
// 别的票接入自己的素材事件（审批决定 07/12/14、澄清回答 12/16、任务结局 13、对产出的反应 13/15、记忆命令 21……）：
// 事件类型照常加进共享协议包的 EVENT_TYPES，然后在 daemon.ts 里、materials.start() 之前：
//   materials.register({
//     name: "approval-decision",                 // 唯一的名字（素材 id 由它和事件算出来，定了就别改）
//     eventType: EVENT_TYPES.approvalDecided,     // 自己的事件类型
//     capture: (event) => [userDecisionDraft({ kind: "approval_decision", ... })],  // 不算素材的返回 []
//   });
// 彻底删除改写过的事件（"已删除"标记）不会交给采集函数。
import { createHash } from "node:crypto";
import type { EventType } from "@ergou/protocol";
import type { StoredEvent } from "../events/event-store.ts";
import { type MaterialPiece, segmentPieces } from "./segments.ts";
import { type CapturedMaterial, type MaterialKind, MATERIAL_MODE, type MaterialSegment, type SourceLevel } from "./types.ts";

/** 采集函数给出的一条素材（id、说或做、指向事件的引用、原文副本由素材模块补上） */
export interface MaterialDraft {
  kind: MaterialKind;
  /** 来源等级：这件事是谁做的、谁说的 */
  source: SourceLevel;
  segments: MaterialSegment[];
  /** 不给就用事件的时间 */
  time?: string;
  conversation?: string;
  task?: string;
  project?: string;
  context?: string[];
  /** 事件里具体指的东西 */
  ref?: { messageId?: string; cardId?: string; recordId?: string };
}

export interface MaterialSource {
  /** 唯一的名字：素材 id 由它和事件算出来，登记之后不要改 */
  name: string;
  /** 管哪种事件 */
  eventType: EventType;
  /** 从一条事件产生素材：确定性的，只看事件本身；不算素材的返回空数组 */
  capture(event: StoredEvent): MaterialDraft[];
}

/**
 * 素材 id：由事件（频道、频道内序号、时间）、采集规则的名字和第几条算出来（ADR-0006）。
 * 不用全局序号，免得 ergou.db 换成别的版本后新事件撞上旧素材的 id。
 */
export function materialId(event: StoredEvent, sourceName: string, index: number): string {
  const digest = createHash("sha256").update([event.channel, event.seq, event.time, sourceName, index].join("\u0000"), "utf8").digest("hex");
  return `mat-${digest.slice(0, 24)}`;
}

/** 采集函数给出的草稿 → 素材信封（原文副本另由素材模块写好后补上） */
export function buildMaterial(event: StoredEvent, sourceName: string, index: number, draft: MaterialDraft): CapturedMaterial {
  return {
    id: materialId(event, sourceName, index),
    kind: draft.kind,
    mode: MATERIAL_MODE[draft.kind],
    time: draft.time ?? event.time,
    conversation: draft.conversation ?? null,
    task: draft.task ?? null,
    project: draft.project ?? null,
    source: draft.source,
    ref: { event: { globalSeq: event.globalSeq, channel: event.channel, seq: event.seq, type: event.type }, ...draft.ref },
    context: draft.context ?? [],
    segments: draft.segments,
  };
}

/** 用户的一个决定里的一段话：文字和它在原始记录里的字段名 */
interface DecisionText {
  text: string;
  field?: string;
}

/**
 * 用户在卡片或审批上的一个决定（审批决定、澄清问题的回答、对产出的反应……）的草稿，给接入的票用：
 * - 用户选的是 agent 先提出的东西（批准计划、点建议卡上的"发起任务"、选了提问卡上的现成选项）：
 *   算用户的选择，来源本人，注明"agent 先提出"；
 * - 用户自己写的话（打回意见、补充说明、自己填的回答）：本人。
 */
export function userDecisionDraft(
  input: Pick<MaterialDraft, "kind" | "time" | "conversation" | "task" | "project" | "context" | "ref"> & {
    /** 被接受的 agent 提议 */
    accepted?: DecisionText;
    /** 用户自己写的话 */
    typed?: readonly DecisionText[];
  },
): MaterialDraft {
  const { accepted, typed, ...rest } = input;
  const pieces: MaterialPiece[] = [];
  if (accepted) pieces.push({ form: "choice", text: accepted.text, locator: fieldLocator(accepted.field) });
  for (const t of typed ?? []) pieces.push({ form: "typed", text: t.text, locator: fieldLocator(t.field) });
  return { ...rest, source: "self", segments: segmentPieces(pieces) };
}

function fieldLocator(field: string | undefined): MaterialPiece["locator"] {
  return field === undefined ? {} : { field };
}
