// `claude agents --json` 的输出怎么读（290 号票写在子进程里，292 号票挪到这里：守护进程这一侧交给官方 App、收回时也跑它）。
// 一次性子进程（child/sessions.ts 转出它）和守护进程两边都 import 这个文件（它不引 SDK）。
import type { ClaudeRunningSession } from "./sessions-protocol.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `claude agents --json` 的输出：一个数组（也认 { sessions: [...] } 这类包了一层的），每条有 sessionId 的才要。
 * 字段照调研 35 第 2 步：交互式的有 pid、status；后台的有 id、state，在跑的才有 pid（加 --all 时停着的后台会话也列出来，同样没有 pid）
 */
export function parseAgents(text: string): ClaudeRunningSession[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parsed: unknown = JSON.parse(trimmed);
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? (Object.values(parsed).find(Array.isArray) ?? []) : [];
  const out: ClaudeRunningSession[] = [];
  for (const entry of list as unknown[]) {
    if (!isRecord(entry) || typeof entry.sessionId !== "string" || entry.sessionId === "") continue;
    out.push({
      sessionId: entry.sessionId,
      kind: typeof entry.kind === "string" ? entry.kind : "interactive",
      ...(typeof entry.pid === "number" ? { pid: entry.pid } : {}),
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    });
  }
  return out;
}
