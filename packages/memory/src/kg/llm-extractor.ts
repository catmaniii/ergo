// 模型版事实抽取（LlmFactExtractor，id = model:<模型名>）：同一个 FactExtractor 接口，由模型写精炼陈述 statement。
// 引擎的 extractFacts 是同步的（在一个事务里写），模型要发请求，所以多一步 prepare：reflect 先按预算把待抽的证据分批问模型、
// 校验后缓存起来，extractFacts 再同步取（没 prepare 过的抛错，不会静默记成"抽过了"）。
// - 提示词要求带证据 id 的结构化输出；证据 id 不是这一批里的（伪造的）、字段不合格的，写入前丢掉，记进 dropped；
// - 出处不标 model_extracted：仍按证据定（本人说的 user_stated、做的 observed），这样模型版的事实照样参加变化判定和推理；
//   是谁抽的记在 extractedBy。
// - 199 号票：另外交实体和实体之间的关系（relations：事件的组织者、参加的人、地点、时间段、活动类型、提前多久约的，和谁一起、提到了谁，
//   人和人的关系）和别名（aliases）。证据 id 不是这一批的、谓词不认得、时间段和提前多久的值不在说法表里、别名的两个叫法原文里没有的，写入前丢掉；
//   事件名没写日子的补上（同名的两次邀约不会并成一个）。
// - 334 号票：模型常把"有点想回去读博了"这种说现在的话的 valid_from 给成 null（= 一直），写事实时由 kg/graph.ts 兜住：
//   原话没说从什么时候起的，开始按说话那天算；change 只是参考，变化判定看原话里有没有明说变化的说法（kg/signals.ts 的
//   explicitChangeSignals），模型说有变化不算数。
import { compareTime, isZonedIso, localDate } from "../domain/time.ts";
import { ENTITY_TYPES, EPISODIC_PREDICATES, PREDICATES, type EntityType, type Evidence, type Predicate } from "../domain/types.ts";
import { unparsedReason, type ChatModel, type ChatRequest } from "../llm/chat.ts";
import { isStringArray, parseModelJson } from "../llm/json.ts";
import { countOutcome, stageStats, type StageStatsMap } from "../llm/robust.ts";
import type { DroppedOutput, ModelBudget } from "../rg/types.ts";
import type { AliasAware, AliasDraft } from "./align.ts";
import { USER_REF, type EntityRef, type FactDraft, type FactExtractor, type KgView } from "./extractor.ts";
import { EVENT_PREDICATES, LEAD_BUCKETS, RELATION_PREDICATES, SLOT_PATTERN } from "./relations.ts";

export interface PrepareOptions {
  budget: ModelBudget;
  dropped: DroppedOutput[];
  /** 218 号票：调用统计（抽事实这一步只记数：调用、截断、解析不了、空回答） */
  stats?: StageStatsMap;
}

/** 要先异步准备好的抽取器（模型版） */
export interface PreparableExtractor extends FactExtractor {
  /** 按预算把这些证据问模型、缓存结果；返回准备好了的证据 id */
  prepare(evidence: readonly Evidence[], known: KgView, options: PrepareOptions): Promise<string[]>;
}

export function isPreparableExtractor(x: FactExtractor): x is PreparableExtractor {
  return typeof (x as Partial<PreparableExtractor>).prepare === "function";
}

