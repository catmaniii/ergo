// 工具调用的完整参数和返回（53 号票，详情页用；规格第 19 节）：聊天里的工具调用 part 只有摘要（参数 160 字、结果 200 字），
// 完整的在这里——每次经守卫的调用（秘书、维护者、子 agent、评审，被拦下的、出错的都算）在 tool_call_end 时另存一份。
//
// 为什么调用结束时另存、不去读 pi 的会话文件：
// - 隐私要在那一刻处理：读过的密钥值（read-secrets.ts）只在内存里，守护进程重启后就没了，事后读会话文件擦不掉；
// - 会话文件是 pi 的格式，只能在 agent-child/ 里读（ADR-0004），按调用 id 找还得先知道在哪个 agent 的哪个会话文件里；
// - 评审子 agent 的会话不留，维护者的会话随删除项目整个删掉。
//
// 存法：事件日志里守护进程内部的频道 tool_calls（前端不订阅它）上的 tool_call_detail 事件，负载就是协议包的
// ToolCallDetail；派生视图 tool_call_details 只记调用 id → 事件的全局序号，外加工具、agent、会话、项目（彻底删除、
// 删除项目按它们先筛出要看的那几条，不整频道读负载），取的时候按全局序号读回事件。同一个调用 id 有两份时取最后一份。
// 写进事件日志之前：
// - 和工具调用记录同一份 CallPrivacy（必给）：读过的密钥值、认得出的密钥形态（守卫的 SECRET_PATTERNS）换成"（密钥）"，
//   放行执行了、读的是密钥文件的不记返回；
// - 单个值（返回的文字、参数里的每个字符串）超过 TOOL_CALL_VALUE_MAX_BYTES（200KB）的只留开头，末尾注明已截断和原长，
//   truncated 里按 JSON Pointer 列出（先擦再截：截断处不会留下半个密钥）；
// - 二进制内容（图片）本来就不在返回的文字里（子进程换成 [image] 这样的占位），media 里说明是什么、多大
//   （宿主协议 11 的 tool_call_end.media）。
// - Claude Code 这类运行时的调用（288 号票）：参数存运行时自己的工具收到的原样（guard_request.native），工具名另记 nativeTool；
//   子代理里的调用记着调用它的那次调用（parentCallId）。
// 归属（任务、项目、阶段）和工具调用记录同一份，判定那一刻取的；评审子 agent 的调用不在任何会话里，也带着它评审的任务、
// 阶段和项目（tasks/review.ts）。
// 彻底删除（ADR-0008 的口径）：工具调用记录被改写的那些调用、执行记录被改写的调用、返回里提到被删素材的检索调用，
// 它们的完整内容一起改写（memory/purge.ts）；删除项目时项目维护者会话里的（含子 agent 的）、维护者的、归属这个项目的
// （含评审子 agent 的）一起改写（279 号票起经"删除参与方"登记表，guard-runtime/deletion.ts），66 号票起还有项目之外读过这个项目的（projects/outside-reads.ts：
// 先按视图的几列筛，再逐条读负载，detailRowsOf、detailEventAt）：参数和返回里的文字换成删除标记，工具、结局这些结构字段不变，
// 删除项目时的另记 purgedBy。
// 只靠完整内容找到的检索调用，会话里的 messages_purged 不会列出（它的工具调用记录没改）：前端不要缓存完整内容。
// 效果记录（56 号票）不另存：取的时候从效果日志里按调用 id 找（effect-log.ts 的 effectsOfCall），执行成功的顺带返回；
// 改写完整内容时，按调用 id 找到的效果日志一起改写。
// 保留期和总量上限（65 号票，ADR-0024）：过了保留期的、超出总量上限时从最旧的起，换成只剩摘要的样子（clearedDetail，
// 经 EventStore.expireContent 改写，不重放派生视图；视图上登记了 contentExpiry）；视图另记每条存下的时间、大小、
// 归属的任务、现在的样子（state），清理按它挑（detail-retention.ts）。清掉的接口照样回 200，cleared 注明原因。
import {
  PURGED_TEXT,
  pickMessageScope,
  TOOL_CALL_VALUE_MAX_BYTES,
  type ConversationId,
  type ToolCallClearReason,
  type ToolCallDetail,
  type TruncatedValue,
  t,
} from "@ergo/protocol";
import type { DerivedView, EventStore, StoredEvent } from "../events/event-store.ts";
import { purgedStrings, type PurgeRewriter } from "../events/purge.ts";
import type { ToolRegistry } from "../guard/index.ts";
import type { Database, ReadonlyDatabase } from "../storage/sqlite.ts";
import { resultSummary, summarizeArgs } from "./describe.ts";
import { effectsOfCall, effectView } from "./effect-log.ts";
import { type CallPrivacy, secretFileResult } from "./read-secrets.ts";
import { type CallState, callOutcome, type ToolCallEnd } from "./tool-call-record.ts";

