// @i18n-ignore-file model：上下文块、工具的说明和结果整个是给秘书（模型）看的（174 号票：给模型看的话照旧中文）；其余是日志
// 顺口问（264 号票接进线上，照 198 号票的规矩；271 号票：秘书按语气自己改写，有没有在答由记忆管理员夜里批量判）：
// 秘书每轮回话前，用这一轮用户的话从问题箱里挑一个"了解你问题"，选中了就作为这条输入后面的上下文块交给秘书——写明要问什么、
// 为什么问、可以不问，让它跟着当时的话题和语气用自己的话自然地带出来（用户 10-20："潜移默化的集成进去"），不再要求原样带 198 那一句。
// 秘书问了就调 mark_woven_question 标一下是哪个问题，标了才记"问过"，没标的不算（不再靠比对句子）。
// 问过、答过、跳过、"别问这个"都记在问题箱里（@ergo/memory 的 question_log），记忆页看得到。
//
// 一轮怎么走（都在记忆插件里：上下文块走 agent 贡献缝的 when: "input"，工具走 agent 贡献缝只给秘书，回话做完靠事件日志的 turn_end）：
// 1. 用户发来一句（秘书主会话、用户本人发的；秘书转达、网页指令、系统通知不算），开始处理它的那一刻（inputText）：
//    a. 先看上一轮：秘书紧挨着这句之前的那一轮标过某个"问过、等回答"的问题（会话里那次 mark_woven_question 的工具调用），
//       这句就是用户的下一句——白天的规则照旧只认明显的（readQuestionReply，不调模型）：在答 → 这句话的素材读成证据草稿
//       （evidenceDraftOf，和每晚整理读出来的一样，出处是素材 id，整理时按出处跳过）→ recordQuestionAnswer；跳过 → recordQuestionSkipped；
//       "别问这个" → declineQuestion（带上这句话）；规则认不出（隐含的回答、在说别的）→ 不动，问题还等着，留给每晚整理时
//       记忆管理员把问题和用户之后的几句话一起看（@ergo/memory 的 rg/reply-judge.ts，守护进程按会话取那几句：reply-follow-ups.ts）；
//    b. 再挑这一轮要不要顺口问（pickQuestion 的 peek：只看不记；settle: false：问了还没判的不在白天记跳过，留给夜里判）：
//       急事（文字里有"赶紧、马上……"）、秘书上一轮在等用户做决定（上一轮的回话里出了卡）、今天问过了、话题对不上的都不问；
//       330 号票（R15）：一次对话最多一个问题——这一次对话里秘书已经标过一个就不再挑，问题照旧留在问题箱里。"一次对话"（实现定，
//       ADR-0032）：从上一个分界算起，分界是新的一段会话（压缩、清空、换模型新开会话、回退切换分支：message-brief.ts 的 isSegmentStart），
//       或者前后两句隔了 CONVERSATION_IDLE_MS 以上（聊完一阵、过一会儿再来算新的一次）。在守护进程里数、不靠提示词自觉：每次从会话末尾
//       往回读到分界，看这中间有没有秘书标过的 mark_woven_question（不存状态，重启照样认）；每天最多一个照旧；
//       挑中了就在上下文块里写明问题的编号、要问的、为什么问、怎么问（用自己的话、可以不问）、问了先标一下。
// 2. 秘书这一轮里调了 mark_woven_question（markTool）：编号对得上这一轮交给它的那个才记下"标了"（不对的回错，不记）。
// 3. 这一轮回话做完（turn_end）：标了、也真的回了话，才记"问过"（markQuestionAsked）；没标的不记（同一天还能再挑）。
//    所以"每天最多一个"按真的问出去的算，没问出去的不会被当成"问了没答"记跳过、更不会因此记回避信号。
//
// 267 号票：问题箱和回答证据都经推理库的唯一写入口写，所以用随用随开的可写引擎（engine-provider.ts 的 createWritableEngineUse），
// 不用秘书那份缓存的读者引擎（它的写入口只读）；每次写写明是谁、经谁转达（WOVEN_VIA）：回答、跳过是用户的表态，"别问这个"是用户发起，
// 记"问过"是记忆管理员（ADR-0030：白天提顺口问归它），都"经秘书顺口问"。秘书的工具本身不写推理库，只在内存里记下这一轮标了哪个，
// 写在这一轮做完时由记忆插件（代记忆管理员）写——秘书照旧没有写推理库的路。
// 设置 · 记忆里关掉（memory/settings.ts，默认开）：两步都不做，上下文块是空的，工具回"关着"；已经问过、等回答的问题夜里照常判。
// 推理库用不了（还没建、版本对不上）：都不做。出错：记一行日志，这一轮当没有（不把秘书的这一轮弄坏）。
// 同一条输入可能被算几次（子进程崩了重新交、读附件慢）：按消息 id 记住算过的结果，回答、跳过不会记两次。
import type { MemoryEngine, QuestionView } from "@ergo/memory";
import type { MemoryEngineUse } from "./engine-provider.ts";
import { CHANNELS, EVENT_TYPES, type MessageEnvelope, settledVoiceText, t, type TurnEndEventPayload, Type, voiceIdsOf } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { SensitiveCategory } from "../config/config.ts";
import { agentRepliesAfter, agentRepliesBefore } from "../conversation/views.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { Materials } from "../materials/materials.ts";
import { getVoice } from "../voice-records/views.ts";
import { evidenceDraftOf } from "./evidence-source.ts";
import { isSegmentStart } from "./message-brief.ts";
import { MARK_WOVEN_QUESTION } from "./tool-names.ts";

