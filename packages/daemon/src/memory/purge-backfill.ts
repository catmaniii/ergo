// 彻底删除的一次性补抹（272 号票第 1 条）：265 号票起彻底删除才会按证据编号改写问记忆（ask_memory）那次调用的记录和完整内容，
// 而 purgePlan 只在删的那一刻算一次——10-21（232 号票）有问记忆以来、265 号票上线以前做过的彻底删除，事件日志里问记忆的结果还留着
// 被删素材的原话（会话文件那一半守护进程启动时会按以前的 messages_purged 补，但只补得到在秘书会话上留了 messages_purged 的那几次）。
// 守护进程启动时（插件起来以后、秘书起来以前）跑一次：
// - 按已登记的彻底删除找：素材频道上 command 为 purge 的记忆命令（对话里的记忆删除卡、设置里成批删、删项目和删任务时连带的都算），
//   被删素材背后的证据编号由调用方给（purged-evidence.ts：还在推理库里的按出处、删掉的按审计）；
// - 保守：只换被删素材的原话。问记忆、问记忆管理员（ask_curator，272 号票第 3 条）的调用记录（结果摘要）和完整内容（完整返回）里，
//   提到这些证据编号（问记忆管理员另看素材 id）的行连同这一条的续行（原话、精炼、没合上的「」）换成"- 编号 · 删除标记"
//   （util/mentions.ts 的 replaceMentionLines，和会话文件那一侧同一个认法）；参数、工具、结局、调用记忆的部分（只有编号、种类、时间）
//   和别的行一个字不动；早就整条换成删除标记的（265 号票起删的）换不出东西，不动；
// - 同一事务在秘书的会话上追加一条 messages_purged：改写过的调用记录给出改写后的样子（开着的页面换掉手里的），列上被删的素材——
//   秘书据此把会话文件里问记忆、问记忆管理员、检索素材的结果按编号再换一遍（完整内容过了保留期清掉了的，会话文件里也照样补得到），
//   每条消息的记忆简报（266 号票，跟在用户输入后面的上下文消息，只在会话文件里引原话）也按证据编号换（after-purge.ts 的 contextLines）；
//   所以被删素材背后有证据就追加，事件日志里一条没改也追加；
// - 做完在内部频道记一笔（PURGE_BACKFILL_KEY 幂等键：只记一次，以后启动看到它就不再跑）。推理库查不了（打不开、版本对不上、读出错）
//   时不补、不记，下次启动再补；推理库没建、没登记过彻底删除的，没有要补的，照样记一笔。
// 改写成什么不走改写函数表（那一套是"带原话的字段整个换掉"）：这里只换字段里的几行，字段级的规矩不变（结构字段原样保留）。
import { CHANNELS, EVENT_TYPES, isDeletedEventPayload, type MemoryCommandEventPayload, type MessageEventPayload, type MessagesPurgedEventPayload, PURGED_TEXT, type ToolCallDetail } from "@ergo/protocol";
import { isConversationChannel } from "../conversation/history.ts";
import { isToolCallRecord } from "../conversation/purge.ts";
import type { EventStore, NewEvent, PurgeRewrite, StoredEvent } from "../events/event-store.ts";
import { detailEventsOfTool } from "../guard-runtime/tool-call-details.ts";
import { MATERIALS_CHANNEL } from "../materials/index.ts";
import { INTERNAL_CHANNEL } from "../scheduler/internal-jobs.ts";
import { replaceMentionLines } from "../util/mentions.ts";
import { ASK_CURATOR, ASK_MEMORY } from "./tool-names.ts";

/** 记一笔的事件（内部频道，前端订阅不到） */
export const PURGE_BACKFILL_EVENT = "purge_backfill";
/** 记一笔的幂等键：只记一次 */
export const PURGE_BACKFILL_KEY = "purge-backfill:ask-memory-quotes";

/** 记一笔的负载：只有编号和条数，没有原话 */
export interface PurgeBackfillPayload {
  at: string;
  /** 登记过的彻底删除里被删的素材几条、背后的证据几条 */
  materials: number;
  evidence: number;
  /** 改了几条调用记录、几份完整内容；是哪几次调用 */
  records: number;
  details: number;
  calls: string[];
}

export interface PurgeBackfillOptions {
  store: EventStore;
  /** 被删素材背后的证据编号；查不了是 undefined（这次不补、不记，下次启动再补） */
  evidenceOf: (materialIds: readonly string[]) => readonly string[] | undefined;
  now: () => string;
  log: (line: string) => void;
}

export type PurgeBackfillResult =
  | { state: "already" }
  | { state: "deferred" }
  | { state: "done"; records: number; details: number; calls: string[] };

/** 要看的工具和各自按什么认：问记忆按证据编号；问记忆管理员的回答是它自己写的话，证据编号、素材 id 都可能提 */
const TOOLS: ReadonlyArray<{ tool: string; withMaterialIds: boolean }> = [
  { tool: ASK_MEMORY, withMaterialIds: false },
  { tool: ASK_CURATOR, withMaterialIds: true },
];

