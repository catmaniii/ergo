// 一个 agent 会话里的范围审视（18 号票，维护者的会话才有；照 serveHostTools 的做法，AgentSession 只在几处接上它）：
// - 拉起子进程时装配里带上审视用的模型、审视的说明、对照物和近期范围记录（setup），记下每个子进程手里的是哪一份；
// - 交每条输入之前对照物、近期范围记录或审视用的模型变了，先送 scope_context（sync）；
// - 守护进程要审视时（request，工单结束时）：子进程就绪了就送 scope_review，没有子进程让会话拉起一个（接着同一个会话）；
//   结果回来、超时、子进程中途退出、会话停下都兑现（后几种是没做成，写原因）。送出去到结果回来之间让 agent 管家别闲置退出
//   （holdAwake）；会话在这期间不换装配、不改写会话文件（inFlight）；
// - 审视用的模型每次审视时现取（73 号票，和子 agent、评审一样）：scope_review 带上此刻按设置取的，scope_context 也带上
//   （之后压缩时子进程自己做的审视用它），设置里改了下一次审视就用新的；
// - 压缩会话时子进程自己做的审视（没有 requestId）交给 onCompactionReview。
// - 309 号票：运行时自己不审视的（Claude Code，子进程里调不了二狗的审视模型；会话给了 recorded、它说现在的运行时是这种）由二狗按自己记下的事件
//   另起一次——守护进程要的审视不送 scope_review、不拉起子进程，把这段会话里还没审视过的部分（上次压缩之后的）整理好，在一次性子进程里用审视的
//   模型做（agent 管家的 recordedGeneration，pi 的同一套提示和结果格式），结果和子进程报的一样兑现；压缩之前子进程报 compacting，这一刻整理好
//   要压缩掉的那段另起一次，结果交给 onCompactionReview（会话停下了就不交，同 pi 的子进程被停掉）。对照物、审视用的模型都在审视那一刻现取。
// 结果都带上那次审视用的对照物（context）：范围记录据此记下审视看到的用户原话从哪来（彻底删除时连带改写）。
import { t } from "@ergo/protocol";
import type { ScopeSources } from "@ergo/protocol";
import type { ManagedAgent } from "../agent-manager/agent-manager.ts";
import { failedScopeReview, type ModelSpec, type RecordedGenerationRequest, type RecordedGenerationResult, type ScopeReviewReport, type ScopeReviewSetup } from "../runtime/index.ts";
import type { RecordedSegment } from "./recorded-transcript.ts";

/** 此刻的对照物、近期范围记录（子进程拿到的文字），和对照物里的用户原话从哪来（不送给子进程） */
export interface ScopeReviewContext {
  reference: string;
  recentRecords?: string;
  sources: ScopeSources;
}

/** 一次审视的结果，和它对照的是哪一份 */
export interface ScopeReviewResult {
  report: ScopeReviewReport;
  context: ScopeReviewContext;
}

/** 拉起会话的模块给的：审视用的模型（spawn 是子进程第几次唤起；每次审视时现取）、审视的说明、此刻的对照物、压缩时的结果交给谁 */
export interface SessionScopeReviewOptions {
  model(spawn: number): ModelSpec;
  /** 审视的说明（71 号票：在系统提示的文件里，拉起时现取） */
  instructions(): string;
  context(): ScopeReviewContext;
  onCompactionReview(result: ScopeReviewResult): void;
  /** 二狗另起审视时交给一次性子进程的凭据（309 号票，审视的模型按 provider 取）；不给用子进程拉起时的 */
  credentials?(): Record<string, string>;
}

/** 按二狗自己记下的事件另起一次审视（309 号票，运行时自己不审视的：Claude Code）要会话给的 */
export interface RecordedReviewLink {
  /** 现在的子进程（没有子进程时是要拉起的那个）的运行时自己不审视、由二狗另起 */
  wanted(): boolean;
  /** 子进程是第几次唤起（现取审视用的模型按它，同 setup） */
  spawn(): number;
  /** 这段会话里还没审视过的部分整理好的样子（叫的那一刻现算） */
  segment(): RecordedSegment;
  /** 另起一次生成（一次性子进程；用量记在这个 agent 名下）；凭据由这里补上 */
  generate(request: Omit<RecordedGenerationRequest, "credentials">, credentials: Record<string, string> | undefined): Promise<RecordedGenerationResult>;
  log(line: string): void;
}

/** 会话这一侧要接上的 */
interface SessionLink {
  /** 就绪了、能送命令的子进程（没有子进程、还没就绪是 undefined） */
  readyProcess(): ManagedAgent | undefined;
  /** 有审视等着送、又没有子进程：让会话拉起一个 */
  wake(): void;
  /** 一次审视兑现了：等着它的换装配、改写会话文件可以做了 */
  settled(): void;
  /** 309 号票：运行时自己不审视的由二狗另起；不给就都送给子进程 */
  recorded?: RecordedReviewLink;
}

