// 事实图谱（第 4.2、5 节）：实体对齐、写事实（合并、变化判定、改旧事实的状态、真冲突生成追问）、
// 按时间点和场景查"那时成立的事实"、按实体查一跳两跳邻接、证据失效时事实这一层怎么变。
// 一张实体表、一张事实表，图扩展靠 SQL 查邻接，不上图数据库。所有改动经存储写修订日志。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import { compareFrom, compareTime, earlierFrom, localDate, offsetMinutes, toMs } from "../domain/time.ts";
import { EPISODIC_PREDICATES, type Assertion, type Entity, type Evidence, type Fact, type FactObject, type FactStatus, type Predicate } from "../domain/types.ts";
import { HELD_STATUSES, type MemoryStore, type NewFact, rgWriter, type RgWriter } from "../store/store.ts";
import { classifyChange, excludes, sameObject, type ChangeKind, type ComparableFact } from "./change.ts";
import { contextsCompatible, CONTEXT_LABELS, sameContext } from "./context.ts";
import type { DraftObject, EntityRef, FactDraft, KgView } from "./extractor.ts";
import { DEFAULT_LEXICON, type Lexicon } from "./lexicon.ts";
import { explicitChangeSignals, statesOwnStart } from "./signals.ts";
import { factPhrase, factStatement } from "./statement.ts";

/** 一次变化判定的记录（写事实时返回，演示和评测看得见"为什么旧的那条变了"） */
export interface ChangeRecord {
  kind: ChangeKind;
  oldFactId: string;
  newFactId: string;
  evidenceId: string;
  /** 起作用的信号词 */
  signals: string[];
}

export interface AddFactResult {
  fact: Fact;
  /** 并进了已有的同一条事实（多了一条证据），没有新建 */
  merged: boolean;
  changes: ChangeRecord[];
  /** 真冲突生成的追问 */
  probeIds: string[];
  /** 被这条纠正的旧事实（推理图谱要传播） */
  correctedFactIds: string[];
}

export interface FactsAtQuery {
  /** 时间点：validFrom ≤ at < validTo */
  at: string;
  /** 场景：事实的场景和它重叠（或者事实不限场景）才要；不给 = 不按场景过滤 */
  context?: readonly string[];
  subjectId?: string;
  predicate?: Predicate;
  objectId?: string;
  /** 默认要成立过的（active、contested、superseded） */
  statuses?: readonly FactStatus[];
}

export interface NeighborOptions {
  /** 只走在这个时间成立的事实 */
  at?: string;
  context?: readonly string[];
  statuses?: readonly FactStatus[];
  /** 走到这些实体就停，不再从它们往外扩（比如用户本人：几乎每条事实都连着他） */
  stopAt?: readonly string[];
}

export interface Neighborhood {
  center: Entity;
  /** 邻居和它离中心几跳、经过哪几条事实到的 */
  entities: { entity: Entity; hops: number; viaFactIds: string[] }[];
  /** 走过的事实 */
  facts: Fact[];
}

/** 证据失效（被忘掉或被纠正）时事实这一层的变化 */
export interface FactInvalidation {
  /** 只靠这条证据的事实：撤回（retracted）或纠正（corrected） */
  retractedFactIds: string[];
  /** 还有别的有效证据的事实：去掉这条证据，保持原状态 */
  weakenedFactIds: string[];
  /** 因为上面那些事实没了而恢复的旧事实（之前被它们取代、跟它们冲突、被这条证据纠正的） */
  restoredFactIds: string[];
}

/** 334：开始得比说话那天早（null = 不知道从什么时候起，也算早；同一天的不算） */
function startsBefore(validFrom: string | null, said: string): boolean {
  return validFrom === null || localDate(validFrom, offsetMinutes(said)) < localDate(said);
}

/** 参加变化判定的出处：本人说的、做的。别人转述的只当背景，不取代、不纠正、不冲突 */
const SELF_ASSERTIONS: ReadonlySet<Assertion> = new Set<Assertion>(["user_stated", "observed"]);

