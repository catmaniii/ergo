// 项目在"删除参与方"登记表里的那一份（279 号票；登记表见 deletion/participants.ts，删除的顺序见 deletion.ts 和 ADR-0010）。
// 组装函数（system.ts）登记；工单（work-orders/purge.ts）、运营方案（operations/deletion.ts）各登记各的，内核里拥有属于项目的事件的
// 模块（任务、子 agent、触发底座、守卫接入、范围审视、待我处理、素材库）在组合根登记。这里是项目自己的：
// - 维护者会话频道上的事件：整条换成"已删除"标记（会话文件整个删掉，用户本人的话在素材的原文副本里）；
// - 立项书：charters 频道上交出的每一版、确认、立项要求变更（125 号票），照彻底删除的改写函数换掉正文；立项书卡、立项要求变更卡
//   字段级改写、追加改写后的新版本（状态不变：立项书卡还是已处理）；
// - 规范改写（261 号票）：standards 频道上提出的每一次、用户的决定，"规范改写"卡，同上；
// - 说的是这个项目的几种卡整张换成标记："首版做完了"卡（112 号票，说的是项目的建设任务）、"运营方案变更"卡（130 号票，说的是项目的
//   内部任务）、"转入使用"确认卡（259 号票，带着运营方案、维护者和秘书写的为什么）、"补齐规范文档"卡（262 号票）；
// - 项目之外读过这个项目的调用（66 号票，outside-reads.ts 找）：秘书会话里的、跨项目任务自己的维护者和评审子 agent 的。完整内容、
//   效果日志（按调用 id 和 agent，旧的按紧跟着）、执行记录和同一段调用摘要出现的别处（只认这个 agent 的）、会话里的工具调用记录，
//   照彻底删除的口径字段级改写（调用本身、工具名、结局留着；据此说过的话不改）；这些会话另追加 messages_purged（前端换掉手里的
//   工具调用记录，agent 据此改写会话文件里这几次调用的参数和返回）——要看改写后的样子，在 settle 一步里追加。
import { CHANNELS, EVENT_TYPES, type CardEventPayload, maintainerChannel, type ToolCallDetail } from "@ergo/protocol";
import { type DeletionParticipants, liveEvents, PROJECT_DELETION } from "../deletion/participants.ts";
import { effectCallOf, effectEventsOfCall, toolCallRecordsOf } from "../guard-runtime/effect-log.ts";
import { executionTraces, messagesPurgedEvents } from "../memory/purge.ts";
import { CHARTER_EVENTS, type CharterChangeProposedPayload, CHARTERS_CHANNEL, type CharterSubmittedPayload, STANDARD_EVENTS, type StandardChangeProposedPayload, STANDARDS_CHANNEL } from "./events.ts";
import { outsideReadsOf } from "./outside-reads.ts";
import type { ProjectRecordsPaths } from "./records.ts";

/** 说的是这个项目、随项目整张换成标记的卡（负载里有项目编号） */
const PROJECT_CARD_TYPES: ReadonlySet<string> = new Set(["build_done", "operations_change", "go_live", "standard_backfill"]);

/** 项目自己登记的参与方（删项目）：records 是项目档案的路径（找项目之外读过它的调用） */
export function registerProjectDeletion(participants: Pick<DeletionParticipants, "register">, deps: { records: (projectId: string) => ProjectRecordsPaths }): () => void {
  const undoOwn = participants.register(PROJECT_DELETION, {
    owner: "projects",
    join: ({ project }, plan) => ({
      claim() {
        const { store } = plan;
        // 维护者会话：整条换成"已删除"标记
        for (const event of liveEvents(store.read(maintainerChannel(project.maintainerId)))) plan.marker(event);
        // 说的是这个项目的几种卡
        for (const event of liveEvents(store.read(CHANNELS.cards, 0, EVENT_TYPES.card))) {
          const { card } = event.payload as CardEventPayload;
          if (PROJECT_CARD_TYPES.has(card.type) && (card.payload as { projectId?: unknown } | undefined)?.projectId === project.id) plan.dropCard(card.id);
        }
        // 立项书：交出的每一版、确认，以及立项书卡、立项要求变更卡
        for (const event of liveEvents(store.read(CHARTERS_CHANNEL))) {
          if ((event.payload as { projectId?: string }).projectId !== project.id) continue;
          plan.rewrite(event);
          if (event.type === CHARTER_EVENTS.submitted) plan.purgeCard((event.payload as CharterSubmittedPayload).cardId);
          if (event.type === CHARTER_EVENTS.changeProposed) plan.purgeCard((event.payload as CharterChangeProposedPayload).cardId);
        }
        // 规范改写：提出的每一次、用户的决定，以及"规范改写"卡
        for (const event of liveEvents(store.read(STANDARDS_CHANNEL))) {
          if ((event.payload as { projectId?: string }).projectId !== project.id) continue;
          plan.rewrite(event);
          if (event.type === STANDARD_EVENTS.changeProposed) plan.purgeCard((event.payload as StandardChangeProposedPayload).cardId);
        }
      },
    }),
  });
  const undoOutside = participants.register(PROJECT_DELETION, {
    owner: "projects:outside-reads",
    join: ({ project }, plan) => {
      /** 会话 → 这次改写了的调用（会话文件里也要改） */
      const outsideCalls = new Map<string, Set<string>>();
      return {
        claim() {
          const { store } = plan;
          for (const event of outsideReadsOf(store, project, deps.records(project.id))) {
            const detail = event.payload as ToolCallDetail;
            const call = effectCallOf(detail);
            plan.rewrite(event);
            for (const effect of liveEvents(effectEventsOfCall(store, call, [event]))) plan.rewrite(effect);
            for (const trace of liveEvents(executionTraces(store, detail.callId, detail.agentId))) plan.rewrite(trace);
            if (detail.conversation === null) continue;
            for (const record of toolCallRecordsOf(store, call)) plan.rewrite(record);
            outsideCalls.set(detail.conversation, (outsideCalls.get(detail.conversation) ?? new Set()).add(detail.callId));
          }
        },
        settle() {
          if (outsideCalls.size === 0) return;
          plan.append("conversations", ...messagesPurgedEvents(plan.rewritten().filter(({ event }) => outsideCalls.has(event.channel)), outsideCalls, plan.context));
        },
      };
    },
  });
  return () => {
    undoOwn();
    undoOutside();
  };
}
