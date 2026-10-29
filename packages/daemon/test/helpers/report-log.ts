// 按到达顺序记录一个 agent 子进程发来的全部消息，测试按顺序等待其中某一类。
import type { AgentReport } from "../../src/runtime/index.ts";

export type ReportOf<T extends AgentReport["type"]> = Extract<AgentReport, { type: T }>;

export class ReportLog {
  readonly reports: AgentReport[] = [];
  private cursor = 0;
  private waiters: Array<() => void> = [];

  constructor(agent: { onReport(listener: (report: AgentReport) => void): () => void }) {
    agent.onReport((report) => {
      this.reports.push(report);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  /**
   * 等下一条 type 类型的消息（从上一次 next 命中的位置往后找；中间别的类型跳过）。
   * 连续调用 next 就能断言消息的先后顺序。
   */
  async next<T extends AgentReport["type"]>(type: T, timeoutMs = 20_000): Promise<ReportOf<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.cursor; i < this.reports.length; i++) {
        const report = this.reports[i]!;
        if (report.type === type) {
          this.cursor = i + 1;
          return report as ReportOf<T>;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const seen = this.reports.slice(this.cursor).map((r) => r.type);
        throw new Error(`等 "${type}" 超时；之后收到的消息：${JSON.stringify(seen)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** 到目前为止收到的某一类消息 */
  ofType<T extends AgentReport["type"]>(type: T): ReportOf<T>[] {
    return this.reports.filter((r): r is ReportOf<T> => r.type === type);
  }
}
