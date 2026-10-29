// 维护者现在接着的是哪个 Claude Code 会话（292 号票：交给官方 App 时按它）。适配子进程在维护者的会话目录里给每段会话记一份小记录
// （child/records.ts：<名字>.claude-session.json，记着 Claude Code 的会话 id、开始时的工作目录、有没有真的开始），守护进程这一侧只读：
// 修改时间最近、真的开始过（claude 那边有这个会话）的那份就是现在接着的——任务维护者"接着最近的"、项目维护者当前这一段、中途 /clear 换过 id 的
// 都写在里面。格式和 child/records.ts 是同一份（子进程的模块守护进程不 import，这里只认要用的几个字段；契约测试对着它核对）。
import fs from "node:fs";
import path from "node:path";

/** 记录文件的扩展名（同 child/records.ts 的 RECORD_EXT） */
export const SESSION_RECORD_EXT = ".claude-session.json";

/** 会话目录里现在接着的 Claude Code 会话：会话 id、开始时的工作目录；没有开始过的会话是 undefined */
export function currentClaudeSession(sessionDir: string): { sessionId: string; cwd: string } | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir).filter((name) => name.endsWith(SESSION_RECORD_EXT));
  } catch {
    return undefined;
  }
  // 修改时间最近的那份（清空当前对话后新开、还没说过话的那段也算：那时没有可交的会话）
  let best: { sessionId: string; cwd: string; started: boolean; mtime: number } | undefined;
  for (const name of names) {
    const file = path.join(sessionDir, name);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (best && mtime <= best.mtime) continue;
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeSessionId?: unknown; cwd?: unknown; started?: unknown };
      if (typeof record.claudeSessionId !== "string" || record.claudeSessionId === "") continue;
      best = { sessionId: record.claudeSessionId, cwd: typeof record.cwd === "string" ? record.cwd : "", started: record.started === true, mtime };
    } catch {
      continue;
    }
  }
  return best?.started ? { sessionId: best.sessionId, cwd: best.cwd } : undefined;
}
