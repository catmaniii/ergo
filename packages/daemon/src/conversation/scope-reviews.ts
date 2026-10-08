// 一个 agent 会话里的范围审视（18 号票，维护者的会话才有；照 serveHostTools 的做法，AgentSession 只在几处接上它）：
// - 拉起子进程时装配里带上审视用的模型、审视的说明、对照物和近期范围记录（setup），记下每个子进程手里的是哪一份；
// - 交每条输入之前对照物或近期范围记录变了，先送 scope_context（sync）；
// - 守护进程要审视时（request，工单结束时）：子进程就绪了就送 scope_review，没有子进程让会话拉起一个（接着同一个会话）；
//   结果回来、超时、子进程中途退出、会话停下都兑现（后几种是没做成，写原因）。送出去到结果回来之间让 agent 管家别闲置退出
//   （holdAwake）；会话在这期间不换装配、不改写会话文件（inFlight）；
// - 压缩会话时子进程自己做的审视（没有 requestId）交给 onCompactionReview。
// 结果都带上那次审视用的对照物（context）：范围记录据此记下审视看到的用户原话从哪来（彻底删除时连带改写）。
import type { ScopeSources } from "@ergou/protocol";
import type { ManagedAgent } from "../agent-manager/agent-manager.ts";
import { failedScopeReview, type ModelSpec, type ScopeReviewReport, type ScopeReviewSetup } from "../runtime/index.ts";

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

/** 拉起会话的模块给的：审视用的模型（spawn 是第几次唤起）、审视的说明、此刻的对照物、压缩时的结果交给谁 */
export interface SessionScopeReviewOptions {
  model(spawn: number): ModelSpec;
  instructions: string;
  context(): ScopeReviewContext;
  onCompactionReview(result: ScopeReviewResult): void;
}

/** 会话这一侧要接上的 */
interface SessionLink {
  /** 就绪了、能送命令的子进程（没有子进程、还没就绪是 undefined） */
  readyProcess(): ManagedAgent | undefined;
  /** 有审视等着送、又没有子进程：让会话拉起一个 */
  wake(): void;
  /** 一次审视兑现了：等着它的换装配、改写会话文件可以做了 */
  settled(): void;
}

/** 守护进程要的一次审视：还没送出去、送出去了在等结果 */
interface PendingReview {
  requestId: string;
  /** 送给了哪个子进程（还没送是 undefined）、送时对照的是哪一份、送时拿着的不闲置退出 */
  sentTo?: ManagedAgent;
  context?: ScopeReviewContext;
  release?: () => void;
  resolve(report: ScopeReviewReport): void;
  timer: NodeJS.Timeout;
}

const NO_CONTEXT: ScopeReviewContext = { reference: "", sources: { messageIds: [], approvalIds: [] } };

/** 两份对照物给子进程的文字一样不一样 */
const sameText = (a: ScopeReviewContext, b: ScopeReviewContext) => a.reference === b.reference && a.recentRecords === b.recentRecords;

export class SessionScopeReviews {
  private readonly options: SessionScopeReviewOptions & { agentId: string; label: string };
  private readonly link: SessionLink;
  /** 每个子进程手里的对照物（拉起时装配里的，之后送过去的） */
  private readonly held = new WeakMap<ManagedAgent, ScopeReviewContext>();
  /** 下一个拉起的子进程装配里的（setup 时记下，attach 时归它） */
  private assembled: ScopeReviewContext | undefined;
  private readonly pending = new Map<string, PendingReview>();
  private seq = 0;
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
    return [...this.pending.values()].some((p) => p.sentTo === undefined);
  }

  /** 拉起子进程时装配里的范围审视（此刻的对照物） */
  setup(spawn: number): ScopeReviewSetup {
    const context = this.options.context();
    this.assembled = context;
    return {
      model: this.options.model(spawn),
      instructions: this.options.instructions,
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
      if (report.type !== "scope_review_result") return;
      if (report.requestId !== undefined) return this.pending.get(report.requestId)?.resolve(report);
      // 压缩会话时子进程自己做的：对照的是它手里的那一份
      this.options.onCompactionReview({ report, context: this.held.get(proc) ?? NO_CONTEXT });
    });
    void proc.exited.then((exit) => {
      const lost = [...this.pending.values()].filter((p) => p.sentTo === proc);
      for (const p of lost) p.resolve(failedScopeReview(p.requestId, `审视时${this.options.label}的子进程退出了（${exit.reason}）`));
    });
  }

  /** 交一条输入之前：子进程手里的对照物或近期范围记录过时了，送最新的过去 */
  sync(proc: ManagedAgent): void {
    const context = this.options.context();
    const held = this.held.get(proc);
    if (held && sameText(held, context)) return;
    try {
      proc.send({ type: "scope_context", reference: context.reference, ...(context.recentRecords === undefined ? {} : { recentRecords: context.recentRecords }) });
      this.held.set(proc, context);
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
      const timer = setTimeout(() => finish(failedScopeReview(requestId, `范围审视超过 ${Math.round(timeoutMs / 1000)} 秒没有结果`)), timeoutMs);
      timer.unref();
      this.pending.set(requestId, { requestId, resolve: finish, timer });
      if (this.stopped) return finish(failedScopeReview(requestId, `${this.options.label}停下了`));
      this.drive();
    });
  }

  /** 会话停下：等着的审视都兑现成没做成 */
  stop(): void {
    this.stopped = true;
    // Map 边迭代边删（兑现时删掉自己）是安全的
    for (const p of this.pending.values()) p.resolve(failedScopeReview(p.requestId, `${this.options.label}停下了`));
  }

  /** 有还没送出去的审视：子进程就绪了就送（先送最新的对照物）；没有子进程就让会话拉起一个 */
  private drive(): void {
    const unsent = [...this.pending.values()].filter((p) => p.sentTo === undefined);
    if (this.stopped || unsent.length === 0) return;
    const proc = this.link.readyProcess();
    if (!proc) return this.link.wake();
    this.sync(proc);
    const context = this.held.get(proc) ?? this.options.context();
    for (const p of unsent) {
      try {
        proc.send({ type: "scope_review", requestId: p.requestId, reference: context.reference });
        p.sentTo = proc;
        p.context = context;
        p.release = proc.holdAwake(p.requestId);
      } catch {
        // 刚好在闲置退出：等它退出后再拉起一个送
      }
    }
  }
}