/** 守护进程内部的频道：每次工具调用的完整内容 */
export const TOOL_CALLS_CHANNEL = "tool_calls";
export const TOOL_CALL_DETAIL_EVENT = "tool_call_detail";

/**
 * 一条完整内容现在的样子（视图的 state 列）：还是完整的（full）、过了保留期或超出总量上限清掉了只剩摘要（cleared）、
 * 彻底删除过（purged，内容本来就没了，清理不管它）
 */
export type DetailState = "full" | "cleared" | "purged";

const isDetailEvent = (event: StoredEvent) => event.channel === TOOL_CALLS_CHANNEL && event.type === TOOL_CALL_DETAIL_EVENT;

/** 视图里随负载变的几列：负载多大（存进事件日志的 JSON，UTF-8 字节）、现在是什么样子 */
function payloadFacts(detail: ToolCallDetail): { bytes: number; state: DetailState } {
  return { bytes: Buffer.byteLength(JSON.stringify(detail), "utf8"), state: detail.purged ? "purged" : detail.cleared ? "cleared" : "full" };
}

function insertDetailRow(db: Database, event: StoredEvent): void {
  const d = event.payload as ToolCallDetail;
  const { bytes, state } = payloadFacts(d);
  db.run(
    "INSERT INTO tool_call_details (global_seq, call_id, tool, agent_id, conversation, project_id, task_id, saved_ms, bytes, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    event.globalSeq,
    d.callId,
    d.tool,
    d.agentId,
    d.conversation,
    d.projectId ?? null,
    d.taskId ?? null,
    Date.parse(event.time),
    bytes,
    state,
  );
}

const DETAIL_TABLE = `
  CREATE TABLE IF NOT EXISTS tool_call_details (
    global_seq INTEGER PRIMARY KEY,
    call_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    conversation TEXT,
    project_id TEXT,
    task_id TEXT,
    saved_ms INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    state TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tool_call_details_by_call ON tool_call_details (call_id);
  CREATE INDEX IF NOT EXISTS tool_call_details_by_tool ON tool_call_details (tool);
  CREATE INDEX IF NOT EXISTS tool_call_details_by_state ON tool_call_details (state, global_seq);
`;

export const toolCallDetailsView: DerivedView = {
  name: "tool_call_details",
  create: (db) => {
    // 53 号票建的表没有任务、时间、大小、状态这几列（65 号票加的，都要从负载算，ALTER 加列补不上）：
    // 表删掉重建，由事件存储打开时从事件日志补回来（只补这一个视图；彻底删除过的本来就只剩删除标记，补不回原文）
    const columns = db.all<{ name: string }>("PRAGMA table_info(tool_call_details)");
    const legacy = columns.length > 0 && !columns.some((c) => c.name === "state");
    if (legacy) db.exec("DROP TABLE tool_call_details");
    db.exec(DETAIL_TABLE);
    return legacy ? "refill" : undefined;
  },
  clear: (db) => db.exec("DELETE FROM tool_call_details"),
  apply(db, event) {
    if (isDetailEvent(event)) insertDetailRow(db, event);
  },
  // 保留期清理（EventStore.expireContent）只改得了这一类：换成只剩摘要之后大小、样子跟着变（别的列换前换后一样）
  contentExpiry: {
    eventType: TOOL_CALL_DETAIL_EVENT,
    expired(db, event) {
      if (!isDetailEvent(event)) return;
      const { bytes, state } = payloadFacts(event.payload as ToolCallDetail);
      db.run("UPDATE tool_call_details SET bytes = ?, state = ? WHERE global_seq = ?", bytes, state, event.globalSeq);
    },
  },
};

/** 一次调用结束时知道的、part 里没有的：谁调的、在哪个会话、工具的中文名、结束时间、这次调用的隐私处理（必给：漏了就会把原文写进日志） */
export interface DetailContext {
  agentId: string;
  conversation: ConversationId | null;
  toolTitle: string;
  endedAt: string;
  privacy: CallPrivacy;
}