/** 按证据的来源等级和说还是做定出处 */
export function assertionFor(evidence: Pick<Evidence, "sourceLevel" | "mode">): Assertion {
  if (evidence.sourceLevel === "self") return evidence.mode === "say" ? "user_stated" : "observed";
  if (evidence.sourceLevel === "system") return "observed";
  return "third_party_reported";
}

export class KnowledgeGraph {
  readonly store: MemoryStore;
  private readonly lexicon: Lexicon;
  private readonly groups = new Map<string, string>();

  constructor(store: MemoryStore, lexicon: Lexicon = DEFAULT_LEXICON) {
    this.store = store;
    this.lexicon = lexicon;
    for (const e of lexicon.entries) if (e.group) this.groups.set(e.name, e.group);
  }

  /** 267 号票：写事实、追问经唯一写入口（引擎挂了写入口时；在调用方开的那一次写里——抽事实、纠正、忘掉、彻底删除） */
  private get w(): RgWriter {
    return rgWriter(this.store);
  }

  /** 抽取器看的只读视图 */
  view(): KgView {
    return {
      findEntity: (name) => this.store.findEntityByName(name),
      knownNames: () => this.store.listEntities().flatMap((e) => (e.id === USER_ENTITY_ID ? [] : [e.name, ...e.aliases])),
    };
  }

  /** 实体对齐：给 id 的直接取；给名字的按名字和别名找，找不到就新建（词表里的带上别名） */
  resolveEntity(ref: EntityRef): Entity {
    if ("id" in ref) {
      const e = this.store.getEntity(ref.id);
      if (!e) throw new Error(`没有这个实体：${ref.id}`);
      return e;
    }
    const found = this.store.findEntityByName(ref.name);
    if (found) return found;
    const entry = this.lexicon.entries.find((x) => x.name === ref.name);
    return this.store.insertEntity({ type: ref.type, name: ref.name, aliases: entry?.aliases ? [...entry.aliases] : [] }, { reason: "实体对齐：新实体" });
  }

  private resolveObject(object: DraftObject): FactObject {
    return object.type === "value" ? object : { type: "entity", id: this.resolveEntity(object.ref).id };
  }

  private groupOf = (object: FactObject): string | undefined => {
    if (object.type !== "entity") return undefined;
    const e = this.store.getEntity(object.id);
    return e ? this.groups.get(e.name) : undefined;
  };

  private nameOf(object: FactObject): string {
    return object.type === "value" ? object.value : (this.store.getEntity(object.id)?.name ?? object.id);
  }

  /** 规则版的精炼陈述（模型版写入时自带 statement） */
  statementOf(f: Omit<Fact, "id" | "statement" | "status" | "supersededBy" | "retractedBy" | "contestedWith" | "extractedBy" | "evidenceIds" | "observedAt">): string {
    return factStatement({
      subjectName: this.store.getEntity(f.subjectId)?.name ?? f.subjectId,
      predicate: f.predicate,
      objectName: this.nameOf(f.object),
      negated: f.negated,
      context: f.context,
      assertion: f.assertion,
      eventTime: f.eventTime,
      validFrom: f.validFrom,
      validTo: f.validTo,
    });
  }

