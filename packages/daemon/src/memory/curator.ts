// 记忆管理员（242 号票）：一个按需拉起的 agent，负责整理记忆、解释自己的结论、按用户要求改正或忘掉东西；不编造。
//
// 为什么是 agent：用户 2026-10-21 的想法——"每天凌晨 3 点维护记忆的就是这个记忆管理 agent……平时要找他问一些事情，
// 或者让他临时处理一些东西也可以……点它就会跳到负责管理记忆的这个 agent 入口"。225 号票起每晚整理是记忆插件的一个内部作业，
// 没有一个能对话的对象；这一票把它升级成"03:00 由它被唤醒去整理"，平时在记忆页（#/more/memory/curator）也能找它说话。
//
// 和别的东西的关系：
// - **整理还是同一条确定性路径**（评测跑的就是 runNightly）：管理员只是外面那层壳。03:00 的内部作业不自己调 runNightly，
//   改成唤醒管理员；管理员调 run_memory_consolidation（就是 235 号票那个"立即整理一次"的内核：同一个引擎、同一份
//   memory.maxModelCalls、同一条整理记录）。管理员这一轮没调成（模型坏了、没听明白）时作业照旧补跑一次，整夜不空转；
//   开机时补跑错过的 03:00 那一次（catch_up）赶在管理员挂上之前，直接按老路径整理（那一夜没有日记，整理照常）；
// - 引擎那 200 次照旧是硬上限；管理员自己每夜额外最多 memory.curator.maxModelCalls 次（默认 8，只做叙述和判断）：
//   从 token 账本里数它这一夜调了几次，跑满就停下这一轮，下一夜照常；次数补进那一夜的整理记录（curatorModelCalls）；
// - 失败：整理失败照旧记 failed / rebuild_needed 和待我处理；管理员起不来什么都不写，也别让整夜崩（作业会补跑）；
// - 平时：它的会话就是普通的输入输出（网页在记忆页那一层订阅、发消息），工具是那一套只读/写记忆的（见 curator-tools.ts），
//   没有改配置、删素材库、改别人会话的工具；用户要那些，它明确说"这个我不做"；
// - 秘书的 ask_memory 是轻量快速通道（232 号票），不动；深聊、动手（改状态、忘掉、别推断）在记忆管理员这里。秘书判断是这类事时，
//   用 ask_curator（curator-link.ts）把用户的话转给管理员、把它的回答带回来——分工写在两边的系统提示里。
//
// 生命周期（243 号票：照维护者的规矩按需拉起，不占 agents.maxLive 的常驻名额）：守护进程起来（记忆插件在运行）时只建壳
// ——会话对象、⚙ 的 handle、工具、提示都准备好，不拉起 pi 子进程；网页看历史、看板卡、⚙ 不用它活着。第一次有人跟它说话
// （网页记忆页发消息、秘书用 ask_curator 转达）或者 03:00 的作业唤醒它时，由会话照常拉起（名额满了排队），先拉起再交那条输入；
// 闲置到 agents.idleMinutes 后照维护者的规矩退出，再来输入时重新唤起、接着同一个会话。插件停用、守护进程停止时跟着停；
// 提示词改了从下一轮起重新拉起。
//
// 284 号票（了解你访谈）：
// - 多四个访谈工具（interview-tools.ts：开一次、收尾、"这个别记"、档案信息出核对卡），访谈的记录和发起在记忆插件里（interview.ts，
//   服务 MEMORY_INTERVIEWS，组合根和每晚整理一样从插件取来交给这里）；问法写在它的系统提示（prompts/memory-curator.md），访谈开着时
//   另跟在每一轮输入后面（会话的 inputContext：开场那一轮的问法要点、用户每次回答的"第几个来回"，会话里看不到）；
// - 接上语音回复（和秘书、维护者同一套，conversation/session-tools.ts 的 sessionVoice）：语音插件开着时，用户在它的会话里按住说话，
//   这一轮的回话由运行时合成语音（像打电话一样一问一答）；口语总结、发语音两个工具随语音插件现取，守卫看到的工具包跟着；
//   语音插件运行中停用、启用时从下一轮起重新拉起。没开语音插件就是文字。
import type { Embedder } from "@ergo/memory";
import { localDate } from "@ergo/memory";
import { type MessageEnvelope, type MessagesPurgedEventPayload, type MessageEventPayload, MEMORY_CURATOR_AGENT_ID, MEMORY_CURATOR_CONVERSATION, t } from "@ergo/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import type { HostTool, HostToolCall, HostToolOutput } from "../agent-manager/host-tools.ts";
import type { AgentHandle } from "../agent-settings/index.ts";
import { AgentSession } from "../conversation/agent-session.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import { type SessionTools, sessionVoice } from "../conversation/session-tools.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { lastClearMarker } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import type { GuardAgent } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { PromptId, PromptLibrary } from "../prompts/index.ts";
import type { ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import { clockIso, type Clock } from "../scheduler/clock.ts";
import type { JobTrigger } from "../scheduler/internal-jobs.ts";
import type { MemoryConfig } from "../config/config.ts";
import type { Materials } from "../materials/index.ts";
import type { MemoryNightlyService } from "./api.ts";
import { CURATOR_TOOL_NAMES, curatorTools } from "./curator-tools.ts";
import { createMemoryGraphReader, type MemoryGraphReader } from "./graph.ts";
import type { MemoryInterviews } from "./interview.ts";
import { interviewInputContext, interviewTools, openBoxQuestions } from "./interview-tools.ts";
import type { MemoryNightlyRecord } from "./nightly-record.ts";
import type { MaterialToolOptions } from "./search-tool.ts";

export { MEMORY_CURATOR_AGENT_ID, MEMORY_CURATOR_CONVERSATION };

/** 改了哪几份系统提示要重新拉起：它自己的、前缀 */
const CURATOR_PROMPTS: readonly PromptId[] = ["memory-curator", "prefix"];

/** 03:00 的唤醒消息开头（给模型看的标记，也是会话里那一行的开头） */
export const CURATOR_WAKE_TAG = "【记忆整理】"; // @i18n-ignore model：交给 agent 的唤醒消息（也是会话里的一行）

/** 唤醒消息的幂等键：一夜一条（重启后补跑不重复问） */
export const CURATOR_WAKE_KEY_PREFIX = "memory-curator-wake:";

/** 它这一轮最多等多久（毫秒）：一次整理本身有 memory.nightlyTimeoutMinutes 的墙钟上限，这里再多给 10 分钟收尾 */
const WAKE_MARGIN_MS = 10 * 60_000;

/** 等不到这一轮结束时，多久看一次会话还在不在（毫秒） */
const WAIT_TICK_MS = 1_000;

/** 会话里一条 turn_end 的负载（只看用得上的几项） */
interface TurnEndLike {
  inputMessageId?: string;
  moreInputMessageIds?: readonly string[];
}

export interface MemoryCuratorOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  guards: GuardRuntime;
  media: MediaStore;
  prompts: Pick<PromptLibrary, "render" | "revision" | "onChange" | "onAgentChange">;
  /** 用户自己的名字（249 号票）：改了下一条输入之前按新的系统提示重新拉起；不给就不管 */
  userName?: { onChange(fn: () => void): () => void };
  /** 每次模型调用记一条（数管理员这一夜额外花了几次） */
  ledger: { onRecorded(listener: (entry: { agentId: string }) => void): () => void };
  clock: Clock;
  /** 发给模型的每条消息前面的本地时间标记按它换算 */
  timeZone: string;
  /** 守卫看到的 cwd：它没有文件工具、也没有 bash，这里只是形式（给数据目录里一个真实路径） */
  cwd: string;
  /** rg.db 的路径（推理库） */
  file: string;
  /** manifest 里记的整理模型名（默认 deepseek-flash） */
  model?: string;
  /** 向量函数（打开引擎时给；不给就不算向量） */
  embedder?: Embedder;
  /** 素材库（检索、读全文、认素材） */
  materials: Materials;
  /** 素材工具看不到的、存的网页（和秘书那一份同一套） */
  materialOptions: MaterialToolOptions;
  /** 每晚整理（记忆插件提供的服务） */
  nightly: MemoryNightlyService;
  /** 配置的 memory 一节（管理员的预算） */
  config: MemoryConfig;
  /**
   * 283 号票：个人档案的摘要（号码、住址不列）——接在它的系统提示末尾当情境，不当证据；档案改了从下一轮起按新的重新拉起。
   * 不给就没有
   */
  background?: () => string;
  /** 它的模型（242 号票先跟随秘书的） */
  modelSpec: () => ModelSpec;
  credentials: Record<string, string>;
  configuredVision: () => Readonly<Record<string, boolean>>;
  /** 彻底删除之后会话文件要改写哪些原话；不给就不改写 */
  sessionRewriteFor?: (purges: readonly MessagesPurgedEventPayload[]) => Omit<SessionRewriteRequest, "sessionDir">;
  /** 了解你访谈（284 号票，记忆插件提供的服务）：不给就没有访谈工具 */
  interviews?: MemoryInterviews;
  /** 访谈里听到的档案信息出核对卡（281 号票的快速动作 personal_file，总是出卡）；不给就提不了 */
  proposePersonalFile?: (params: unknown, call: HostToolCall) => HostToolOutput | Promise<HostToolOutput>;
  /** 每个会话都配的那一份（284 号票只用它的语音回复：按住说话时回话合成语音）；不给就只有文字 */
  sessionTools?: SessionTools;
  log: (line: string) => void;
}