export const EXTRACT_SYSTEM = `你是记忆系统的事实抽取器。从用户的原话或行为记录里抽出关于"用户"的事实，只抽原文里有的，不推断动机。
只输出一个 JSON 对象：{"facts": [ ... ]}，每条事实：
{"evidence_id": 原样抄输入里的证据 id,
 "predicate": "participated_in" | "declined" | "initiated" | "said_about" | "prefers" | "dislikes" | "works_on" | "occurred_at" | "associated_with",
 "object": {"name": 宾语的短名字, "type": "person" | "place" | "activity" | "project" | "organization" | "topic" | "event"},
 "negated": true | false（"不反感 X" 是 dislikes 取反；"不想 X" 是 prefers 取反）,
 "context": 场景标签数组（weekend、workday、holiday、social、work、family、travel、study、health、leisure 等，没有就用证据的标签）,
 "valid_from": 带时区的 ISO 时间或 null（只给喜欢、不喜欢、在做这类状态；"上个月开始"写上个月 1 号；原话说了"一直、从小"才写 null；说的是现在的感受、打算，没说从什么时候起的，写这句话的 event_time，不要写 null）,
 "valid_to": 带时区的 ISO 时间或 null,
 "statement": 一句单独看得懂的精炼陈述，带时间和场景，去掉口语，如"用户 2026-10-01 在周末、社交场合拒绝了聚会",
 "change": 这句话自己有没有明说"变了"（不再、不…了、改成、以前…现在…、搬家、换工作这类）；只是和以前说的相反、自己没说变了的写 false,
 "correction": 这句话是不是在纠正以前说错的,
 "span": 抽出它的那段原文}
每条证据最多抽 3 条；抽不出来就不抽。证据 id 只能用输入里给的。
另外两样（没有就给空数组），整个输出是 {"facts": [...], "relations": [...], "aliases": [...]}：
"relations"：实体和实体之间的关系，每条 {"evidence_id", "subject": {"name", "type"}, "predicate", "object": {"name", "type"} 或 {"value"}, "span"}：
 - 别人来约用户的事当一个事件（type 是 event，名字写"谁约的什么（活动那天 YYYY-MM-DD）"）；用户推掉还是去了写在 facts 里（declined 或 participated_in，宾语是这个事件）；
 - 事件的组织者 organized_by、参加的人 involves、地点 held_at、时间段 in_slot（值是"工作日""周末""假期"之一加"上午""中午""下午""晚上"之一，如"工作日晚上"）、
   活动类型 of_type（聚餐、运动、文娱、工作机会、见面、会议）、提前多久约的 lead_time（值是"当天才约""提前1到3天约""提前4天以上约"之一）；
 - 用户和谁一起 went_with、提到了谁 mentioned（主语写"用户"）；人和用户的关系 colleague_of、family_of、friend_of、work_contact_of（主语是那个人，宾语写"用户"）；
"aliases"：同一个人的两个叫法 {"evidence_id", "name", "alias"}，两个叫法都要在原文里出现。`;

/** 199 号票：模型交的关系能用的谓词 */
const RELATION_FACT_PREDICATES: ReadonlySet<string> = new Set<string>([...EVENT_PREDICATES, ...RELATION_PREDICATES, "went_with", "mentioned"]);
const USER_NAMES = new Set(["用户", "user", "我", "本人"]);
const DATED = /\d{4}-\d{2}-\d{2}/;

/** 事件名没写日子的补上证据那天（同名的两次邀约不会并成一个） */
function eventName(name: string, evidence: Evidence): string {
  return DATED.test(name) ? name : `${name}（${localDate(evidence.eventTime ?? evidence.observedAt)}）`;
}

const MAX_STATEMENT_CHARS = 200;
/** 抽事实时每条证据给的输出上限（token） */
export const MAX_TOKENS_PER_EVIDENCE = 800;

/** 模型给的时间：没给是 undefined，null 照留，不合格是 false */
function timeOf(v: unknown): string | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return isZonedIso(v) ? v : false;
}

export class LlmFactExtractor implements PreparableExtractor, AliasAware {
  readonly id: string;
  readonly batchSize: number;
  private readonly model: ChatModel;
  private readonly cache = new Map<string, FactDraft[]>();
  private readonly aliasCache = new Map<string, AliasDraft[]>();

  constructor(model: ChatModel, options: { batchSize?: number } = {}) {
    this.model = model;
    this.id = `model:${model.name}`;
    this.batchSize = options.batchSize ?? 8;
  }

  /** 一批证据的请求（预计费用也用它算） */
  requestFor(batch: readonly Evidence[], known: KgView): ChatRequest {
    const names = known.knownNames().slice(0, 60);
    const lines = batch.map((e) =>
      JSON.stringify({ evidence_id: e.id, source_level: e.sourceLevel, mode: e.mode, kind: e.kind, context: e.context, event_time: e.eventTime, observed_at: e.observedAt, text: e.text }),
    );
    return {
      purpose: "extract",
      system: EXTRACT_SYSTEM,
      user: `已知实体名（同一个东西请用这些名字）：${names.join("、") || "（还没有）"}\n证据：\n${lines.join("\n")}`,
      // 每条证据最多 3 条事实、带精炼陈述和原文片段；192 号票第一次真跑时 300 / 条常被截断，放到 800 / 条
      maxTokens: MAX_TOKENS_PER_EVIDENCE * batch.length,
    };
  }

