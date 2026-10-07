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
//   意外退出后隔一会儿（1 秒起翻倍，最多 30 秒）常驻的重新拉起，按需的有输入等着才再唤起。从会话文件续上的恢复在 23 号票。
// - 代为执行的工具调用时带上正在处理的那条输入（快速动作判定"用户明确点了"、素材检索不列出命令本身，21 号票）。
// - 彻底删除（21 号票，给了 sessionRewriteFor 时）：会话里来了 messages_purged，会话文件里对应的原话也要改写（改写哪些由
//   记忆模块从删除事件生成，改写本身由 agent 管家在一次性子进程里做）。子进程内存里还有原文，所以等手头这一条处理完，
//   停掉子进程、改写会话文件、再拉起（接着同一个会话）；和崩溃后的重新拉起共用一段收尾（relaunch）。
//   start() 时把以前的 messages_purged 再对一遍（上次改写到一半被杀也补上；改写是幂等的），改完才拉起。
import {
  type ConversationId,
  EVENT_TYPES,
  type MessagesPurgedEventPayload,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
} from "@ergou/protocol";
import type { AgentManager, ManagedAgent, ManagedExit, SpawnAgentRequest } from "../agent-manager/agent-manager.ts";
import { type HostTool, hostToolTimeouts, serveHostTools } from "../agent-manager/host-tools.ts";
import type { EventStore } from "../events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY, findTool, registerTools } from "../guard/index.ts";
import type { GuardedSession, GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { AgentReport, ModelSpec, SessionRewriteRequest } from "../runtime/index.ts";
import { type AgentInputContext, prepareAgentInput } from "./agent-input.ts";
import { finalParts, quoteMessage } from "./agent-replies.ts";
import { appendMessage, type MessageScope, newMessageId } from "./messages.ts";
import type { StreamHub } from "./stream-hub.ts";
import { getMessage, pendingInputs, startedInputs } from "./views.ts";

/** 子进程意外退出后再拉起的等待时间：1 秒起，每次翻倍，最多 30 秒 */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** 会话此刻的状态：休眠（按需的，没有子进程）、拉起中（含排队）、闲着、在处理一条输入、意外退出后等着再拉起、已停止 */
export type AgentSessionStatus = "asleep" | "starting" | "idle" | "busy" | "restarting" | "stopped";

/** 每次唤起的装配：agent id、代为执行的工具、超时、守卫转发、常驻由会话类自己填 */
export type AgentSessionSpawn = Omit<SpawnAgentRequest, "agentId" | "hostTools" | "toolTimeouts" | "forwardToolCalls" | "resident">;

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
  /** 会话里的消息带上的任务、项目（维护者会话） */
  scope?: MessageScope;
  /** 常驻（秘书）：一开始就拉起、意外退出后重新拉起，不闲置退出、不排队；否则有输入才唤起 */
  resident?: boolean;
  /** 第几次唤起（1 起）时的装配 */
  spawn(n: number): AgentSessionSpawn;
  /** 守护进程代为执行的工具（它们的登记加进守卫的工具注册表） */
  hostTools: readonly HostTool[];
  /** 守卫看到的这个会话：agent、来源、会话段、所属的任务（工具注册表、会话、消息范围由会话类填） */
  guard: Omit<GuardedSession, "tools" | "conversation" | "messageScope">;
  /** 这个模型支不支持图片输入 */
  vision(model: ModelSpec): boolean;
  /** 处理到一半被打断的那条输入的系统说明（quoted 是它开头的引用，可能为空） */
  interruptedNote(quoted: string): string;
  /** 彻底删除之后会话文件要改写哪些原话（记忆模块从删除事件生成）；不给就不改写 */
  sessionRewriteFor?(purges: readonly MessagesPurgedEventPayload[]): Omit<SessionRewriteRequest, "sessionDir">;
  onStatus?(status: AgentSessionStatus): void;
}