  /**
   * 写一条从证据抽出来的事实：
   * 1. 状态类的、和已有的一模一样（同主语、谓词、宾语、否定、场景、出处，都还成立）：并进去，多记一条证据；
   * 2. 本人证据抽出的，找和它互相排斥的已有事实（change.ts 的 excludes），逐条判是哪一种，改旧的状态；
   *    事情类的纠正只纠最近的那一件；
   * 3. 写入新事实（精炼陈述按最后的有效期拼），真冲突各生成一个追问。
   * 在一个事务里做完。
   *
   * 334 号票：状态类的事实开始不能早于说这句话的那天（抽取器给了 null 或者更早的、这句话自己又没说从什么时候起——
   * 没有时间说法、没说"以前""一直"——就按说话那天算开始）；变化判定看后说的那句**自己明说了变化**没有（explicitChangeSignals），
   * 没说的当真冲突，不再按日子先后让后说的赢。
   */
  addFact(draft: FactDraft, evidence: Evidence, extractorId: string): AddFactResult {
    return this.store.transaction(() => {
      const cause = { evidenceId: evidence.id };
      const subjectId = this.resolveEntity(draft.subject).id;
      const object = this.resolveObject(draft.object);
      const assertion = draft.assertion ?? assertionFor(evidence);
      const eventTime = draft.eventTime !== undefined ? draft.eventTime : evidence.eventTime;
      const cand: ComparableFact & { validTo: string | null } = {
        subjectId,
        predicate: draft.predicate,
        object,
        negated: draft.negated,
        context: [...draft.context],
        eventTime,
        validFrom: draft.validFrom !== undefined ? draft.validFrom : (eventTime ?? evidence.observedAt),
        validTo: draft.validTo ?? null,
      };
      const episodic = EPISODIC_PREDICATES.has(cand.predicate);
      // 334：一句话抽出来的状态，开始不早于说这句话的那天——这句话自己说了从什么时候起的（时间说法、"以前""一直"）除外；
      // 抽取器说它在说话之前就结束了的（validTo 不晚于说话的时候）是在说以前，不动
      const said = evidence.eventTime ?? evidence.observedAt;
      if (!episodic && startsBefore(cand.validFrom, said) && (cand.validTo === null || compareTime(cand.validTo, said) > 0) && !statesOwnStart(draft.span, said)) cand.validFrom = said;

      // 1. 合并
      if (!episodic) {
        const same = this.store
          .listFacts({ status: ["active"], subjectId, predicate: cand.predicate })
          .find((f) => sameObject(f.object, object) && f.negated === cand.negated && f.assertion === assertion && sameContext(f.context, cand.context) && f.validTo === null && cand.validTo === null);
        if (same) {
          const evidenceIds = same.evidenceIds.includes(evidence.id) ? same.evidenceIds : [...same.evidenceIds, evidence.id];
          const validFrom = earlierFrom(same.validFrom, cand.validFrom);
          const patch: Partial<Fact> = { evidenceIds, validFrom, observedAt: compareTime(evidence.observedAt, same.observedAt) < 0 ? evidence.observedAt : same.observedAt };
          if (same.extractedBy.startsWith("rule:")) patch.statement = this.statementOf({ ...same, validFrom });
          const fact = this.w.updateFact(same.id, patch, { ...cause, reason: "同一条事实又有一条证据" });
          return { fact, merged: true, changes: [], probeIds: [], correctedFactIds: [] };
        }
      }

      // 2. 变化判定
      // 334：变化信号只认这句话自己明说了变化的（"现在、最近"、模型说有变化都不算数，拿不准就当矛盾）
      const changeWords = explicitChangeSignals(draft.span, evidence.text);
      const signals = { change: changeWords.length > 0, correction: draft.signals.correction.length > 0 };
      const usedSignals = [...changeWords, ...draft.signals.correction];
      let candidates: Fact[] = [];
      if (SELF_ASSERTIONS.has(assertion) && evidence.sourceLevel === "self") {
        candidates = this.store
          .listFacts({ status: ["active", "contested"], subjectId })
          .filter((f) => SELF_ASSERTIONS.has(f.assertion) && excludes(f, cand, { groupOf: this.groupOf, correction: signals.correction }));
        if (episodic && signals.correction && candidates.length > 1) {
          candidates = [candidates.reduce((a, b) => (compareFrom(a.eventTime ?? a.validFrom, b.eventTime ?? b.validFrom) >= 0 ? a : b))];
        }
      }

      type Plan = { old: Fact; kind: ChangeKind; later?: "old" | "new" };
      const plans: Plan[] = candidates.map((old) => ({ old, ...classifyChange(old, cand, { ...signals, oldChange: this.saidChange(old) }) }));
      let status: FactStatus = "active";
      let supersededBy: string | null = null;
      const contestedWith: string[] = [];
      for (const p of plans) {
        if (p.kind === "correction") {
          // 以前就记错了：新的这条至少从旧的那条开始时就成立；事情类的说的是同一件事
          if (episodic) cand.eventTime = p.old.eventTime;
          cand.validFrom = episodic ? p.old.validFrom : earlierFrom(cand.validFrom, p.old.validFrom);
        } else if (p.kind === "change_of_mind" && p.later === "old") {
          // 新来的说的是更早的事：它到旧的那条开始时为止
          if (cand.validTo === null || compareFrom(p.old.validFrom, cand.validTo) < 0) cand.validTo = p.old.validFrom;
          status = "superseded";
          supersededBy = p.old.id;
        } else if (p.kind === "conflict") {
          contestedWith.push(p.old.id);
        }
      }
      if (contestedWith.length > 0 && status === "active") status = "contested";

      // 3. 写新事实
      const base = { subjectId, predicate: cand.predicate, object, negated: cand.negated, assertion, context: cand.context, eventTime: cand.eventTime, validFrom: cand.validFrom, validTo: cand.validTo };
      const newFact: NewFact = {
        ...base,
        statement: draft.statement ?? this.statementOf(base),
        evidenceIds: [evidence.id],
        observedAt: evidence.observedAt,
        status,
        supersededBy,
        retractedBy: null,
        contestedWith: status === "contested" ? contestedWith : [],
        extractedBy: extractorId,
      };
      const fact = this.w.insertFact(newFact, { ...cause, reason: `抽取：${draft.span}` });

      // 4. 改旧事实
      const changes: ChangeRecord[] = [];
      const probeIds: string[] = [];
      const correctedFactIds: string[] = [];
      for (const p of plans) {
        changes.push({ kind: p.kind, oldFactId: p.old.id, newFactId: fact.id, evidenceId: evidence.id, signals: usedSignals });
        if (p.kind === "correction") {
          this.w.updateFact(p.old.id, { status: "corrected", retractedBy: evidence.id }, { ...cause, reason: `纠正：被 ${fact.id} 取代（${usedSignals.join("、")}）` });
          correctedFactIds.push(p.old.id);
        } else if (p.kind === "change_of_mind" && p.later === "new") {
          const validTo = cand.validFrom!;
          this.w.updateFact(p.old.id, this.endPatch(p.old, validTo, fact.id), { ...cause, reason: `观点变化：到 ${validTo} 为止，被 ${fact.id} 取代` });
        } else if (p.kind === "time_differs" && signals.change && p.old.validTo !== null && cand.validFrom !== null && compareTime(p.old.validTo, cand.validFrom) <= 0 && p.old.status === "active") {
          // "以前喜欢，现在不喜欢了"：旧的本来就到期了，记上是被哪条取代的
          this.w.updateFact(p.old.id, { status: "superseded", supersededBy: fact.id }, { ...cause, reason: `观点变化：已在 ${p.old.validTo} 到期，由 ${fact.id} 接上` });
        } else if (p.kind === "conflict" && status === "contested") {
          this.w.updateFact(p.old.id, { status: "contested", contestedWith: [...new Set([...p.old.contestedWith, fact.id])] }, { ...cause, reason: `真冲突：和 ${fact.id} 同时间同场景互相排斥` });
          probeIds.push(this.conflictProbe(p.old, fact).id);
        }
      }
      return { fact, merged: false, changes, probeIds, correctedFactIds };
    });
  }