/** 一次调用的完整内容（写进事件日志的样子） */
export function toolCallDetail(state: CallState, end: ToolCallEnd, context: DetailContext): ToolCallDetail {
  const { privacy } = context;
  const truncated: TruncatedValue[] = [];
  const withheld = privacy.readsSecretFile;
  // 运行时自己的工具收到的原样参数（288 号票：Claude Code 的调用，守卫判的是映射到登记表之后的那份）
  const args = truncateStrings(privacy.deep(state.native ? state.native.args : state.args), "/args", truncated);
  const result = withheld ? secretFileResult() : truncateValue(privacy.text(end.resultText), "/result", truncated);
  return {
    callId: state.toolCallId,
    tool: state.toolName,
    toolTitle: context.toolTitle,
    ...pickMessageScope(state.scope),
    agentId: context.agentId,
    conversation: context.conversation,
    outcome: callOutcome(state, end),
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    endedAt: context.endedAt,
    args,
    ...(state.native && state.native.toolName !== state.toolName ? { nativeTool: state.native.toolName } : {}),
    ...(end.parentToolCallId === undefined ? {} : { parentCallId: end.parentToolCallId }),
    result,
    isError: end.isError,
    ...(end.media !== undefined && end.media.length > 0 ? { media: end.media } : {}),
    ...(truncated.length > 0 ? { truncated } : {}),
    ...(withheld ? { resultWithheld: "secret_file" as const } : {}),
  };
}

/** 这次调用的完整内容写进事件日志 */
export function recordToolCallDetail(store: EventStore, detail: ToolCallDetail): void {
  store.append({ channel: TOOL_CALLS_CHANNEL, type: TOOL_CALL_DETAIL_EVENT, payload: detail });
}

/**
 * 按调用 id 取完整内容（同一个 id 有几份时取最后一份）；没有是 undefined。
 * 执行成功的顺带这次调用的效果记录（56 号票，现从效果日志里找，effect-log.ts 的 effectsOfCall）；彻底删除过的不带
 */
export function findToolCallDetail(store: EventStore, callId: string): ToolCallDetail | undefined {
  const row = store.reader.get<{ global_seq: number }>("SELECT global_seq FROM tool_call_details WHERE call_id = ? ORDER BY global_seq DESC LIMIT 1", callId);
  const event = row === undefined ? undefined : detailEventAt(store, Number(row.global_seq));
  if (!event) return undefined;
  const detail = event.payload as ToolCallDetail;
  if (detail.outcome !== "done" || detail.purged) return detail;
  return { ...detail, effects: effectsOfCall(store, event).map((r) => effectView(r, detail)) };
}

/** 这一次调用（按调用 id）的完整内容的事件：彻底删除改写某次调用时连带它 */
export function detailEventsOfCall(store: EventStore, callId: string): StoredEvent[] {
  return detailEventsWhere(store, "call_id = ?", callId);
}

/**
 * 属于一个项目的调用的完整内容的事件（删除项目时找）：项目维护者会话里的（含子 agent 的）、维护者自己的、
 * 归属这个项目的（评审子 agent 的调用不在任何会话里，靠归属找）
 */
export function detailEventsOfProject(store: EventStore, project: { maintainerConversation: string; maintainerId: string; projectId: string }): StoredEvent[] {
  return detailEventsWhere(store, "conversation = ? OR agent_id = ? OR project_id = ?", project.maintainerConversation, project.maintainerId, project.projectId);
}

/**
 * 属于一个任务的调用的完整内容的事件（删除任务时找，186 号票）：它的维护者会话里的（含子 agent 的；任务转为项目、项目删掉了的
 * 不给会话）、这几个 agent（维护者、子 agent）自己的、归属这个任务又不在任何会话里的（评审子 agent 的）。秘书会话里归属这个任务的调用不算
 */
export function detailEventsOfTask(store: EventStore, task: { conversation?: string | undefined; agentIds: readonly string[]; taskId: string }): StoredEvent[] {
  const agents = task.agentIds.length > 0 ? ` OR agent_id IN (${task.agentIds.map(() => "?").join(", ")})` : "";
  const conversation = task.conversation === undefined ? "" : " OR conversation = ?";
  return detailEventsWhere(
    store,
    `(task_id = ? AND conversation IS NULL)${conversation}${agents}`,
    task.taskId,
    ...(task.conversation === undefined ? [] : [task.conversation]),
    ...task.agentIds,
  );
}

/** 视图里一次调用的几列（不读负载）：删除项目时先按它们筛，要看负载的再逐条读（detailEventAt，66 号票） */
export interface DetailRow {
  globalSeq: number;
  callId: string;
  agentId: string;
  conversation: string | null;
}

