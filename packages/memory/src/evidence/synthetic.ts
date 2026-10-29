// 合成数据适配器：读合成数据的 JSON（格式见 188 号票；评测数据在私有的评测包里，测试用 test/fixtures/ 里自己写的例子）。
//   { "version": 1, "now": "<ISO>", "events": [{ id, source_level, mode, kind, text, context, event_time, observed_at }] }
// event_time 可以是 null 或不写（不知道什么时候发生）。读的时候逐条校验，错了写明是哪条、哪个字段。
// 只读 events.json，不读 truth/（隐藏答案只给评测脚本）。
import fs from "node:fs";
import { isIdOf } from "../domain/ids.ts";
import { isZonedIso } from "../domain/time.ts";
import { EVIDENCE_KINDS, MODES, SOURCE_LEVELS, type EvidenceDraft } from "../domain/types.ts";
import type { EvidenceSource } from "./source.ts";

export interface SyntheticEvent {
  id: string;
  source_level: string;
  mode: string;
  kind: string;
  text: string;
  context: string[];
  event_time?: string | null;
  observed_at: string;
}

export interface SyntheticDataset {
  version: 1;
  now: string;
  events: SyntheticEvent[];
}

export class SyntheticEventsSource implements EvidenceSource {
  readonly name = "synthetic";
  readonly now: string;
  private readonly drafts: EvidenceDraft[];

  constructor(dataset: SyntheticDataset) {
    const problems: string[] = [];
    if (dataset?.version !== 1) problems.push(`version 应为 1，现在是 ${JSON.stringify(dataset?.version)}`);
    if (!isZonedIso(dataset?.now)) problems.push(`now 应为带时区的 ISO 时间，现在是 ${JSON.stringify(dataset?.now)}`);
    if (!Array.isArray(dataset?.events)) problems.push("events 应为数组");
    if (problems.length > 0) throw new Error(`合成数据格式不对：${problems.join("；")}`);
    this.now = dataset.now;
    const seen = new Set<string>();
    this.drafts = dataset.events.map((e, i) => {
      const draft = toDraft(e, i);
      if (seen.has(draft.id!)) throw new Error(`合成数据格式不对：事件 ${draft.id} 重复`);
      seen.add(draft.id!);
      return draft;
    });
  }

  static fromFile(file: string): SyntheticEventsSource {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`合成数据读不了（${file}）：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`合成数据不是合法的 JSON（${file}）：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    return new SyntheticEventsSource(data as SyntheticDataset);
  }

  read(): EvidenceDraft[] {
    return this.drafts.map((d) => ({ ...d, context: [...d.context] }));
  }
}

function toDraft(e: SyntheticEvent, index: number): EvidenceDraft {
  const label = typeof e?.id === "string" ? e.id : `第 ${index + 1} 条`;
  const problems: string[] = [];
  if (!isIdOf("evidence", e?.id)) problems.push(`id 应以 ev- 开头，现在是 ${JSON.stringify(e?.id)}`);
  if (!(SOURCE_LEVELS as readonly string[]).includes(e?.source_level)) problems.push(`source_level 应为 ${SOURCE_LEVELS.join(" | ")}`);
  if (!(MODES as readonly string[]).includes(e?.mode)) problems.push(`mode 应为 ${MODES.join(" | ")}`);
  if (!(EVIDENCE_KINDS as readonly string[]).includes(e?.kind)) problems.push(`kind 应为 ${EVIDENCE_KINDS.join(" | ")}`);
  if (typeof e?.text !== "string" || e.text.trim().length === 0) problems.push("text 应为非空字符串");
  if (!Array.isArray(e?.context) || e.context.some((t) => typeof t !== "string" || t.trim().length === 0)) problems.push("context 应为非空字符串的数组");
  if (e?.event_time !== undefined && e.event_time !== null && !isZonedIso(e.event_time)) problems.push("event_time 应为带时区的 ISO 时间或 null");
  if (!isZonedIso(e?.observed_at)) problems.push("observed_at 应为带时区的 ISO 时间");
  if (problems.length > 0) throw new Error(`合成数据格式不对：事件 ${label}：${problems.join("；")}`);
  return {
    id: e.id,
    sourceLevel: e.source_level as EvidenceDraft["sourceLevel"],
    mode: e.mode as EvidenceDraft["mode"],
    kind: e.kind as EvidenceDraft["kind"],
    text: e.text,
    context: [...e.context],
    eventTime: e.event_time ?? null,
    observedAt: e.observed_at,
    sourceRef: `fixture:${e.id}`,
  };
}
