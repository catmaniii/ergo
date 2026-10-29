// @i18n-ignore-file model：上下文块整个是给秘书（模型）看的（174 号票：给模型看的话照旧中文）；其余是日志
// 每条消息的记忆简报（266 号票，CONTEXT.md"记忆简报"）：用户发来一句话，有相关的记忆就自动给秘书带一份——相关的结论连同支撑它的原话
// （标明用户说的还是推断的、把握多少），追加在这一轮输入的尾部；没有相关的就不带。目标是"不用交代上下文"：相关记忆自己送到秘书手里，
// 不靠秘书想起来去问。醒来时的简报（context.ts）、按需问记忆（ask-tool.ts）照旧。
//
// 用户 2026-10-25 定的开销边界，这里照做：
// - 判"有没有相关"只用本机检索和相关门槛（@ergo/memory 的 messageBrief：三条路里有"直接说到这件事"的结论才带），不调大模型；
// - 上限用 BRIEF_LIMITS（实验 D 组那档，不用 ask_memory 那档）；同一段对话里带过、没变的结论不再带，只补新的；
// - 追加在这一轮输入的尾部（agent 贡献缝的 when: "input"，和看板变化、顺口问拼成一条跟在用户消息后面的上下文消息），
//   不进系统提示、不改前面的历史，保住前缀缓存；
// - "好的""谢谢""嗯"这类短应答不带（isShortReply）；
// - 用量页单独列"记忆简报"一项（每带一次记一笔估的 token，ledger 的 context_usage）；设置 · 记忆里能关（memoryBrief，默认开）。
//
// "同一段对话"：秘书的会话从上一次压缩、清空当前对话、换模型新开会话、回退切换分支之后算起——这些之后前面带过的已经不在模型的上下文里了，
// 再带。带过的记在秘书这一轮回话的 MemoryBriefPart 上（brought：键 → 指纹，只有编号和哈希），守护进程重启后从会话里往回认到上一个分界；
// 运行中跟着事件日志，碰到分界就清空。
//
// 一条输入可能被算几次（子进程崩了重新交、读附件慢）：按消息 id 记住算过的结果。算得太慢（超过 MESSAGE_BRIEF_TIMEOUT_MS）这一轮就不带、
// 记一行日志，不拖住回话；推理库用不了、出错也不带。
//
// 337 号票：这一段简报不再直接问引擎，改成问**记忆插件**（注入进来的 brief，组合根传记忆插件宿主的 host.brief：插件声明了
// capabilities.brief 就用它的，没有就宿主拿 search 拼），行为一样——抬头、INTRO、"带过没变的不再带"、3 秒上限、记账都没动。
// 插件回来的是 { text, keys, items, hits }：正文照原样跟在下面，keys（键 → 指纹）是"这次带上了哪几条"，下一轮当 known 交回去
// （插件据此不重复带没变的），items / hits 就是回话上那份结构化部分。只回字符串的插件（老实现）也收：等于没有键——不去重，
// 每一轮都带，结构化那两样是空的。还没接插件时（只有引擎的装配、老测试）走 engine 直接问引擎，用的是和会意插件里同一个算法
// （engineMessageBrief），算出来的东西一模一样。
import { type Embedder, estimateTokens, type MemoryEngine } from "@ergo/memory";
import {
  agentSessionStart,
  CHANNELS,
  EVENT_TYPES,
  isDeletedEventPayload,
  type MemoryBriefInput,
  type MemoryBriefItem,
  type MemoryBriefPart,
  type MemoryBriefResult,
  type MemoryBriefReturn,
  type MemoryRecallHit,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  settledVoiceText,
  type TimelineRecordEventPayload,
  voiceIdsOf,
} from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { Materials } from "../materials/index.ts";
import { getVoice } from "../voice-records/views.ts";
import { briefRecallHits } from "./ask-tool.ts";

/** 上下文块的抬头（秘书认它；测试也认它） */
export const MESSAGE_BRIEF_HEAD = "【记忆简报】";

