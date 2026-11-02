// 列本机的 Codex 会话、读会话状况、读主线最近一段（前情）、分叉一份：一次性子进程（sessions-main.ts）里跑，每次起一个 codex app-server，全部经它的接口拿，
// 不读 ~/.codex 下的任何文件（ADR-0046）。app-server 怎么起由入口给，契约测试给假的。
// - 列：thread/list（默认的交互来源：终端、VS Code），按最近活动排；二狗自己开的（originator 是 CODEX_CLIENT_NAME）不列，免得被别的任务再接管一次；
// - 前情：thread/turns/list（itemsView: full，从新往旧读），翻成二狗的样子（用户说的一句、它的一条回复：文字、思考、工具调用——工具名照守卫登记表映射，结果截短）；
//   老的 legacy 会话这个接口读不了时退到 thread/read（includeTurns）；
// - 分叉：thread/fork（原会话不动，它开着也能分叉，实测）。一次性进程退出后新 thread 在盘上，负责人按 id 接着；
// - 状况：thread/read 的 status 跨进程永远是 notLoaded，看不出来；开着没有靠 thread/resume 探写入锁（isWriterConflict）。实测探一次不改会话记录（文件大小、修改时间都不变），
//   代价是这个进程会拉起一次用户配的 MCP 服务，进程退出就收掉。接着就退出了，没有写。
// @i18n-ignore-file data：前情里的占位（图片）；给人看的说明在守护进程那一侧按语言写
import type { RuntimeHistory, RuntimeHistoryItem, RuntimeHistoryPart } from "../../runtime/index.ts";
import type { CodexSessionInfo, CodexSessionsRequest, CodexSessionsResult } from "../sessions-protocol.ts";
import { CODEX_CLIENT_NAME, type CodexRpc, isWriterConflict } from "./app-server.ts";
import { type CodexItem, endOfItem, toolOfItem } from "./translator.ts";

/** 前情里一段文字最多留多少字 */
const TEXT_MAX = 8000;
const REASONING_MAX = 2000;
const RESULT_MAX = 600;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

interface ThreadView {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  updatedAt?: number;
  originator?: string | null;
  status?: { type?: string };
  gitInfo?: { branch?: string | null } | null;
}

interface TurnView {
  id?: string;
  items?: CodexItem[];
}

function sessionInfo(thread: ThreadView): CodexSessionInfo {
  const title = (thread.name ?? thread.preview ?? "").replace(/\s+/g, " ").trim();
  return {
    sessionId: thread.id,
    title: title || thread.id,
    cwd: thread.cwd ?? "",
    ...(thread.gitInfo?.branch ? { branch: thread.gitInfo.branch } : {}),
    updatedAt: (thread.updatedAt ?? 0) * 1000,
    loaded: thread.status?.type !== undefined && thread.status.type !== "notLoaded",
  };
}

export async function handleSessionsRequest(request: CodexSessionsRequest, rpc: Pick<CodexRpc, "request">): Promise<CodexSessionsResult> {
  switch (request.op) {
    case "list": {
      const sessions: CodexSessionInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await rpc.request<{ data?: ThreadView[]; nextCursor?: string | null }>("thread/list", { limit: Math.min(request.limit, 100), sortKey: "updated_at", sortDirection: "desc", ...(cursor ? { cursor } : {}) });
        for (const thread of page.data ?? []) if (thread.originator !== CODEX_CLIENT_NAME) sessions.push(sessionInfo(thread));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined && sessions.length < request.limit);
      return { op: "list", sessions: sessions.slice(0, request.limit) };
    }
    case "state": {
      const read = await rpc.request<{ thread: ThreadView }>("thread/read", { threadId: request.sessionId });
      const info = sessionInfo(read.thread);
      return { op: "state", state: { updatedAt: info.updatedAt, loaded: info.loaded || (await hasWriter(request.sessionId, rpc)) } };
    }
    case "history":
      return { op: "history", history: await readHistory(request.sessionId, request.turns, request.messages, rpc) };
    case "fork": {
      const forked = await rpc.request<{ thread: { id: string } }>("thread/fork", { threadId: request.sessionId, cwd: request.cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", excludeTurns: true });
      return { op: "fork", sessionId: forked.thread.id };
    }
  }
}

/** 有别的进程开着这个会话（见文件开头）：探不出来的（别的错）当没有，由最近活动兜着 */
async function hasWriter(threadId: string, rpc: Pick<CodexRpc, "request">): Promise<boolean> {
  try {
    await rpc.request("thread/resume", { threadId, excludeTurns: true });
    return false;
  } catch (err) {
    return isWriterConflict(err);
  }
}

async function readHistory(threadId: string, turns: number, messages: number, rpc: Pick<CodexRpc, "request">): Promise<RuntimeHistory> {
  let list: TurnView[];
  let more = false;
  try {
    const page = await rpc.request<{ data?: TurnView[]; nextCursor?: string | null }>("thread/turns/list", { threadId, limit: turns, sortDirection: "desc", itemsView: "full" });
    list = [...(page.data ?? [])].toReversed();
    more = (page.nextCursor ?? null) !== null;
  } catch {
    const read = await rpc.request<{ thread: { turns?: TurnView[] } }>("thread/read", { threadId, includeTurns: true });
    const all = read.thread.turns ?? [];
    list = all.slice(-turns);
    more = all.length > list.length;
  }
  return historyOf(list, more, messages);
}

/** 用户消息条目里的话（图片写个占位） */
function userText(item: CodexItem): string {
  const content = Array.isArray(item.content) ? (item.content as Array<{ type?: string; text?: string }>) : [];
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "image" || block.type === "localImage" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** 翻成二狗的样子（按先后）：见文件开头。最多 max 条，尽量从一句用户的话开始 */
export function historyOf(turns: readonly TurnView[], more: boolean, max: number): RuntimeHistory {
  const items: RuntimeHistoryItem[] = [];
  let parts: RuntimeHistoryPart[] = [];
  const flush = () => {
    if (parts.length > 0) items.push({ kind: "agent", parts });
    parts = [];
  };
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = userText(item);
        if (text) {
          flush();
          items.push({ kind: "user", text: clip(text, TEXT_MAX) });
        }
      } else if (item.type === "agentMessage") {
        if (typeof item.text === "string" && item.text.trim()) parts.push({ type: "text", text: clip(item.text.trim(), TEXT_MAX) });
      } else if (item.type === "reasoning") {
        const lines = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].filter((s): s is string => typeof s === "string");
        if (lines.join("").trim()) parts.push({ type: "reasoning", text: clip(lines.join("\n").trim(), REASONING_MAX) });
      } else if (item.type === "contextCompaction") {
        flush();
        items.push({ kind: "compacted" });
      } else {
        const call = toolOfItem(item, () => undefined);
        if (!call) continue;
        const { isError, text } = endOfItem(item);
        parts.push({ type: "tool", id: call.id, tool: call.toolName, native: call.native.toolName, args: call.args, ...(text ? { result: clip(text.trim(), RESULT_MAX) } : {}), ...(isError ? { failed: true } : {}) });
      }
    }
    flush();
  }
  let kept = items.length > max ? items.slice(-max) : items;
  const firstUser = kept.findIndex((item) => item.kind === "user");
  if (firstUser > 0 && (kept !== items || more)) kept = kept.slice(firstUser);
  return { items: kept, truncated: more || kept.length < items.length };
}