export { MARK_WOVEN_QUESTION } from "./tool-names.ts";

/** 267 号票：顺口问这条路的写在留痕里记的"经谁转达" */
export const WOVEN_VIA = "经秘书顺口问";

/** 上下文块的抬头（秘书认它；测试也认它） */
export const WOVEN_QUESTION_HEAD = "【顺口问】";

/** 记住算过的输入最多几条（同一条输入再算一次时原样给，不重复记） */
const MEMO_LIMIT = 50;
/** 330 号票（R15）：前后两句隔了这么久算新的一次对话 */
export const CONVERSATION_IDLE_MS = 60 * 60 * 1000;
/** 330 号票：往回认这一次对话里问过没有：一批读几条事件、最多读几条（到上一个分界为止） */
const SCAN_BATCH = 200;
const SCAN_MAX = 5_000;

export interface WovenQuestionsOptions {
  /** 随用随开一份可写的引擎做一件事（engine-provider.ts 的 createWritableEngineUse，267 号票）；库用不了是 undefined */
  withEngine: MemoryEngineUse;
  /** 事件日志：读会话里的消息、语音的识别结果；330 号票：往回认这一段对话里顺口问过没有（readBefore） */
  store: Pick<EventStore, "reader" | "readBefore">;
  /** 素材库：找用户这句话的素材（回答回写成证据） */
  materials: Pick<Materials, "list">;
  /** 设置 · 记忆里顺口问开着没有（现取，改了下一条输入就按新的） */
  enabled: () => boolean;
  /** 允许用来推断的敏感类别（配置 memory.sensitiveCategories）：回答的素材落进没打开的类别时不回写 */
  inferableSensitiveCategories: () => readonly SensitiveCategory[];
  log: (line: string) => void;
}

export interface WovenQuestions {
  /** 秘书开始处理这条输入时跟在后面的上下文块（when: "input"）；没有是 undefined */
  inputText(message: MessageEnvelope): string | undefined;
  /** 秘书标"这一轮顺口问了哪个"的工具（271 号票，只给秘书） */
  markTool(): HostTool;
  /** 事件日志的订阅（store.onAppend）：秘书这一轮做完时看标了没有 */
  onEvent(event: StoredEvent): void;
}

/** 这一轮交给秘书的问题：哪条输入、哪个问题、对上在哪、秘书标了没有 */
interface Offer {
  inputMessageId: string;
  questionId: string;
  matchedOn: string;
  marked: boolean;
}

/**
 * 271 号票：秘书在这几条回话里标了哪个问题（mark_woven_question 做成了的那次调用的编号）；没标是 undefined。
 * 标错了编号、工具回错的（outcome 不是 done）不算
 */