export interface MemoryCurator {
  /** 给它一个 ⚙（提示词、清空、上下文用量；模型那行先跟随秘书的） */
  agentHandle(): AgentHandle;
  /** 现在（手头这一条处理完）停：摘掉 03:00 的委派、停会话 */
  stop(): Promise<void>;
}

/** 日志、⚙ 里怎么称呼它 */
function label(): string {
  return t("memory.curator.label");
}

/** 这一夜被唤醒时要它做什么（给模型看的） */
// @i18n-ignore-start model：03:00 的唤醒消息（交给管理员的模型，也存进它自己的会话里；不是界面文字）
function wakeText(): string {
  return (
    `${CURATOR_WAKE_TAG}03:00 到了：这一夜该整理记忆了。\n` +
    "先调 run_memory_consolidation 把这一夜的整理跑完（就是每晚 03:00 的那一份：同一个引擎、同一份预算、同一条整理记录）。\n" +
    "跑完照着结果写一段整理日记，追加在你的回复里：这一夜干了什么、新出/变化几条、还拿不准什么、想问用户什么。\n" +
    "整理没跑成就照实说（素材一条没少、下一夜照常），不要编造整理结果。"
  );
}
// @i18n-ignore-end

/** 会话里一条 turn_end 的负载里是不是这一条输入（一起交出的一批时更多的那几条也算） */
function settledFor(payload: unknown, messageId: string): boolean {
  const turn = payload as TurnEndLike;
  return turn.inputMessageId === messageId || (turn.moreInputMessageIds?.includes(messageId) ?? false);
}