/** 守护进程要的一次审视：还没送出去、送出去了在等结果 */
interface PendingReview {
  requestId: string;
  /** 送给了哪个子进程（还没送是 undefined）、送时对照的是哪一份、送时拿着的不闲置退出 */
  sentTo?: ManagedAgent;
  /** 由二狗另起了（309 号票：不送子进程，不算 inFlight） */
  recorded?: true;
  context?: ScopeReviewContext;
  release?: () => void;
  resolve(report: ScopeReviewReport): void;
  timer: NodeJS.Timeout;
}

/** 一个子进程手里的：对照物、审视用的模型，和它是第几次唤起（现取模型时按它） */
interface HeldReview {
  context: ScopeReviewContext;
  model: ModelSpec;
  spawn: number;
}

const NO_CONTEXT: ScopeReviewContext = { reference: "", sources: { messageIds: [], approvalIds: [] } };

/** 两份对照物给子进程的文字一样不一样 */
const sameText = (a: ScopeReviewContext, b: ScopeReviewContext) => a.reference === b.reference && a.recentRecords === b.recentRecords;

/** 两个模型一样不一样（faux 连剧本一起比） */
const sameModel = (a: ModelSpec, b: ModelSpec) => JSON.stringify(a) === JSON.stringify(b);

export class SessionScopeReviews {
  private readonly options: SessionScopeReviewOptions & { agentId: string; label: string };
  private readonly link: SessionLink;
  /** 每个子进程手里的对照物和审视用的模型（拉起时装配里的，之后送过去的） */
  private readonly held = new WeakMap<ManagedAgent, HeldReview>();
  /** 下一个拉起的子进程装配里的（setup 时记下，attach 时归它） */
  private assembled: HeldReview | undefined;
  private readonly pending = new Map<string, PendingReview>();
  private seq = 0;
  /** 二狗另起的审视是第几次（用量记录的 messageId） */
  private recordedSeq = 0;
  private stopped = false;

  constructor(options: SessionScopeReviewOptions & { agentId: string; label: string }, link: SessionLink) {
    this.options = options;
    this.link = link;
  }

  /** 有送给子进程、还在等结果的审视 */
  get inFlight(): boolean {
    return [...this.pending.values()].some((p) => p.sentTo !== undefined);
  }

  /** 有还没送出去的审视（会话据此在没有输入时也拉起子进程） */
  get waiting(): boolean {
    return [...this.pending.values()].some((p) => p.sentTo === undefined && !p.recorded);
  }

  /** 拉起子进程时装配里的范围审视（此刻的对照物和审视用的模型） */
  setup(spawn: number): ScopeReviewSetup {
    const context = this.options.context();
    const model = this.options.model(spawn);
    this.assembled = { context, model, spawn };
    return {
      model,
      instructions: this.options.instructions(),
      reference: context.reference,
      ...(context.recentRecords === undefined ? {} : { recentRecords: context.recentRecords }),
    };
  }

  /** 接上一个刚拉起的子进程：收它的审视结果；它退出时送给它的审视兑现成没做成，还没送的等下一个 */
  attach(proc: ManagedAgent): void {
    if (this.assembled) this.held.set(proc, this.assembled);
    this.assembled = undefined;
    proc.onReport((report) => {
      // 会话先处理同一条 ready（标成就绪），这里再送还没送的审视
      if (report.type === "ready") return this.drive();
      // 压缩就要开始（309 号票：运行时自己不审视的报它）
      if (report.type === "compacting") return this.reviewBeforeCompaction();
      if (report.type !== "scope_review_result") return;
      if (report.requestId !== undefined) return this.pending.get(report.requestId)?.resolve(report);
      // 压缩会话时子进程自己做的：对照的是它手里的那一份
      this.options.onCompactionReview({ report, context: this.held.get(proc)?.context ?? NO_CONTEXT });
    });
    void proc.exited.then((exit) => {
      const lost = [...this.pending.values()].filter((p) => p.sentTo === proc);
      for (const p of lost) p.resolve(failedScopeReview(p.requestId, t("conversation.scopeReview.exited", { who: this.options.label, reason: exit.reason })));
    });
  }

  /** 交一条输入之前：子进程手里的对照物、近期范围记录或审视用的模型过时了，送最新的过去 */
  sync(proc: ManagedAgent): void {
    const held = this.held.get(proc);
    // 不是经 setup 拉起的（不该有）：没法知道它第几次唤起，不送
    if (!held) return;
    const context = this.options.context();
    const model = this.options.model(held.spawn);
    if (sameText(held.context, context) && sameModel(held.model, model)) return;
    try {
      proc.send({ type: "scope_context", reference: context.reference, ...(context.recentRecords === undefined ? {} : { recentRecords: context.recentRecords }), model });
      this.held.set(proc, { context, model, spawn: held.spawn });
    } catch {
      // 刚好退出了：下次拉起时装配里有最新的
    }
  }

