// 列本机的 Codex 会话、读前情、分叉的一次性子进程（child/sessions-main.ts）和守护进程这一侧（sessions.ts）之间的请求和结果。
// 会话都经 codex app-server 的接口拿（thread/list、thread/read、thread/turns/list、thread/fork），二狗不读 ~/.codex 下的任何文件。
// 子进程和守护进程两边都 import 这个文件。
import type { RuntimeHistory } from "../runtime/index.ts";

export type CodexSessionsRequest =
  /** 列本机的会话（终端 codex resume 能看到的），最近活动的在前，最多 limit 个；二狗自己开的不列 */
  | { op: "list"; limit: number }
  /** 一个会话的状况（接管、收回前核对） */
  | { op: "state"; sessionId: string }
  /** 读主线最近一段：最多 turns 个轮次，翻成二狗的样子后最多 messages 条 */
  | { op: "history"; sessionId: string; turns: number; messages: number }
  /** 分叉一份（原会话不动） */
  | { op: "fork"; sessionId: string; cwd: string };

/** 本机的一个会话 */
export interface CodexSessionInfo {
  sessionId: string;
  title: string;
  cwd: string;
  branch?: string;
  /** 最近一次改动（毫秒） */
  updatedAt: number;
  /** app-server 报的状态不是"没加载"（这个一次性进程自己刚起，一般都是没加载；是别的当作开着） */
  loaded: boolean;
}

export type CodexSessionsResult =
  | { op: "list"; sessions: CodexSessionInfo[] }
  | { op: "state"; state: { updatedAt: number; loaded: boolean } }
  | { op: "history"; history: RuntimeHistory }
  | { op: "fork"; sessionId: string };

/** 列多少个会话 */
export const SESSIONS_LIST_LIMIT = 100;
/** 前情：最多读这么多轮 */
export const HISTORY_TURNS = 40;
/** 前情：翻成二狗的消息后最多留这么多条 */
export const HISTORY_MESSAGES = 60;