export function markedQuestionOf(replies: readonly MessageEnvelope[]): string | undefined {
  for (const reply of replies.toReversed()) {
    for (const part of reply.parts.toReversed()) {
      if (part.type !== "tool_call" || part.tool !== MARK_WOVEN_QUESTION || part.outcome !== "done") continue;
      const id = /qu-\d+/.exec(part.argsSummary)?.[0];
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

/** 一条消息里给人看的文字：文字段，加上语音识别出来的字 */
function messageText(store: Pick<EventStore, "reader">, message: MessageEnvelope): string {
  const texts = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
  for (const voiceId of voiceIdsOf(message.parts)) {
    const voice = getVoice(store.reader, voiceId);
    const text = voice && settledVoiceText(voice);
    if (text) texts.push(text);
  }
  return texts.join("\n").trim();
}

/** agent 一条回话里的文字（文字段；想法、工具调用、卡片不算） */
const replyText = (message: MessageEnvelope) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** 截一下，写进给秘书的那一句 */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const VERDICT_TEXT = { yes: "是", no: "不是", unclear: "说不好" } as const;

/** 为什么问（给秘书的一句）：要弄清的那几种说法——是还没弄清的猜测，不说给用户听 */
function whyText(question: QuestionView): string {
  const statements = question.targets.map((target) => `「${clip(target.statement, 30)}」`);
  const what = statements.length >= 2 ? `是${statements.join("还是")}，现在分不清` : `${statements[0] ?? "一条关于他的推断"}对不对`;
  return `想弄清${what}。这些是还没弄清的猜测，别说给用户听，也别据此下结论`;
}

const MarkParams = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 32, description: "【顺口问】里那个问题的编号（qu- 开头）" }),
  },
  { additionalProperties: false },
);