  async prepare(evidence: readonly Evidence[], known: KgView, options: PrepareOptions): Promise<string[]> {
    const ready = evidence.filter((e) => this.cache.has(e.id)).map((e) => e.id);
    const todo = evidence.filter((e) => !this.cache.has(e.id));
    for (let i = 0; i < todo.length; i += this.batchSize) {
      const batch = todo.slice(i, i + this.batchSize);
      if (!options.budget.take()) break;
      const response = await this.model.complete(this.requestFor(batch, known));
      countOutcome(stageStats(options.stats, "extract"), response);
      let parsed: Record<string, unknown>;
      try {
        parsed = parseModelJson(response.content);
      } catch (err) {
        options.dropped.push({ stage: "extract", reason: unparsedReason(response, this.requestFor(batch, known), err), item: batch.map((e) => e.id) });
        continue;
      }
      const drafts = this.validate(parsed, batch, options.dropped);
      for (const [id, list] of this.validateRelations(parsed, batch, options.dropped)) drafts.set(id, [...(drafts.get(id) ?? []), ...list]);
      const aliases = this.validateAliases(parsed, batch, options.dropped);
      for (const e of batch) {
        this.cache.set(e.id, drafts.get(e.id) ?? []);
        this.aliasCache.set(e.id, aliases.get(e.id) ?? []);
        ready.push(e.id);
      }
    }
    return ready;
  }

  /** 199 号票：prepare 时模型交的别名（引擎抽事实之前先对齐） */
  aliasesOf(evidence: Evidence, _known: KgView): AliasDraft[] {
    return (this.aliasCache.get(evidence.id) ?? []).map((a) => ({ ...a }));
  }

  extract(evidence: Evidence, _known: KgView): FactDraft[] {
    const drafts = this.cache.get(evidence.id);
    if (!drafts) throw new Error(`模型版抽取要先 prepare：${evidence.id}`);
    return drafts.map((d) => ({ ...d, context: [...d.context] }));
  }

  /** 校验模型交回的事实：证据 id 得是这一批的，字段得合格；不合格的丢掉 */
  private validate(parsed: Record<string, unknown>, batch: readonly Evidence[], dropped: DroppedOutput[]): Map<string, FactDraft[]> {
    const out = new Map<string, FactDraft[]>();
    const byId = new Map(batch.map((e) => [e.id, e]));
    const items = Array.isArray(parsed.facts) ? parsed.facts : [];
    if (!Array.isArray(parsed.facts)) dropped.push({ stage: "extract", reason: "没有 facts 数组", item: parsed });
    for (const raw of items) {
      const drop = (reason: string) => dropped.push({ stage: "extract", reason, item: raw });
      if (typeof raw !== "object" || raw === null) {
        drop("不是对象");
        continue;
      }
      const r = raw as Record<string, unknown>;
      const evidence = typeof r.evidence_id === "string" ? byId.get(r.evidence_id) : undefined;
      if (!evidence) {
        drop(`伪造的证据 id：${String(r.evidence_id)}`);
        continue;
      }
      if (!(PREDICATES as readonly unknown[]).includes(r.predicate)) {
        drop(`谓词不认得：${String(r.predicate)}`);
        continue;
      }
      const predicate = r.predicate as Predicate;
      const object = r.object as Record<string, unknown> | undefined;
      let draftObject: FactDraft["object"];
      if (object && typeof object.name === "string" && object.name.trim().length > 0 && (ENTITY_TYPES as readonly unknown[]).includes(object.type)) {
        const name = object.type === "event" ? eventName(object.name.trim(), evidence) : object.name.trim();
        draftObject = { type: "entity", ref: { name, type: object.type as EntityType } };
      } else if (object && typeof object.value === "string" && object.value.trim().length > 0) {
        draftObject = { type: "value", value: object.value.trim() };
      } else {
        drop("宾语不合格");
        continue;
      }
      if (typeof r.negated !== "boolean") {
        drop("negated 不是布尔值");
        continue;
      }
      if (typeof r.statement !== "string" || r.statement.trim().length === 0 || r.statement.length > MAX_STATEMENT_CHARS) {
        drop("精炼陈述不合格");
        continue;
      }
      const validFrom = timeOf(r.valid_from);
      const validTo = timeOf(r.valid_to);
      if (validFrom === false || validTo === false) {
        drop("有效期不是带时区的 ISO 时间");
        continue;
      }
      // 204 号票：截止早于开始的写事实时会被校验挡下、整次抽取崩掉，写入前丢掉
      if (validFrom && validTo && compareTime(validTo, validFrom) < 0) {
        drop("有效期截止早于开始");
        continue;
      }
      const draft: FactDraft = {
        subject: USER_REF,
        predicate,
        object: draftObject,
        negated: r.negated,
        context: isStringArray(r.context) ? r.context.filter((t) => t.trim().length > 0) : [...evidence.context],
        statement: r.statement.trim(),
        signals: { change: r.change === true ? ["model:change"] : [], correction: r.correction === true || evidence.kind === "correction" ? ["model:correction"] : [] },
        span: typeof r.span === "string" && r.span.length > 0 ? r.span : r.statement.trim(),
      };
      if (!EPISODIC_PREDICATES.has(predicate)) {
        if (validFrom !== undefined) draft.validFrom = validFrom;
        if (validTo !== undefined) draft.validTo = validTo;
      }
      out.set(evidence.id, [...(out.get(evidence.id) ?? []), draft]);
    }
    return out;
  }

