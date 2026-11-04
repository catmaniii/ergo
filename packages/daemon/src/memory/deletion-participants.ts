// 素材库在"删除参与方"登记表里的那一份（登记表见 deletion/participants.ts）：随删除彻底删掉由系统记下的素材（
// 分界）。原来在 projects/deletion.ts（ADR-0010）、tasks/deletion.ts里各写一遍。
// - 删项目：这个项目的内部任务由系统记下的记录（internal-records.ts：结局、计划和审批的决定、验收、提问卡的回答、建议卡被关掉……）；
// - 删任务：从这次改写了的事件采到的系统记录（任务的结局、计划和审批的决定、对产出的反应、回避信号……）。
// 用户本人说过的话（发言、投喂的材料、记忆命令）不删：原文副本里有（ADR-0006），重建时补回。
// - 断开数据源时连已导入的一起删：由它导入的记录（这次换成标记的那些事件）采成的素材，不分种类全删——用户选的就是
//   "连已导入的一起删"，本人的也删（原文副本跟着删，重建时不回来）。
// - 删任务、删项目时连会话一起删的：那个会话里本人的话挂的前文（前文就是被删的会话里对方的话），判它的 material_replies 里
//   这几项的总结换成删除标记，再追加一条 cleared 把素材上挂的撤掉（话本身作为素材留着，只是不再挂前文）。
// 照彻底删除的口径：同一事务记一条彻底删除的记忆命令（出处 project_deletion / task_deletion，不产生"显式记忆命令"素材——不是用户下的命令），
// 素材模块据此删掉素材和索引、记下墓碑，重建时不回来；改写它们的原始事件和带原话的记录。要看整张改写单，在 settle 一步里做：
// 已经改写了的事件不改第二遍（skip）；彻底删除连带追加的事件里，这次删除已经管了的不要——整个删掉的会话上的、卡片的新版本
// （整张换成标记的、另追加了新版本的），删项目时还有这个项目的范围记录的新版本。
import {
  type CardEventPayload,
  EVENT_TYPES,
  isDeletedEventPayload,
  maintainerChannel,
  type MaterialRepliesEventPayload,
  type MaterialReplyItem,
  PURGED_TEXT,
  type ScopeRecordEventPayload,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import { DATA_SOURCE_DELETION, type DeletionParticipants, type DeletionPlan, PROJECT_DELETION, TASK_DELETION } from "../deletion/participants.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { type Material, MATERIALS_CHANNEL, purgedReplyItem } from "../materials/index.ts";
import { deletionEvents } from "./deletion.ts";
import { USER_OWN_WORDS } from "./internal-records.ts";
import type { PurgeRewriters } from "./rewriters.ts";

export interface MaterialsDeletionDeps {
  store: EventStore;
  cards: CardService;
  rewriters: PurgeRewriters;
  /** 素材库里的素材（删任务时从中挑从改写了的事件采到的系统记录） */
  materials: () => readonly Material[];
  /** 这个项目的内部任务由系统记下的记录（素材库只保管时也找得到只在原文副本里的） */
  internalRecords: (projectId: string) => readonly Material[];
  /** 这些素材在推理库里的证据编号：问记忆的结果按证据编号引原话，一起找（同 PurgeDeps.evidenceOf） */
  evidenceOf?: (materialIds: readonly string[]) => readonly string[];
}

/** 追加的事件是这次删除已经管了的卡（整张换成标记的、另追加了新版本的）的新版本 */
const ofHandledCard = (plan: DeletionPlan, event: NewEvent) => event.type === EVENT_TYPES.card && plan.cardFate((event.payload as CardEventPayload).card.id) !== undefined;

/**
 * 连会话一起删时，这个会话里挂着的前文（总结的是被删的会话里对方的话）跟着删：判它的那几条 material_replies 里这个会话的几项
 * 总结换成删除标记；同一事务追加一条 cleared，素材上挂的撤掉（之后不再判）。没有挂着的不做
 */
function clearRepliesIn(plan: DeletionPlan, conversation: string): void {
  const cleared = new Map<string, MaterialReplyItem>();
  for (const event of plan.store.mentioning(EVENT_TYPES.materialReplies, conversation)) {
    if (isDeletedEventPayload(event.payload)) continue;
    const payload = event.payload as MaterialRepliesEventPayload;
    const hit = (item: MaterialReplyItem) => item.conversation === conversation && item.summary !== undefined && item.summary !== PURGED_TEXT;
    if (!payload.items.some(hit)) continue;
    for (const item of payload.items.filter(hit)) cleared.set(item.materialId, { materialId: item.materialId, conversation, verdict: "cleared" });
    plan.replace(event, { ...payload, items: payload.items.map((item) => (hit(item) ? purgedReplyItem(item) : item)) } satisfies MaterialRepliesEventPayload);
  }
  if (cleared.size === 0) return;
  const payload: MaterialRepliesEventPayload = { night: plan.context.deletedAt.slice(0, 10), items: [...cleared.values()] };
  plan.append("materials", { channel: MATERIALS_CHANNEL, type: EVENT_TYPES.materialReplies, payload });
}

/** 素材库登记的参与方：删项目、删任务各一个 */
export function registerMaterialsDeletion(participants: Pick<DeletionParticipants, "register">, deps: MaterialsDeletionDeps): () => void {
  const purgeDeps = (deletedAt: string) => ({ store: deps.store, cards: deps.cards, rewriters: deps.rewriters, now: () => deletedAt, ...(deps.evidenceOf ? { evidenceOf: deps.evidenceOf } : {}) });
  const undo = [
    participants.register(PROJECT_DELETION, {
      owner: "materials",
      join: ({ project }, plan) => ({
        settle() {
          // 项目负责人的会话整个删了：里面本人的话挂的前文跟着删
          clearRepliesIn(plan, maintainerChannel(project.maintainerId));
          const records = deps.internalRecords(project.id);
          if (records.length === 0) return;
          const purged = deletionEvents(purgeDeps(plan.context.deletedAt), {
            mode: "purge",
            materials: records,
            from: { kind: "project_deletion", projectId: project.id },
            skip: plan.claimedSeqs(),
          });
          for (const rewrite of purged.purge) plan.replace(rewrite, rewrite.payload);
          const handled = (event: NewEvent) =>
            event.channel === maintainerChannel(project.maintainerId) ||
            ofHandledCard(plan, event) ||
            (event.type === EVENT_TYPES.scopeRecord && (event.payload as ScopeRecordEventPayload).record.projectId === project.id);
          plan.append("materials", ...purged.events.filter((event) => !handled(event)));
        },
      }),
    }),
    participants.register(TASK_DELETION, {
      owner: "materials",
      join: ({ task, conversation }, plan) => ({
        settle() {
          // 任务自己的负责人会话整个删了：里面本人的话挂的前文跟着删
          if (conversation !== undefined) clearRepliesIn(plan, conversation);
          const purgedSeqs = plan.claimedSeqs();
          const records = deps.materials().filter((m) => !USER_OWN_WORDS.has(m.kind) && purgedSeqs.has(m.ref.event.globalSeq));
          if (records.length === 0) return;
          const purged = deletionEvents(purgeDeps(plan.context.deletedAt), { mode: "purge", materials: records, from: { kind: "task_deletion", taskId: task.id }, skip: purgedSeqs });
          for (const rewrite of purged.purge) plan.replace(rewrite, rewrite.payload);
          const handled = (event: NewEvent) => (conversation !== undefined && event.channel === conversation) || ofHandledCard(plan, event);
          plan.append("materials", ...purged.events.filter((event) => !handled(event)));
        },
      }),
    }),
    participants.register(DATA_SOURCE_DELETION, {
      owner: "materials",
      join: ({ source, counts }, plan) => ({
        settle() {
          const purgedSeqs = plan.claimedSeqs();
          const records = deps.materials().filter((m) => purgedSeqs.has(m.ref.event.globalSeq));
          if (records.length === 0) return;
          const purged = deletionEvents(purgeDeps(plan.context.deletedAt), { mode: "purge", materials: records, from: { kind: "data_source", source }, skip: purgedSeqs });
          for (const rewrite of purged.purge) plan.replace(rewrite, rewrite.payload);
          plan.append("materials", ...purged.events.filter((event) => !ofHandledCard(plan, event)));
          counts.materials += records.length;
        },
      }),
    }),
  ];
  return () => {
    for (const u of undo) u();
  };
}