export function createWovenQuestions(options: WovenQuestionsOptions): WovenQuestions {
  const { store, log } = options;

  /**
   * 330 号票（R15）：这一次对话里秘书已经标过（顺口问过）的问题；没有是 undefined。从会话末尾往回读：碰到新的一段会话停；
   * 碰到一句用户的话和它后面那句隔了 CONVERSATION_IDLE_MS 以上也停（它那一轮的回话算上一次对话的）。回话里的标记要等认出它属于
   * 哪一句用户的话（往回读时回话在那句话前面出现）才算数
   */
  const askedInConversation = (message: MessageEnvelope): string | undefined => {
    let newer = Date.parse(message.time);
    let pending: string | undefined;
    let before = Number.MAX_SAFE_INTEGER;
    let read = 0;
    while (read < SCAN_MAX) {
      const batch = store.readBefore(CHANNELS.secretary, before, SCAN_BATCH);
      for (const event of batch.toReversed()) {
        if (isSegmentStart(event)) return pending;
        if (event.type !== EVENT_TYPES.message) continue;
        const m = (event.payload as { message?: MessageEnvelope }).message;
        if (m === undefined || m.id === message.id) continue;
        if (m.speaker !== "user") {
          pending ??= markedQuestionOf([m]);
          continue;
        }
        const at = Date.parse(m.time);
        if (Number.isFinite(newer) && Number.isFinite(at) && newer - at >= CONVERSATION_IDLE_MS) return undefined;
        if (pending !== undefined) return pending;
        if (Number.isFinite(at)) newer = at;
      }
      read += batch.length;
      if (batch.length < SCAN_BATCH) break;
      before = batch[0]!.seq;
    }
    return pending;
  };
  /** 算过的输入：消息 id → 上下文块（没有是空串） */
  const memo = new Map<string, string>();
  /** 交给秘书、等这一轮做完再看标没标的：输入的消息 id → 问题 */
  const offers = new Map<string, Offer>();

  const remember = (messageId: string, text: string) => {
    memo.set(messageId, text);
    while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  };

  /** 这句话的素材读成的证据草稿；找不到素材、不能当依据（别推断、敏感类别）是 undefined */
  const evidenceOf = (message: MessageEnvelope) => {
    const drafts = options.materials
      .list({ messageId: message.id })
      // 337 号票：显式记忆命令的素材不算"用户在答这个"（用户让记的那一句不是回答；它由"记一句"那条路自己进推理库）
      .filter((material) => material.source === "self" && material.kind !== "memory_command")
      .map((material) => evidenceDraftOf(material, options.inferableSensitiveCategories()))
      .filter((draft) => draft !== undefined);
    // 一条消息带着附件、语音时可能有两条素材：取字最多的那条（说的话在那里）
    return drafts.toSorted((a, b) => b.text.length - a.text.length)[0];
  };

  /**
   * 1a：用户这句是不是在答上一轮问的那个（白天的规则只认明显的）；返回告诉秘书的一句（没有是 undefined）。
   * 规则认不出的不动：问题还等着回答，每晚整理时记忆管理员把它和用户之后的几句话一起判
   */
  function judgeReply(engine: MemoryEngine, message: MessageEnvelope, text: string, before: readonly MessageEnvelope[]): string | undefined {
    const markedId = markedQuestionOf(before);
    if (markedId === undefined) return undefined;
    const pending = engine.listQuestions({ status: "asked" }).find((q) => q.id === markedId);
    if (!pending) return undefined;
    const at = engine.store.now();
    const reading = engine.readQuestionReply(pending.id, text);
    const quoted = `「${clip(pending.text, 40)}」`;
    switch (reading.kind) {
      case "answer": {
        const draft = evidenceOf(message);
        if (!draft) {
          log(`顺口问：用户这句像是在答 ${pending.id}，但这句话没有能当依据的素材（别推断、敏感类别或者还没采到），不回写`);
          return undefined;
        }
        const record = engine.recordQuestionAnswer(pending.id, draft, { at, via: WOVEN_VIA });
        log(`顺口问：用户回答了 ${pending.id}，读成"${VERDICT_TEXT[record.verdict]}"（${record.applied === "now" ? "说得很明确，马上判了" : record.applied === "nightly" ? "下一夜按判法判" : "不判输赢"}），回答记成证据 ${record.evidenceId}`);
        return `${WOVEN_QUESTION_HEAD}用户这句回答了你上一轮顺口问的${quoted}，已经记进记忆（读成"${VERDICT_TEXT[record.verdict]}"）。照常回话就行，不用再追问这个问题。`;
      }
      case "decline": {
        const draft = evidenceOf(message);
        engine.declineQuestion(pending.id, { at, via: WOVEN_VIA, ...(draft === undefined ? {} : { evidence: draft }) });
        log(`顺口问：用户说别问 ${pending.id}（${reading.cue}），这一类不再问`);
        return `${WOVEN_QUESTION_HEAD}用户说别问这个：这一类以后不会再问了。回一句"好，不问了"就行，别再提这件事。`;
      }
      case "skip": {
        engine.recordQuestionSkipped(pending.id, { at, via: WOVEN_VIA });
        log(`顺口问：用户跳过了 ${pending.id}（${reading.cue}）`);
        return `${WOVEN_QUESTION_HEAD}用户跳过了你上一轮顺口问的${quoted}：不用再提，照常回话。`;
      }
      case "unrelated":
        // 271：白天的规则认不出（可能是隐含的回答）——不动，问题还等着，夜里记忆管理员看用户之后的几句话再判
        return undefined;
    }
  }

  /** 1b：这一轮要不要顺口问；返回给秘书的那几行（不问是 undefined） */
  function offerQuestion(engine: MemoryEngine, message: MessageEnvelope, text: string, before: readonly MessageEnvelope[]): string | undefined {
    // 330 号票（R15）：一次对话最多一个问题——这一次对话里已经问过了就不挑（问题照旧留在问题箱里，下一次对话、访谈里再说）
    const asked = askedInConversation(message);
    if (asked !== undefined) {
      log(`顺口问：这一次对话里已经顺口问过 ${asked} 了，一次对话最多一个，这一轮不挑`);
      return undefined;
    }
    // 秘书上一轮在等用户做决定：回话里出了卡（快速动作、审批……），或者用户这句引用了卡
    const awaitingDecision = message.parts.some((part) => part.type === "card_ref") || before.some((reply) => reply.parts.some((part) => part.type === "card_ref"));
    // 271：settle: false——问了还没判的不在白天记跳过（夜里记忆管理员判过再记）
    const pick = engine.pickQuestion(text, { at: engine.store.now(), peek: true, settle: false, awaitingDecision, actor: "curator", via: WOVEN_VIA });
    if (!pick.ask || pick.question === undefined) return undefined;
    const question = pick.question;
    for (const id of offers.keys()) if (id !== message.id) offers.delete(id);
    offers.set(message.id, { inputMessageId: message.id, questionId: question.id, matchedOn: pick.matchedOn ?? "", marked: false });
    return [
      `${WOVEN_QUESTION_HEAD}这一轮的话题对上了问题箱里的一个"了解你问题"（${question.id}）。`,
      `要问的：${question.text}`,
      `为什么问：${whyText(question)}。`,
      "怎么问：正事照常回完，觉得顺就用你自己的话、跟着这一轮的话题和语气自然地带一句（不用照抄上面的问法，也不用说\"顺便问一句\"）；" +
        "只问这一件具体的事，不问动机，不带诱导（不说\"是不是因为……\"），不解释为什么问、不追问。不合适就别问（太突兀、用户正烦着），这一轮当没这回事。" +
        "用户不接就算了；用户问起为什么问，照实说是想更了解他，不想答可以不答。",
      `问了的话，先调一次 ${MARK_WOVEN_QUESTION}（id 填 ${question.id}）再写回话——标了才算问过，用户之后有没有在答，记忆管理员夜里会看。没问就别调。`,
    ].join("\n");
  }

  function compute(message: MessageEnvelope): string {
    if (!options.enabled()) return "";
    const text = messageText(store, message);
    if (text === "") return "";
    const before = agentRepliesBefore(store.reader, message.conversation, message.id);
    const computed = options.withEngine((engine) => {
      const lines: string[] = [];
      try {
        const judged = judgeReply(engine, message, text, before);
        if (judged !== undefined) lines.push(judged);
      } catch (err) {
        log(`顺口问：读用户的回答出错：${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const offered = offerQuestion(engine, message, text, before);
        if (offered !== undefined) lines.push(offered);
      } catch (err) {
        log(`顺口问：挑问题出错：${err instanceof Error ? err.message : String(err)}`);
      }
      return lines.join("\n");
    });
    return computed ?? "";
  }

  /** 秘书正在处理的这一批输入交给它的那个问题 */
  const offerFor = (ids: readonly (string | undefined)[]): Offer | undefined => ids.flatMap((id) => (id === undefined ? [] : [offers.get(id)])).find((o) => o !== undefined);

  const markTool = defineHostTool({
    name: MARK_WOVEN_QUESTION,
    title: t("memory.tool.woven"),
    description:
      "标一下：这一轮你用自己的话问了【顺口问】交给你的那个\"了解你问题\"。决定要问了就先调一次（id 填【顺口问】里的编号）再写回话；" +
      "标了才算问过（用户之后有没有在答，记忆管理员夜里会看），没问就别调。只是记个标记，不改记忆。",
    parameters: MarkParams,
    readOnlyOrIdempotent: true,
    nature: "look",
    run(args, call) {
      if (!options.enabled()) return { text: "顺口问在设置里关着，不用标。", isError: true };
      const offer = offerFor([call.inputMessageId, ...(call.moreInputMessageIds ?? [])]);
      if (!offer) return { text: "这一轮没有交给你顺口问的问题，不用标。", isError: true };
      if (offer.questionId !== args.id.trim()) return { text: `这一轮交给你的顺口问是 ${offer.questionId}，不是 ${args.id}；问的是它才标。`, isError: true };
      offer.marked = true;
      return { text: `记下了：${offer.questionId} 这一轮问过（用户之后有没有在答，记忆管理员夜里会看）。接着写回话，用你自己的话自然地问出来；别提记下了这件事。` };
    },
  });

  return {
    inputText(message) {
      // 只管秘书主会话里用户本人发的（秘书转达、网页指令、系统通知不算）
      if (message.speaker !== "user" || message.relayedBy !== undefined || message.pageCommand !== undefined || message.conversation !== CHANNELS.secretary) return undefined;
      const known = memo.get(message.id);
      const text = known ?? compute(message);
      if (known === undefined) remember(message.id, text);
      return text === "" ? undefined : text;
    },
    markTool: () => markTool,
    onEvent(event) {
      if (event.channel !== CHANNELS.secretary || event.type !== EVENT_TYPES.turnEnd) return;
      const payload = event.payload as Partial<TurnEndEventPayload>;
      const offer = offerFor([payload.inputMessageId, ...(payload.moreInputMessageIds ?? [])]);
      if (!offer) return;
      offers.delete(offer.inputMessageId);
      try {
        if (!options.enabled()) return;
        if (!offer.marked) {
          log(`顺口问：秘书这一轮没标 ${offer.questionId}（没问或者忘了标），不记问过`);
          return;
        }
        const said = agentRepliesAfter(store.reader, CHANNELS.secretary, offer.inputMessageId).map(replyText).join("\n");
        if (said.trim() === "") {
          log(`顺口问：秘书标了 ${offer.questionId}，但这一轮没回出话来（被打断了），不记问过`);
          return;
        }
        options.withEngine((engine) =>
          engine.markQuestionAsked(offer.questionId, { at: engine.store.now(), how: `在聊天里顺着话题顺口问了（话题对上了：${offer.matchedOn}）`, via: WOVEN_VIA }),
        );
      } catch (err) {
        log(`顺口问：记"问过"出错：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
