// 效果日志（规格第 9 节）：ergou.db 的派生视图，由 guard 频道上的 effect_recorded 事件归并。
// 只有执行成功的调用才追加：`{序号, 任务, 阶段, agent, 工具或伪工具, 规范化参数, 效果摘要, 时间}`，再加上会话段。
// 时序规则和授权项计次只看它（判定时按范围取：任务里只看同一个任务的，不属于任务的只看同一个 agent、同一段会话的）。
// 效果摘要写执行后的效果：成功（bash 带退出码）、改动的文件、简短结果。
import { PURGED_TEXT } from "@ergou/protocol";
import type { DerivedView, EventStore } from "../events/event-store.ts";
import { purgedStrings, type PurgeRewriter } from "../events/purge.ts";
import { type EffectRecord, effectRecordsFor, type GuardInput, type GuardJudgement, type JudgedCall, type ToolRegistry } from "../guard/index.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { oneLine } from "../util/text.ts";
import { type EffectRecordedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "./events.ts";
import { type CallPrivacy, SECRET_FILE_RESULT } from "./read-secrets.ts";

export const effectLogView: DerivedView = {
  name: "effect_log",
  create: (db) =>
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
    `),
  clear: (db) => db.exec("DELETE FROM effect_log"),
  apply(db, event) {
    if (event.channel !== GUARD_CHANNEL || event.type !== GUARD_EVENTS.effectRecorded) return;
    for (const record of (event.payload as EffectRecordedPayload).records) {
      db.run(
        "INSERT INTO effect_log (seq, task_id, stage_id, agent_id, segment_id, tool, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
        record.seq,
        record.taskId,
        record.stageId,
        record.agentId,
        record.segmentId ?? null,
        record.tool,
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
 * privacy（read-secrets.ts）：读了密钥文件的，摘要里不记结果；参数和摘要里读过的密钥值换成"（密钥）"
 */
export function recordEffects(
  store: EventStore,
  input: GuardInput,
  judgement: GuardJudgement,
  done: { resultText: string; at: number; privacy?: CallPrivacy },
): EffectRecord[] {
  const records = effectRecordsFor(input, judgement, { firstSeq: nextEffectSeq(store.reader), at: done.at });
  const privacy = done.privacy;
  const resultText = privacy?.readsSecretFile ? SECRET_FILE_RESULT : done.resultText;
  const withSummaries = records.map((r, i) => {
    const summary = effectSummary(judgement.calls[i]!, r.args, input.tools, resultText);
    return privacy ? { ...r, args: privacy.deep(r.args), summary: privacy.text(summary) } : { ...r, summary };
  });
  const payload: EffectRecordedPayload = { records: withSummaries };
  store.append({ channel: GUARD_CHANNEL, type: GUARD_EVENTS.effectRecorded, payload });
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
 * 彻底删除（21 号票）：效果记录里的参数（原话可能在里面）的文字和效果摘要换成删除标记，序号、工具、任务、agent、会话段、时间不变，
 * 所以效果日志的条数和先后不变（时序规则据此判断的"之前做过什么"还在）
 */
export const effectRecordPurge: PurgeRewriter = {
  eventType: GUARD_EVENTS.effectRecorded,
  rewrite(event) {
    const p = event.payload as EffectRecordedPayload;
    return { records: p.records.map((r) => ({ ...r, args: purgedStrings(r.args) as Record<string, unknown>, summary: PURGED_TEXT })) } satisfies EffectRecordedPayload;
  },
};