/** 这几种工具的调用（只取视图里的几列，按全局序号）；给了会话的只要这个会话里的和不在任何会话里的（评审子 agent 的） */
export function detailRowsOf(store: EventStore, tools: readonly string[], conversation?: string): DetailRow[] {
  if (tools.length === 0) return [];
  const byTool = `tool IN (${tools.map(() => "?").join(", ")})`;
  const where = conversation === undefined ? byTool : `(conversation = ? OR conversation IS NULL) AND ${byTool}`;
  const params = conversation === undefined ? tools : [conversation, ...tools];
  return store.reader
    .all<{ global_seq: number; call_id: string; agent_id: string; conversation: string | null }>(
      `SELECT global_seq, call_id, agent_id, conversation FROM tool_call_details WHERE ${where} ORDER BY global_seq`,
      ...params,
    )
    .map((r) => ({ globalSeq: Number(r.global_seq), callId: r.call_id, agentId: r.agent_id, conversation: r.conversation }));
}

/** 某个工具的全部调用的完整内容的事件，按全局序号（272 号票：一次性补抹问记忆、问记忆管理员的结果） */
export function detailEventsOfTool(store: EventStore, tool: string): StoredEvent[] {
  return detailEventsWhere(store, "tool = ?", tool);
}

/**
 * 某个工具的调用里，参数或返回提到这段文字的完整内容的事件（彻底删除时找结果里列出过被删素材的检索）：
 * 先按视图筛出这个工具的调用，只看这些的负载
 */
export function detailEventsOfToolMentioning(store: EventStore, tool: string, text: string): StoredEvent[] {
  return detailEventsWhere(store, "tool = ?", tool).filter((e) => {
    const d = e.payload as ToolCallDetail;
    return d.result.includes(text) || JSON.stringify(d.args).includes(text);
  });
}

/**
 * 返回或参数里有这段文字的调用的完整内容（281 号票：彻底删除个人档案里的值时，读过它的、参数里带着它的调用）；
 * tools 给了只看这几个工具的
 */
export function detailEventsMentioning(store: EventStore, text: string, tools?: readonly string[]): StoredEvent[] {
  // 负载是 JSON：按 JSON 里的写法在库里先筛（instr，不把全部完整内容读出来），再按工具、按返回和参数核对
  return store.mentioning(TOOL_CALL_DETAIL_EVENT, JSON.stringify(text).slice(1, -1)).filter((e) => {
    const d = e.payload as ToolCallDetail;
    if (tools !== undefined && !tools.includes(d.tool)) return false;
    return d.result.includes(text) || JSON.stringify(d.args).includes(JSON.stringify(text).slice(1, -1));
  });
}

function detailEventsWhere(store: EventStore, where: string, ...params: string[]): StoredEvent[] {
  return store.reader
    .all<{ global_seq: number }>(`SELECT global_seq FROM tool_call_details WHERE ${where} ORDER BY global_seq`, ...params)
    .flatMap((row) => detailEventAt(store, Number(row.global_seq)) ?? []);
}

/** 按全局序号读回一次调用的完整内容的事件；不是完整内容的事件为 undefined */
export function detailEventAt(store: EventStore, globalSeq: number): StoredEvent | undefined {
  const [event] = store.readGlobal(globalSeq - 1, 1);
  return event?.globalSeq === globalSeq && event.type === TOOL_CALL_DETAIL_EVENT ? event : undefined;
}

/**
 * 彻底删除（ADR-0008）：参数里的文字、返回换成删除标记，工具、结局、归属、时间不变；截断说明、"不记返回"的原因、
 * 过了保留期清掉的说明（65 号票）跟着去掉（内容都没了，详情页按删除说）。图片的说明里没有原话，留着。
 * 删除项目时一起改写的（66 号票）另记 purgedBy，彻底删除过的再随项目改写时还算彻底删除的（不改说法）
 */
export const toolCallDetailPurge: PurgeRewriter = {
  eventType: TOOL_CALL_DETAIL_EVENT,
  rewrite(event, context) {
    const detail = event.payload as ToolCallDetail;
    const purged: ToolCallDetail = {
      ...detail,
      args: purgedStrings(detail.args),
      result: PURGED_TEXT,
      purged: true,
      ...(context.purgedBy !== undefined && !detail.purged ? { purgedBy: context.purgedBy } : {}),
    };
    delete purged.truncated;
    delete purged.resultWithheld;
    delete purged.cleared;
    return purged;
  },
};

// ───────────────────────── 保留期和总量上限（65 号票） ─────────────────────────

/**
 * 清掉完整内容（过了保留期、超出总量上限）后剩下的样子：参数只剩参数摘要、返回只剩结果摘要（和聊天里工具调用记录的摘要
 * 同一个写法；存的时候已经擦过密钥；工具自己声明了参数要打码的按 tools 里的登记擦，280 号票），截断说明跟着去掉；工具、结局、归属、
 * 时间、图片说明、"不记返回"的原因不变，记下为什么、什么时候清的。效果记录不在这里，照旧从效果日志里找
 */
