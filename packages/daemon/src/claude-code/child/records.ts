// 二狗的会话名 ⇄ Claude Code 的会话 id（287 号票）：宿主协议里会话是"会话目录里的一个名字"（装配参数 session、continueSession、
// freshSession，ready.session 报回），pi 的会话文件就放在会话目录里；Claude Code 的会话记录在它自己的目录（~/.claude/projects/…），
// 格式是内部的、随版本变，二狗不读不改（调研 31 第 1.2 节）。所以会话目录里每个会话只放一份小记录：<名字>.claude-session.json，
// 记着 Claude Code 的会话 id、开始时的工作目录、最近用的模型和上下文窗口、有没有真的开始（claude 写过记录）。
// - 新开：二狗自己定会话 id（SDK 的 sessionId），名字是装配参数给的，没给就用这个 id；
// - 接着：记录里 started 了就按 id 恢复（SDK 的 resume），还没开始（拉起后一句话都没说就退出了）就照原来的 id 新开；
// - /clear 之类让 Claude Code 换了会话 id 的，下一轮开头的 system/init 报的 id 不一样，记录跟着改（以后接着的是新的）。
// 选哪个会话照 pi 那边（runtime/agent-child/session.ts 的 sessionManagerFor）：freshSession 还没有就新开；指定了名字有就接着；
// 选了 continueSession 接着最近的（记录文件的修改时间）；都没有就新开。
// 290 号票（接管已有会话）：装配参数给了 resumeRuntimeSession（接管的 Claude 会话 id）时，"新开"不新开 Claude 的会话：记录接着接管的那条线——
// 会话目录里已有记着同一个接管来源（takenOver）的记录就接着它最近的那个 id（中途 /clear 换了 id 的接着新的），没有就是接管的那个 id，
// started 记成 true（按 id 恢复）。项目维护者换段（新的段名）也接着同一条线。freshSession（清空当前对话、换运行时）照旧新开，不接管。
// 293 号票（撤回和分支）：记录里另记 lineage（navigation.ts）——每条输入推进了哪个 Claude 会话、每个会话从哪分叉来的、还没交给模型的分支摘要；
// 撤回、切分支之后 claudeSessionId 换成新分叉出来的、切过去的那个，之后接着它。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionAssembly } from "../../runtime/host-protocol.ts";
import type { ClaudeForkPoint, ClaudeLineage } from "./navigation.ts";

/** 记录文件的扩展名：会话的名字加上它就是文件名 */
export const RECORD_EXT = ".claude-session.json";

export interface ClaudeSessionRecord {
  /** Claude Code 的会话 id（UUID） */
  claudeSessionId: string;
  /** 开始时的工作目录（以后接管、核对用；恢复时用装配参数的工作目录） */
  cwd: string;
  createdAt: string;
  /** claude 写过记录了（有过回复）：之后按 id 恢复；还没有就照原来的 id 新开 */
  started: boolean;
  /** 最近一轮 system/init 报的模型（ready 里报回；还没跑过是没有） */
  model?: string;
  /** 最近一次知道的上下文窗口（result 的 modelUsage 里的；还没跑过是没有） */
  contextWindow?: number;
  /** 接管来的（290 号票）：接管的是哪个 Claude 会话（装配参数 resumeRuntimeSession）；之后换了 id（/clear）这里照旧记来源 */
  takenOver?: string;
  /** 撤回、切分支要的（293 号票，navigation.ts 的 ClaudeLineage）；还没交过输入的没有 */
  lineage?: ClaudeLineage;
}

/** 这次打开的会话：名字、记录、是不是接着已有的、记录文件 */
export interface OpenedRecord {
  name: string;
  record: ClaudeSessionRecord;
  /** 接着会话目录里已有的那个（不是这次新开的） */
  existing: boolean;
  file: string;
}

const fileOf = (sessionDir: string, name: string) => path.join(sessionDir, `${name}${RECORD_EXT}`);