  /** 334：已有的这条事实背后的本人原话明说了变化（新来的说的是更早的事时，后说的是它） */
  private saidChange(f: Fact): boolean {
    return f.evidenceIds.some((id) => {
      const e = this.store.getEvidence(id);
      return e !== undefined && e.status === "active" && explicitChangeSignals(e.text).length > 0;
    });
  }

  /** 让一条事实到期、被取代；规则版的陈述跟着重写 */
  private endPatch(old: Fact, validTo: string, by: string): Partial<Fact> {
    const patch: Partial<Fact> = { validTo, status: "superseded", supersededBy: by };
    if (old.extractedBy.startsWith("rule:")) patch.statement = this.statementOf({ ...old, validTo });
    return patch;
  }

  /** 真冲突的判别性追问：问用户是哪一种，第二轮检索用宾语的名字 */
  private conflictProbe(a: Fact, b: Fact) {
    const objectName = this.nameOf(b.object);
    const where = b.context.length > 0 ? `${b.context.map((t) => CONTEXT_LABELS[t] ?? t).join("、")}，` : "";
    const describe = (f: Fact) => factPhrase(f.predicate, f.negated, this.nameOf(f.object));
    return this.w.insertProbe(
      {
        discriminates: [a.id, b.id],
        ask: `${where}关于「${objectName}」，是「${describe(a)}」还是「${describe(b)}」？`,
        queries: [objectName],
        ifFound: null,
        outcome: "open",
        foundEvidenceIds: [],
      },
      { evidenceId: b.evidenceIds[0] ?? null, reason: `真冲突：${a.id} 和 ${b.id}` },
    );
  }

