// 一个 agent 处理一条会话的输入（规格第 3、7 节）：秘书和维护者共用这一个类，各自只配置差异
// （常驻还是按需唤起、每次唤起的装配、守卫看到的 agent、怎么称呼它）；15、16 号票的项目维护者直接用它。
//
// - 输入队列就是事件日志：会话里交给 agent 的消息（用户消息、运行时的通知）排队（派生视图 agent_inputs），
//   一次处理一条——交给子进程时追加 turn_start，处理完追加 turn_end 出队，再取下一条。内存里只记"正在处理哪一条"。
// - 唤起：常驻的（秘书）一开始就拉起；按需的（维护者）有输入等着才经 agent 管家唤起（名额满了排队），
//   闲置退出后再来输入时重新唤起。每次唤起接着会话目录里最近的会话还是新开，由装配决定。
// - 回复：流式增量交给 StreamHub 节流推送（不落盘），定稿后只把文本和推理 part 写进会话；
//   代为执行的工具产生的卡片以一条只有卡片引用的消息出现在会话里；会话里的消息都带上 scope（所属的任务、项目）。
// - 每次工具调用都先经守卫（forwardToolCalls + guards.attach，07 号票）。
// - 处理到一半被打断（子进程崩溃、守护进程重启）的输入不再重送：标成"中断"出队，会话里追加一条系统说明。
//   意外退出后隔一会儿（1 秒起翻倍，最多 30 秒）常驻的重新拉起，按需的有输入等着才再唤起。重新拉起时子进程从会话文件里
//   最后一个完整回合续上（去掉写到一半的一行、给被中断的工具调用补上结果），被中断的有副作用的调用由守卫接入记下（23 号票，
//   见 guard-runtime/executions.ts、recovery/）。
// - 代为执行的工具调用时带上正在处理的那条输入（快速动作判定"用户明确点了"、素材检索不列出命令本身，21 号票）。
// - 语音（31 号票）：队首是还没识别完的语音时，它在队里等着（后面的也不越过它），也不为它唤起 agent；
//   识别有了结局（会话频道上的 voice 事件）再看队首。交过去的是识别出的文字（注明"语音转写"），识别失败的是"[语音，识别失败]"。
// - 彻底删除（21 号票，给了 sessionRewriteFor 时）：会话里来了 messages_purged，会话文件里对应的原话也要改写（改写哪些由
//   记忆模块从删除事件生成，改写本身由 agent 管家在一次性子进程里做）。子进程内存里还有原文，所以等手头这一条处理完，
//   停掉子进程、改写会话文件、再拉起（接着同一个会话）；和崩溃后的重新拉起共用一段收尾（relaunch）。
//   start() 时把以前的 messages_purged 再对一遍（上次改写到一半被杀也补上；改写是幂等的），改完才拉起。
// - 13 号票起（维护者执行任务）：
//   - 什么时候能处理输入由配置的 canProcess 决定（任务排队、暂停、结束时输入留在队里），状态变了由拉起它的模块 poke()；
//   - 每次唤起的装配、代为执行的工具和守卫看到的会话都按当时的情况现取（函数）；要换一套装配时 refresh()：
//     等手头这一条处理完，停掉子进程，下次唤起按新的装配拉起（接着同一个会话）；
//   - 插话（interject 打开时）：正在处理一条输入时用户又发来的话，作为插话送进去（在下一步之前插入）；子进程在回合结束时
//     报出收下了哪几条（turn_end.interjected），这几条随之记成处理完；没收下的照常排队；
//   - 重注入块：装配里的 contextBlock 在每条输入之前（被唤起：刚拉起，或者闲着时来了新输入）注入，压缩之后也注入；
//     setContextBlock 换成最新的；
//   - abortTurn：中止手头这一轮（任务暂停、取消时）。
// - 22 号票起（秘书的看板变化）：配置了 inputContext 的，交给子进程一条输入时可以带一条跟在它后面的上下文消息
//   （在开始处理这条输入的那一刻现取，系统提示不动）。
// - 24 号票：每次模型调用的用量记在谁名下（交给 agent 管家的 ledger，现取）：正在处理（或刚处理完）的那条输入所属的定时作业，
//   没有就是任务，再没有是项目，都没有按会话的 scope。agent 在账本里的角色由配置给（ledgerRole）；秘书的用量不论输入属于谁
//   都是系统开销（账本按角色判）。
// - 16 号票起（项目维护者的会话分段）：会话里的消息带上的范围可以随当前这一段变（scope 给函数）；
//   accepts 决定现在处理哪条输入（只处理属于当前这一段的，别的留在队里，不挡着后面的）；闲置退出时告诉拉起它的模块（onIdleExit）。
import {
  type ConversationId,
  EVENT_TYPES,
  type LedgerOwner,
  type LedgerRole,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagesPurgedEventPayload,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
} from "@ergou/protocol";
import type { AgentManager, ManagedAgent, ManagedExit, SpawnAgentRequest } from "../agent-manager/agent-manager.ts";
import { type HostTool, hostToolTimeouts, serveHostTools } from "../agent-manager/host-tools.ts";
import type { EventStore } from "../events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, registerTools } from "../guard/index.ts";
import type { GuardedSession, GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { UsageAttribution } from "../ledger/index.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { AgentReport, ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import { type AgentInputContext, prepareAgentInput } from "./agent-input.ts";
import { finalParts, quoteMessage } from "./agent-replies.ts";
import { appendMessage, type MessageScope, newMessageId } from "./messages.ts";
import type { StreamHub } from "./stream-hub.ts";
import { voicesSettled } from "../voice/views.ts";
import { getMessage, pendingInputs, type QueuedInput, startedInputs } from "./views.ts";

/** 子进程意外退出后再拉起的等待时间：1 秒起，每次翻倍，最多 30 秒 */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** 会话此刻的状态：休眠（按需的，没有子进程）、拉起中（含排队）、闲着、在处理一条输入、意外退出后等着再拉起、已停止 */
export type AgentSessionStatus = "asleep" | "starting" | "idle" | "busy" | "restarting" | "stopped";

/** 每次唤起的装配：agent id、代为执行的工具、超时、守卫转发、常驻由会话类自己填 */
export type AgentSessionSpawn = Omit<SpawnAgentRequest, "agentId" | "hostTools" | "toolTimeouts" | "toolTitles" | "forwardToolCalls" | "resident">;

/** 守卫看到的这个会话：agent、来源、会话段、所属的任务（工具注册表、会话、消息范围由会话类填） */
export type AgentSessionGuard = Omit<GuardedSession, "tools" | "conversation" | "messageScope">;

export interface AgentSessionOptions {
  agents: AgentManager;
  store: EventStore;
  streams: StreamHub;
  guards: GuardRuntime;
  media: MediaStore;
  /** 交给模型的每条消息前面的本地时间标记按它换算 */
  timeZone: string;
  log: (line: string) => void;
  agentId: string;
  conversation: ConversationId;
  /** 说明里怎么称呼它："秘书"、"维护者" */
  label: string;
  /**
   * 会话里的消息带上的归属（维护者会话：任务、项目）；给函数时每条消息现取（任务的维护者带上当时的阶段，25 号票；
   * 项目维护者的随当前这一段变，16 号票）。守卫接入在判定一次调用时取一次，这次调用的记录用那一刻的
   */
  scope?: MessageScope | (() => MessageScope);
  /** 这个 agent 在 token 账本里的角色（秘书、维护者）；不给是维护者 */
  ledgerRole?: LedgerRole;
  /** 现在处理不处理这条排着的输入（不给就按先后都处理）：不处理的留在队里，接着看后面的（16 号票） */
  accepts?(input: QueuedAgentInput): boolean;
  /** 闲置退出了（按需的 agent，16 号票：对话段在维护者闲置退出时结束） */
  onIdleExit?(): void;
  /** 子进程就绪了：它打开的是哪个会话（16 号票：项目维护者的第一段对话段接着以前的会话时，记下接的是哪个） */
  onReady?(ready: { session: string }): void;
  /**
   * 现在的子进程是不是按过时的装配拉起的（16 号票：维护者换了一段会话、项目的装配变了）：交下一条输入之前看一眼，
   * 过时了就停掉、按新的装配重新拉起再交。不给就只看 refresh()
   */
  outdated?(): boolean;
  /** 常驻（秘书）：一开始就拉起、意外退出后重新拉起，不闲置退出、不排队；否则有输入才唤起 */
  resident?: boolean;
  /** 第几次唤起（1 起）时的装配 */
  spawn(n: number): AgentSessionSpawn;
  /** 守护进程代为执行的工具（它们的登记加进守卫的工具注册表）：每次唤起现取 */
  hostTools(): readonly HostTool[];
  /** 守卫看到的这个会话：每次唤起现取 */
  guard(): AgentSessionGuard;
  /** 现在能不能处理输入（不给就总是能）：不能时输入留在队里，状态变了调 poke() */
  canProcess?(): boolean;
  /** 正在处理一条输入时用户又发来的话作为插话送进去（维护者）；不打开就排队 */
  interject?: boolean;
  /** 这个模型支不支持图片输入 */
  vision(model: ModelSpec): boolean;
  /** 处理到一半被打断的那条输入的系统说明（quoted 是它开头的引用，可能为空） */
  interruptedNote(quoted: string): string;
  /**
   * 交给子进程这条输入时，跟在它后面的一条上下文消息（秘书的看板变化，22 号票）：开始处理这条输入的那一刻现取
   * （在 turn_start 之前），undefined 就不带
   */
  inputContext?(message: MessageEnvelope): string | undefined;
  /** 彻底删除之后会话文件要改写哪些原话（记忆模块从删除事件生成）；不给就不改写 */
  sessionRewriteFor?(purges: readonly MessagesPurgedEventPayload[]): Omit<SessionRewriteRequest, "sessionDir">;
  onStatus?(status: AgentSessionStatus): void;
}

/** 排着等 agent 处理的一条输入：消息 id 和它的事件负载（所属的任务、项目……） */
export interface QueuedAgentInput {
  messageId: string;
  payload: MessageEventPayload;
}

/** 输入队列里的一条，连同它的消息事件负载（按全局序号取） */
export function queuedAgentInput(store: EventStore, input: Pick<QueuedInput, "messageId" | "globalSeq">): QueuedAgentInput {
  return { messageId: input.messageId, payload: store.readGlobal(input.globalSeq - 1, 1)[0]!.payload as MessageEventPayload };
}

export class AgentSession {
  private readonly options: AgentSessionOptions;
  private readonly inputContext: AgentInputContext;
  private proc: ManagedAgent | undefined;
  private ready = false;
  /** 正在处理的那条输入 */
  private current: string | undefined;
  /** 正在处理（或刚处理完）的那条输入所属的任务、项目：用量记在它名下 */
  private inputScope: MessageScope = {};
  /** 正在生成的回复：子进程里的消息 id → 定稿后的消息 id（流式增量和定稿消息共用它） */
  private reply: { agentMessageId: string; messageId: string } | undefined;
  private spawns = 0;
  private crashes = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  /** 正在重新拉起（停子进程、改写会话文件、崩溃后的退避）：期间不取输入 */
  private relaunching = false;
  /** 等着在会话文件里改写的彻底删除 */
  private readonly pendingPurges: MessagesPurgedEventPayload[] = [];
  /** 送进去当插话、还不知道收没收下的输入（消息 id → 送给的子进程） */
  private readonly interjected = new Map<string, ManagedAgent>();
  /** 要换一套装配：手头这一条处理完就停掉子进程，下次按新的装配拉起 */
  private stale = false;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;
  private currentStatus: AgentSessionStatus = "asleep";

  constructor(options: AgentSessionOptions) {
    this.options = options;
    this.inputContext = { store: options.store, media: options.media, timeZone: options.timeZone, vision: false };
  }

  get status(): AgentSessionStatus {
    return this.currentStatus;
  }

  /** 当前子进程的 pid（还没拉起、排队中或已退出时没有） */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /**
   * 开始接输入：上次被打断的输入标成中断（不重送）；以前彻底删除过的先把会话文件对一遍；
   * 然后常驻的拉起，按需的有输入等着才唤起
   */
  start(): void {
    const { store, conversation } = this.options;
    // 会话里来了消息：闲着就开始处理；有消息被彻底删除了：闲着就改写会话文件
    this.unsubscribe = store.onAppend((event) => {
      if (event.channel !== conversation) return;
      if (event.type === EVENT_TYPES.message) {
        this.maybeInterject(event.payload as MessageEventPayload);
        this.pump();
      }
      // 语音识别有了结局（31 号票）：等着它的那条输入现在可以交过去了
      if (event.type === EVENT_TYPES.voice) this.pump();
      if (event.type === EVENT_TYPES.messagesPurged && this.options.sessionRewriteFor) {
        this.pendingPurges.push(event.payload as MessagesPurgedEventPayload);
        this.pump();
      }
    });
    this.interruptStartedInputs();
    const purgedBefore = this.options.sessionRewriteFor
      ? store.read(conversation, 0, EVENT_TYPES.messagesPurged).map((e) => e.payload as MessagesPurgedEventPayload)
      : [];
    if (purgedBefore.length > 0) this.relaunch(() => this.rewriteSessions(purgedBefore), 0);
    else this.pump();
  }

  /** 状态变了（能处理输入了、有新的装配）：看一眼队首 */
  poke(): void {
    this.pump();
  }

  /** 换一套装配：手头这一条处理完就停掉子进程，下次唤起按新的装配拉起（接着同一个会话） */
  refresh(): void {
    this.stale = true;
    this.pump();
  }

  /** 中止手头这一轮（任务暂停、取消）；没在处理就什么都不做 */
  abortTurn(): void {
    if (this.current === undefined || this.proc?.state !== "running") return;
    try {
      this.proc.send({ type: "abort" });
    } catch {
      // 刚好退出了
    }
  }

  /** 换成最新的重注入块：活着的子进程在下一条输入之前、下次压缩之后注入它（重新拉起时由装配给） */
  setContextBlock(text: string): void {
    if (this.proc?.state !== "running") return;
    try {
      this.proc.send({ type: "context_block", text });
    } catch {
      // 刚好退出了：下次唤起时装配里有最新的
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const proc = this.proc;
    if (proc) {
      proc.kill();
      await proc.exited;
    }
    this.setStatus("stopped");
  }

  /** 闲着时：有要改写的会话文件先改写；有输入等着时没有子进程就唤起（常驻的总是拉起），就绪了就把队首的那条交过去 */
  private pump(): void {
    if (this.stopped || this.relaunching || this.current !== undefined || this.retryTimer) return;
    if (this.pendingPurges.length > 0) return this.rewriteWhenIdle();
    if (this.stale) return this.restartWhenIdle();
    if (this.options.canProcess && !this.options.canProcess()) return;
    const { store, conversation } = this.options;
    const next = this.nextInput();
    if (!this.proc) {
      if (next || this.options.resident) this.spawn();
      return;
    }
    if (!next) return;
    if (this.options.outdated?.()) {
      this.stale = true;
      return this.restartWhenIdle();
    }
    if (!this.ready || this.proc.state !== "running") return;
    // 当插话送过、子进程没收下的：照常作为一条输入送
    this.interjected.delete(next.messageId);
    const message = getMessage(store.reader, next.messageId);
    if (!message) {
      this.finishTurn(next.messageId, "error", `找不到消息 ${next.messageId}`);
      return this.pump();
    }
    this.current = message.id;
    this.inputScope = next.scope;
    this.setStatus("busy");
    const context = this.options.inputContext?.(message);
    const started: TurnStartEventPayload = { inputMessageId: message.id };
    store.append({ channel: conversation, type: EVENT_TYPES.turnStart, payload: started });
    // 附件的内容要读文件（PDF 还要抽文本），是异步的；准备好时还是同一个子进程、还在处理这一条，才交过去
    const proc = this.proc;
    const stillCurrent = () => this.proc === proc && this.current === message.id;
    prepareAgentInput(this.inputContext, message).then(
      (input) => {
        if (!stillCurrent()) return;
        try {
          proc.send({
            type: "user_input",
            inputId: message.id,
            text: input.text,
            ...(input.images.length > 0 ? { images: input.images } : {}),
            ...(context === undefined ? {} : { context }),
          });
        } catch (err) {
          // 子进程刚好退出了：这条在退出时按中断处理
          this.options.log(`交给${this.options.label}（${this.options.agentId}）的输入没送出去：${err instanceof Error ? err.message : String(err)}`);
        }
      },
      (err: unknown) => {
        if (!stillCurrent()) return;
        const reason = err instanceof Error ? err.message : String(err);
        this.options.log(`准备${this.options.label}（${this.options.agentId}）的输入出错：${reason}`);
        this.systemNote(`${this.options.label}这次没能回复：读取附件出错（${reason}）`);
        this.finishTurn(message.id, "error", reason);
        this.current = undefined;
        this.setStatus("idle");
        this.pump();
      },
    );
  }

  /** 这条输入现在能不能交给 agent：里面的语音都识别出了结局才行（31 号票） */
  private inputReady(messageId: string): boolean {
    const message = getMessage(this.options.store.reader, messageId);
    return message === undefined || voicesSettled(this.options.store.reader, message);
  }

  /** 队里排在这条之前（正在处理的那条除外）和它自己的语音都识别出了结局：这时它才能当插话送，不越过前面没识别完的 */
  private settledUpTo(messageId: string): boolean {
    for (const queued of pendingInputs(this.options.store.reader, this.options.conversation)) {
      if (queued.messageId !== this.current && !this.inputReady(queued.messageId)) return false;
      if (queued.messageId === messageId) return true;
    }
    return this.inputReady(messageId);
  }

  /**
   * 下一条要处理的输入：按先后，给了 accepts 时跳过现在不处理的（16 号票：留在队里，不挡着后面的）；
   * 要处理的那条是还没识别完的语音（31 号票）：它在队里等着，后面的也不越过它，也不为它唤起 agent，识别有了结局（voice 事件）再看
   */
  private nextInput() {
    const accepts = this.options.accepts;
    for (const queued of pendingInputs(this.options.store.reader, this.options.conversation)) {
      if (accepts && !accepts(queuedAgentInput(this.options.store, queued))) continue;
      return this.inputReady(queued.messageId) ? queued : undefined;
    }
    return undefined;
  }

  private spawn(): void {
    const { options } = this;
    this.stale = false;
    const request = options.spawn(++this.spawns);
    const hostTools = options.hostTools();
    const guard = options.guard();
    this.inputContext.vision = options.vision(request.model);
    const proc = options.agents.spawn({
      ...request,
      agentId: options.agentId,
      hostTools: hostTools.map((t) => t.spec),
      toolTimeouts: hostToolTimeouts(hostTools),
      toolTitles: Object.fromEntries(hostTools.map((t) => [t.spec.name, t.descriptor.title])),
      forwardToolCalls: true,
      ...(options.resident ? { resident: true } : {}),
      ledger: () => this.usageAttribution(),
    });
    this.proc = proc;
    this.ready = false;
    this.setStatus("starting");
    options.guards.attach(proc, {
      ...guard,
      // 带类型的 bash 工具（28）也是代为执行的，但登记的就是框架自带的那份（来源 typed_shell），不再加一遍
      tools: registerTools(BUILTIN_TOOL_REGISTRY, ...hostTools.map((t) => t.descriptor).filter((d) => d.source !== "typed_shell")),
      conversation: options.conversation,
      ...(options.scope ? { messageScope: () => this.scope() } : {}),
    });
    serveHostTools(proc, hostTools, {
      log: options.log,
      // 工具产生的卡片以一条只有卡片引用的消息出现在会话里
      onCards: (cardIds) => appendMessage(options.store, { conversation: options.conversation, speaker: "agent", parts: cardIds.map((cardId) => ({ type: "card_ref", cardId })) }, this.scope()),
      // 工具据此知道正在处理哪条输入
      context: () => (this.current === undefined ? {} : { inputMessageId: this.current }),
    });
    proc.onReport((report) => {
      if (this.proc === proc) this.onReport(report);
    });
    void proc.exited.then((exit) => this.onExit(proc, exit));
  }

  private onReport(report: AgentReport): void {
    const { options } = this;
    switch (report.type) {
      case "ready":
        this.ready = true;
        this.crashes = 0;
        options.onReady?.({ session: report.session });
        this.setStatus("idle");
        this.pump();
        return;
      case "stream_delta":
        if (this.current === undefined) return;
        options.streams.delta(options.conversation, this.replyIdFor(report.messageId), report.part === "thinking" ? "reasoning" : "text", report.delta);
        return;
      case "message_final": {
        if (this.current === undefined) return;
        const messageId = this.replyIdFor(report.messageId);
        this.endReply();
        const parts = finalParts(report.message.parts);
        if (parts.length > 0) appendMessage(options.store, { id: messageId, conversation: options.conversation, speaker: "agent", parts }, this.scope());
        return;
      }
      case "turn_end":
        if (this.current === undefined) return;
        this.endReply();
        // 这一轮里收下的插话随这一轮记成处理完（在这一轮的输入之前出队）
        for (const id of report.interjected ?? []) {
          if (!this.interjected.delete(id)) continue;
          const started: TurnStartEventPayload = { inputMessageId: id };
          options.store.append({ channel: options.conversation, type: EVENT_TYPES.turnStart, payload: started });
          this.finishTurn(id, "completed");
        }
        if (report.outcome === "error") this.systemNote(`${options.label}这次没能回复：${report.errorMessage ?? "未知错误"}`);
        this.finishTurn(this.current, report.outcome, report.errorMessage);
        this.current = undefined;
        this.setStatus("idle");
        this.pump();
        return;
      case "error":
        // 没收下的插话：留在队里，回合结束后照常作为一条输入送
        if (report.inputId !== undefined && this.interjected.delete(report.inputId)) return this.pump();
        options.log(`${options.label}（${options.agentId}）的子进程报错（${report.code}${report.fatal ? "，致命" : ""}）：${report.message}`);
        return;
      default:
        // 心跳不处理；用量由 agent 管家交给账本（归属是上面的 usageAttribution）；代为执行的工具由 serveHostTools 处理，
        // 守卫判定和工具调用的记录由守卫接入处理
        return;
    }
  }

  private onExit(proc: ManagedAgent, exit: ManagedExit): void {
    for (const [id, owner] of this.interjected) if (owner === proc) this.interjected.delete(id);
    if (proc !== this.proc) return;
    this.proc = undefined;
    this.ready = false;
    this.endReply();
    this.current = undefined;
    if (this.stopped) return this.setStatus("stopped");
    if (!this.options.resident && (exit.reason === "idle" || exit.reason === "killed" || exit.reason === "cancelled")) {
      // 闲置退出（或者被结束）：之后再来输入时重新唤起；退出途中来了输入的，现在就唤起
      this.setStatus("asleep");
      if (exit.reason === "idle") this.options.onIdleExit?.();
      return this.pump();
    }
    // 意外退出（或者超时中止后还不结束被结束）：正在处理的那条不再交给它，隔一会儿再拉起
    this.interruptStartedInputs();
    this.crashes += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.crashes - 1), RETRY_MAX_MS);
    this.options.log(
      `${this.options.label}（${this.options.agentId}）的子进程意外退出（${exit.reason}，code ${exit.code}，signal ${exit.signal}），${delay} 毫秒后${this.options.resident ? "重新拉起" : "有输入再唤起"}`,
    );
    // 等着改写的会话文件趁这时候一起改
    const purges = this.pendingPurges.splice(0);
    this.relaunch(() => (purges.length > 0 ? this.rewriteSessions(purges) : Promise.resolve()), delay);
  }

  /**
   * 重新拉起（崩溃之后、改写会话文件之后共用的收尾）：先做完 before，再等 delayMs（崩溃后的退避），
   * 然后常驻的拉起、按需的有输入才唤起。期间没有子进程，不取输入
   */
  private relaunch(before: () => Promise<void>, delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.relaunching = true;
    this.setStatus("restarting");
    void before().finally(() => {
      this.relaunching = false;
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (!this.options.resident) this.setStatus("asleep");
        this.pump();
      }, delayMs);
      this.retryTimer.unref();
    });
  }

  /**
   * 闲着时（手头这一条处理完）改写会话文件：子进程内存里还有原文，所以先停掉子进程，改完再拉起，接着同一个会话。
   * 正在处理一条输入时等它的 turn_end；正在重新拉起时等拉起来以后
   */
  private rewriteWhenIdle(): void {
    if (this.stopped || this.relaunching || this.current !== undefined || this.retryTimer || this.pendingPurges.length === 0) return;
    const purges = this.pendingPurges.splice(0);
    const proc = this.proc;
    // 这次退出是计划内的：onExit 看到它不是当前的子进程就不当崩溃处理
    this.proc = undefined;
    this.ready = false;
    this.endReply();
    this.relaunch(async () => {
      if (proc) {
        proc.kill();
        await proc.exited;
      }
      await this.rewriteSessions(purges);
    }, 0);
  }

  /** 闲着时换一套装配：停掉子进程，下次有输入（常驻的马上）按新的装配拉起 */
  private restartWhenIdle(): void {
    if (this.stopped || this.relaunching || this.current !== undefined || this.retryTimer || !this.stale) return;
    this.stale = false;
    const proc = this.proc;
    // 没有子进程：下次唤起时自然用新的装配
    if (!proc) return this.pump();
    // 这次退出是计划内的：onExit 看到它不是当前的子进程就不当崩溃处理
    this.proc = undefined;
    this.ready = false;
    this.endReply();
    this.relaunch(async () => {
      proc.kill();
      await proc.exited;
    }, 0);
  }

  /**
   * 正在处理一条输入时用户又发来一句：作为插话送进去（在下一步之前插入）。附件要先读：读好时还在处理同一条、
   * 这句话也还在排队（没被当成普通输入送出去）才送
   */
  private maybeInterject(payload: MessageEventPayload): void {
    const { options } = this;
    const message = payload.message;
    if (!options.interject || message?.speaker !== "user" || this.current === undefined || !this.ready || this.proc?.state !== "running") return;
    if (options.accepts && !options.accepts({ messageId: message.id, payload })) return;
    // 还没识别完的语音不当插话，排在它后面的话也不越过它（31 号票）：都留在队里，识别完了按先后作为输入处理
    if (!this.settledUpTo(message.id)) return;
    const proc = this.proc;
    const turn = this.current;
    prepareAgentInput(this.inputContext, message).then(
      (input) => {
        const stillQueued = pendingInputs(options.store.reader, options.conversation).some((q) => q.messageId === message.id);
        if (this.proc !== proc || this.current !== turn || !stillQueued) return;
        try {
          proc.send({ type: "interject", inputId: message.id, text: input.text });
          this.interjected.set(message.id, proc);
        } catch {
          // 子进程刚好退出了：这句话留在队里
        }
      },
      () => {
        // 读附件出错：留在队里，作为普通输入处理时再报
      },
    );
  }

  /** 改写会话文件（一次性子进程）；改写不了只记日志（下次 start() 时再对一遍） */
  private async rewriteSessions(purges: readonly MessagesPurgedEventPayload[]): Promise<void> {
    const { options } = this;
    if (!options.sessionRewriteFor) return;
    try {
      const { files, entries, summaries } = await options.agents.rewriteSessions(options.agentId, options.sessionRewriteFor(purges));
      if (files > 0) options.log(`彻底删除：改写了${options.label}（${options.agentId}）会话文件里的 ${entries} 条原话、${summaries} 段摘要（${files} 个文件）`);
    } catch (err) {
      options.log(`彻底删除：改写${options.label}（${options.agentId}）的会话文件出错，下次启动时再改：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }

  /** 用量记在谁名下：输入所属的定时作业优先，其次任务、项目，再按会话的 scope */
  private usageAttribution(): UsageAttribution {
    return { owner: ownerOf({ ...this.scope(), ...this.inputScope }), role: this.options.ledgerRole ?? "maintainer" };
  }

  private replyIdFor(agentMessageId: string): string {
    if (this.reply?.agentMessageId !== agentMessageId) {
      this.endReply();
      this.reply = { agentMessageId, messageId: newMessageId() };
    }
    return this.reply.messageId;
  }

  /** 结束正在生成的回复的流式推送（定稿、回合结束、子进程退出时） */
  private endReply(): void {
    if (this.reply) this.options.streams.end(this.options.conversation, this.reply.messageId);
    this.reply = undefined;
  }

  private systemNote(text: string): void {
    appendMessage(this.options.store, { conversation: this.options.conversation, speaker: "system", parts: [{ type: "text", text }] }, this.scope());
  }

  /** 会话里的消息现在带上的任务、项目、阶段 */
  private scope(): MessageScope {
    const { scope } = this.options;
    return typeof scope === "function" ? scope() : (scope ?? {});
  }


  private finishTurn(inputMessageId: string, outcome: TurnEndEventPayload["outcome"], error?: string): void {
    const payload: TurnEndEventPayload = { inputMessageId, outcome, ...(error === undefined ? {} : { error }) };
    this.options.store.append({ channel: this.options.conversation, type: EVENT_TYPES.turnEnd, payload });
  }

  /** 处理到一半被打断的输入（已有 turn_start、还没有 turn_end）：标成中断出队，追加系统说明，不重送 */
  private interruptStartedInputs(): void {
    const { store, conversation } = this.options;
    for (const input of startedInputs(store.reader, conversation)) {
      this.systemNote(this.options.interruptedNote(quoteMessage(getMessage(store.reader, input.messageId)?.parts ?? [])));
      this.finishTurn(input.messageId, "interrupted");
    }
  }

  private setStatus(status: AgentSessionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.options.onStatus?.(status);
  }
}

/** 归属的优先次序：定时作业、任务、项目；都没有是 null */
function ownerOf(scope: MessageScope): LedgerOwner | null {
  if (scope.scheduledJobId !== undefined) return { kind: "scheduled_job", id: scope.scheduledJobId };
  if (scope.taskId !== undefined) return { kind: "task", id: scope.taskId };
  if (scope.projectId !== undefined) return { kind: "project", id: scope.projectId };
  return null;
}
