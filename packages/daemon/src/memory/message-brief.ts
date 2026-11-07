// @i18n-ignore-file model：上下文块整个是给秘书（模型）看的（给模型看的话照旧中文）；其余是日志
// 每条消息的记忆简报（CONTEXT.md"记忆简报"）：用户发来一句话，有相关的记忆就自动给秘书带一份——相关的结论连同支撑它的原话
// （标明用户说的还是推断的、把握多少），追加在这一轮输入的尾部；没有相关的就不带。目标是"不用交代上下文"：相关记忆自己送到秘书手里，
// 不靠秘书想起来去问。醒来时的简报（context.ts）、按需问记忆（ask-tool.ts）照旧。
//
// 开销边界，这里照做：
// - 判"有没有相关"只用本机检索和相关门槛（@ergo/memory 的 messageBrief：三条路里有"直接说到这件事"的结论才带），不调大模型；
// - 上限用 BRIEF_LIMITS（实验 D 组那档，不用 ask_memory 那档）；同一段对话里带过、没变的结论不再带，只补新的；
// - 追加在这一轮输入的尾部（agent 贡献缝的 when: "input"，和看板变化、顺口问拼成一条跟在用户消息后面的上下文消息），
//   不进系统提示、不改前面的历史，保住前缀缓存；
// - "好的""谢谢""嗯"这类短应答不带（isShortReply）；
// - 用量页单独列"记忆简报"一项（每带一次记一笔估的 token，ledger 的 context_usage）；记忆页的设置里能关（memoryBrief，默认开）。
//
// "同一段对话"：秘书的会话从上一次压缩、清空当前对话、换模型新开会话、回退切换分支之后算起——这些之后前面带过的已经不在模型的上下文里了，
// 再带。带过的记在秘书这一轮回话的 MemoryBriefPart 上（brought：键 → 指纹，只有编号和哈希），守护进程重启后从会话里往回认到上一个分界；
// 运行中跟着事件日志，碰到分界就清空。
//
// 一条输入可能被算几次（子进程崩了重新交、读附件慢）：按消息 id 记住算过的结果。算得太慢（超过 MESSAGE_BRIEF_TIMEOUT_MS）这一轮就不带、
// 记一行日志，不拖住回话；推理库用不了、出错也不带。每问完一次（带上、没相关的、超时、出错）给 stats 记一笔结局和用时
// （brief-stats.ts，412：体检的"记忆简报"那一项看最近 24 小时超时加出错占几成）。
//
// 这一段简报不再直接问引擎，改成问**记忆插件**（注入进来的 brief，组合根传记忆插件宿主的 host.brief：插件声明了
// capabilities.brief 就用它的，没有就宿主拿 search 拼），行为一样——抬头、INTRO、"带过没变的不再带"、3 秒上限、记账都没动。
// 插件回来的是 { text, keys, items, hits }：正文照原样跟在下面，keys（键 → 指纹）是"这次带上了哪几条"，下一轮当 known 交回去
// （插件据此不重复带没变的），items / hits 就是回话上那份结构化部分。只回字符串的插件（老实现）也收：等于没有键——不去重，
// 每一轮都带，结构化那两样是空的。还没接插件时（只有引擎的装配、老测试）走 engine 直接问引擎，用的是和会意插件里同一个算法
// （engineMessageBrief），算出来的东西一模一样。
//
// 各步耗时（427）：问插件时带上 onStep，插件每做完一步报一次（会意报：等向量模型、打开推理库、检索、往上走的起点、三条路找结论、
// 向量门槛、任务建议、挑结论和原话、拼正文、对回素材；这边自己记"往回认带过的"）。每算一次记一笔（MessageBriefRun：结果、总耗时、
// 做完的各步），日志一行带各步毫秒；超时的那一份不扔，后来算完再记一行它一共用了多久。最近 MESSAGE_BRIEF_RECENT 次和累计次数由
// stats() 交出去（体检用）。用户发来一句话时先叫 prewarm 把向量模型拉起来（不等），省得模型闲置卸掉以后这一条再从头加载。
import { estimateTokens, type MemoryEngine } from "@ergo/memory";
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
import type { BriefStats } from "./brief-stats.ts";

