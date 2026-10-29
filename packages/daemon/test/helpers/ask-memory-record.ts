// 272 号票：主切面里摆一次"秘书问过记忆"——秘书会话里一条 ask_memory 的调用记录（结果摘要）和它的完整内容（完整返回），
// 简报里按证据编号引着某条素材的原话。真让秘书问一遍要靠检索碰巧带出那条证据；彻底删除找的是事件日志里的这两条，直接摆出来。
import { CHANNELS, EVENT_TYPES, type MessageEventPayload, type ToolCallDetail } from "@ergo/protocol";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { appendMessage } from "../../src/conversation/messages.ts";
import type { EventStore } from "../../src/events/event-store.ts";
import { recordToolCallDetail, TOOL_CALLS_CHANNEL } from "../../src/guard-runtime/tool-call-details.ts";
import { purgedEvidenceIds } from "../../src/memory/purged-evidence.ts";

/** 这条素材在数据目录的推理库里是哪条证据（整理过一次之后才有） */
export function evidenceOfMaterial(dataDir: string, materialId: string): string | undefined {
  return purgedEvidenceIds(dataDirLayout(dataDir).rgDb, [materialId])[0];
}

/** 秘书调了一次 ask_memory：调用记录和完整内容，返回调用 id */
export function appendAskMemory(store: EventStore, callId: string, brief: string): string {
  appendMessage(store, {
    conversation: CHANNELS.secretary,
    speaker: "agent",
    parts: [{ type: "tool_call", callId, tool: "ask_memory", argsSummary: "question=我最近在忙什么？", categoryTitles: [], withinGrant: false, genericBash: false, outcome: "done", resultSummary: brief }],
  });
  const detail: ToolCallDetail = { callId, agentId: "secretary", conversation: CHANNELS.secretary, tool: "ask_memory", args: { question: "我最近在忙什么？" }, outcome: "done", result: brief, isError: false };
  recordToolCallDetail(store, detail);
  return callId;
}

/** 那次调用现在的结果摘要和完整返回 */
export function askMemoryNow(store: EventStore, callId: string): { summary: string | undefined; result: string | undefined } {
  const record = store.read(CHANNELS.secretary, 0, EVENT_TYPES.message).find((e) => JSON.stringify(e.payload).includes(`"callId":${JSON.stringify(callId)}`));
  const part = (record?.payload as MessageEventPayload | undefined)?.message.parts[0];
  const detail = store.read(TOOL_CALLS_CHANNEL).map((e) => e.payload as ToolCallDetail).find((d) => d.callId === callId);
  return { summary: part?.type === "tool_call" ? part.resultSummary : undefined, result: detail?.result };
}
