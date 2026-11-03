// 存下的外部信息在素材库这一侧（存它的工具在记忆插件里，memory/ingest-tool.ts）：素材频道上的 material_ingested 事件怎么变成素材、
// 彻底删除时怎么改写、看素材时从原始事件里取回存下的东西。
// - 素材（记忆插件的数据契约里登记，停用也登记）：一条"存下的外部信息"（ingested_info），来源外部（不可信）、算"说"。
//   内容是一段引用块：说明是标题（进关键词索引，读成证据时就是这句），正文只记哈希——不进切段、不进原文副本，推断不拿它当用户的话；
//   正文和出处进检索的索引（MaterialDraft.indexText：关键词全文、向量算开头），秘书按正文、按出处检索得到。
//   时间是存的时间（二狗知道这件事的时间）；信息本身的时间（capturedAt）留在事件里，检索结果、读素材、设置里点开时写明。
//   会话是存它的那个会话；指向原始记录的引用是这一条的编号（ref.recordId）；
// - 检索结果里的那一段、读素材的全文、设置里点开时的正文和出处都从这条事件里取（ingestedOf）：事件还在、对得上、
//   没被彻底删除改写过才有；
// - 彻底删除：改写函数把标题、正文、出处换成删除标记，编号、时间、种类、会话、调用这些不变；改写过的不再采。
//   存它的那次工具调用（参数里就是正文）由彻底删除那一套按记下的 toolCallId 一起改写（memory/purge.ts）；
// - 建议几天后清理（ttlDays）：只是记下，到了在素材列表上标出来（ingestedCleanup），不自动删。
import { EVENT_TYPES, ingestedCleanupAtMs, isDeletedEventPayload, type MaterialIngestedEventPayload, nowIso, PURGED_TEXT } from "@ergo/protocol";
import type { EventStore } from "../events/event-store.ts";
import type { PurgeRewriter } from "../events/purge.ts";
import type { MaterialSource } from "./capture.ts";
import { segmentPieces } from "./segments.ts";
import type { Material } from "./types.ts";

/** 素材来源的名字（素材 id 由它和事件算出来，定了就别改） */
export const MATERIAL_INGESTED_SOURCE = "material-ingested";

/** 存下的一条：采成一条存下的外部信息，正文只进检索的索引；彻底删除改写过的（正文换成了删除标记）不再采 */
export const materialIngestedSource: MaterialSource = {
  name: MATERIAL_INGESTED_SOURCE,
  eventType: EVENT_TYPES.materialIngested,
  capture(event) {
    const p = event.payload as Partial<MaterialIngestedEventPayload>;
    if (typeof p.id !== "string" || typeof p.text !== "string" || p.text === PURGED_TEXT || p.text.trim() === "") return [];
    const title = typeof p.title === "string" ? p.title.trim() : "";
    const sourceRef = typeof p.sourceRef === "string" ? p.sourceRef : "";
    return [
      {
        kind: "ingested_info",
        source: "external_untrusted",
        ...(typeof p.time === "string" ? { time: p.time } : {}),
        ...(typeof p.conversation === "string" ? { conversation: p.conversation } : {}),
        segments: segmentPieces([{ form: "quote", text: p.text, ...(title === "" ? {} : { label: title }), locator: { field: "text" } }]),
        ref: { recordId: p.id },
        indexText: [p.text, sourceRef].filter((s) => s.trim() !== "").join("\n"),
      },
    ];
  },
};

/**
 * 素材是存下的外部信息时，从它的原始事件里取存下的东西：事件还在、对得上、没被彻底删除改写过才有。
 * 设置里点开这条（memory/browse.ts）、秘书检索和读素材（memory/search-tool.ts）都用它
 */
export function ingestedOf(store: Pick<EventStore, "eventAt">, m: Pick<Material, "ref">): MaterialIngestedEventPayload | undefined {
  const { channel, seq, type } = m.ref.event;
  if (type !== EVENT_TYPES.materialIngested) return undefined;
  const event = store.eventAt(channel, seq);
  if (!event || event.type !== type || isDeletedEventPayload(event.payload)) return undefined;
  const p = event.payload as MaterialIngestedEventPayload;
  if (p.id !== m.ref.recordId || p.text === PURGED_TEXT) return undefined;
  return p;
}

/** 建议清理的时间（存的时间加 ttlDays 天，协议时间）和到了没有；没给建议几天后清理的、时间写法不对的没有 */
export function ingestedCleanup(p: Pick<MaterialIngestedEventPayload, "time" | "ttlDays">, now: number): { at: string; due: boolean } | undefined {
  if (p.ttlDays === undefined) return undefined;
  const at = ingestedCleanupAtMs(p.time, p.ttlDays);
  if (Number.isNaN(at)) return undefined;
  return { at: nowIso(new Date(at)), due: now >= at };
}

/** 彻底删除：标题、正文、出处换成删除标记，别的不变 */
export const materialIngestedPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.materialIngested,
  rewrite(event) {
    const p = event.payload as MaterialIngestedEventPayload;
    return { ...p, title: PURGED_TEXT, text: PURGED_TEXT, sourceRef: PURGED_TEXT } satisfies MaterialIngestedEventPayload;
  },
};
