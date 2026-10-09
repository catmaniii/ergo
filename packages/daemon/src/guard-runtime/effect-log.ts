// 效果日志（规格第 9 节）：ergou.db 的派生视图，由 guard 频道上的 effect_recorded 事件归并。
// 只有执行成功的调用才追加：`{序号, 任务, 阶段, agent, 工具或伪工具, 规范化参数, 效果摘要, 时间}`，再加上会话段。
// 时序规则和授权项计次只看它（判定时按范围取：任务里只看同一个任务的，不属于任务的只看同一个 agent、同一段会话的）。
// 效果摘要写执行后的效果：成功（bash 带退出码）、改动的文件、简短结果。
// 56 号票起每条记上哪次调用产生的（callId），详情页取一次调用的完整内容时顺带它的效果（effectsOfCall、effectView）。
import { EVENT_TYPES, isDeletedEventPayload, type MessageEventPayload, PURGED_TEXT, type ToolCallDetail, type ToolCallEffect, type ToolCallEffectObject } from "@ergou/protocol";
import type { DerivedView, EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import { purgedStrings, type PurgeRewriter } from "../events/purge.ts";
import {
  type ArgKind,
  BUILTIN_TOOL_REGISTRY,
  type EffectRecord,
  effectRecordsFor,
  findTool,
  type GuardInput,
  type GuardJudgement,
  type JudgedCall,
  TOOL,
  type ToolRegistry,
} from "../guard/index.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { oneLine } from "../util/text.ts";
import { type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "./events.ts";
import { type CallPrivacy, SECRET_FILE_RESULT } from "./read-secrets.ts";

export const effectLogView: DerivedView = {
  name: "effect_log",
  create: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS effect_log (
        seq INTEGER PRIMARY KEY,
        task_id TEXT,
        stage_id TEXT,
        agent_id TEXT NOT NULL,
        segment_id TEXT,
        tool TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS effect_log_by_task ON effect_log (task_id, seq);
      CREATE INDEX IF NOT EXISTS effect_log_by_segment ON effect_log (agent_id, segment_id, seq);
    `);
    // 56 号票加的：哪次调用产生的（之前的记录没有，是 NULL）
    if (!db.all<{ name: string }>("PRAGMA table_info(effect_log)").some((c) => c.name === "call_id")) db.exec("ALTER TABLE effect_log ADD COLUMN call_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS effect_log_by_call ON effect_log (call_id)");
  },
  clear: (db) => db.exec("DELETE FROM effect_log"),
  apply(db, event) {
    if (event.channel !== GUARD_CHANNEL || event.type !== GUARD_EVENTS.effectRecorded) return;
    for (const record of (event.payload as EffectRecordedPayload).records) {
      db.run(
        "INSERT INTO effect_log (seq, task_id, stage_id, agent_id, segment_id, tool, call_id, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        record.seq,
        record.taskId,
        record.stageId,
        record.agentId,
        record.segmentId ?? null,
        record.tool,
        record.callId ?? null,
        JSON.stringify(record),
      );
    }
  },
};

/** 效果日志的范围：任务里是这个任务；不属于任务的是某个 agent 的某段会话 */
export type EffectScope = { taskId: string } | { taskId: null; agentId: string; segmentId: string | undefined };

/** 范围里的效果，按序号 */
export function listEffects(db: ReadonlyDatabase, scope: EffectScope): EffectRecord[] {
  const rows =
    scope.taskId !== null
      ? db.all<{ record: string }>("SELECT record FROM effect_log WHERE task_id = ? ORDER BY seq", scope.taskId)
      : db.all<{ record: string }>(
          "SELECT record FROM effect_log WHERE task_id IS NULL AND agent_id = ? AND segment_id IS ? ORDER BY seq",
          scope.agentId,
          scope.segmentId ?? null,
        );
  return rows.map((row) => JSON.parse(row.record) as EffectRecord);
}

/** 下一条效果的序号（全局从 1 起连续） */
export function nextEffectSeq(db: ReadonlyDatabase): number {
  return Number(db.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM effect_log")?.seq ?? 0) + 1;
}

/**
 * 一次放行、执行成功的调用追加进效果日志（调用方保证只在执行成功后调用）。
 * resultText 是工具交回模型的结果文字（效果摘要里截一小段），at 是执行完的时间（毫秒）。
 * callId 是这次调用的 id（56 号票：详情页按它找这次调用的效果），拆出来的每一条都记上。
 * privacy（read-secrets.ts）：读了密钥文件的，摘要里不记结果；参数和摘要里读过的密钥值换成"（密钥）"。
 * also 是同一事务追加在后面的事件（这次调用结束的记录，23 号票）
 */
export function recordEffects(
  store: EventStore,
  input: GuardInput,
  judgement: GuardJudgement,
  done: { callId: string; resultText: string; at: number; privacy?: CallPrivacy; also?: readonly NewEvent[] },
): EffectRecord[] {
  const records = effectRecordsFor(input, judgement, { firstSeq: nextEffectSeq(store.reader), at: done.at });
  const privacy = done.privacy;
  const resultText = privacy?.readsSecretFile ? SECRET_FILE_RESULT : done.resultText;
  const withSummaries = records.map((r, i) => {
    const summary = effectSummary(judgement.calls[i]!, r.args, input.tools, resultText);
    const record: EffectRecord = { ...r, callId: done.callId };
    return privacy ? { ...record, args: privacy.deep(r.args), summary: privacy.text(summary) } : { ...record, summary };
  });
  const payload: EffectRecordedPayload = { records: withSummaries };
  // also：同一事务追加的（这次调用结束的记录，23 号票），排在效果日志之后（彻底删除按"紧跟在工具调用记录后面"找效果日志）
  store.appendBatch([{ channel: GUARD_CHANNEL, type: GUARD_EVENTS.effectRecorded, payload }, ...(done.also ?? [])]);
  return withSummaries;
}

const RESULT_MAX = 80;
const COMMAND_MAX = 80;

/**
 * 效果摘要：做了什么、改动（写、删）和涉及（不知道读还是写）的文件、成功（bash 带退出码；只有执行成功的调用才记，
 * pi 的 bash 非零退出按出错结束，所以总是 0）、结果的开头一小段。比如"跑脚本（bash「node calc.js」）；成功，退出码 0；结果：6"
 * "写文件；改动 D:\…\scratch\calc.js；成功；结果：Successfully wrote 52 bytes to calc.js"
 */
export function effectSummary(call: JudgedCall, args: Record<string, unknown>, tools: ToolRegistry, resultText: string): string {
  const descriptor = Object.hasOwn(tools, call.tool) ? tools[call.tool] : undefined;
  const title = descriptor?.title ?? call.tool;
  const shell = call.origin === "shell";
  const changed: string[] = [];
  const touched: string[] = [];
  for (const [name, rule] of Object.entries(descriptor?.args ?? {})) {
    if (rule.kind !== "path" || rule.access === "read") continue;
    const value = args[name];
    const into = rule.access === "unknown" || rule.access === undefined ? touched : changed;
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string") into.push(v);
  }
  const result = oneLine(resultText, RESULT_MAX);
  return [
    shell ? `${title}（bash「${oneLine(call.text ?? "", COMMAND_MAX)}」）` : title,
    changed.length > 0 ? `改动 ${changed.join("、")}` : "",
    touched.length > 0 ? `涉及 ${touched.join("、")}` : "",
    shell ? "成功，退出码 0" : "成功",
    result ? `结果：${result}` : "",
  ]
    .filter((s) => s !== "")
    .join("；");
}

/**
 * 彻底删除（21 号票）：效果记录里的参数（原话可能在里面）的文字和效果摘要换成删除标记，调用 id（56 号票）一起去掉——
 * 详情页不再按它找到这几条；序号、工具、任务、agent、会话段、时间不变，
 * 所以效果日志的条数和先后不变（时序规则据此判断的"之前做过什么"还在）
 */
export const effectRecordPurge: PurgeRewriter = {
  eventType: GUARD_EVENTS.effectRecorded,
  rewrite(event) {
    const p = event.payload as EffectRecordedPayload;
    const records = p.records.map((r) => {
      const purged: EffectRecord = { ...r, args: purgedStrings(r.args) as Record<string, unknown>, summary: PURGED_TEXT };
      delete purged.callId;
      return purged;
    });
    return { records } satisfies EffectRecordedPayload;
  },
};

// ───────────────────────── 一次调用的效果（56 号票：详情页、彻底删除、删除项目共用） ─────────────────────────

/**
 * 找效果日志用的一次调用：调用 id、发起的 agent（旧的工具调用记录上看不出、又没有完整内容时不知道，就不按 agent 限定）、
 * 模型调用的工具、会话里的工具调用记录在哪个会话（不在会话里的评审子 agent 为 null）
 */
export interface EffectCall {
  readonly callId: string;
  readonly agentId: string | undefined;
  readonly tool: string;
  readonly conversation: string | null;
}

export const effectCallOf = (d: ToolCallDetail): EffectCall => ({ callId: d.callId, agentId: d.agentId, tool: d.tool, conversation: d.conversation });

/** 记了调用 id 的效果记录（56 号票起）是不是这次调用的：调用 id 相同，agent 也相同（不同 agent 的调用 id 可能撞上） */
const ownedBy = (r: EffectRecord, call: EffectCall) => r.callId === call.callId && (call.agentId === undefined || r.agentId === call.agentId);

/**
 * 加上调用 id 之前的旧效果日志：紧跟在这次调用的记录后面的那条 effect_recorded——守护进程在调用结束时依次追加完整内容
 * （53 号票）、会话里的工具调用记录（评审子 agent 没有）、效果日志，中间不插别的。anchor 是这次调用的完整内容或工具调用记录，
 * 从完整内容往后找时跨过紧跟着的工具调用记录。紧跟着的效果日志还得每一条都没有调用 id、是同一个 agent 的（知道 agent 时）、
 * 记的是同一个工具（通用 bash 记的是拆出来的伪工具，不比工具）才算。中间插了别的就找不到（宁可漏，不认错）。
 * 详情页、彻底删除、删除项目都只用这一份
 */
export function legacyEffectEventAfter(store: EventStore, anchor: StoredEvent, call: EffectCall): StoredEvent | undefined {
  const [first, second] = store.readGlobal(anchor.globalSeq, 2);
  const next = first && isToolCallRecordOf(first, call) ? second : first;
  if (next?.channel !== GUARD_CHANNEL || next.type !== GUARD_EVENTS.effectRecorded || isDeletedEventPayload(next.payload)) return undefined;
  const { records } = next.payload as EffectRecordedPayload;
  const ours =
    records.length > 0 &&
    records.every((r) => r.callId === undefined && (call.agentId === undefined || r.agentId === call.agentId) && (call.tool === TOOL.bash || r.tool === call.tool));
  return ours ? next : undefined;
}

/** 会话里这次调用的工具调用记录（守卫接入追加的消息，这次调用的 part 在里面） */
function isToolCallRecordOf(event: StoredEvent, call: EffectCall): boolean {
  if (event.channel !== call.conversation || event.type !== EVENT_TYPES.message || isDeletedEventPayload(event.payload)) return false;
  const parts = (event.payload as Partial<MessageEventPayload>).message?.parts ?? [];
  return parts.some((p) => p.type === "tool_call" && p.callId === call.callId);
}

/**
 * 这次调用的效果日志事件（彻底删除、删除项目改写这次调用时连带）：记了调用 id 的按调用 id 和 agent 找；
 * 之前的旧记录按紧跟在 anchors（这次调用的完整内容、工具调用记录）后面找
 */
export function effectEventsOfCall(store: EventStore, call: EffectCall, anchors: readonly StoredEvent[]): StoredEvent[] {
  const byId = store
    .mentioning(GUARD_EVENTS.effectRecorded, JSON.stringify(call.callId).slice(1, -1))
    .filter((e) => e.channel === GUARD_CHANNEL && (e.payload as EffectRecordedPayload).records.some((r) => ownedBy(r, call)));
  return [...byId, ...anchors.flatMap((a) => legacyEffectEventAfter(store, a, call) ?? [])];
}

/** 一次调用的效果记录（详情页用），按序号：detail 是它的完整内容事件。记了调用 id 的按调用 id 和 agent 找，旧的按紧跟着找 */
export function effectsOfCall(store: EventStore, detail: StoredEvent): EffectRecord[] {
  const call = effectCallOf(detail.payload as ToolCallDetail);
  const rows = store.reader.all<{ record: string }>("SELECT record FROM effect_log WHERE call_id = ? AND agent_id = ? ORDER BY seq", call.callId, call.agentId ?? "");
  if (rows.length > 0) return rows.map((row) => JSON.parse(row.record) as EffectRecord);
  const legacy = legacyEffectEventAfter(store, detail, call);
  return legacy ? [...(legacy.payload as EffectRecordedPayload).records] : [];
}

/** 效果涉及的对象：按工具登记里的参数规则认的路径、收件人、网址 */
const OBJECT_KINDS: ReadonlySet<ArgKind> = new Set(["path", "recipient", "url"]);

/**
 * 详情页上的一条效果：摘要和涉及的对象。对象按内置工具、带类型的 bash 工具、伪工具的登记认（取的时候调用时那份会话的注册表已经不在了）；
 * 别的工具（MCP、二狗自己的工具）认不出对象，涉及的文件写在摘要里。工具的中文名：和这次调用是同一个工具的，用调用时的
 */
export function effectView(record: EffectRecord, call: Pick<ToolCallDetail, "tool" | "toolTitle">): ToolCallEffect {
  const descriptor = findTool(BUILTIN_TOOL_REGISTRY, record.tool);
  const toolTitle = record.tool === call.tool ? call.toolTitle : descriptor?.title;
  const objects: ToolCallEffectObject[] = [];
  for (const [name, rule] of Object.entries(descriptor?.args ?? {})) {
    if (!OBJECT_KINDS.has(rule.kind)) continue;
    const value = record.args[name];
    for (const v of Array.isArray(value) ? value : [value]) {
      const object = objectValue(v);
      if (!object) continue;
      objects.push({ kind: rule.kind as ToolCallEffectObject["kind"], ...(rule.kind === "path" ? { access: rule.access ?? "unknown" } : {}), ...object });
    }
  }
  return { seq: record.seq, tool: record.tool, ...(toolTitle === undefined ? {} : { toolTitle }), summary: record.summary, objects };
}

/** 规范化参数里的一个值：字符串照写；守卫没法确定的（{"$unknown": 原文}）写原文、标上说不准；别的不算对象 */
function objectValue(v: unknown): Pick<ToolCallEffectObject, "value" | "uncertain"> | undefined {
  if (typeof v === "string") return v === "" ? undefined : { value: v };
  if (typeof v !== "object" || v === null || !Object.hasOwn(v, "$unknown")) return undefined;
  const desc = (v as { $unknown: unknown }).$unknown;
  return typeof desc === "string" && desc !== "" ? { value: desc, uncertain: true } : undefined;
}
