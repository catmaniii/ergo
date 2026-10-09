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
// 归属（任务、项目、阶段）和工具调用记录同一份，判定那一刻取的；评审子 agent 的调用不在任何会话里，也带着它评审的任务、
// 阶段和项目（tasks/review.ts）。
// 彻底删除（ADR-0008 的口径）：工具调用记录被改写的那些调用、执行记录被改写的调用、返回里提到被删素材的检索调用，
// 它们的完整内容一起改写（memory/purge.ts）；删除项目时项目维护者会话里的（含子 agent 的）、维护者的、归属这个项目的
// （含评审子 agent 的）一起改写（projects/deletion.ts）：参数和返回里的文字换成删除标记，工具、结局这些结构字段不变。
// 只靠完整内容找到的检索调用，会话里的 messages_purged 不会列出（它的工具调用记录没改）：前端不要缓存完整内容。
import { PURGED_TEXT, pickMessageScope, TOOL_CALL_VALUE_MAX_BYTES, type ConversationId, type ToolCallDetail, type TruncatedValue } from "@ergou/protocol";
import type { DerivedView, EventStore, StoredEvent } from "../events/event-store.ts";
import { purgedStrings, type PurgeRewriter } from "../events/purge.ts";
import { type CallPrivacy, SECRET_FILE_RESULT } from "./read-secrets.ts";
import { type CallState, callOutcome, type ToolCallEnd } from "./tool-call-record.ts";

/** 守护进程内部的频道：每次工具调用的完整内容 */
export const TOOL_CALLS_CHANNEL = "tool_calls";
export const TOOL_CALL_DETAIL_EVENT = "tool_call_detail";

export const toolCallDetailsView: DerivedView = {
  name: "tool_call_details",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_call_details (
        global_seq INTEGER PRIMARY KEY,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation TEXT,
        project_id TEXT
      );
      CREATE INDEX IF NOT EXISTS tool_call_details_by_call ON tool_call_details (call_id);
      CREATE INDEX IF NOT EXISTS tool_call_details_by_tool ON tool_call_details (tool);
    `),
  clear: (db) => db.exec("DELETE FROM tool_call_details"),
  apply(db, event) {
    if (event.channel !== TOOL_CALLS_CHANNEL || event.type !== TOOL_CALL_DETAIL_EVENT) return;
    const d = event.payload as ToolCallDetail;
    db.run(
      "INSERT INTO tool_call_details (global_seq, call_id, tool, agent_id, conversation, project_id) VALUES (?, ?, ?, ?, ?, ?)",
      event.globalSeq,
      d.callId,
      d.tool,
      d.agentId,
      d.conversation,
      d.projectId ?? null,
    );
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
  const args = truncateStrings(privacy.deep(state.args), "/args", truncated);
  const result = withheld ? SECRET_FILE_RESULT : truncateValue(privacy.text(end.resultText), "/result", truncated);
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

/** 按调用 id 取完整内容（同一个 id 有几份时取最后一份）；没有是 undefined */
export function findToolCallDetail(store: EventStore, callId: string): ToolCallDetail | undefined {
  const row = store.reader.get<{ global_seq: number }>("SELECT global_seq FROM tool_call_details WHERE call_id = ? ORDER BY global_seq DESC LIMIT 1", callId);
  return row === undefined ? undefined : (detailEventAt(store, Number(row.global_seq))?.payload as ToolCallDetail | undefined);
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
 * 某个工具的调用里，参数或返回提到这段文字的完整内容的事件（彻底删除时找结果里列出过被删素材的检索）：
 * 先按视图筛出这个工具的调用，只看这些的负载
 */
export function detailEventsOfToolMentioning(store: EventStore, tool: string, text: string): StoredEvent[] {
  return detailEventsWhere(store, "tool = ?", tool).filter((e) => {
    const d = e.payload as ToolCallDetail;
    return d.result.includes(text) || JSON.stringify(d.args).includes(text);
  });
}

function detailEventsWhere(store: EventStore, where: string, ...params: string[]): StoredEvent[] {
  return store.reader
    .all<{ global_seq: number }>(`SELECT global_seq FROM tool_call_details WHERE ${where} ORDER BY global_seq`, ...params)
    .flatMap((row) => detailEventAt(store, Number(row.global_seq)) ?? []);
}

function detailEventAt(store: EventStore, globalSeq: number): StoredEvent | undefined {
  const [event] = store.readGlobal(globalSeq - 1, 1);
  return event?.globalSeq === globalSeq && event.type === TOOL_CALL_DETAIL_EVENT ? event : undefined;
}

/**
 * 彻底删除（ADR-0008）：参数里的文字、返回换成删除标记，工具、结局、归属、时间不变；截断说明和"不记返回"的原因跟着去掉
 * （内容都没了）。图片的说明里没有原话，留着
 */
export const toolCallDetailPurge: PurgeRewriter = {
  eventType: TOOL_CALL_DETAIL_EVENT,
  rewrite(event) {
    const purged: ToolCallDetail = { ...(event.payload as ToolCallDetail), args: purgedStrings((event.payload as ToolCallDetail).args), result: PURGED_TEXT, purged: true };
    delete purged.truncated;
    delete purged.resultWithheld;
    return purged;
  },
};

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
  return `${buf.subarray(0, end).toString("utf8")}\n…（已截断：原长 ${bytes} 字节，只留开头 ${TOOL_CALL_VALUE_MAX_BYTES / 1024} KB）`;
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