/** 上下文块的抬头（秘书认它；测试也认它） */
export const MESSAGE_BRIEF_HEAD = "【记忆简报】";

/** 交给秘书的那块的第一行：这是什么、怎么用 */
const INTRO = `${MESSAGE_BRIEF_HEAD}和用户这句话相关的记忆（二狗自动带上的，这些不用再 ask_memory 查；"推断的"是二狗推出来的、不是用户说的，引用时说清是推断的、带把握；只引用下面出现的编号）`;

/** 算一份简报最多等多久（毫秒）：超过这个这一轮就不带 */
export const MESSAGE_BRIEF_TIMEOUT_MS = 3000;

/**
 * 向量模型还没加载好（闲置卸掉了、刚起来）时简报最多等它多久（毫秒）：等到了照常算，等不到这一轮不算向量、只走关键词
 * （先带拿得到的，不让整份简报跟着模型加载一起超时）。要比 MESSAGE_BRIEF_TIMEOUT_MS 小得多，给后面的检索留出时间
 */
export const BRIEF_MODEL_WAIT_MS = 1200;

/** stats() 留最近几次 */
export const MESSAGE_BRIEF_RECENT = 50;

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
 * 引擎那一份每条消息的简报包成插件回来的形状：
 * - 会意插件的 brief 用它（插件只包一层，算法还是这一份）；
 * - 还没接记忆插件时（只有引擎的装配、老测试）createMessageBriefs 也用它，所以两条路算出来的东西一模一样。
 * 正文为空（不相关、都带过了）是 undefined；不给素材库时命中的素材是空的（结构化那一样不得）。
 */