export function clearedDetail(detail: ToolCallDetail, reason: ToolCallClearReason, at: string, tools: ToolRegistry): ToolCallDetail {
  const cleared: ToolCallDetail = { ...detail, args: summarizeArgs(tools, detail.tool, detail.args), result: resultSummary(detail.result), cleared: { reason, at } };
  delete cleared.truncated;
  return cleared;
}

/** 视图里一条还存着完整内容的：清理按它挑（存下的时间、大小、归属的任务） */
export interface StoredDetail {
  globalSeq: number;
  callId: string;
  taskId: string | null;
  /** 存下的时间（调用结束时，毫秒） */
  savedMs: number;
  bytes: number;
}

/** 还存着完整内容的，从旧到新 */
export function fullDetails(db: ReadonlyDatabase): StoredDetail[] {
  return db
    .all<{ global_seq: number; call_id: string; task_id: string | null; saved_ms: number; bytes: number }>(
      "SELECT global_seq, call_id, task_id, saved_ms, bytes FROM tool_call_details WHERE state = 'full' ORDER BY global_seq",
    )
    .map((r) => ({ globalSeq: Number(r.global_seq), callId: r.call_id, taskId: r.task_id, savedMs: Number(r.saved_ms), bytes: Number(r.bytes) }));
}

/** 完整内容一共占多大（清掉后剩的摘要、彻底删除后剩的标记也算），还存着完整内容的、清掉了的各几次 */
export function detailTotals(db: ReadonlyDatabase): { bytes: number; full: number; cleared: number } {
  const row = db.get<{ bytes: number | null; full: number | null; cleared: number | null }>(
    "SELECT SUM(bytes) AS bytes, SUM(state = 'full') AS full, SUM(state = 'cleared') AS cleared FROM tool_call_details",
  );
  return { bytes: Number(row?.bytes ?? 0), full: Number(row?.full ?? 0), cleared: Number(row?.cleared ?? 0) };
}

type ClearTarget = { globalSeq: number; reason: ToolCallClearReason };

/**
 * 把这几条完整内容换成只剩摘要的样子（同一事务，EventStore.expireContent）：返回真清掉了的、腾出多少字节。
 * 已经不是完整的了（这期间被彻底删除了、清掉了）的跳过。tools：认得的工具的登记（参数摘要按里面的"参数要打码"擦）
 */
export function clearDetails(store: EventStore, targets: readonly ClearTarget[], at: string, tools: ToolRegistry): { cleared: ClearTarget[]; freedBytes: number } {
  let freedBytes = 0;
  const cleared: ClearTarget[] = [];
  const rewrites = targets.flatMap((target) => {
    const detail = detailEventAt(store, target.globalSeq)?.payload as ToolCallDetail | undefined;
    if (!detail || detail.purged || detail.cleared) return [];
    const payload = clearedDetail(detail, target.reason, at, tools);
    freedBytes += payloadFacts(detail).bytes - payloadFacts(payload).bytes;
    cleared.push(target);
    return [{ globalSeq: target.globalSeq, payload }];
  });
  if (rewrites.length > 0) store.expireContent(rewrites);
  return { cleared, freedBytes };
}

// ───────────────────────── 截断 ─────────────────────────

/** 截断一个值：超过上限时只留开头（不切开多字节字符），末尾注明已截断和原长；截了的记进 truncated */
function truncateValue(text: string, pointer: string, truncated: TruncatedValue[]): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TOOL_CALL_VALUE_MAX_BYTES) return text;
  truncated.push({ pointer, bytes });
  const buf = Buffer.from(text, "utf8");
  let end = TOOL_CALL_VALUE_MAX_BYTES;
  // 切点落在一个字符的中间（后续字节 10xxxxxx）时退到这个字符的开头
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8") + t("guardRuntime.details.truncated", { bytes, kb: TOOL_CALL_VALUE_MAX_BYTES / 1024 });
}

/** 参数结构里的每个字符串各自截断（数组、对象往里走，结构不变）；位置写成 JSON Pointer */
function truncateStrings(value: unknown, pointer: string, truncated: TruncatedValue[]): unknown {
  if (typeof value === "string") return truncateValue(value, pointer, truncated);
  if (Array.isArray(value)) return value.map((v, i) => truncateStrings(v, `${pointer}/${i}`, truncated));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v, `${pointer}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`, truncated)]));
  }
  return value;
}
