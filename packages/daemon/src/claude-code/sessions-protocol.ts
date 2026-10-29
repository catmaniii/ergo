// 列本机会话、读前情、分叉的一次性子进程（290 号票，child/sessions-main.ts；292 号票加了只读跟随）和守护进程这一侧（sessions.ts）之间的请求和结果。
// Agent SDK 只在子进程里（listSessions、getSessionMessages、forkSession 直接读写本机 ~/.claude 下的会话记录，不起 claude、不花额度；
// 超大的会话记录在子进程里读，撑爆了也不拖垮守护进程），正被占着的会话按官方说的受支持的办法查：`claude agents --json`。
// 子进程和守护进程两边都 import 这个文件（它不引 SDK）。
import type { RuntimeFollow, RuntimeHistory } from "../runtime/index.ts";

/** 一次性子进程的请求 */
export type ClaudeSessionsRequest =
  /** 列本机的会话（终端 /resume 能看到的那些：SDK、-p 起的不列），最近活动的在前，最多 limit 个 */
  | { op: "list"; limit: number }
  /** 正在跑的会话（claude agents --json） */
  | { op: "running" }
  /** 读主线最近一段：SDK 读出的消息只留最后 entries 条，翻成二狗的样子后最多 messages 条 */
  | { op: "history"; sessionId: string; cwd: string; entries: number; messages: number }
  /** 分叉一份（原会话不动） */
  | { op: "fork"; sessionId: string; cwd: string }
  /**
   * 只读跟随（292 号票）：主线上 after 那一条之后的新内容，最多 max 条；final 是后台会话已经停了（最后那条回复也算说完了）；
   * tail 只要主线最后一条的 id（交出去那一刻定下从哪接着跟）
   */
  | { op: "follow"; sessionId: string; after?: string; final: boolean; max: number; tail?: boolean };

/** 本机的一个会话（SDK 的 listSessions 给的那几样） */
export interface ClaudeSessionInfo {
  sessionId: string;
  /** 标题：自己起的名字 → 自动摘要 → 第一句话 */
  title: string;
  cwd?: string;
  branch?: string;
  /** 最近一次改动（毫秒） */
  lastModified: number;
  bytes?: number;
}

/** 一个正在跑的会话（claude agents --json 的一条） */
export interface ClaudeRunningSession {
  sessionId: string;
  /** interactive（终端里开着；二狗自己经 SDK 起的进程也显示成这个）、background（claude --bg 的后台会话） */
  kind: string;
  /** 进程号：没有的是停着的后台会话记录 */
  pid?: number;
  /** 后台会话的短 id */
  id?: string;
  name?: string;
}

export type ClaudeSessionsResult =
  | { op: "list"; sessions: ClaudeSessionInfo[] }
  | { op: "running"; running: ClaudeRunningSession[] }
  | { op: "history"; history: RuntimeHistory }
  | { op: "fork"; sessionId: string }
  | { op: "follow"; follow: RuntimeFollow };

/** 列多少个会话 */
export const SESSIONS_LIST_LIMIT = 100;
/** 前情：SDK 读出的消息只看最后这么多条（一次工具调用就是两条） */
export const HISTORY_ENTRIES = 400;
/** 前情：翻成二狗的消息后最多留这么多条 */
export const HISTORY_MESSAGES = 60;
/** 只读跟随：一次最多补记这么多条（多的下次接着） */
export const FOLLOW_MESSAGES = 200;
