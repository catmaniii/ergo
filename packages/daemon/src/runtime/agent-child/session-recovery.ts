// 被杀后的恢复（23 号票，规格第 17 节）：接着会话之前把会话文件理一遍。
// 守护进程被杀时 Job 对象把子进程一起结束，pi 的会话文件（JSONL，追加写）停在被杀的那一刻：
// - 末尾可能有写到一半的一行：去掉，只留完整的条目（输出到一半的回复不留碎片；pi 自己读的时候也会跳过它，但会留在文件里）；
// - 最后一个回合里模型要调用的工具还没有结果：补上一条工具结果，回合就完整了，模型从这里接着往下走。没有结果的不只是
//   被杀时正在执行、正在等审批的——pi 并行执行一批工具调用，全部结束才把结果写进会话，同一批里先做完的也还没有结果。
//   结果按工具调用 id 取守护进程给的（等审批的；有副作用的：做完了、失败了、说不清做没做完），没给的用默认的那句（出错）。
// "回合"是 pi 的回合：一条助手消息，加上它要调用的那些工具的结果。只看最后一个回合——更早的回合不会缺结果
// （缺了的也是 pi 在发给模型前补"没有结果"，不会落盘），补在末尾才排得对。
import fs from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { INTERRUPTED_TOOL_RESULT, type InterruptedToolResult } from "../host-protocol.ts";

const LF = 0x0a;

/** 去掉会话文件末尾写到一半的一行；末尾那行是完整的条目、只差换行的，补上换行。返回去掉了多少字节 */
export function dropPartialTail(file: string): number {
  let content: Buffer;
  try {
    content = fs.readFileSync(file);
  } catch {
    // 文件还没有（第一次拉起）
    return 0;
  }
  if (content.length === 0 || content[content.length - 1] === LF) return 0;
  const keep = content.lastIndexOf(LF) + 1;
  try {
    JSON.parse(content.subarray(keep).toString("utf8"));
    fs.appendFileSync(file, "\n");
    return 0;
  } catch {
    fs.truncateSync(file, keep);
    return content.length - keep;
  }
}

/**
 * 最后一个回合里还没有结果的工具调用补上工具结果（追加进会话文件）；返回补上的工具调用 id。
 * 从当前分支的末尾往前看：跳过不是消息的条目（输入标记、重注入块、压缩……）和工具结果，遇到的第一条助手消息就是最后一个回合；
 * 先遇到用户消息说明最后一个回合已经完整；出错、被中止的助手消息 pi 不会再发给模型，它的工具调用也不补
 */
export function fillInterruptedToolResults(sessionManager: SessionManager, results: Readonly<Record<string, InterruptedToolResult>>): string[] {
  const answered = new Set<string>();
  const branch = sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!("role" in message)) return [];
    if (message.role === "toolResult") {
      answered.add(message.toolCallId);
      continue;
    }
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return [];
    const pending = message.content.flatMap((part) => (part.type === "toolCall" && !answered.has(part.id) ? [part] : []));
    for (const call of pending) {
      const result = Object.hasOwn(results, call.id) ? results[call.id]! : { text: INTERRUPTED_TOOL_RESULT, isError: true };
      sessionManager.appendMessage({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
        timestamp: Date.now(),
      });
    }
    return pending.map((call) => call.id);
  }
  return [];
}
