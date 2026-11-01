// Codex 会话的撤回和切分支，宿主协议 navigate_session 在 Codex 适配子进程这一侧。照 claude-code/child/navigation.ts 的思路，但比它简单：
// - ↶ 撤回到某条输入之前：thread/fork 的 beforeTurnId 从那一轮之前分叉出新 thread 接着用（原来的 thread 不动，就是废弃分支）。from 是撤回前的 thread，at 是新的。
//   不用 thread/revert：它只认 paginated 的会话，还会改写原来的历史，切不回去。终端里开的老会话也可能是 legacy；
// - 只回对话：Codex 不恢复文件（能力清单 rewind_files 是 false），不报 files；
// - 回不到一次工具调用前后（阶段、步骤开始前）：Codex 只能按整轮分叉，回原因；
// - 撤回到二狗自己开的 thread 的第一条之前：没有历史可留，新开一个空 thread（第一条输入之前它不落盘）；
// - 切到废弃分支：接着那个 thread（不分叉）；"撤回到这条分支开始前"：照这个 thread 当初分叉的地方再分叉一次；
// - 分支摘要 Codex 不写（branch_summary 是 false），守护进程写好交来（summary.written），记在新 thread 名下，它的下一条输入带给模型。
// 这些都要二狗自己记着（会话记录里的 lineage，records.ts）：每条输入是哪个 thread 的哪一轮、每个 thread 从哪分叉来的。以前交的输入没有记录，撤回不到它之前。
// @i18n-ignore-file log
import { t } from "@ergo/protocol";
import type { HostCommand, NavigateTarget, SessionNavigatedReport } from "../../runtime/host-protocol.ts";

type NavigateCommand = Extract<HostCommand, { type: "navigate_session" }>;

/** 撤回点：从哪个 thread 的哪一轮之前分叉；empty 是回到开头之前（新开一个 thread） */
export type CodexForkPoint = { thread: string; turn: string } | "empty";

export interface CodexLineage {
  /** 交给 Codex 的每条输入（二狗的输入 id）：哪个 thread 的哪一轮 */
  inputs: Record<string, { thread: string; turn: string }>;
  /** 每个 thread：撤回时分叉出来的记着从哪分叉（origin），它里面二狗交的第一轮（first），二狗自己 thread/start 开的（fresh） */
  threads: Record<string, { origin?: CodexForkPoint; first?: string; fresh?: true }>;
  /** 还没交给模型的分支摘要（thread id → 进上下文的那段） */
  notes: Record<string, string>;
}

export const emptyLineage = (): CodexLineage => ({ inputs: {}, threads: {}, notes: {} });

export interface NavigationHost {
  current(): string;
  readonly lineage: CodexLineage;
  /** 从 thread 的 beforeTurn 之前分叉：新 thread 的 id */
  fork(thread: string, beforeTurn: string): Promise<string>;
  /** 新开一个空 thread（撤回到开头之前）：它的 id */
  startFresh(): Promise<string>;
  /** 换成接着 thread（started：落盘了，按 id 恢复；false 是还没落盘的空 thread） */
  switchTo(thread: string, started: boolean): Promise<void>;
  log(line: string): void;
}

class NavigationError extends Error {}

function forkPoint(host: NavigationHost, target: NavigateTarget): CodexForkPoint {
  if ("beforeInput" in target) {
    const input = host.lineage.inputs[target.beforeInput];
    if (!input) throw new NavigationError(t("codex.navigate.noInput"));
    const own = host.lineage.threads[input.thread];
    return own?.fresh === true && own.first === input.turn ? "empty" : { thread: input.thread, turn: input.turn };
  }
  if ("entry" in target) {
    const origin = host.lineage.threads[target.entry]?.origin;
    if (origin === undefined) throw new NavigationError(t("runtime.navigate.noEntry", { entry: target.entry }));
    return origin;
  }
  throw new NavigationError(t("codex.navigate.noCallPoint"));
}

/** 在 Codex 的 thread 之间挪（见文件开头）；结果以 session_navigated 交回 */
export async function navigateCodex(host: NavigationHost, command: NavigateCommand): Promise<SessionNavigatedReport> {
  const { requestId } = command;
  try {
    const from = host.current();
    if (command.marker.change === "switch") {
      if (!("entry" in command.target)) throw new NavigationError(t("runtime.navigate.noEntry", { entry: JSON.stringify(command.target) }));
      const to = command.target.entry;
      if (to === from) throw new NavigationError(t("runtime.navigate.alreadyHere"));
      await host.switchTo(to, host.lineage.threads[to]?.first !== undefined || host.lineage.threads[to]?.origin !== "empty");
      host.log(`切到废弃分支：接着 thread ${to}（离开 ${from}）`);
      return { type: "session_navigated", requestId, ok: true, from, at: to };
    }
    if (command.summary && "instructions" in command.summary) throw new NavigationError(t("codex.navigate.ownSummary"));
    const point = forkPoint(host, command.target);
    const to = point === "empty" ? await host.startFresh() : await host.fork(point.thread, point.turn);
    await host.switchTo(to, point !== "empty");
    host.lineage.threads[to] = { origin: point, ...(point === "empty" ? { fresh: true as const } : {}) };
    if (command.summary && "written" in command.summary && command.summary.written.trim()) host.lineage.notes[to] = command.summary.written;
    host.log(`撤回：从 thread ${from} ${point === "empty" ? "回到开头" : `的 ${point.thread} 分叉到 ${point.turn} 之前`}，新 thread ${to}`);
    return { type: "session_navigated", requestId, ok: true, from, at: to };
  } catch (err) {
    const error = err instanceof NavigationError ? err.message : t("runtime.navigate.failed", { message: err instanceof Error ? err.message : String(err) });
    return { type: "session_navigated", requestId, ok: false, error };
  }
}
