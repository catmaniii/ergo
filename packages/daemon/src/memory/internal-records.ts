// 项目内部的记录（64 号票，ADR-0023）：素材属于的任务、引着的审批或卡片是项目内部的——内部任务的结局、计划和审批的决定、验收、
// 提问卡的回答、建议卡被关掉……这些由系统记下的记录秘书检索不到（search-tool.ts），删除项目时随项目彻底删掉（66 号票，
// projects/deletion.ts；用户 2026-10-10 定）。用户本人说过的话（发言、投喂的材料、记忆命令）不算：它们是用户的记忆（ADR-0006），
// 秘书照常检索得到，删项目也不删。
import type { ProjectInternal } from "@ergou/protocol";
import type { Material, MaterialKind } from "../materials/index.ts";

/** 用户本人说过的话：不按项目隔离、不随项目删 */
const USER_OWN_WORDS: ReadonlySet<MaterialKind> = new Set<MaterialKind>(["user_utterance", "fed_material", "memory_command"]);

/** 素材引着的东西从哪儿查（daemon.ts 接上任务、审批、卡片、待我处理） */
export interface MaterialOwners {
  task(taskId: string): { internal?: ProjectInternal | undefined } | undefined;
  /** 审批（"审批决定"素材的记录编号）：调用从哪儿来 */
  approvalOrigin(approvalId: string): { internal?: ProjectInternal | undefined } | undefined;
  /** 卡片的负载（项目的维护者给的建议卡带着标记）和它在待我处理里的事项 */
  cardPayload(cardId: string): unknown;
  inboxItemsOfCard(cardId: string): ReadonlyArray<{ internal?: ProjectInternal | undefined }>;
}

/** 这条素材记的是哪个项目内部的事：它属于的任务、引着的审批、卡片（卡片本身或它的事项）带着的标记；不是项目内部的为 undefined */
function internalOf(m: Material, owners: MaterialOwners): ProjectInternal | undefined {
  const fromTask = m.task === null ? undefined : owners.task(m.task)?.internal;
  if (fromTask) return fromTask;
  const fromApproval = m.ref.recordId === undefined ? undefined : owners.approvalOrigin(m.ref.recordId)?.internal;
  if (fromApproval) return fromApproval;
  const { cardId } = m.ref;
  if (cardId === undefined) return undefined;
  const payload = owners.cardPayload(cardId) as { internal?: ProjectInternal; taskId?: unknown } | undefined;
  return payload?.internal ?? (typeof payload?.taskId === "string" ? owners.task(payload.taskId)?.internal : undefined) ?? owners.inboxItemsOfCard(cardId).find((i) => i.internal)?.internal;
}

/** 由系统记下的项目内部记录是哪个项目的；用户本人说过的话、不是项目内部的为 undefined */
export function internalRecordOf(m: Material, owners: MaterialOwners): ProjectInternal | undefined {
  return USER_OWN_WORDS.has(m.kind) ? undefined : internalOf(m, owners);
}