export async function engineMessageBrief(engine: MemoryEngine, input: MemoryBriefInput, materials?: Pick<Materials, "get">): Promise<MemoryBriefResult | undefined> {
  const known = input.known === undefined ? undefined : new Map(Object.entries(input.known));
  const brief = await engine.messageBrief(input.text, {
    at: engine.store.now(),
    ...(known === undefined || known.size === 0 ? {} : { known }),
    ...(input.onStep === undefined ? {} : { onStep: input.onStep }),
  });
  if (brief.text === "") return undefined;
  const started = performance.now();
  const items: MemoryBriefItem[] = brief.items.map((item) => ({ key: item.key, kind: item.kind, reason: item.reason, claimIds: [...item.claimIds], routes: [...item.routes] }));
  const hits: MemoryRecallHit[] = materials === undefined ? [] : briefRecallHits(engine, brief, materials);
  input.onStep?.("hits", Math.round(performance.now() - started));
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
 * 顺口问的"一次对话最多一个问题"也拿它当分界之一（woven-questions.ts）
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

/** 一步：名字（插件定，会意报的见 STEP_LABELS）、用了多少毫秒 */
export interface MessageBriefStepTiming {
  step: string;
  ms: number;
}

/** 算一次简报的记录（stats() 里最近几次就是它） */
export interface MessageBriefRun {
  /** 开始算的时间（ISO） */
  at: string;
  /** brought 带了；empty 没带（不相关、相关的都带过了、库用不了）；timeout 超过上限这一轮没带；error 出错没带 */
  outcome: "brought" | "empty" | "timeout" | "error";
  /** 从开始到有结果用了多少毫秒（超时的是到上限那一刻；含往回认带过的） */
  ms: number;
  /** 做完的各步，按先后（超时的先记到上限那一刻做完的，后来算完了补全） */
  steps: MessageBriefStepTiming[];
  /** 带了几条（brought 才有） */
  items?: number;
  /** 超时的那一份后来一共用了多少毫秒（算完或出错为止）；还没回来是 undefined */
  lateMs?: number;
}

/** 体检要的统计（stats()） */
export interface MessageBriefStats {
  /** 从什么时候开始数的（这一份建起来的时候：守护进程起来、记忆插件启用） */
  since: string;
  /** 从 since 起一共算了几次（asked；短应答、简报关着、同一条输入再取的不算），各种结果各几次 */
  counts: { asked: number; brought: number; empty: number; timeout: number; error: number };
  /** 最近 MESSAGE_BRIEF_RECENT 次，旧的在前 */
  recent: MessageBriefRun[];
}

/** 日志里各步的叫法（会意报的那几步；不认识的照原名写） */
const STEP_LABELS: Readonly<Record<string, string>> = {
  recall: "往回认带过的",
  modelLoad: "等向量模型加载",
  modelCold: "向量模型没等到、这一轮不算向量",
  open: "打开推理库",
  search: "检索",
  base: "往上走的起点",
  userModel: "三条路找结论",
  vectorGate: "向量门槛",
  advice: "任务建议",
  profile: "挑结论和原话",
  render: "拼正文",
  hits: "对回素材",
};

/** 日志里的各步：用了时间的（和"没等到模型"这一步）按先后写 */
function stepsText(steps: readonly MessageBriefStepTiming[]): string {
  const shown = steps.filter((s) => s.ms > 0 || s.step === "modelCold").map((s) => `${STEP_LABELS[s.step] ?? s.step} ${s.ms}`);
  return shown.length === 0 ? "" : `；各步：${shown.join("、")}`;
}

export interface MessageBriefsOptions {
  /**
   * 问记忆要这一段简报：组合根传记忆插件宿主的 host.brief——插件声明了 capabilities.brief 就用它的，
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
  /** 记忆页的设置里记忆简报开着没有（现取，改了下一条输入就按新的） */
  enabled: () => boolean;
  /** 带了一次：记一笔用量（用量页的"记忆简报"）；不给就不记 */
  record?: (usage: MessageBriefUsage) => void;
  /** 最多等多久（毫秒），默认 MESSAGE_BRIEF_TIMEOUT_MS */
  timeoutMs?: number;
  /**
   * 用户在秘书这边发来一句话（事件日志里一出现就叫，不等秘书开始处理）：把向量模型拉起来、不等它（插件给 secretaryEmbedder.warm(0)）。
   * 语音要先识别，等秘书开始算简报时模型多半已经加载好了。简报关着不叫；不给就不叫
   */
  prewarm?: () => void;
  /** 现在（ISO），记录里的 at 用；默认机器时间 */
  now?: () => string;
  /** 每问完一次记一笔（结局、用了多久；体检读，brief-stats.ts）；不给就不记 */
  stats?: Pick<BriefStats, "record">;
  log: (line: string) => void;
}

export interface MessageBriefs {
  /** 秘书开始处理这条输入时跟在后面的那块（when: "input"）；不带是 undefined */
  inputText(message: MessageEnvelope, target: { agentId: string }): Promise<string | undefined> | undefined;
  /** 这条输入的回话要带上的结构化部分（算好了才有，取一次就没了） */
  replyParts(message: MessageEnvelope): MessagePart[] | undefined;
  /** 事件日志的订阅（store.onAppend）：秘书的会话到了新的一段（压缩、清空、换模型、回退），前面带过的作废；用户发来一句话时预热 */
  onEvent(event: StoredEvent): void;
  /** 算过几次、各是什么结果、最近几次各步用了多久（体检用；交出去的是拷贝） */
  stats(): MessageBriefStats;
}

const TIMED_OUT = Symbol("timeout");

/** 用户本人在秘书主会话里发的一句（简报只管这种；秘书转达、网页指令不算） */
function isUserInput(message: MessageEnvelope): boolean {
  return message.speaker === "user" && message.relayedBy === undefined && message.pageCommand === undefined && message.conversation === CHANNELS.secretary;
}

export function createMessageBriefs(options: MessageBriefsOptions): MessageBriefs {
  const { store, log } = options;
  const timeoutMs = options.timeoutMs ?? MESSAGE_BRIEF_TIMEOUT_MS;
  const now = options.now ?? (() => new Date().toISOString());
  /** 这一段对话里带过的：键 → 指纹；undefined 是还没从会话里认过 */
  let known: Map<string, string> | undefined;
  /** 算过的输入：消息 id → 那块（不带是 undefined） */
  const memo = new Map<string, Promise<string | undefined>>();
  /** 算好了、等这一轮的回话带上的 */
  const pending = new Map<string, MemoryBriefPart>();
  /** 统计（stats()） */
  const since = now();
  const counts: MessageBriefStats["counts"] = { asked: 0, brought: 0, empty: 0, timeout: 0, error: 0 };
  const recent: MessageBriefRun[] = [];

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

  /** 这一次算完了（或超时、出错）：记进统计 */
  const finish = (run: MessageBriefRun, outcome: MessageBriefRun["outcome"], ms: number, steps: readonly MessageBriefStepTiming[]) => {
    run.outcome = outcome;
    run.ms = ms;
    run.steps = [...steps];
    counts[outcome] += 1;
    options.stats?.record(outcome, outcome === "timeout" ? timeoutMs : ms);
    recent.push(run);
    while (recent.length > MESSAGE_BRIEF_RECENT) recent.shift();
  };

  async function compute(message: MessageEnvelope, text: string, agentId: string): Promise<string | undefined> {
    counts.asked += 1;
    const run: MessageBriefRun = { at: now(), outcome: "empty", ms: 0, steps: [] };
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    // 插件每做完一步报一次；超时以后还在报的照样记下（后来那一行日志用）
    const steps: MessageBriefStepTiming[] = [];
    const onStep = (step: string, ms: number) => {
      steps.push({ step, ms });
    };
    if (known === undefined) {
      known = recall();
      onStep("recall", elapsed());
    }
    const segment = known;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    try {
      // 这一段带过的（键 → 指纹）交回给插件：指纹没变的不再带。插件不做去重（keys 空）时它就是空的 —— 每一轮都带
      const asking = ask({ text, conversation: { id: message.conversation, agentId }, known: Object.fromEntries(segment), onStep });
      const asked = await Promise.race([asking, timeout]);
      if (asked === TIMED_OUT) {
        finish(run, "timeout", elapsed(), steps);
        log(`记忆简报超时（超过 ${timeoutMs} 毫秒），这一轮不带${steps.length === 0 ? "；一步都没做完" : stepsText(steps)}`);
        // 超时的那一份接着算完（不扔、也不再用）：记一行它一共用了多久、各步多久——看清慢在哪一步
        asking.then(
          () => {
            run.lateMs = elapsed();
            run.steps = [...steps];
            log(`记忆简报：超时的那一份后来算完了，一共 ${run.lateMs} 毫秒${stepsText(steps)}`);
          },
          (err: unknown) => {
            run.lateMs = elapsed();
            run.steps = [...steps];
            log(`记忆简报：超时的那一份后来出错了（${run.lateMs} 毫秒）：${err instanceof Error ? err.message : String(err)}`);
          },
        );
        return undefined;
      }
      // 只回字符串的是老实现：只有正文，没有键（不去重），也没有结构化那两样
      const brief: MemoryBriefResult | undefined = typeof asked === "string" ? { text: asked } : asked;
      if (brief === undefined || brief.text === "") {
        finish(run, "empty", elapsed(), steps);
        log(`记忆简报：没有要带的（${run.ms} 毫秒${stepsText(steps)}）`);
        return undefined;
      }
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
      for (const [key, print] of Object.entries(brought)) segment.set(key, print);
      pending.set(message.id, part);
      options.record?.({ agentId, kind: "memory_brief", chars: block.length, tokens });
      run.items = items.length;
      finish(run, "brought", elapsed(), steps);
      log(`记忆简报：带了 ${items.length} 条（约 ${tokens} token，${run.ms} 毫秒${stepsText(steps)}）`);
      return block;
    } catch (err) {
      finish(run, "error", elapsed(), steps);
      log(`记忆简报出错，这一轮不带：${err instanceof Error ? err.message : String(err)}（${run.ms} 毫秒${stepsText(steps)}）`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    inputText(message, target) {
      // 只管秘书主会话里用户本人发的（秘书转达、网页指令、系统通知不算）
      if (!isUserInput(message)) return undefined;
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
      if (event.channel !== CHANNELS.secretary) return;
      if (isSegmentStart(event)) {
        known = new Map();
        return;
      }
      // 用户发来一句：先把向量模型拉起来（不等），秘书开始算简报时多半已经加载好了
      if (options.prewarm === undefined || event.type !== EVENT_TYPES.message || isDeletedEventPayload(event.payload)) return;
      if (isUserInput((event.payload as MessageEventPayload).message) && options.enabled()) options.prewarm();
    },
    stats() {
      return { since, counts: { ...counts }, recent: recent.map((run) => ({ ...run, steps: run.steps.map((s) => ({ ...s })) })) };
    },
  };
}
