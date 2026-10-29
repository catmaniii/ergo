// Claude Code 运行时接管已有会话的那几样（290 号票，issue 24 方案 2.3），守护进程这一侧：
// - 会话从哪来（ClaudeSessionSource，可注入）：正式运行是一次性子进程（child/sessions-main.ts，经内核的 KERNEL.oneShot 拉起；SDK 的
//   listSessions / getSessionMessages / forkSession 和 `claude agents --json` 都在子进程里），主切面换成假的（不读用户真实的 ~/.claude、
//   不起 claude）；
// - 列会话（listResumable）：列出来的连同"正被占着"的说明——`claude agents --json` 里有这个会话的：交互式的（终端里开着，CLI 不拦第二个
//   写入者，接了会分叉、丢轮，调研 35 E2）、后台会话在跑的、停着的后台会话记录（没有进程，保守当作占着，调研 35 第 4 节）。
//   查不到（claude 不在、出错）时一律写"查不到它现在有没有在别处开着"，当作占着（只能分叉接管）；
//   二狗自己在管的（写入锁）不在这里认，接管服务（takeover/）盖上去；二狗自己的进程在 agents 里也显示成交互式，同样由那边盖掉；
// - 核对一个会话（sessionBusy）：接管、收回前再查一次 agents；
// - 分叉（fork）、前情（history）：照转子进程；292 号票的只读跟随（follow）也是。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso, type ResumableSessionView, t } from "@ergo/protocol";
import type { OneShotRunner } from "../plugins/kernel.ts";
import type { RuntimeFollow, RuntimeHistory } from "../runtime/index.ts";
import { type ClaudeRunningSession, type ClaudeSessionInfo, type ClaudeSessionsRequest, type ClaudeSessionsResult, FOLLOW_MESSAGES, HISTORY_ENTRIES, HISTORY_MESSAGES, SESSIONS_LIST_LIMIT } from "./sessions-protocol.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
/** 列会话、读前情、分叉的一次性子进程入口（child/sessions-main），和本文件同扩展名 */
export const CLAUDE_SESSIONS_ENTRY = fileURLToPath(new URL(`./child/sessions-main${ownExt}`, import.meta.url));

/** 本机的 Claude Code 会话从哪来（正式运行是一次性子进程，测试换成假的） */
export interface ClaudeSessionSource {
  /** 本机的会话（终端 /resume 能看到的），最近活动的在前 */
  list(): Promise<ClaudeSessionInfo[]>;
  /** 正在跑的会话（claude agents --json）；查不到抛错 */
  running(): Promise<ClaudeRunningSession[]>;
  /** 主线最近一段（前情），翻成二狗的样子 */
  history(sessionId: string, cwd: string): Promise<RuntimeHistory>;
  /** 分叉一份：新会话的 id */
  fork(sessionId: string, cwd: string): Promise<string>;
  /** 只读跟随（292 号票，交给官方 App 期间）：主线上 after 那一条之后的新内容，翻成二狗的样子；tail 只要最后一条的 id */
  follow(sessionId: string, options: { after?: string; final: boolean; tail?: boolean }): Promise<RuntimeFollow>;
}

/** 各样最多等多久：列（读每个会话的头尾）、查 agents、读前情（大会话 SDK 要读几 MB）、分叉（复制整份记录） */
const TIMEOUTS: Readonly<Record<ClaudeSessionsRequest["op"], number>> = { list: 60_000, running: 30_000, history: 120_000, fork: 120_000, follow: 120_000 };

/** 正式运行的：每样拉一个一次性子进程 */
export function oneShotSessionSource(run: OneShotRunner): ClaudeSessionSource {
  const ask = async <K extends ClaudeSessionsRequest["op"]>(request: Extract<ClaudeSessionsRequest, { op: K }>): Promise<Extract<ClaudeSessionsResult, { op: K }>> => {
    const result = await run<ClaudeSessionsResult>(CLAUDE_SESSIONS_ENTRY, request, t("claudeCode.sessions.label"), TIMEOUTS[request.op]);
    // @i18n-ignore-next log：编程错误
    if (result.op !== request.op) throw new Error(`一次性子进程回的结果对不上：要 ${request.op}，回了 ${result.op}`);
    return result as Extract<ClaudeSessionsResult, { op: K }>;
  };
  return {
    list: async () => (await ask({ op: "list", limit: SESSIONS_LIST_LIMIT })).sessions,
    running: async () => (await ask({ op: "running" })).running,
    history: async (sessionId, cwd) => (await ask({ op: "history", sessionId, cwd, entries: HISTORY_ENTRIES, messages: HISTORY_MESSAGES })).history,
    fork: async (sessionId, cwd) => (await ask({ op: "fork", sessionId, cwd })).sessionId,
    follow: async (sessionId, { after, final, tail }) =>
      (await ask({ op: "follow", sessionId, ...(after === undefined ? {} : { after }), final, max: FOLLOW_MESSAGES, ...(tail ? { tail } : {}) })).follow,
  };
}

/** agents 里这个会话的几条 → 占着的说明（给人看）；没有是 undefined */
export function busyOf(entries: readonly ClaudeRunningSession[]): string | undefined {
  const live = entries.find((e) => e.pid !== undefined && e.kind !== "background");
  if (live) return t("claudeCode.sessions.busyInteractive", { pid: live.pid! });
  const background = entries.find((e) => e.kind === "background" && e.pid !== undefined);
  if (background) return t("claudeCode.sessions.busyBackground", { id: background.id ?? background.name ?? "" });
  const stopped = entries.find((e) => e.kind === "background");
  if (stopped) return t("claudeCode.sessions.busyStoppedJob", { id: stopped.id ?? stopped.name ?? "" });
  return entries.length > 0 ? t("claudeCode.sessions.busyOther") : undefined;
}

/** 本机能接管的会话（见文件开头）：工作目录不知道的不列（接管后维护者没地方干活） */
export async function listResumable(source: ClaudeSessionSource, log: (line: string) => void): Promise<ResumableSessionView[]> {
  const [sessions, running] = await Promise.all([
    source.list(),
    source.running().then(
      (list) => ({ list }),
      (err: unknown) => {
        log(`查不到哪些 Claude Code 会话正开着：${err instanceof Error ? err.message : String(err)}`);
        return { list: undefined };
      },
    ),
  ]);
  return sessions
    .filter((s) => s.cwd !== undefined && s.cwd !== "")
    .map((s) => {
      const busy = running.list === undefined ? t("claudeCode.sessions.busyUnknown") : busyOf(running.list.filter((r) => r.sessionId === s.sessionId));
      return {
        id: s.sessionId,
        title: s.title,
        cwd: s.cwd!,
        ...(s.branch ? { branch: s.branch } : {}),
        updatedAt: nowIso(new Date(s.lastModified)),
        ...(s.bytes === undefined ? {} : { bytes: s.bytes }),
        ...(busy === undefined ? {} : { busy }),
      };
    });
}

/** 一个会话现在有没有被别处占着（接管、收回前再核对）：查不到的照样抛出 */
export async function sessionBusy(source: ClaudeSessionSource, sessionId: string): Promise<string | undefined> {
  return busyOf((await source.running()).filter((r) => r.sessionId === sessionId));
}