export function startMemoryCurator(options: MemoryCuratorOptions): MemoryCurator {
  const log = options.log;
  const { store } = options;
  const conversation = MEMORY_CURATOR_CONVERSATION;
  const graph: MemoryGraphReader = createMemoryGraphReader({ file: options.file, clock: options.clock, log });
  /** 03:00 正在唤醒的那一轮：工具据此知道现在用的是作业给的 run（定时整理），不是立即整理一次 */
  let waking: { trigger: JobTrigger; signal: AbortSignal; run: (trigger: JobTrigger, signal: AbortSignal) => Promise<MemoryNightlyRecord | undefined>; record?: MemoryNightlyRecord } | undefined;

  /** 现在整理一次：03:00 唤醒的那一轮里用作业给的 run（同一份定时整理）；平时是立即整理一次（manual） */
  const consolidate = async (): Promise<MemoryNightlyRecord | undefined> => {
    const current = waking;
    const record = current === undefined ? await options.nightly.runNow() : await current.run(current.trigger, current.signal);
    if (current !== undefined) current.record = record;
    return record;
  };

  const tools: HostTool[] = curatorTools({
    file: options.file,
    now: () => clockIso(options.clock),
    model: options.model ?? "deepseek-flash",
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    store,
    conversation,
    graph,
    materials: options.materials,
    materialOptions: options.materialOptions,
    consolidate,
    blocked: () => options.nightly.blocked(),
    log,
  });
  // 284 号票：了解你访谈的四个工具（访谈的服务由记忆插件提供）
  if (options.interviews !== undefined) {
    tools.push(
      ...interviewTools({
        interviews: options.interviews,
        store,
        conversation,
        materials: options.materials,
        ...(options.proposePersonalFile === undefined ? {} : { proposePersonalFile: options.proposePersonalFile }),
        log,
      }),
    );
  }
  /** 此刻的工具：记忆的那一套，加上语音插件开着时的口语总结、发语音（现取，插件停用了就没有） */
  const hostTools = (): HostTool[] => [...tools, ...(options.sessionTools?.voiceReplies?.tools ?? [])];

  const systemPrompt = () => options.prompts.render("memory-curator", {}, MEMORY_CURATOR_AGENT_ID);
  /** 283：档案摘要（空的不接）；出错当没有，不把拉起弄坏 */
  const background = (): string => {
    try {
      return options.background?.().trim() ?? "";
    } catch (err) {
      log(`记忆管理员：取档案摘要出错，这一轮不带（${err instanceof Error ? err.message : String(err)}）`);
      return "";
    }
  };
  /** 拉起时这几份提示文件的样子（直接改了文件，交下一条输入之前看出来、按新的重新拉起） */
  let promptRevision = "";
  /** 283：拉起时带的档案摘要（档案改了，下一条输入之前按新的重新拉起） */
  let backgroundRevision = "";

  /** 守卫看到的记忆管理员：没有文件工具、没有 bash、不联网；工具就是上面那一套（加上语音插件给的口语总结、发语音） */
  const guardAgent = (): GuardAgent => ({
    kind: "secretary",
    agentId: MEMORY_CURATOR_AGENT_ID,
    cwd: options.cwd,
    toolkit: { bash: false, network: false, tools: [...new Set([...CURATOR_TOOL_NAMES, ...hostTools().map((tool) => tool.spec.name)])] },
    scratchDir: options.cwd,
  });

  const session = new AgentSession({
    agents: options.agents,
    store,
    streams: options.streams,
    guards: options.guards,
    media: options.media,
    timeZone: options.timeZone,
    log,
    agentId: MEMORY_CURATOR_AGENT_ID,
    conversation,
    label: label(),
    // 它的用量算系统开销（和秘书同列，不是谁的活）
    ledgerRole: "curator",
    // 按需拉起（243 号票）：不给 resident——起来时只建壳，来输入（用户发消息、ask_curator 转达）或 03:00 唤醒时才由会话拉起，
    // 闲置到 agents.idleMinutes 后照维护者的规矩退出；不占 agents.maxLive 的常驻名额
    spawn: () => {
      promptRevision = options.prompts.revision(CURATOR_PROMPTS, MEMORY_CURATOR_AGENT_ID);
      backgroundRevision = background();
      return {
        model: options.modelSpec(),
        // 没有 pi 的内置工具（不读文件、不跑命令、不联网）：它能碰的只有代为执行的那几个记忆工具
        tools: [],
        cwd: options.cwd,
        systemPrompt: backgroundRevision === "" ? systemPrompt() : `${systemPrompt()}\n\n${backgroundRevision}`,
        continueSession: true,
        credentials: options.credentials,
        network: false,
      };
    },
    outdated: () => options.prompts.revision(CURATOR_PROMPTS, MEMORY_CURATOR_AGENT_ID) !== promptRevision || background() !== backgroundRevision,
    hostTools,
    // 284 号票：了解你访谈开着时，跟在这一轮输入后面的问法要点、第几个来回（不显示在会话里；开场的系统消息只有一行给人看）
    // 330 号票（R15）：开场那一轮再带上问题箱里还开着的几个（访谈里可以连问几个；平时聊天一次对话最多一个）
    ...(options.interviews === undefined ? {} : { inputContext: (message: MessageEnvelope) => interviewInputContext(options.interviews!, message, () => openBoxQuestions(graph)) }),
    guard: () => ({ agent: guardAgent(), source: t("memory.curator.source"), segmentId: conversation }),
    // 284 号票：语音回复（用户按住说话时这一轮的回话合成语音）、输入队列的挡板（还没识别完的语音等一等），和秘书、维护者同一套
    ...sessionVoice(options.sessionTools, true),
    configuredVision: options.configuredVision,
    interruptedNote: (quoted) => t(quoted ? "memory.curator.interruptedQuoted" : "memory.curator.interrupted", { quoted }),
    ...(options.sessionRewriteFor === undefined ? {} : { sessionRewriteFor: options.sessionRewriteFor }),
  });

  /** 会话里这一条输入的 turn_end 已经有过了没有（重启后补跑时用） */
  const turnEndOf = (messageId: string): unknown | undefined => {
    for (const event of store.read(conversation, 0, "turn_end")) if (settledFor(event.payload, messageId)) return event.payload;
    return undefined;
  };

  /**
   * 等这一条输入处理完：有了 turn_end 就交回它；到点、被中止、会话停了（不再有人会处理它）交回 undefined。
   * 中止（守护进程停止）时马上停，不拖着——作业那边照 AbortError 当没跑过。
   */
  const waitForTurn = (messageId: string, signal: AbortSignal, timeoutMs: number): Promise<unknown | undefined> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve(undefined);
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let tick: ReturnType<typeof setInterval> | undefined;
      let off: () => void = () => {};
      const finish = (payload: unknown | undefined) => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        if (tick !== undefined) clearInterval(tick);
        off();
        signal.removeEventListener("abort", onAbort);
        resolve(payload);
      };
      const onAbort = () => finish(undefined);
      off = store.onAppend((event) => {
        if (event.channel !== conversation || event.type !== "turn_end") return;
        if (settledFor(event.payload, messageId)) finish(event.payload);
      });
      timer = setTimeout(() => {
        log(`记忆管理员这一夜 ${Math.round(timeoutMs / 60_000)} 分钟还没处理完唤醒，作业照旧整理`);
        finish(undefined);
      }, timeoutMs);
      timer.unref?.();
      // 会话停了（守护进程在停、起不来）：不再等
      tick = setInterval(() => {
        if (session.status === "stopped") finish(undefined);
      }, WAIT_TICK_MS);
      tick.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
    });

  /**
   * 03:00 的唤醒：给它一条系统消息（同一夜只发一次），等它处理完；数它这一夜调了几次模型（预算跑满就停下这一轮）。
   * 交回这一夜花了几次、跑成的整理记录——作业据此把次数补进整理记录，没跑成时自己补跑一次。
   */
  const wake = async (info: { trigger: JobTrigger; signal: AbortSignal; run: (trigger: JobTrigger, signal: AbortSignal) => Promise<MemoryNightlyRecord | undefined> }) => {
    const night = localDate(clockIso(options.clock));
    const key = `${CURATOR_WAKE_KEY_PREFIX}${night}`;
    const maxCalls = Math.max(1, options.config.curator.maxModelCalls);
    let calls = 0;
    let budgetExhausted = false;
    /** 预算跑满了就停下这一轮：之后还会到几次调用（已经开始的那一次），次数照数 */
    const offLedger = options.ledger.onRecorded((entry) => {
      if (entry.agentId !== MEMORY_CURATOR_AGENT_ID) return;
      calls += 1;
      if (calls >= maxCalls && !budgetExhausted) {
        budgetExhausted = true;
        log(`记忆管理员这一夜已经调了 ${calls} 次模型（memory.curator.maxModelCalls 是 ${maxCalls}）：停下这一轮，下一夜照常`);
        session.stopReply();
      }
    });
    waking = { trigger: info.trigger, signal: info.signal, run: info.run };
    try {
      // 同一夜只发一次（守护进程重启后补跑时，那一轮可能已经跑了）
      const existing = store.eventByIdempotencyKey(key);
      let message: MessageEventPayload["message"];
      if (existing === undefined) {
        const built = buildAgentNotice(conversation, wakeText(), key);
        store.append(built.event);
        message = built.message;
      } else {
        message = (existing.payload as MessageEventPayload).message;
      }
      // 这一夜那一轮已经处理完了（重启后补跑）：不再等，交回让作业补跑
      if (existing === undefined || turnEndOf(message.id) === undefined) {
        const minutes = options.config.nightlyTimeoutMinutes > 0 ? options.config.nightlyTimeoutMinutes : 60;
        await waitForTurn(message.id, info.signal, minutes * 60_000 + WAKE_MARGIN_MS);
      } else {
        log("记忆管理员这一夜的唤醒已经处理过（同一个幂等键），作业照旧整理");
      }
      const record = waking?.record;
      return { modelCalls: calls, ...(record === undefined ? {} : { record }), ...(budgetExhausted ? { budgetExhausted: true } : {}) };
    } finally {
      offLedger();
      waking = undefined;
    }
  };

  const detachWake = options.nightly.wakeWith((info) => wake(info));
  session.start();
  const offPrompts = options.prompts.onChange((id) => {
    if ((CURATOR_PROMPTS as readonly string[]).includes(id)) session.refresh();
  });
  const offOwnPrompt = options.prompts.onAgentChange((agentId) => {
    if (agentId === MEMORY_CURATOR_AGENT_ID) session.refresh();
  });
  // 改了"我的名字"（249 号票）：系统提示最前面那句"用户叫「…」"跟着变，同样从下一轮起
  const offUserName = options.userName?.onChange(() => session.refresh());
  // 284 号票：语音插件运行中停用、启用（口语总结、发语音两个工具跟着有没有）：同样从下一轮起按新的工具重新拉起
  const offVoice = options.sessionTools?.onVoiceChange?.(() => session.refresh());

  return {
    agentHandle: () => ({
      agentId: MEMORY_CURATOR_AGENT_ID,
      kind: "curator",
      label: label(),
      template: "memory-curator",
      readOnly: undefined,
      systemPrompt,
      clearKind: "new_session",
      clear: (key) => void session.clear(key),
      compact: () => session.compactNow(),
      cannotCompact: () => undefined,
      since: () => {
        const cleared = lastClearMarker(store.reader, conversation);
        return cleared ? { seq: cleared.globalSeq, clearedAt: cleared.time } : { seq: 0 };
      },
      panel: () => session.panel,
      stopReply: () => session.stopReply(),
    }),
    async stop() {
      detachWake();
      offPrompts();
      offOwnPrompt();
      offUserName?.();
      offVoice?.();
      await session.stop();
    },
  };
}

/** 工具名（测试、守卫看到的工具包用） */
export const MEMORY_CURATOR_TOOLS: readonly string[] = [...CURATOR_TOOL_NAMES];

/** 它没有 pi 的内置工具（不读文件、不跑命令、不联网），工具全是守护进程代为执行的记忆工具 */
export const MEMORY_CURATOR_PI_TOOLS: readonly string[] = [];

/** 它不联网（守卫、agent 管家都照它） */
export const MEMORY_CURATOR_NETWORK = false;
