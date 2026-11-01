// Codex 运行时接管已有会话的那几样，守护进程这一侧：
// - 会话从哪来（CodexSessionSource，可注入）：正式运行是一次性子进程（child/sessions-main.ts，经内核的 KERNEL.oneShot 拉起，里面起一个 codex app-server），
//   主切面换成假的（不读用户真实的会话、不起 codex）；
// - 占没占：Codex 没有"谁开着"的接口。thread/loaded/list 只认同一个 app-server 进程里加载的，终端里开着的看不到；能拿到的信号是状态字段和最近活动时间：
//   · 状态不是"没加载"，或者最近 CODEX_BUSY_RECENT_MS 内还有活动：写"可能还开着"（busy：不能直接接，先在那边关掉，或者分叉一份接管）；
//   · 再早的也判不准（开着没说话的终端看不出来）：写明 unsure，界面默认勾上分叉，用户确认关了可以取消勾选直接接；
// - 收回前核对：同样按状态和最近活动，只算交还之后的活动（交还之前是二狗自己写的）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso, type ResumableSessionView, t } from "@ergo/protocol";
import type { OneShotRunner } from "../plugins/kernel.ts";
import type { RuntimeHistory } from "../runtime/index.ts";
import { type CodexSessionInfo, type CodexSessionsRequest, type CodexSessionsResult, HISTORY_MESSAGES, HISTORY_TURNS, SESSIONS_LIST_LIMIT } from "./sessions-protocol.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
/** 列会话、读前情、分叉的一次性子进程入口（child/sessions-main），和本文件同扩展名 */
export const CODEX_SESSIONS_ENTRY = fileURLToPath(new URL(`./child/sessions-main${ownExt}`, import.meta.url));

/** 最近这么久内还有活动的算"可能还开着" */
export const CODEX_BUSY_RECENT_MS = 5 * 60_000;

/** 本机的 Codex 会话从哪来（正式运行是一次性子进程，测试换成假的） */
export interface CodexSessionSource {
  list(): Promise<CodexSessionInfo[]>;
  state(sessionId: string): Promise<{ updatedAt: number; loaded: boolean }>;
  history(sessionId: string): Promise<RuntimeHistory>;
  fork(sessionId: string, cwd: string): Promise<string>;
}

/** 各样最多等多久（要起一个 app-server） */
const TIMEOUTS: Readonly<Record<CodexSessionsRequest["op"], number>> = { list: 60_000, state: 30_000, history: 120_000, fork: 120_000 };

/** 正式运行的：每样拉一个一次性子进程 */
export function oneShotSessionSource(run: OneShotRunner): CodexSessionSource {
  const ask = async <K extends CodexSessionsRequest["op"]>(request: Extract<CodexSessionsRequest, { op: K }>): Promise<Extract<CodexSessionsResult, { op: K }>> => {
    const result = await run<CodexSessionsResult>(CODEX_SESSIONS_ENTRY, request, t("codex.sessions.label"), TIMEOUTS[request.op]);
    // @i18n-ignore-next log：编程错误
    if (result.op !== request.op) throw new Error(`一次性子进程回的结果对不上：要 ${request.op}，回了 ${result.op}`);
    return result as Extract<CodexSessionsResult, { op: K }>;
  };
  return {
    list: async () => (await ask({ op: "list", limit: SESSIONS_LIST_LIMIT })).sessions,
    state: async (sessionId) => (await ask({ op: "state", sessionId })).state,
    history: async (sessionId) => (await ask({ op: "history", sessionId, turns: HISTORY_TURNS, messages: HISTORY_MESSAGES })).history,
    fork: async (sessionId, cwd) => (await ask({ op: "fork", sessionId, cwd })).sessionId,
  };
}

/** 状况 → "可能还开着"的说明；看不出来是 undefined。after：只算这个时刻之后的活动（毫秒） */
function busyOf(state: { updatedAt: number; loaded: boolean }, now: number, after?: number): string | undefined {
  if (state.loaded) return t("codex.sessions.busyLoaded");
  const age = now - state.updatedAt;
  if (age >= CODEX_BUSY_RECENT_MS || (after !== undefined && state.updatedAt <= after)) return undefined;
  return t("codex.sessions.busyRecent", { minutes: Math.max(1, Math.round(age / 60_000)) });
}

/** 本机能接管的会话（见文件开头）：工作目录不知道的不列 */
export async function listResumable(source: CodexSessionSource, now: () => number = Date.now): Promise<ResumableSessionView[]> {
  const at = now();
  return (await source.list())
    .filter((s) => s.cwd !== "")
    .map((s) => {
      const busy = busyOf(s, at);
      return {
        id: s.sessionId,
        title: s.title,
        cwd: s.cwd,
        ...(s.branch ? { branch: s.branch } : {}),
        updatedAt: nowIso(new Date(s.updatedAt)),
        ...(busy === undefined ? { unsure: t("codex.sessions.unsure") } : { busy }),
      };
    });
}

/** 一个会话现在是不是可能还开着（接管、收回前核对）：after 是交还的时刻（ISO），只算那之后的活动；查不到的照样抛出 */
export async function sessionBusy(source: CodexSessionSource, sessionId: string, after?: string, now: () => number = Date.now): Promise<string | undefined> {
  const since = after === undefined ? undefined : Date.parse(after);
  return busyOf(await source.state(sessionId), now(), since !== undefined && Number.isFinite(since) ? since : undefined);
}
