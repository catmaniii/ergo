// 二狗的会话名 ⇄ Codex 的 thread id：宿主协议里会话是"会话目录里的一个名字"（装配参数 session、continueSession、freshSession，ready.session 报回）；
// Codex 的会话记录在它自己的目录（$CODEX_HOME/sessions），二狗不读不改。会话目录里每个会话只放一份小记录：<名字>.codex-session.json，
// 记着 thread id、开始时的工作目录、最近用的模型和上下文窗口、有没有真的开始（0.166：第一条用户消息之前 thread 没落盘，resume、fork、turns/list 都回 no rollout found）。
// 选哪个会话照 claude-code/child/records.ts（pi 那边的 sessionManagerFor）：freshSession 还没有就新开；指定了名字有就接着；选了 continueSession 接着最近的；都没有就新开。
// 接管已有会话：装配参数给了 resumeRuntimeSession 时，"新开"不新开 thread：记录接着接管的那条线（同来源的最近那份记的 thread，没有就是接管的那个），started 记成 true。
// 撤回和分支：记录里另记 lineage（navigation.ts）。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionAssembly } from "../../runtime/host-protocol.ts";
import type { CodexForkPoint, CodexLineage } from "./navigation.ts";

/** 记录文件的扩展名：会话的名字加上它就是文件名 */
export const RECORD_EXT = ".codex-session.json";

export interface CodexSessionRecord {
  /** Codex 的 thread id；还没 thread/start 过是空的 */
  threadId: string;
  /** 开始时的工作目录 */
  cwd: string;
  createdAt: string;
  /** thread 开始过一轮（落盘了）：之后按 id 恢复；还没有就新开 */
  started: boolean;
  model?: string;
  contextWindow?: number;
  /** 接管来的：接管的是哪个 thread */
  takenOver?: string;
  lineage?: CodexLineage;
}

export interface OpenedRecord {
  name: string;
  record: CodexSessionRecord;
  /** 接着会话目录里已有的那个（不是这次新开的） */
  existing: boolean;
  file: string;
}

const fileOf = (sessionDir: string, name: string) => path.join(sessionDir, `${name}${RECORD_EXT}`);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value !== "";

function read(file: string): CodexSessionRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CodexSessionRecord>;
    if (typeof parsed.threadId !== "string") return undefined;
    return {
      threadId: parsed.threadId,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      started: parsed.started === true,
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
      ...(typeof parsed.contextWindow === "number" ? { contextWindow: parsed.contextWindow } : {}),
      ...(isString(parsed.takenOver) ? { takenOver: parsed.takenOver } : {}),
      ...lineageOf(parsed.lineage),
    };
  } catch {
    return undefined;
  }
}

/** 记录里的 lineage：形状不对的条目丢掉 */
function lineageOf(raw: unknown): { lineage?: CodexLineage } {
  if (!isObject(raw)) return {};
  const lineage: CodexLineage = { inputs: {}, threads: {}, notes: {} };
  for (const [id, input] of Object.entries(isObject(raw.inputs) ? raw.inputs : {})) {
    if (isObject(input) && isString(input.thread) && isString(input.turn)) lineage.inputs[id] = { thread: input.thread, turn: input.turn };
  }
  const point = (value: unknown): CodexForkPoint | undefined => (value === "empty" ? "empty" : isObject(value) && isString(value.thread) && isString(value.turn) ? { thread: value.thread, turn: value.turn } : undefined);
  for (const [id, thread] of Object.entries(isObject(raw.threads) ? raw.threads : {})) {
    if (!isObject(thread)) continue;
    const origin = point(thread.origin);
    lineage.threads[id] = { ...(origin === undefined ? {} : { origin }), ...(isString(thread.first) ? { first: thread.first } : {}), ...(thread.fresh === true ? { fresh: true as const } : {}) };
  }
  for (const [id, note] of Object.entries(isObject(raw.notes) ? raw.notes : {})) if (isString(note)) lineage.notes[id] = note;
  return { lineage };
}

/** 写记录（先写临时文件再换名）；修改时间就是"最近用过" */
export function writeRecord(file: string, record: CodexSessionRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function mostRecent(sessionDir: string, accept?: (record: CodexSessionRecord) => boolean): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(sessionDir).filter((name) => name.endsWith(RECORD_EXT));
  } catch {
    return undefined;
  }
  let best: { name: string; mtime: number } | undefined;
  for (const name of names) {
    let mtime: number;
    try {
      mtime = fs.statSync(path.join(sessionDir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (accept) {
      const record = read(path.join(sessionDir, name));
      if (!record || !accept(record)) continue;
    }
    if (!best || mtime > best.mtime) best = { name: name.slice(0, -RECORD_EXT.length), mtime };
  }
  return best?.name;
}

function takenOverThread(sessionDir: string, source: string): string {
  const recent = mostRecent(sessionDir, (record) => record.takenOver === source);
  return (recent === undefined ? undefined : read(fileOf(sessionDir, recent))?.threadId) || source;
}

function create(assembly: SessionAssembly, name: string | undefined, now: () => Date, takeOver?: string): OpenedRecord {
  const record: CodexSessionRecord =
    takeOver === undefined
      ? { threadId: "", cwd: assembly.cwd, createdAt: now().toISOString(), started: false }
      : { threadId: takenOverThread(assembly.sessionDir, takeOver), cwd: assembly.cwd, createdAt: now().toISOString(), started: true, takenOver: takeOver };
  const finalName = name ?? (record.threadId || randomUUID());
  const file = fileOf(assembly.sessionDir, finalName);
  writeRecord(file, record);
  return { name: finalName, record, existing: false, file };
}

function open(assembly: SessionAssembly, name: string): OpenedRecord | undefined {
  const file = fileOf(assembly.sessionDir, name);
  const record = read(file);
  return record && { name, record, existing: true, file };
}

/** 按装配参数选会话（见文件头）；新开的马上写好记录 */
export function openSessionRecord(assembly: SessionAssembly, now: () => Date = () => new Date()): OpenedRecord {
  if (assembly.freshSession !== undefined && !fs.existsSync(fileOf(assembly.sessionDir, assembly.freshSession))) return create(assembly, assembly.freshSession, now);
  if (assembly.session !== undefined) {
    const named = open(assembly, assembly.session);
    if (named) return named;
  }
  if (assembly.continueSession) {
    const recent = mostRecent(assembly.sessionDir);
    const opened = recent === undefined ? undefined : open(assembly, recent);
    if (opened) return opened;
  }
  return create(assembly, assembly.session, now, assembly.resumeRuntimeSession);
}