  /** 让子进程审视这个会话里还没审视过的部分：结果回来、子进程中途退出、超时、会话停下都兑现（后几种 error 写原因） */
  request(timeoutMs: number): Promise<ScopeReviewResult> {
    const requestId = `${this.options.agentId}-review-${++this.seq}`;
    return new Promise((resolve) => {
      const finish = (report: ScopeReviewReport) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.release?.();
        this.pending.delete(requestId);
        resolve({ report, context: pending.context ?? NO_CONTEXT });
        this.link.settled();
      };
      const timer = setTimeout(() => finish(failedScopeReview(requestId, t("conversation.scopeReview.timeout", { seconds: Math.round(timeoutMs / 1000) }))), timeoutMs);
      timer.unref();
      this.pending.set(requestId, { requestId, resolve: finish, timer });
      if (this.stopped) return finish(failedScopeReview(requestId, t("conversation.scopeReview.stopped", { who: this.options.label })));
      this.drive();
    });
  }

  /** 会话停下：等着的审视都兑现成没做成 */
  stop(): void {
    this.stopped = true;
    // Map 边迭代边删（兑现时删掉自己）是安全的
    for (const p of this.pending.values()) p.resolve(failedScopeReview(p.requestId, t("conversation.scopeReview.stopped", { who: this.options.label })));
  }

  /** 有还没送出去的审视：子进程就绪了就送（先送最新的对照物）；没有子进程就让会话拉起一个。运行时自己不审视的由二狗另起（309 号票） */
  private drive(): void {
    const unsent = [...this.pending.values()].filter((p) => p.sentTo === undefined && !p.recorded);
    if (this.stopped || unsent.length === 0) return;
    const recorded = this.link.recorded;
    if (recorded?.wanted()) {
      for (const p of unsent) {
        const context = this.options.context();
        p.recorded = true;
        p.context = context;
        void this.recordedReview(recorded, recorded.segment(), context, p.requestId).then((report) => p.resolve(report));
      }
      return;
    }
    const proc = this.link.readyProcess();
    if (!proc) return this.link.wake();
    this.sync(proc);
    const held = this.held.get(proc);
    const context = held?.context ?? this.options.context();
    for (const p of unsent) {
      try {
        // 审视用的模型此刻按设置取的（sync 刚换上的那个）
        proc.send({ type: "scope_review", requestId: p.requestId, reference: context.reference, ...(held ? { model: held.model } : {}) });
        p.sentTo = proc;
        p.context = context;
        p.release = proc.holdAwake(p.requestId);
      } catch {
        // 刚好在闲置退出：等它退出后再拉起一个送
      }
    }
  }

  /**
   * 压缩就要开始（309 号票，子进程报 compacting）：运行时自己不审视的，这一刻把还没审视过的那段（上次压缩之后的）整理好、另起一次审视，
   * 结果当压缩时的审视交给 onCompactionReview；会话停下了就不交
   */
  private reviewBeforeCompaction(): void {
    const recorded = this.link.recorded;
    if (!recorded?.wanted() || this.stopped) return;
    const context = this.options.context();
    void this.recordedReview(recorded, recorded.segment(), context).then((report) => {
      if (this.stopped) return;
      try {
        this.options.onCompactionReview({ report, context });
      } catch (err) {
        recorded.log(`${this.options.label}（${this.options.agentId}）压缩前的范围审视没记下：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
      }
    });
  }

  /**
   * 二狗另起一次审视这段（309 号票）：审视的说明、此刻的对照物、此刻按设置取的审视模型交给一次性子进程（pi 的同一套提示和结果格式），结果写成
   * 子进程报的那个样子（inputIds 是这段里交给 agent 的输入）；这段没有要审视的不调用模型，没做成的 error 写原因。不抛
   */
  private async recordedReview(recorded: RecordedReviewLink, segment: RecordedSegment, context: ScopeReviewContext, requestId?: string): Promise<ScopeReviewReport> {
    const report: ScopeReviewReport = { type: "scope_review_result", ...(requestId === undefined ? {} : { requestId }), findings: [], inputIds: segment.inputIds };
    if (segment.turns.length === 0) return report;
    try {
      const result = await recorded.generate(
        {
          task: { kind: "scope_review", instructions: this.options.instructions(), reference: context.reference },
          model: this.options.model(recorded.spawn()),
          turns: segment.turns,
          usageId: `scope-review-${this.options.agentId}-${++this.recordedSeq}`,
        },
        this.options.credentials?.(),
      );
      // @i18n-ignore-next log：编程错误
      if (result.kind !== "scope_review") throw new Error(`另起的审视交回了别的结果：${result.kind}`);
      return { ...report, findings: result.findings, ...(result.error === undefined ? {} : { error: result.error }) };
    } catch (err) {
      return { ...report, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