/** 交给秘书的那块的第一行：这是什么、怎么用 */
const INTRO = `${MESSAGE_BRIEF_HEAD}和用户这句话相关的记忆（二狗自动带上的，这些不用再 ask_memory 查；"推断的"是二狗推出来的、不是用户说的，引用时说清是推断的、带把握；只引用下面出现的编号）`;

/** 算一份简报最多等多久（毫秒）：实测线上一条约 0.3 秒（266 号票 Comments），超过这个这一轮就不带 */
export const MESSAGE_BRIEF_TIMEOUT_MS = 3000;

/** 记住算过的输入最多几条 */
const MEMO_LIMIT = 50;
/** 重启后往回认带过的：一批读几条事件、最多读几条（到上一个分界为止） */
const SCAN_BATCH = 500;
const SCAN_MAX = 20_000;

/** 短应答：去掉空白、标点、表情以后只剩这些（可以连着说、带语气字："好的谢谢""嗯嗯好""可以啊"） */
const ACK =
  /^(?:(?:好|好的|行|可以|没问题|嗯|恩|哦|噢|喔|收到|知道了|明白|明白了|懂了|了解|谢谢|谢谢你|谢了|多谢|感谢|辛苦了|辛苦|ok|okay|对|对的|是的|是|没事|算了|拜拜|晚安|哈|嘿|嘻)[啊呀吧呢啦嘛哦喔噢嘞滴哈]*)+$/i;
const NOISE = /[\s\p{P}\p{S}\p{Extended_Pictographic}]/gu;

/** "好的""谢谢""嗯"这类短应答（空的也算）：不带记忆简报 */
export function isShortReply(text: string): boolean {
  const plain = text.replace(NOISE, "").toLowerCase();
  return plain === "" || ACK.test(plain);
}

/**
 * 查询向量记住最近几句（一份简报里几处检索、相关门槛都要算同一句话的查询向量，bge-m3 每次约 25 毫秒）：
 * 同一句话只算一次。文档向量照常算。向量是确定的，记住不影响结果
 */
export function queryMemoEmbedder(inner: Embedder, size = 16): Embedder {
  const memo = new Map<string, Float32Array>();
  return {
    model: inner.model,
    available: () => inner.available(),
    unavailableHint: () => inner.unavailableHint(),
    embedDocuments: (texts) => inner.embedDocuments(texts),
    async embedQueries(texts) {
      const missing = [...new Set(texts.filter((t) => !memo.has(t)))];
      if (missing.length > 0) {
        const vectors = await inner.embedQueries(missing);
        missing.forEach((t, i) => memo.set(t, vectors[i]!));
        while (memo.size > size) memo.delete(memo.keys().next().value!);
      }
      return texts.map((t) => memo.get(t)!);
    },
    close: () => inner.close(),
  };
}

/**
 * 引擎那一份每条消息的简报（266 号票）包成插件回来的形状（337 号票）：
 * - 会意插件的 brief 用它（插件只包一层，算法还是这一份）；
 * - 还没接记忆插件时（只有引擎的装配、老测试）createMessageBriefs 也用它，所以两条路算出来的东西一模一样。
 * 正文为空（不相关、都带过了）是 undefined；不给素材库时命中的素材是空的（结构化那一样不得）。
 */