  /** 在时间 at 成立、场景对得上的事实 */
  factsAt(q: FactsAtQuery): Fact[] {
    return this.store
      .factsValidAt(q.at, q.statuses ?? HELD_STATUSES)
      .filter(
        (f) =>
          (q.subjectId === undefined || f.subjectId === q.subjectId) &&
          (q.predicate === undefined || f.predicate === q.predicate) &&
          (q.objectId === undefined || (f.object.type === "entity" && f.object.id === q.objectId)) &&
          (q.context === undefined || contextsCompatible(f.context, q.context)),
      );
  }

  /** 从一个实体出发走一跳或两跳（经过主语或宾语是它的事实） */
  neighbors(entityId: string, hops: 1 | 2 = 1, options: NeighborOptions = {}): Neighborhood {
    const center = this.store.getEntity(entityId);
    if (!center) throw new Error(`没有这个实体：${entityId}`);
    const statuses = options.statuses ?? HELD_STATUSES;
    const at = options.at === undefined ? undefined : toMs(options.at);
    const usable = (f: Fact) =>
      (at === undefined || ((f.validFrom === null || toMs(f.validFrom) <= at) && (f.validTo === null || at < toMs(f.validTo)))) &&
      (options.context === undefined || contextsCompatible(f.context, options.context));
    const stop = new Set(options.stopAt ?? []);
    const found = new Map<string, { hops: number; viaFactIds: string[] }>();
    const facts = new Map<string, Fact>();
    let frontier = [entityId];
    for (let depth = 1; depth <= hops; depth++) {
      const next: string[] = [];
      for (const from of frontier) {
        for (const f of this.store.factsTouching(from, statuses)) {
          if (!usable(f)) continue;
          facts.set(f.id, f);
          const other = f.subjectId === from ? (f.object.type === "entity" ? f.object.id : undefined) : f.subjectId;
          if (other === undefined || other === entityId) continue;
          const seen = found.get(other);
          if (seen) {
            if (seen.hops === depth && !seen.viaFactIds.includes(f.id)) seen.viaFactIds.push(f.id);
            continue;
          }
          found.set(other, { hops: depth, viaFactIds: [f.id] });
          if (!stop.has(other)) next.push(other);
        }
      }
      frontier = next;
    }
    const entities = [...found.entries()].map(([id, v]) => ({ entity: this.store.getEntity(id)!, ...v }));
    return { center, entities, facts: [...facts.values()] };
  }