export class AgentSession {
  private readonly options: AgentSessionOptions;
  private readonly inputContext: AgentInputContext;
  private proc: ManagedAgent | undefined;
  private ready = false;
  /** 正在处理的那条输入 */
  private current: string | undefined;
  /** 正在生成的回复：子进程里的消息 id → 定稿后的消息 id（流式增量和定稿消息共用它） */
  private reply: { agentMessageId: string; messageId: string } | undefined;
  private spawns = 0;
  private crashes = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  /** 正在重新拉起（停子进程、改写会话文件、崩溃后的退避）：期间不取输入 */
  private relaunching = false;
  /** 等着在会话文件里改写的彻底删除 */
  private readonly pendingPurges: MessagesPurgedEventPayload[] = [];
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
      if (event.type === EVENT_TYPES.message) this.pump();
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
    const { store, conversation } = this.options;
    const next = pendingInputs(store.reader, conversation)[0];
    if (!this.proc) {
      if (next || this.options.resident) this.spawn();
      return;
    }
    if (!next || !this.ready || this.proc.state !== "running") return;
    const message = getMessage(store.reader, next.messageId);
    if (!message) {
      this.finishTurn(next.messageId, "error", `找不到消息 ${next.messageId}`);
      return this.pump();
    }
    this.current = message.id;
    this.setStatus("busy");
    const started: TurnStartEventPayload = { inputMessageId: message.id };
    store.append({ channel: conversation, type: EVENT_TYPES.turnStart, payload: started });
    // 附件的内容要读文件（PDF 还要抽文本），是异步的；准备好时还是同一个子进程、还在处理这一条，才交过去
    const proc = this.proc;
    const stillCurrent = () => this.proc === proc && this.current === message.id;
    prepareAgentInput(this.inputContext, message).then(
      (input) => {
        if (!stillCurrent()) return;
        try {
          proc.send({ type: "user_input", inputId: message.id, text: input.text, ...(input.images.length > 0 ? { images: input.images } : {}) });
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

  private spawn(): void {
    const { options } = this;
    const request = options.spawn(++this.spawns);
    this.inputContext.vision = options.vision(request.model);
    const proc = options.agents.spawn({
      ...request,
      agentId: options.agentId,
      hostTools: options.hostTools.map((t) => t.spec),
      toolTimeouts: hostToolTimeouts(options.hostTools),
      forwardToolCalls: true,
      ...(options.resident ? { resident: true } : {}),
    });
    this.proc = proc;
    this.ready = false;
    this.setStatus("starting");
    options.guards.attach(proc, {
      ...options.guard,
      // 带类型的 bash 工具（28）也是代为执行的，但登记的就是框架自带的那份（来源 typed_shell），不再加一遍
      tools: registerTools(BUILTIN_TOOL_REGISTRY, ...options.hostTools.map((t) => t.descriptor).filter((d) => findTool(BUILTIN_TOOL_REGISTRY, d.name) !== d)),
      conversation: options.conversation,
      ...(options.scope ? { messageScope: options.scope } : {}),
    });
    serveHostTools(proc, options.hostTools, {
      log: options.log,
      // 工具产生的卡片以一条只有卡片引用的消息出现在会话里
      onCards: (cardIds) => appendMessage(options.store, { conversation: options.conversation, speaker: "agent", parts: cardIds.map((cardId) => ({ type: "card_ref", cardId })) }, options.scope),
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
        if (parts.length > 0) appendMessage(options.store, { id: messageId, conversation: options.conversation, speaker: "agent", parts }, options.scope);
        return;
      }
      case "turn_end":
        if (this.current === undefined) return;
        this.endReply();
        if (report.outcome === "error") this.systemNote(`${options.label}这次没能回复：${report.errorMessage ?? "未知错误"}`);
        this.finishTurn(this.current, report.outcome, report.errorMessage);
        this.current = undefined;
        this.setStatus("idle");
        this.pump();
        return;
      case "error":
        options.log(`${options.label}（${options.agentId}）的子进程报错（${report.code}${report.fatal ? "，致命" : ""}）：${report.message}`);
        return;
      default:
        // 心跳、用量（24 号票记账）不处理；代为执行的工具由 serveHostTools 处理，守卫判定和工具调用的记录由守卫接入处理
        return;
    }
  }

  private onExit(proc: ManagedAgent, exit: ManagedExit): void {
    if (proc !== this.proc) return;
    this.proc = undefined;
    this.ready = false;
    this.endReply();
    this.current = undefined;
    if (this.stopped) return this.setStatus("stopped");
    if (!this.options.resident && (exit.reason === "idle" || exit.reason === "killed" || exit.reason === "cancelled")) {
      // 闲置退出（或者被结束）：之后再来输入时重新唤起；退出途中来了输入的，现在就唤起
      this.setStatus("asleep");
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
    appendMessage(this.options.store, { conversation: this.options.conversation, speaker: "system", parts: [{ type: "text", text }] }, this.options.scope);
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