  /** 199 号票：校验模型交的关系（证据 id 得是这一批的、谓词得认得、主语宾语合格、时间段和提前多久的值在说法表里） */
  private validateRelations(parsed: Record<string, unknown>, batch: readonly Evidence[], dropped: DroppedOutput[]): Map<string, FactDraft[]> {
    const out = new Map<string, FactDraft[]>();
    const byId = new Map(batch.map((e) => [e.id, e]));
    const items = Array.isArray(parsed.relations) ? parsed.relations : [];
    for (const raw of items) {
      const drop = (reason: string) => dropped.push({ stage: "extract", reason, item: raw });
      if (typeof raw !== "object" || raw === null) {
        drop("关系不是对象");
        continue;
      }
      const r = raw as Record<string, unknown>;
      const evidence = typeof r.evidence_id === "string" ? byId.get(r.evidence_id) : undefined;
      if (!evidence) {
        drop(`关系里伪造的证据 id：${String(r.evidence_id)}`);
        continue;
      }
      if (typeof r.predicate !== "string" || !RELATION_FACT_PREDICATES.has(r.predicate)) {
        drop(`关系的谓词不认得：${String(r.predicate)}`);
        continue;
      }
      const predicate = r.predicate as Predicate;
      const ref = (v: unknown): EntityRef | undefined => {
        const o = v as Record<string, unknown> | undefined;
        if (!o || typeof o.name !== "string" || o.name.trim().length === 0) return undefined;
        if (USER_NAMES.has(o.name.trim())) return USER_REF;
        if (!(ENTITY_TYPES as readonly unknown[]).includes(o.type)) return undefined;
        const name = o.type === "event" ? eventName(o.name.trim(), evidence) : o.name.trim();
        return { name, type: o.type as EntityType };
      };
      const subject = ref(r.subject);
      if (!subject) {
        drop("关系的主语不合格");
        continue;
      }
      const o = r.object as Record<string, unknown> | undefined;
      let object: FactDraft["object"] | undefined;
      if (o && typeof o.value === "string" && o.value.trim().length > 0) object = { type: "value", value: o.value.trim() };
      else {
        const e = ref(o);
        if (e) object = { type: "entity", ref: e };
      }
      if (!object) {
        drop("关系的宾语不合格");
        continue;
      }
      if (predicate === "in_slot" && (object.type !== "value" || !SLOT_PATTERN.test(object.value))) {
        drop(`时间段不在说法表里：${JSON.stringify(object)}`);
        continue;
      }
      if (predicate === "lead_time" && (object.type !== "value" || !(LEAD_BUCKETS as readonly string[]).includes(object.value))) {
        drop(`提前多久不在说法表里：${JSON.stringify(object)}`);
        continue;
      }
      const userSubject = subject === USER_REF;
      out.set(evidence.id, [
        ...(out.get(evidence.id) ?? []),
        {
          subject,
          predicate,
          object,
          negated: false,
          context: userSubject ? [...evidence.context] : [],
          signals: { change: [], correction: [] },
          span: typeof r.span === "string" && r.span.length > 0 ? r.span : evidence.text.slice(0, 40),
        },
      ]);
    }
    return out;
  }

  /** 199 号票：校验模型交的别名（证据 id 得是这一批的，两个叫法都要在原文里） */
  private validateAliases(parsed: Record<string, unknown>, batch: readonly Evidence[], dropped: DroppedOutput[]): Map<string, AliasDraft[]> {
    const out = new Map<string, AliasDraft[]>();
    const byId = new Map(batch.map((e) => [e.id, e]));
    for (const raw of Array.isArray(parsed.aliases) ? parsed.aliases : []) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const evidence = typeof r.evidence_id === "string" ? byId.get(r.evidence_id) : undefined;
      if (!evidence) {
        dropped.push({ stage: "extract", reason: `别名里伪造的证据 id：${String(r.evidence_id)}`, item: raw });
        continue;
      }
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const alias = typeof r.alias === "string" ? r.alias.trim() : "";
      if (name.length === 0 || alias.length === 0 || name === alias || !evidence.text.includes(name) || !evidence.text.includes(alias)) {
        dropped.push({ stage: "extract", reason: "别名的两个叫法原文里没有（或者一样）", item: raw });
        continue;
      }
      out.set(evidence.id, [...(out.get(evidence.id) ?? []), { name, alias, type: "person", span: `${name} / ${alias}` }]);
    }
    return out;
  }
}