/** 已登记的彻底删除里被删的素材（去重，按先后） */
function purgedMaterialIds(store: EventStore): string[] {
  const ids = new Set<string>();
  for (const event of store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.memoryCommand)) {
    if (isDeletedEventPayload(event.payload)) continue;
    const command = event.payload as MemoryCommandEventPayload;
    if (command.command === "purge") for (const id of command.materialIds) ids.add(id);
  }
  return [...ids];
}

/** 会话里一条某个工具的调用记录（只有一个工具调用 part 的消息）的那个 part；不是的 undefined */
function toolCallPart(event: StoredEvent, tool: string) {
  if (event.type !== EVENT_TYPES.message || !isConversationChannel(event.channel) || isDeletedEventPayload(event.payload)) return undefined;
  const parts = (event.payload as MessageEventPayload).message.parts;
  return isToolCallRecord(parts) && parts.length === 1 && parts[0]!.tool === tool ? parts[0] : undefined;
}

export function backfillPurgedQuotes(options: PurgeBackfillOptions): PurgeBackfillResult {
  const { store, log } = options;
  if (store.eventByIdempotencyKey(PURGE_BACKFILL_KEY)) return { state: "already" };
  const materialIds = purgedMaterialIds(store);
  const evidenceIds = materialIds.length === 0 ? [] : options.evidenceOf(materialIds);
  if (evidenceIds === undefined) {
    log("彻底删除的补抹（272 号票）：推理库这会儿查不了被删素材的证据编号，这次不补，下次启动再补"); // @i18n-ignore log
    return { state: "deferred" };
  }
  const at = options.now();
  const purge: PurgeRewrite[] = [];
  const calls = new Set<string>();
  /** 各会话里改写过的调用记录：messages_purged 里给出改写后的样子 */
  const replaced = new Map<string, MessagesPurgedEventPayload["messages"]>();
  let records = 0;
  let details = 0;
  if (evidenceIds.length > 0) {
    for (const { tool, withMaterialIds } of TOOLS) {
      const needles = withMaterialIds ? [...evidenceIds, ...materialIds] : [...evidenceIds];
      // 调用记录：结果摘要里的那几行（负载是 JSON，按 JSON 里的写法先筛出这个工具的）
      for (const event of store.mentioning(EVENT_TYPES.message, `"tool":${JSON.stringify(tool)}`)) {
        const part = toolCallPart(event, tool);
        if (part?.resultSummary === undefined) continue;
        const summary = replaceMentionLines(part.resultSummary, needles, PURGED_TEXT, { continuation: true });
        if (summary === undefined) continue;
        const payload = event.payload as MessageEventPayload;
        const message = { ...payload.message, parts: [{ ...part, resultSummary: summary }] };
        purge.push({ globalSeq: event.globalSeq, payload: { ...payload, message } satisfies MessageEventPayload });
        replaced.set(event.channel, [...(replaced.get(event.channel) ?? []), { seq: event.seq, messageId: message.id, replacement: message }]);
        calls.add(part.callId);
        records += 1;
      }
      // 完整内容：完整返回里的那几行（参数是问题，不是素材的原话，不动）
      for (const event of detailEventsOfTool(store, tool)) {
        const detail = event.payload as ToolCallDetail;
        const result = replaceMentionLines(detail.result, needles, PURGED_TEXT, { continuation: true });
        if (result === undefined) continue;
        purge.push({ globalSeq: event.globalSeq, payload: { ...detail, result } satisfies ToolCallDetail });
        if (detail.conversation !== null && !replaced.has(detail.conversation)) replaced.set(detail.conversation, []);
        calls.add(detail.callId);
        details += 1;
      }
    }
  }
  // 秘书的会话（问记忆、问记忆管理员、每条消息的记忆简报只给秘书）：有被删素材的证据就追加一条，会话文件里的结果、简报按编号再换一遍
  if (evidenceIds.length > 0 && !replaced.has(CHANNELS.secretary)) replaced.set(CHANNELS.secretary, []);
  const purgedEvents: NewEvent[] = [...replaced].map(([conversation, messages]) => ({
    channel: conversation,
    type: EVENT_TYPES.messagesPurged,
    payload: { messages, materialIds, toolCallIds: [], mediaIds: [], deletedAt: at } satisfies MessagesPurgedEventPayload,
  }));
  const mark: PurgeBackfillPayload = { at, materials: materialIds.length, evidence: evidenceIds.length, records, details, calls: [...calls] };
  store.appendBatch([...purgedEvents, { channel: INTERNAL_CHANNEL, type: PURGE_BACKFILL_EVENT, payload: mark, idempotencyKey: PURGE_BACKFILL_KEY }], { purge });
  if (records + details > 0) log(`彻底删除的补抹（272 号票）：问记忆、问记忆管理员的 ${calls.size} 次调用里引着被删素材原话的行换成了删除标记（调用记录 ${records} 条、完整内容 ${details} 份）`); // @i18n-ignore log
  return { state: "done", records, details, calls: [...calls] };
}