  /**
   * 证据失效后事实这一层（第 7.3 节第 1 条）：只靠它的事实变成 retracted（被纠正时是 corrected），retractedBy 指向起因；
   * 还有别的有效证据的去掉这条证据、保持原状。顺带恢复因此失去依据的派生状态（照真值维护的做法）：
   * 被撤回的事实取代过、冲突过的旧事实，被这条证据纠正过的旧事实，按修订日志里改之前的样子恢复。
   * 推理图谱那一层由引擎的传播钩子做（④ 号票）。
   */
  dropEvidence(evidenceId: string, mode: "forgotten" | "corrected" | "purged", causeEvidenceId: string): FactInvalidation {
    return this.store.transaction(() => {
      const result: FactInvalidation = { retractedFactIds: [], weakenedFactIds: [], restoredFactIds: [] };
      const cause = { evidenceId: causeEvidenceId };
      const label = mode === "forgotten" ? `证据 ${evidenceId} 被忘掉` : mode === "purged" ? `证据 ${evidenceId} 被彻底删除` : `证据 ${evidenceId} 被 ${causeEvidenceId} 纠正`;
      for (const f of this.store.factsByEvidence(evidenceId)) {
        if (f.status === "retracted" || f.status === "corrected") continue;
        const others = f.evidenceIds.filter((id) => id !== evidenceId && this.store.getEvidence(id)?.status === "active");
        if (others.length > 0) {
          this.w.updateFact(f.id, { evidenceIds: f.evidenceIds.filter((id) => id !== evidenceId) }, { ...cause, reason: `${label}，还有别的证据` });
          result.weakenedFactIds.push(f.id);
          continue;
        }
        this.w.updateFact(f.id, { status: mode === "corrected" ? "corrected" : "retracted", retractedBy: causeEvidenceId }, { ...cause, reason: `${label}，没有别的证据了` });
        result.retractedFactIds.push(f.id);
        result.restoredFactIds.push(...this.restoreDependents(f.id, cause, label));
      }
      // 这条证据纠正过的旧事实：纠正没了，恢复
      for (const f of this.store.listFacts({ status: ["corrected"] })) {
        if (f.retractedBy !== evidenceId) continue;
        if (!f.evidenceIds.some((id) => this.store.getEvidence(id)?.status === "active")) continue;
        const before = this.lastChange(f.id, "retractedBy", evidenceId);
        this.w.updateFact(f.id, { status: (before?.status?.from as FactStatus | undefined) ?? "active", retractedBy: null }, { ...cause, reason: `${label}，它做的纠正撤销` });
        result.restoredFactIds.push(f.id);
      }
      return result;
    });
  }

  /** 撤回的事实取代过、冲突过的旧事实恢复原状 */
  private restoreDependents(retractedId: string, cause: { evidenceId: string }, label: string): string[] {
    const restored: string[] = [];
    for (const f of this.store.listFacts({ status: ["superseded", "contested"] })) {
      if (f.supersededBy === retractedId) {
        const before = this.lastChange(f.id, "supersededBy", retractedId);
        const validTo = before && "validTo" in before ? (before.validTo!.from as string | null) : f.validTo;
        const status = (before?.status?.from as FactStatus | undefined) ?? "active";
        const patch: Partial<Fact> = { status, supersededBy: null, validTo };
        if (f.extractedBy.startsWith("rule:")) patch.statement = this.statementOf({ ...f, validTo });
        this.w.updateFact(f.id, patch, { ...cause, reason: `${label}，取代它的 ${retractedId} 撤回了，恢复` });
        restored.push(f.id);
      } else if (f.contestedWith.includes(retractedId)) {
        const contestedWith = f.contestedWith.filter((id) => id !== retractedId);
        this.w.updateFact(f.id, { contestedWith, status: contestedWith.length === 0 && f.status === "contested" ? "active" : f.status }, { ...cause, reason: `${label}，和它冲突的 ${retractedId} 撤回了` });
        restored.push(f.id);
      }
    }
    return restored;
  }

  /** 修订日志里最后一次把 field 改成 value 的那次改动 */
  private lastChange(factId: string, field: string, value: unknown): Record<string, { from: unknown; to: unknown }> | undefined {
    return this.store
      .revisions(factId, "fact")
      .toReversed()
      .find((r) => r.op === "update" && r.changes[field]?.to === value)?.changes;
  }
}