export async function engineMessageBrief(engine: MemoryEngine, input: MemoryBriefInput, materials?: Pick<Materials, "get">): Promise<MemoryBriefResult | undefined> {
  const known = input.known === undefined ? undefined : new Map(Object.entries(input.known));
  const brief = await engine.messageBrief(input.text, { at: engine.store.now(), ...(known === undefined || known.size === 0 ? {} : { known }) });
  if (brief.text === "") return undefined;
  const items: MemoryBriefItem[] = brief.items.map((item) => ({ key: item.key, kind: item.kind, reason: item.reason, claimIds: [...item.claimIds], routes: [...item.routes] }));
  const hits: MemoryRecallHit[] = materials === undefined ? [] : briefRecallHits(engine, brief, materials);
  return { text: brief.text, keys: { ...brief.brought }, items, hits };
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

/**
 * 秘书的会话从这里起是新的一段（前面带过的已经不在模型的上下文里）：压缩过、清空当前对话、换模型新开会话、回退切换分支。
 * 330 号票：顺口问的"一次对话最多一个问题"也拿它当分界之一（woven-questions.ts）
 */
export function isSegmentStart(event: StoredEvent): boolean {
  if (isDeletedEventPayload(event.payload)) return false;
  if (event.type === EVENT_TYPES.timelineRecord) return (event.payload as TimelineRecordEventPayload).record.kind === "compaction";
  if (event.type === EVENT_TYPES.sessionBranch) return true;
  if (event.type !== EVENT_TYPES.message) return false;
  const message = (event.payload as MessageEventPayload).message;
  return message.speaker === "system" && agentSessionStart(message);
}

/** 一条消息事件里的记忆简报 part */
function briefPartsOf(event: StoredEvent): MemoryBriefPart[] {
  if (event.type !== EVENT_TYPES.message || isDeletedEventPayload(event.payload)) return [];
  return (event.payload as MessageEventPayload).message.parts.filter((p): p is MemoryBriefPart => p.type === "memory_brief");
}

/** 每带一次记的用量（ledger 的 context_usage） */
export interface MessageBriefUsage {
  agentId: string;
  kind: "memory_brief";
  chars: number;
  tokens: number;
}

export interface MessageBriefsOptions {
  /**
   * 问记忆要这一段简报（337 号票）：组合根传记忆插件宿主的 host.brief——插件声明了 capabilities.brief 就用它的，
   * 没有就宿主拿 search 拼。回一份（正文 + 这次带上了哪几条），只回字符串也行（没有键 → 不去重、每一轮都带）；
   * 不带是 undefined。给了它就只用它
   */
  brief?: (input: MemoryBriefInput) => Promise<MemoryBriefReturn | undefined>;
  /**
   * 没接记忆插件时问谁（只有引擎的装配、老测试）：和会意插件里那一份同一个算法（engineMessageBrief）。
   * 给了 brief 就轮不到它；用不了是 undefined
   */
  engine?: () => MemoryEngine | undefined;
  /** 事件日志：读这句话（语音的识别结果）、往回认带过的 */
  store: Pick<EventStore, "reader" | "readBefore">;
  /** 素材库：简报引的证据对回素材（进"回忆了 N 条记忆"） */
  materials: Pick<Materials, "get">;
  /** 设置 · 记忆里记忆简报开着没有（现取，改了下一条输入就按新的） */
  enabled: () => boolean;
  /** 带了一次：记一笔用量（用量页的"记忆简报"）；不给就不记 */
  record?: (usage: MessageBriefUsage) => void;
  /** 最多等多久（毫秒），默认 MESSAGE_BRIEF_TIMEOUT_MS */
  timeoutMs?: number;
  log: (line: string) => void;
}

export interface MessageBriefs {
  /** 秘书开始处理这条输入时跟在后面的那块（when: "input"）；不带是 undefined */
  inputText(message: MessageEnvelope, target: { agentId: string }): Promise<string | undefined> | undefined;
  /** 这条输入的回话要带上的结构化部分（算好了才有，取一次就没了） */
  replyParts(message: MessageEnvelope): MessagePart[] | undefined;
  /** 事件日志的订阅（store.onAppend）：秘书的会话到了新的一段（压缩、清空、换模型、回退），前面带过的作废 */
  onEvent(event: StoredEvent): void;
}

const TIMED_OUT = Symbol("timeout");

export function createMessageBriefs(options: MessageBriefsOptions): MessageBriefs {
  const { store, log } = options;
  const timeoutMs = options.timeoutMs ?? MESSAGE_BRIEF_TIMEOUT_MS;
  /** 这一段对话里带过的：键 → 指纹；undefined 是还没从会话里认过 */
  let known: Map<string, string> | undefined;
  /** 算过的输入：消息 id → 那块（不带是 undefined） */
  const memo = new Map<string, Promise<string | undefined>>();
  /** 算好了、等这一轮的回话带上的 */
  const pending = new Map<string, MemoryBriefPart>();

  /** 问谁要这一段简报：注入的 brief（记忆插件）优先；没注入就回头问引擎（和会意插件里同一份算法） */
  const ask = (input: MemoryBriefInput): Promise<MemoryBriefReturn | undefined> => {
    if (options.brief !== undefined) return options.brief(input);
    const engine = options.engine?.();
    return engine === undefined ? Promise.resolve(undefined) : engineMessageBrief(engine, input, options.materials);
  };

  /** 从会话末尾往回读到上一个分界：这一段里带过的（早的先并、晚的盖上） */
  const recall = (): Map<string, string> => {
    const parts: MemoryBriefPart[] = [];
    let before = Number.MAX_SAFE_INTEGER;
    let read = 0;
    scan: while (read < SCAN_MAX) {
      const batch = store.readBefore(CHANNELS.secretary, before, SCAN_BATCH);
      for (const event of batch.toReversed()) {
        if (isSegmentStart(event)) break scan;
        parts.push(...briefPartsOf(event).toReversed());
      }
      read += batch.length;
      if (batch.length < SCAN_BATCH) break;
      before = batch[0]!.seq;
    }
    const map = new Map<string, string>();
    for (const part of parts.toReversed()) for (const [key, print] of Object.entries(part.brought)) map.set(key, print);
    return map;
  };

  async function compute(message: MessageEnvelope, text: string, agentId: string): Promise<string | undefined> {
    known ??= recall();
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      // 这一段带过的（键 → 指纹）交回给插件：指纹没变的不再带。插件不做去重（keys 空）时它就是空的 —— 每一轮都带
      const asked = await Promise.race([ask({ text, conversation: { id: message.conversation, agentId }, known: Object.fromEntries(known) }), timeout]);
      if (asked === TIMED_OUT) {
        log(`记忆简报超时（超过 ${timeoutMs} 毫秒），这一轮不带`);
        return undefined;
      }
      if (asked === undefined) return undefined;
      // 只回字符串的是老实现：只有正文，没有键（不去重），也没有结构化那两样
      const brief: MemoryBriefResult = typeof asked === "string" ? { text: asked } : asked;
      if (brief.text === "") return undefined;
      const block = `${INTRO}\n${brief.text}`;
      const tokens = estimateTokens(block);
      const items = brief.items ?? [];
      const brought = brief.keys ?? {};
      const part: MemoryBriefPart = {
        type: "memory_brief",
        recall: { source: "brief", hits: brief.hits ?? [] },
        items: items.map((item) => ({ key: item.key, kind: item.kind, reason: item.reason, claimIds: [...item.claimIds], routes: [...item.routes] })),
        brought: { ...brought },
        tokens,
        chars: block.length,
      };
      for (const [key, print] of Object.entries(brought)) known.set(key, print);
      pending.set(message.id, part);
      options.record?.({ agentId, kind: "memory_brief", chars: block.length, tokens });
      log(`记忆简报：带了 ${items.length} 条（约 ${tokens} token，${Date.now() - started} 毫秒）`);
      return block;
    } catch (err) {
      log(`记忆简报出错，这一轮不带：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    inputText(message, target) {
      // 只管秘书主会话里用户本人发的（秘书转达、网页指令、系统通知不算）
      if (message.speaker !== "user" || message.relayedBy !== undefined || message.pageCommand !== undefined || message.conversation !== CHANNELS.secretary) return undefined;
      const computed = memo.get(message.id);
      if (computed) return computed;
      if (!options.enabled()) return undefined;
      const text = messageText(store, message);
      if (isShortReply(text)) return undefined;
      const pendingBlock = compute(message, text, target.agentId);
      memo.set(message.id, pendingBlock);
      while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
      return pendingBlock;
    },
    replyParts(message) {
      const part = pending.get(message.id);
      if (!part) return undefined;
      pending.delete(message.id);
      return [part];
    },
    onEvent(event) {
      if (event.channel === CHANNELS.secretary && isSegmentStart(event)) known = new Map();
    },
  };
}