function read(file: string): ClaudeSessionRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ClaudeSessionRecord>;
    if (typeof parsed.claudeSessionId !== "string" || parsed.claudeSessionId === "") return undefined;
    return {
      claudeSessionId: parsed.claudeSessionId,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      started: parsed.started === true,
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
      ...(typeof parsed.contextWindow === "number" ? { contextWindow: parsed.contextWindow } : {}),
      ...(typeof parsed.takenOver === "string" && parsed.takenOver !== "" ? { takenOver: parsed.takenOver } : {}),
      ...lineageOf(parsed.lineage),
    };
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value !== "";

/** 记录里的 lineage：形状不对的条目丢掉（文件被手改坏了也照样能起来，只是撤回不到那些输入之前） */
function lineageOf(raw: unknown): { lineage?: ClaudeLineage } {
  if (!isObject(raw)) return {};
  const lineage: ClaudeLineage = { inputs: {}, sessions: {}, notes: {} };
  for (const [id, input] of Object.entries(isObject(raw.inputs) ? raw.inputs : {})) {
    if (isObject(input) && isString(input.session) && isString(input.uuid)) lineage.inputs[id] = { session: input.session, uuid: input.uuid, ...(isString(input.anchor) ? { anchor: input.anchor } : {}) };
  }
  const point = (value: unknown): ClaudeForkPoint | undefined =>
    value === "empty" ? "empty" : isObject(value) && isString(value.session) && isString(value.anchor) ? { session: value.session, anchor: value.anchor } : undefined;
  for (const [id, session] of Object.entries(isObject(raw.sessions) ? raw.sessions : {})) {
    if (!isObject(session)) continue;
    const origin = point(session.origin);
    lineage.sessions[id] = { ...(origin === undefined ? {} : { origin }), ...(isString(session.first) ? { first: session.first } : {}) };
  }
  for (const [id, note] of Object.entries(isObject(raw.notes) ? raw.notes : {})) if (isString(note)) lineage.notes[id] = note;
  return { lineage };
}

/** 写记录（先写临时文件再换名，写到一半被杀也不会留下坏文件）；修改时间就是"最近用过" */
export function writeRecord(file: string, record: ClaudeSessionRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** 会话目录里修改时间最近的记录的名字（给了 accept 的只看它认的）；没有是 undefined */
function mostRecent(sessionDir: string, accept?: (record: ClaudeSessionRecord) => boolean): string | undefined {
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

/** 接管来的那条线上现在的 Claude 会话 id（290 号票）：会话目录里记着同一个来源的最近那份记录的；没有是接管的那个 id 本身 */
function takenOverSessionId(sessionDir: string, source: string): string {
  const recent = mostRecent(sessionDir, (record) => record.takenOver === source);
  return (recent === undefined ? undefined : read(fileOf(sessionDir, recent))?.claudeSessionId) ?? source;
}

function create(assembly: SessionAssembly, name: string | undefined, now: () => Date, takeOver?: string): OpenedRecord {
  // 接管的（290 号票）：不新开 Claude 的会话，接着接管的那条线（按 id 恢复）
  const record: ClaudeSessionRecord =
    takeOver === undefined
      ? { claudeSessionId: randomUUID(), cwd: assembly.cwd, createdAt: now().toISOString(), started: false }
      : { claudeSessionId: takenOverSessionId(assembly.sessionDir, takeOver), cwd: assembly.cwd, createdAt: now().toISOString(), started: true, takenOver: takeOver };
  const { claudeSessionId } = record;
  const finalName = name ?? claudeSessionId;
  const file = fileOf(assembly.sessionDir, finalName);
  writeRecord(file, record);
  return { name: finalName, record, existing: false, file };
}

function open(assembly: SessionAssembly, name: string): OpenedRecord | undefined {
  const file = fileOf(assembly.sessionDir, name);
  const record = read(file);
  return record && { name, record, existing: true, file };
}

/** 按装配参数选会话（见文件头）；新开的马上写好记录（之后"接着最近的"接的就是它） */
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
