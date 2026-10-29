// 知识图谱和推理图谱联动（199 号票）。用户 2026-10-20："知识图谱是知其然，推理图谱是知其所以然。"
// reflect() 里的先后（rg/reasoning-graph.ts 调这里）：
//   1. 知识图谱：抽取、对齐实体（engine.extractFacts）、变化判定（kg/graph.ts）、找对比模式（kgPhase：kg/motifs.ts）、认矛盾（rg/conflict-roots.ts）；
//   2. 推理图谱：对比模式、矛盾根源各出一组竞争假设（propose），和原有的观察模式一起走追问 → 计分 → 往上抽；
//   3. 写回知识图谱（rg/writeback.ts）；
//   4. 用户模型（不存，下次取快照按新的断言现算）；
//   5. 问题队列：分不出的组进"了解你问题"（syncQuestions）。207 号票起接到 198 的问题箱：每条能区分的追问一个问题，照 198 的格式
//      （question-sources.ts 出草稿：为什么问、区分哪几个、回答各支持哪边、领域和场景、优先级、过期时间），经 QuestionSink 交给
//      QuestionBook（引擎默认接上），走同一套顺口问、跳过、"别问这个"、回写；joint_questions 留作簿记。问法和"是 / 不是"各支持哪边见 questionFor。
// 对比模式、矛盾根源的假设、追问、判定都由代码按知识图谱算（规则版、模型版共用：模型版的区别在抽取，见 kg/llm-extractor.ts）。
// 组的 pattern 是 contrast、conflict_root，原有的观察模式那几步（模型版 propose、撤回、追问、计分）不碰它们，由这里管。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import { addDays, localDate, toMs } from "../domain/time.ts";
import type { Claim, ClaimTier, Fact, LinkWeight, Probe } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { excludes } from "../kg/change.ts";
import { contextsCompatible } from "../kg/context.ts";
import { CONTRAST_DIMENSIONS, DIMENSION_LABELS, controlsFor, eventRecords, hasValue, mineContrasts, sharedValue, type ContrastDimension, type ContrastMotif, type EventRecord } from "../kg/motifs.ts";
import { factPhrase } from "../kg/statement.ts";
import { HELD_STATUSES, rgSession, rgWriter } from "../store/store.ts";
import { assessRoots, detectConflicts, hasConstraint, ROOT_KINDS, type ConflictRecord, type ConflictTrigger, type RootAssessment, type RootKind } from "./conflict-roots.ts";
import { claimDomains, domainsOfTags, domainsOfText } from "./domains.ts";
import { generateQuestions, type PriorityDetail, type QuestionAnswers, type QuestionDraft, type QuestionSource } from "./question-sources.ts";
import type { GroupRecord } from "./registry.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import type { GroupView, HypothesisDraft, HypothesisGroupDraft, JudgeHit, LinkDraft, ProbeDraft, ProbeJudgement, ReasonerContext, RgView, TargetLink } from "./types.ts";

export const CONTRAST_PATTERN = "contrast";
export const ROOT_PATTERN = "conflict_root";

export const isContrastGroup = (g: Pick<GroupRecord, "pattern">): boolean => g.pattern === CONTRAST_PATTERN;
export const isRootGroup = (g: Pick<GroupRecord, "pattern">): boolean => g.pattern === ROOT_PATTERN;
/** 联动出的组（对比模式、矛盾根源） */
export const isJointGroup = (g: Pick<GroupRecord, "pattern">): boolean => isContrastGroup(g) || isRootGroup(g);

const TRIGGER_LABELS: Readonly<Record<ConflictTrigger, string>> = { contested: "真冲突", say_do: "说的和做的不一样", flip_flop: "观点来回变" };

/** 联动交给问题箱的了解你问题（207 号票起照 198 的格式；draft 原样交给 QuestionBook） */
export interface KnowYouQuestion {
  /** 同问题箱里的 key（probe:<追问 id>） */
  key: string;
  groupKey: string;
  kind: "conflict_root" | "contrast";
  ask: string;
  /** 为什么问 */
  why: string;
  /** 区分哪几个假设 */
  discriminates: string[];
  /** 回答"是""不是"各支持哪边 */
  answers: QuestionAnswers;
  domains: string[];
  scenes: string[];
  /** 优先级（question-sources.ts 的算法：回答能不能分出胜负 × 分数接近的程度 × 常不常遇到） */
  priority: number;
  priorityDetail: PriorityDetail;
  evidenceIds: string[];
  createdAt: string;
  /** 30 天过期 */
  expiresAt: string;
  /** 交给问题箱的草稿 */
  draft: QuestionDraft;
}

/** 接问题队列的钩子：引擎默认接 198 的 QuestionBook；onClosed 是那一组分出来了（或者这个问题不用问了） */
export interface QuestionSink {
  onQuestion(question: KnowYouQuestion): void;
  onClosed?(key: string, at: string, why: string): void;
}

/** 联动的组问一个问题：问法、"是 / 不是"各支持哪几个模板、话题和"别问这个"挡的那一类、领域、对话里对上的说法 */
export interface JointQuestion {
  text: string;
  answers: { yes: { supports: string[]; refutes: string[] }; no: { supports: string[]; refutes: string[] } };
  topic: string;
  sources: QuestionSource[];
  extraDomains: string[];
  terms: string[];
  why: string;
}

/** 知识图谱这一步算出来的：邀约、对比模式、矛盾 */
export interface KgPhase {
  at: string;
  records: EventRecord[];
  motifs: ContrastMotif[];
  conflicts: ConflictRecord[];
}

/** 对比模式那组的参数 */
export interface ContrastParams {
  kind: "contrast";
  dimension: ContrastDimension;
  valueKey: string;
  valueLabel: string;
  valueNames: string[];
  declinedEventIds: string[];
  acceptedEventIds: string[];
  declinedEvidenceIds: string[];
  acceptedEvidenceIds: string[];
  controlEvidenceIds: string[];
  relatedFactIds: string[];
  /** 推掉的那几次共有的别的属性的值（备择那几条说的；207 号票问问题用） */
  alternativeLabels?: Partial<Record<ContrastDimension, string>>;
  rateWith: number;
  rateWithout: number;
  daytype: null;
  domain: string | null;
  activities: { id: string; name: string }[];
  first: string;
  last: string;
  spanDays: number;
  count: number;
  workTagged: boolean;
}

/** 矛盾根源那组的参数 */
export interface RootParams extends Omit<RootAssessment, "links"> {
  kind: "root";
  trigger: ConflictTrigger;
  conflictKey: string;
  objectId: string;
  objectName: string;
  sideA: string[];
  sideB: string[];
  daytype: null;
  domain: null;
  activities: { id: string; name: string }[];
  first: string;
  last: string;
  spanDays: number;
  count: number;
  workTagged: boolean;
}

const RANK: Readonly<Record<LinkWeight, number>> = { weak: 1, strong: 2, decisive: 3 };
const time = (f: Fact) => f.eventTime ?? f.validFrom ?? f.observedAt;

function dedupe(links: readonly TargetLink[]): TargetLink[] {
  const m = new Map<string, TargetLink>();
  for (const l of links) {
    const key = `${l.target}|${l.polarity}`;
    const prev = m.get(key);
    if (!prev || RANK[l.weight] > RANK[prev.weight]) m.set(key, l);
  }
  return [...m.values()];
}

/** 329 号票：当"更深的需求"候选时的先后——已验证的在前，再按把握 */
const needRank = (c: Claim): number => (c.status === "active" ? 0 : 3) + ({ high: 0, medium: 1, low: 2 } as const)[c.confidence];

export class JointReasoner {
  readonly id = "joint:1";
  private readonly engine: MemoryEngine;
  private readonly rg: ReasoningGraph;
  private sink: QuestionSink | undefined;

  constructor(engine: MemoryEngine, rg: ReasoningGraph) {
    this.engine = engine;
    this.rg = rg;
  }

  private get store() {
    return this.engine.store;
  }

  setQuestionSink(sink: QuestionSink | undefined): void {
    this.sink = sink;
  }

  // ---------- 1. 知识图谱 ----------

  /** 知识图谱这一步：邀约和对比模式、矛盾（新认出的记进 joint_conflicts，认过的照旧在） */
  kgPhase(at: string, view: RgView): KgPhase {
    const records = eventRecords(this.store, at, view.usableFact);
    const motifs = mineContrasts(records);
    this.separateByFacts();
    const conflicts = this.store.transaction(() => this.rememberConflicts(detectConflicts(this.store, view), view));
    this.markSayDoGaps(conflicts);
    return { at, records, motifs, conflicts };
  }

  /**
   * 330 号票（矛盾根源，用户 10-27 选 A）：真冲突的两边，事实自己带的场景标签对不上、或者有效期不重叠——事实本身就写清了能把两边分开，
   * 直接把事实改成不冲突（摘掉互相的 contestedWith，没有别的冲突就回到成立），照旧留痕、能撤回；不建根源猜测
   */
  private separateByFacts(): void {
    const plans = new Map<string, Set<string>>();
    for (const f of this.store.listFacts({ status: ["contested"], subjectId: USER_ENTITY_ID })) {
      for (const id of f.contestedWith) {
        const g = this.store.getFact(id);
        if (!g) continue;
        if (contextsCompatible(f.context, g.context) && !validityDisjoint(f, g)) continue;
        plans.set(f.id, (plans.get(f.id) ?? new Set()).add(id));
      }
    }
    if (plans.size === 0) return;
    rgSession(this.store, { op: "writeback", actor: "nightly", reason: "事实本身写清了场合或时间：两边分得开，不算矛盾（用户 10-27 选 A）" }, () => {
      const w = rgWriter(this.store);
      for (const [id, apart] of plans) {
        const f = this.store.getFact(id)!;
        const rest = f.contestedWith.filter((x) => !apart.has(x));
        w.updateFact(
          id,
          { contestedWith: rest, status: rest.length > 0 ? "contested" : "active" },
          { evidenceId: f.evidenceIds[0] ?? null, reason: `事实本身写清了场合或时间：和 ${[...apart].join("、")} 的场景标签对不上或有效期不重叠，分得开，不算矛盾（A）` },
        );
      }
    });
  }

  /** 330 号票（R14）：说的和做的对不上，"嘴上和行为不一样"记一笔——两边的事实互相标 gap（ref 是这个矛盾）；哪边都不自动赢 */
  private markSayDoGaps(conflicts: readonly ConflictRecord[]): void {
    const marks = this.rg.writeback.marks;
    for (const c of conflicts) {
      if (c.trigger !== "say_do") continue;
      const detailOf = (others: readonly string[]) => ({ with: [...others].toSorted(), reason: `说的和做的对不上（${c.objectName}）：记一笔，哪边都不自动赢（R14）` });
      const todo = [...c.sideA.map((id) => ({ id, detail: detailOf(c.sideB) })), ...c.sideB.map((id) => ({ id, detail: detailOf(c.sideA) }))].filter((x) => {
        const m = marks.get(x.id, "gap", c.key);
        return !(m?.active === true && JSON.stringify(m.detail) === JSON.stringify(x.detail));
      });
      if (todo.length === 0) continue;
      rgSession(this.store, { op: "writeback", actor: "nightly", reason: `说的和做的对不上：${c.objectName}（记一笔，R14）` }, () => {
        for (const x of todo) marks.put({ factId: x.id, kind: "gap", ref: c.key, detail: x.detail }, { evidenceId: this.store.getFact(x.id)?.evidenceIds[0] ?? null, reason: `说的和做的对不上：${c.objectName}（记一笔，R14）` });
      });
    }
  }

  /** 新认出的矛盾记下来（两边并进已有的）；认过的、两边的事实还在的照旧返回 */
  private rememberConflicts(fresh: readonly ConflictRecord[], view: RgView): ConflictRecord[] {
    const db = this.store.db;
    for (const c of fresh) {
      const row = db.get<{ sides: string }>("SELECT sides FROM joint_conflicts WHERE key = ?", c.key);
      const old = row ? (JSON.parse(row.sides) as { a: string[]; b: string[] }) : { a: [], b: [] };
      const sides = { a: [...new Set([...old.a, ...c.sideA])], b: [...new Set([...old.b, ...c.sideB])] };
      const detail = JSON.stringify({ objectId: c.objectId, objectName: c.objectName });
      if (row) db.run("UPDATE joint_conflicts SET sides = ?, detail = ? WHERE key = ?", JSON.stringify(sides), detail, c.key);
      else db.run("INSERT INTO joint_conflicts (key, kind, sides, detail, created_at) VALUES (?, ?, ?, ?, ?)", c.key, c.trigger, JSON.stringify(sides), detail, this.store.now());
    }
    const out: ConflictRecord[] = [];
    for (const r of db.all("SELECT * FROM joint_conflicts ORDER BY rowid")) {
      const sides = JSON.parse(String(r.sides)) as { a: string[]; b: string[] };
      const detail = JSON.parse(String(r.detail)) as { objectId: string; objectName: string };
      // 证据被忘掉、撤回的事实不算；写回改成 corrected、superseded 的还算（不然写回以后这组就散了）
      const alive = (id: string) => {
        const f = this.store.getFact(id);
        return f !== undefined && f.status !== "retracted" && f.evidenceIds.some((e) => view.usableEvidence(e));
      };
      const a = sides.a.filter(alive);
      const b = sides.b.filter(alive);
      if (a.length === 0 || b.length === 0) continue;
      out.push({ key: String(r.key), trigger: String(r.kind) as ConflictTrigger, objectId: detail.objectId, objectName: detail.objectName, sideA: a, sideB: b });
    }
    return out;
  }

  // ---------- 2. 推理图谱：出组 ----------

  /** 对比模式、矛盾根源各出一组竞争假设 */
  propose(phase: KgPhase, view: RgView): HypothesisGroupDraft[] {
    const drafts: HypothesisGroupDraft[] = [];
    for (const m of phase.motifs) drafts.push(this.contrastGroup(m, phase.records));
    // 329 号票（R4）：猜测（把握 low 的、还在竞争的）也能当矛盾根源"更深的需求"那一条的依据，推出来的也是猜测；已验证的、把握高的排前面
    const needs = this.store
      .listClaims({ status: ["active", "contested"] })
      .filter((c) => (c.tier === "need" || c.tier === "value") && !this.isJointClaim(c.id))
      .toSorted((a, b) => needRank(a) - needRank(b));
    const memo = new Map<string, ReturnType<typeof claimDomains>>();
    for (const c of phase.conflicts) {
      const a = assessRoots(c, { store: this.store, view, needs, domainsOfClaim: (claim) => claimDomains(this.store, claim, memo) });
      const d = this.rootGroup(c, a);
      if (d) drafts.push(d);
    }
    return drafts;
  }

  private isJointClaim(claimId: string): boolean {
    const m = this.rg.registry.memberOf(claimId);
    const g = m ? this.rg.registry.getGroup(m.groupKey) : undefined;
    return g !== undefined && isJointGroup(g);
  }

  /** 一个属性值对一条"推掉和它有关"的假设：有它推掉的弱支持，有它去了的弱反证，对照（只有它不一样、去了）强支持 */
  private attributeLinks(dim: ContrastDimension, key: string, label: string, records: readonly EventRecord[]): TargetLink[] {
    const links: TargetLink[] = [];
    const dl = DIMENSION_LABELS[dim];
    for (const r of records) {
      if (!hasValue(r, dim, key)) continue;
      if (r.response === "declined") links.push({ target: r.factId, polarity: "supports", weight: "weak", rationale: `观察：${r.name}推掉了（${dl}是「${label}」）` });
      else links.push({ target: r.factId, polarity: "refutes", weight: "weak", rationale: `${dl}也是「${label}」的${r.name}他去了` });
    }
    for (const c of controlsFor(dim, key, records)) {
      links.push({
        target: c.accepted.factId,
        polarity: "supports",
        weight: "strong",
        rationale: `对照：${c.accepted.name}和推掉的${c.declined.name}一样（${c.shared.map((d) => DIMENSION_LABELS[d]).join("、")}），只有${dl}不是「${label}」，他去了`,
      });
    }
    return dedupe(links);
  }

  private contrastGroup(m: ContrastMotif, records: readonly EventRecord[]): HypothesisGroupDraft {
    const dim = m.dimension;
    const dl = DIMENSION_LABELS[dim];
    const label = m.value.label;
    const times = m.declinedWith.map((r) => r.time);
    const first = times.reduce((a, b) => (toMs(a) <= toMs(b) ? a : b));
    const last = times.reduce((a, b) => (toMs(a) >= toMs(b) ? a : b));
    const entityValued = this.store.getEntity(m.value.key) !== undefined;
    const store = this.store;
    // 图上的联系：组织者、地点这类实体在这几次邀约以外还出现在哪（"王哥"在周会上的那件事）
    const eventIds = new Set(records.map((r) => r.eventId));
    const related = entityValued
      ? store
          .factsTouching(m.value.key)
          .filter((f) => !eventIds.has(f.subjectId) && f.subjectId !== m.value.key && (HELD_STATUSES as readonly string[]).includes(f.status))
          .map((f) => f.id)
      : [];
    const hyp = (template: string, tier: ClaimTier, statement: string, links: TargetLink[], validTo: string | null = null): HypothesisDraft => ({
      template,
      tier,
      statement,
      context: [],
      validFrom: first,
      validTo,
      method: "abduction",
      links: dedupe(links),
    });
    const motif = hyp(
      `contrast:${dim}`,
      "preference",
      `用户推掉邀约和${dl}「${label}」有关：${dl}是「${label}」的 ${m.declinedWith.length + m.acceptedWith.length} 次推了 ${m.declinedWith.length} 次，别的 ${m.declinedWithout + m.acceptedWithout} 次只推了 ${m.declinedWithout} 次`,
      [...this.attributeLinks(dim, m.value.key, label, records), ...related.map((id): TargetLink => ({ target: id, polarity: "context", weight: "weak", rationale: `图上的联系：${store.getFact(id)?.statement ?? id}` }))],
    );
    const alternatives: HypothesisDraft[] = [];
    const alternativeLabels: Partial<Record<ContrastDimension, string>> = {};
    for (const other of CONTRAST_DIMENSIONS) {
      if (other === dim) continue;
      const v = sharedValue(m.declinedWith, other);
      if (!v) continue;
      alternativeLabels[other] = v.label;
      alternatives.push(hyp(`alt:${other}`, "preference", `用户推掉这几次是因为${DIMENSION_LABELS[other]}「${v.label}」，和${dl}「${label}」无关`, this.attributeLinks(other, v.key, v.label, records)));
    }
    const reasonIds = [...new Set(m.declinedWith.flatMap((r) => r.reasonFactIds))];
    const reasons = reasonIds.map((id) => store.getFact(id)?.statement).filter((s): s is string => s !== undefined);
    const controls = controlsFor(dim, m.value.key, records);
    const coincidence = hyp(
      "alt:coincidence",
      "state",
      `这几次各有各的原因${reasons.length > 0 ? `（他当时说：${reasons.join("；")}）` : ""}，和${dl}「${label}」没关系`,
      [
        ...m.declinedWith.map((r): TargetLink => ({ target: r.factId, polarity: "supports", weight: "weak", rationale: `观察：${r.name}推掉了` })),
        ...reasonIds.map((id): TargetLink => ({ target: id, polarity: "supports", weight: "weak", rationale: `他当时给的理由：${store.getFact(id)?.statement ?? id}` })),
        ...controls.map((c): TargetLink => ({ target: c.accepted.factId, polarity: "refutes", weight: "weak", rationale: `对照：只换了${dl}他就去了（${c.accepted.name}），不像各有各的原因` })),
      ],
      addDays(last, 14),
    );
    const params: ContrastParams = {
      kind: "contrast",
      dimension: dim,
      valueKey: m.value.key,
      valueLabel: label,
      valueNames: m.value.names,
      declinedEventIds: m.declinedWith.map((r) => r.eventId),
      acceptedEventIds: m.acceptedWith.map((r) => r.eventId),
      declinedEvidenceIds: [...new Set(m.declinedWith.flatMap((r) => r.evidenceIds))],
      acceptedEvidenceIds: [...new Set(m.acceptedWith.flatMap((r) => r.evidenceIds))],
      controlEvidenceIds: [...new Set(controls.flatMap((c) => c.accepted.evidenceIds))],
      relatedFactIds: related,
      alternativeLabels,
      rateWith: m.rateWith,
      rateWithout: m.rateWithout,
      daytype: null,
      domain: null,
      activities: entityValued ? [{ id: m.value.key, name: label }] : [],
      first,
      last,
      spanDays: Math.round((toMs(last) - toMs(first)) / 86_400_000),
      count: m.declinedWith.length,
      workTagged: false,
    };
    return {
      key: `${CONTRAST_PATTERN}|${dim}|${m.value.key}`,
      pattern: CONTRAST_PATTERN,
      params: params as unknown as Record<string, unknown>,
      description: `推掉的邀约里有 ${m.declinedWith.length} 次${dl}是「${label}」（这样的推了 ${Math.round(m.rateWith * 100)}%，别的推了 ${Math.round(m.rateWithout * 100)}%）`,
      observationIds: m.declinedWith.map((r) => r.factId),
      hypotheses: [motif, ...alternatives, coincidence],
    };
  }

  private phrase(f: Fact): string {
    const name = f.object.type === "entity" ? (this.store.getEntity(f.object.id)?.name ?? f.object.id) : f.object.value;
    return factPhrase(f.predicate, f.negated, name);
  }

  private rootGroup(c: ConflictRecord, a: RootAssessment): HypothesisGroupDraft | undefined {
    const facts = (ids: readonly string[]) => ids.map((id) => this.store.getFact(id)).filter((f): f is Fact => f !== undefined);
    const A = facts(c.sideA);
    const B = facts(c.sideB);
    if (A.length === 0 || B.length === 0) return undefined;
    const all = [...A, ...B];
    const first = all.map(time).reduce((x, y) => (toMs(x) <= toMs(y) ? x : y));
    const last = all.map(time).reduce((x, y) => (toMs(x) >= toMs(y) ? x : y));
    const pa = this.phrase(A[0]!);
    const pb = this.phrase(B[0]!);
    const [E, L] = a.earlier === "A" ? [A, B] : [B, A];
    const later = E === A ? pb : pa;
    const earlierPhrase = E === A ? pa : pb;
    const need = a.needId ? this.store.getClaim(a.needId) : undefined;
    const minorityPhrase = a.minority === "A" ? pa : a.minority === "B" ? pb : undefined;
    const sceneOf = (fs: Fact[]) => [...new Set(fs.flatMap((f) => [...f.context, ...(a.sceneTags[f.id] ?? [])]))].join("、") || "不限场景";
    const constraints = a.constraintEvidenceIds.map((id) => this.store.getEvidence(id)?.text.slice(0, 16) ?? id);
    const statements: Record<RootKind, { tier: ClaimTier; statement: string; validFrom: string; validTo: string | null }> = {
      misrecorded: { tier: "state", statement: minorityPhrase ? `「${minorityPhrase}」那条可能记错了（抽取或者听错），另一边才对` : `「${pa}」和「${pb}」里有一条记错了（抽取或者听错）`, validFrom: first, validTo: addDays(last, 1) },
      changed_over_time: { tier: "preference", statement: `用户对「${c.objectName}」的想法变过：先是「${earlierPhrase}」，${localDate(time(L[0]!))} 起是「${later}」`, validFrom: time(L[0]!), validTo: null },
      scene_differs: { tier: "preference", statement: `用户对「${c.objectName}」看场合：「${pa}」在${sceneOf(A)}，「${pb}」在${sceneOf(B)}`, validFrom: first, validTo: null },
      say_do_gap: {
        tier: "state",
        statement: `用户想「${c.objectName}」，可实际一再没做到：愿望和现实约束对不上${constraints.length > 0 ? `（${constraints.join("；")}）` : ""}`,
        validFrom: first,
        validTo: addDays(last, 14),
      },
      deeper_need: { tier: "need", statement: need ? `两边背后是同一个需求：${need.statement}` : `「${pa}」和「${pb}」背后可能有同一个更深的需求（还没有成立的需求、价值断言对得上）`, validFrom: first, validTo: null },
    };
    const hypotheses: HypothesisDraft[] = ROOT_KINDS.map((root) => ({
      template: `root:${root}`,
      tier: statements[root].tier,
      statement: statements[root].statement,
      context: [],
      validFrom: statements[root].validFrom,
      validTo: statements[root].validTo,
      method: "abduction",
      links: a.links[root],
    }));
    const { links: _links, ...rest } = a;
    const params: RootParams = {
      ...rest,
      kind: "root",
      trigger: c.trigger,
      conflictKey: c.key,
      objectId: c.objectId,
      objectName: c.objectName,
      sideA: A.map((f) => f.id),
      sideB: B.map((f) => f.id),
      persons: a.persons.map((id) => this.store.getEntity(id)?.name ?? id),
      daytype: null,
      domain: null,
      activities: [],
      first,
      last,
      spanDays: Math.round((toMs(last) - toMs(first)) / 86_400_000),
      count: all.length,
      workTagged: false,
    };
    return {
      key: `${ROOT_PATTERN}|${c.key}`,
      pattern: ROOT_PATTERN,
      params: params as unknown as Record<string, unknown>,
      description: `「${pa}」和「${pb}」对不上（${TRIGGER_LABELS[c.trigger]}，关于「${c.objectName}」）`,
      observationIds: all.map((f) => f.id),
      hypotheses,
    };
  }

  // ---------- 2. 推理图谱：追问、判定 ----------

  async probesFor(group: GroupView, _ctx?: ReasonerContext): Promise<ProbeDraft[]> {
    const claimOf = new Map(group.members.map((m) => [m.template, m.claim.id]));
    const out: ProbeDraft[] = [];
    const push = (template: string, pair: readonly [string, string], ask: string, queries: string[]) => {
      const x = claimOf.get(pair[0]);
      const y = claimOf.get(pair[1]);
      const q = [...new Set(queries.map((s) => s.trim()).filter((s) => s.length >= 2))];
      if (x && y && q.length > 0) out.push({ template, discriminates: [x, y], ask, queries: q, ifFound: x });
    };
    if (isContrastGroup(group)) {
      const p = group.params as unknown as ContrastParams;
      for (const m of group.members) {
        if (!m.template.startsWith("alt:")) continue;
        const other = m.template.slice(4);
        const ask = contrastAsk(p, other);
        push(`contrast:${other}`, [`contrast:${p.dimension}`, m.template], ask, [...p.valueNames, ...(p.dimension === "lead_time" ? ["临时", "当天", "今晚", "现在过去"] : [])]);
      }
      return out;
    }
    const p = group.params as unknown as RootParams;
    const phrase = (ids: readonly string[]) => {
      const f = ids.map((id) => this.store.getFact(id)).find((x) => x !== undefined);
      return f ? this.phrase(f) : "";
    };
    const pa = phrase(p.sideA);
    const pb = phrase(p.sideB);
    const need = p.needId ? this.store.getClaim(p.needId) : undefined;
    push("check_wording", ["root:misrecorded", "root:changed_over_time"], rootAsk("check_wording", p, pa, pb, need), [p.objectName, "记错", "差点", "好像"]);
    push("check_time", ["root:changed_over_time", "root:scene_differs"], rootAsk("check_time", p, pa, pb, need), [p.objectName, "开始", "现在", "不再"]);
    push("check_scene", ["root:scene_differs", "root:misrecorded"], rootAsk("check_scene", p, pa, pb, need), [...p.persons, p.objectName]);
    push("check_constraint", ["root:say_do_gap", "root:changed_over_time"], rootAsk("check_constraint", p, pa, pb, need), ["加班", "没时间", "下雨", "太贵", "出差", "家里有事"]);
    push("check_need", ["root:deeper_need", "root:say_do_gap"], rootAsk("check_need", p, pa, pb, need), [p.objectName, ...(need ? [need.statement.slice(0, 8)] : [])]);
    return out;
  }

  /** 判定（代码）：追问搜到的本人证据里，和某边一致的、说了变化的、有约束的，按各自的根源记关联；已经记过的目标不再记 */
  async judge(probe: Probe, group: GroupView, hits: JudgeHit[], ctx: ReasonerContext): Promise<ProbeJudgement> {
    if (!isRootGroup(group)) return { outcome: "not_found", foundEvidenceIds: [], ifFound: probe.ifFound, links: [] };
    const p = group.params as unknown as RootParams;
    const template = this.rg.registry.probesOf(group.key).find((x) => x.probeId === probe.id)?.template;
    const claimOf = new Map(group.members.map((m) => [m.template, m.claim.id]));
    const sides = [...p.sideA, ...p.sideB].map((id) => this.store.getFact(id)).filter((f): f is Fact => f !== undefined);
    const sideEvidence = new Set(sides.flatMap((f) => f.evidenceIds));
    const links: LinkDraft[] = [];
    const found: string[] = [];
    const existing = (claimId: string) => new Set(this.store.linksOf(claimId).map((l) => `${l.target}|${l.polarity}`));
    const push = (root: RootKind, target: string, weight: LinkWeight, rationale: string) => {
      const claimId = claimOf.get(`root:${root}`);
      if (!claimId || existing(claimId).has(`${target}|supports`)) return;
      links.push({ claimId, target, polarity: "supports", weight, rationale });
      if (!found.includes(target)) found.push(target);
    };
    const behaviorTimes = (p.trigger === "say_do" ? p.sideB : [...p.sideA, ...p.sideB]).map((id) => this.store.getFact(id)).filter((f): f is Fact => f !== undefined).map((f) => toMs(f.eventTime ?? f.validFrom ?? f.observedAt));
    for (const { evidence, facts } of hits) {
      if (!ctx.view.usableEvidence(evidence.id) || sideEvidence.has(evidence.id)) continue;
      if (template === "check_wording" && p.trigger !== "say_do") {
        const agrees = facts.some((f) => sides.some((s) => s.predicate === f.predicate && s.negated === f.negated && JSON.stringify(s.object) === JSON.stringify(f.object)));
        if (agrees) push("misrecorded", evidence.id, "weak", `另一条证据和其中一边说法一样：${evidence.text.slice(0, 30)}`);
      } else if (template === "check_constraint") {
        const t = toMs(evidence.eventTime ?? evidence.observedAt);
        const near = behaviorTimes.some((b) => t >= b - 14 * 86_400_000 && t <= b + 3 * 86_400_000);
        if (near && hasConstraint(evidence.text)) push("say_do_gap", evidence.id, "strong", `那段时间的约束：${evidence.text.slice(0, 30)}`);
      }
    }
    return { outcome: found.length > 0 ? "found" : "not_found", foundEvidenceIds: found.filter((id) => this.store.getEvidence(id) !== undefined), ifFound: probe.ifFound, links };
  }

  // ---------- 5. 问题队列 ----------

  /** 这一组还分不出来（还活着、组里没有一条成立）：分不出的才进问题队列 */
  undecided(groupKey: string): boolean {
    const g = this.rg.registry.getGroup(groupKey);
    if (!g || !g.live || !isJointGroup(g)) return false;
    const view = this.rg.groupView(groupKey);
    return view !== undefined && !view.members.some((m) => m.claim.status === "active");
  }

  /**
   * 这一组的一条追问能不能问用户、怎么问（207 号票）：问能用"是 / 不是"（会去 / 不会去）回答的具体的事，写明两种回答各支持、反驳哪几个模板。
   * - 对比模式："下次王哥再约你，你会去吗？"（区分"和组织者有关"与"各有各的原因"）、"同样是工作日晚上的邀约，要是换成别人约，你会去吗？"
   *   （区分"和组织者有关"与"和时间段有关"）：两种回答都能分出胜负；
   * - 矛盾根源：查原话（有一条记错了吗）、查时间（后来变过吗）、查场景（是在不同的场合吗）、查约束（只是这阵子被耽误了吗，只问说的和做的不一样）、
   *   查需求（都跟那条成立的需求有关吗，没有成立的需求不问——问不出具体的事）。
   * 问不了的返回 undefined。
   */
  questionFor(groupKey: string, template: string): JointQuestion | undefined {
    const g = this.rg.registry.getGroup(groupKey);
    if (!g) return undefined;
    const view = this.rg.groupView(groupKey);
    const has = (t: string) => view?.members.some((m) => m.template === t) ?? false;
    if (isContrastGroup(g)) {
      const p = g.params as unknown as ContrastParams;
      const other = template.startsWith("contrast:") ? template.slice("contrast:".length) : "";
      const motif = `contrast:${p.dimension}`;
      const alt = `alt:${other}`;
      if (!other || !has(motif) || !has(alt)) return undefined;
      const tags = [...new Set(p.declinedEvidenceIds.flatMap((id) => this.store.getEvidence(id)?.context ?? []))];
      const domains = [...new Set([...domainsOfTags(tags), ...domainsOfText(p.valueLabel)])];
      const dl = DIMENSION_LABELS[p.dimension];
      const controls = p.controlEvidenceIds.length;
      const base = {
        text: contrastAsk(p, other),
        topic: groupKey,
        sources: [] as QuestionSource[],
        extraDomains: domains.length > 0 ? domains : ["social"],
        terms: [...p.valueNames],
        why: `推掉邀约和${dl}「${p.valueLabel}」有没有关系还分不出来（${dl}是「${p.valueLabel}」的推了 ${p.count} 次${controls > 0 ? `，有 ${controls} 次对照` : "，没有只差这一样的对照"}）。`,
      };
      // "会去"：换个人约就去（和这个值有关）／这个值再约也去（各有各的原因）
      return other === "coincidence"
        ? { ...base, answers: { yes: { supports: [alt], refutes: [motif] }, no: { supports: [motif], refutes: [alt] } } }
        : { ...base, answers: { yes: { supports: [motif], refutes: [alt] }, no: { supports: [alt], refutes: [motif] } } };
    }
    if (!isRootGroup(g)) return undefined;
    const p = g.params as unknown as RootParams;
    const sideFacts = [...p.sideA, ...p.sideB].map((id) => this.store.getFact(id)).filter((f): f is Fact => f !== undefined);
    const phrase = (ids: readonly string[]) => {
      const f = ids.map((id) => this.store.getFact(id)).find((x) => x !== undefined);
      return f ? this.phrase(f) : "";
    };
    const need = p.needId ? this.store.getClaim(p.needId) : undefined;
    const usableNeed = need && need.status === "active" ? need : undefined;
    const tags = [...new Set(sideFacts.flatMap((f) => f.context))];
    const base = {
      topic: `object:${p.objectId}`,
      sources: [p.trigger === "say_do" ? "tension" : "contradiction"] as QuestionSource[],
      extraDomains: [...new Set([...domainsOfTags(tags), ...domainsOfText(p.objectName)])],
      terms: [p.objectName, ...p.persons],
      why: `矛盾的根源查不清（${TRIGGER_LABELS[p.trigger]}：「${phrase(p.sideA)}」和「${phrase(p.sideB)}」，关于「${p.objectName}」）。`,
    };
    const text = rootAsk(template, p, phrase(p.sideA), phrase(p.sideB), usableNeed);
    switch (template) {
      case "check_wording":
        return { ...base, text, answers: pair([["root:misrecorded"], ["root:changed_over_time"]], [[], ["root:misrecorded"]]) };
      case "check_time":
        return { ...base, text, answers: pair([["root:changed_over_time"], []], [[], ["root:changed_over_time"]]) };
      case "check_scene":
        return { ...base, text, answers: pair([["root:scene_differs"], ["root:misrecorded"]], [[], ["root:scene_differs"]]) };
      case "check_constraint":
        if (p.trigger !== "say_do") return undefined;
        return { ...base, text, answers: pair([["root:say_do_gap"], ["root:changed_over_time"]], [[], ["root:say_do_gap"]]) };
      case "check_need":
        if (!usableNeed) return undefined;
        return { ...base, text, answers: pair([["root:deeper_need"], ["root:say_do_gap"]], [[], ["root:deeper_need"]]) };
      default:
        return undefined;
    }
  }

  /**
   * 分不出的组进问题队列：每条能区分的追问一个问题（question-sources.ts 按 198 的格式出草稿），新的交给钩子（默认是问题箱）；
   * 分出来了、撤回了的组，和这次不再出的问题，把还开着的关掉并告诉钩子。joint_questions 记账。返回这次新进的。
   */
  syncQuestions(at: string): KnowYouQuestion[] {
    const opened: KnowYouQuestion[] = [];
    const db = this.store.db;
    const openRows = db
      .all("SELECT key, payload FROM joint_questions WHERE status = 'open' ORDER BY rowid")
      .map((r) => ({ key: String(r.key), q: JSON.parse(String(r.payload)) as Partial<KnowYouQuestion> }));
    const close = (key: string, why: string) => {
      db.run("UPDATE joint_questions SET status = 'closed', closed_at = ? WHERE key = ?", at, key);
      this.sink?.onClosed?.(key, at, why);
    };
    for (const g of this.rg.registry.listGroups()) {
      if (!isJointGroup(g)) continue;
      const mine = openRows.filter((r) => r.q.groupKey === g.key);
      if (!this.undecided(g.key)) {
        const why = !g.live ? `${g.key} 撤回了` : `${g.key} 分出来了`;
        for (const r of mine) close(r.key, why);
        continue;
      }
      const drafts = generateQuestions(this.rg, at, { groups: [g.key] }).drafts;
      const keys = new Set(drafts.map((d) => d.key));
      for (const r of mine) if (!keys.has(r.key)) close(r.key, `${g.key} 这条追问区分的两条已经有一条不在了`);
      for (const d of drafts) {
        const question = this.knowYou(g, d, at);
        const wasOpen = mine.some((r) => r.key === d.key);
        db.run(
          "INSERT INTO joint_questions (key, payload, status, created_at, closed_at) VALUES (?, ?, 'open', ?, NULL) ON CONFLICT (key) DO UPDATE SET payload = excluded.payload, status = 'open', closed_at = NULL",
          d.key,
          JSON.stringify(question),
          at,
        );
        if (wasOpen) continue;
        opened.push(question);
        this.sink?.onQuestion(question);
      }
    }
    return opened;
  }

  private knowYou(g: GroupRecord, d: QuestionDraft, at: string): KnowYouQuestion {
    const priorityDetail: PriorityDetail = { separation: d.separation, closeness: d.closeness, frequency: d.frequency, fresh: 1 };
    return {
      key: d.key,
      groupKey: g.key,
      kind: isRootGroup(g) ? "conflict_root" : "contrast",
      ask: d.text,
      why: d.why,
      discriminates: d.targets.map((t) => t.id),
      answers: d.answers,
      domains: d.domains,
      scenes: d.scenes,
      priority: Math.round(d.separation * d.closeness * d.frequency * 1000) / 1000,
      priorityDetail,
      evidenceIds: [...new Set(g.observationIds.flatMap((id) => this.store.getFact(id)?.evidenceIds ?? []))],
      createdAt: at,
      expiresAt: addDays(at, 30),
      draft: d,
    };
  }

  /** 问题队列里的（默认只要还开着的） */
  questions(options: { all?: boolean } = {}): KnowYouQuestion[] {
    return this.store.db
      .all(`SELECT payload FROM joint_questions ${options.all ? "" : "WHERE status = 'open'"} ORDER BY rowid`)
      .map((r) => JSON.parse(String(r.payload)) as KnowYouQuestion);
  }

  // ---------- 给评测、演示看的 ----------

  /** 联动的结果：找出的隐蔽联系、矛盾和它们的根源（推理图谱定的，加上知识图谱自己判成观点变化、场景不同的）、写回、问题队列 */
  summary(at: string = this.store.now()): JointSummary {
    const registry = this.rg.registry;
    const motifs: MotifSummary[] = [];
    const conflicts: ConflictSummary[] = [];
    const covered = new Set<string>();
    for (const g of registry.listGroups({ live: true })) {
      const view = this.rg.groupView(g.key);
      if (!view) continue;
      if (isContrastGroup(g)) {
        const p = g.params as unknown as ContrastParams;
        const motif = view.members.find((m) => m.template === `contrast:${p.dimension}`)!;
        motifs.push({
          groupKey: g.key,
          dimension: p.dimension,
          dimensionLabel: DIMENSION_LABELS[p.dimension],
          valueKey: p.valueKey,
          valueLabel: p.valueLabel,
          valueNames: p.valueNames,
          claimId: motif.claim.id,
          statement: motif.claim.statement,
          status: motif.claim.status,
          confidence: motif.claim.confidence,
          declinedEvidenceIds: p.declinedEvidenceIds,
          acceptedEvidenceIds: p.acceptedEvidenceIds,
          controlEvidenceIds: p.controlEvidenceIds,
          relatedEvidenceIds: [...new Set(p.relatedFactIds.flatMap((id) => this.store.getFact(id)?.evidenceIds ?? []))],
          alternatives: view.members.filter((m) => m !== motif).map((m) => ({ template: m.template, statement: m.claim.statement, status: m.claim.status })),
        });
      } else if (isRootGroup(g)) {
        const p = g.params as unknown as RootParams;
        for (const id of [...p.sideA, ...p.sideB]) covered.add(id);
        const hyps = view.members.map((m) => ({ root: m.template.slice("root:".length) as RootKind, claimId: m.claim.id, status: m.claim.status, confidence: m.claim.confidence, statement: m.claim.statement }));
        const winner = hyps.find((h) => h.status === "active")?.root ?? null;
        const evidenceOf = (ids: readonly string[]) => [...new Set(ids.flatMap((id) => this.store.getFact(id)?.evidenceIds ?? []))];
        conflicts.push({
          key: g.key,
          source: "rg",
          trigger: p.trigger,
          objectName: p.objectName,
          evidenceIds: evidenceOf([...p.sideA, ...p.sideB]),
          sideA: { factIds: p.sideA, evidenceIds: evidenceOf(p.sideA) },
          sideB: { factIds: p.sideB, evidenceIds: evidenceOf(p.sideB) },
          hypotheses: hyps,
          winner,
          writeback: this.rg.writeback.appliedFor(g.key),
        });
      }
    }
    conflicts.push(...this.kgResolved(covered, at));
    return { at, motifs, conflicts, questions: this.questions() };
  }

  /** 知识图谱自己判了的矛盾：观点变化（旧的被取代）、场景不同（互相排斥、场景对不上，两条都成立）；推理图谱已经有组的不算 */
  private kgResolved(covered: ReadonlySet<string>, at: string): ConflictSummary[] {
    const view = this.rg.view(at);
    const mine = this.store
      .listFacts({ subjectId: USER_ENTITY_ID })
      .filter((f) => (f.assertion === "user_stated" || f.assertion === "observed") && (HELD_STATUSES as readonly string[]).includes(f.status) && view.usableFact(f) && !covered.has(f.id));
    const out: ConflictSummary[] = [];
    const name = (f: Fact) => (f.object.type === "entity" ? (this.store.getEntity(f.object.id)?.name ?? f.object.id) : f.object.value);
    const entry = (a: Fact, b: Fact, trigger: "kg_change" | "kg_scene"): ConflictSummary => ({
      key: `kg|${trigger}|${a.id}|${b.id}`,
      source: "kg",
      trigger,
      objectName: name(a),
      evidenceIds: [...new Set([...a.evidenceIds, ...b.evidenceIds])],
      sideA: { factIds: [a.id], evidenceIds: a.evidenceIds },
      sideB: { factIds: [b.id], evidenceIds: b.evidenceIds },
      hypotheses: [],
      winner: trigger === "kg_change" ? "changed_over_time" : "scene_differs",
      writeback: null,
    });
    for (const f of mine) {
      if (f.status !== "superseded" || !f.supersededBy) continue;
      const by = this.store.getFact(f.supersededBy);
      if (by && !covered.has(by.id) && by.subjectId === USER_ENTITY_ID) out.push(entry(f, by, "kg_change"));
    }
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i]!;
        const b = mine[j]!;
        if (a.status === "superseded" || b.status === "superseded") continue;
        if (excludes(a, b, { correction: false }) && !contextsCompatible(a.context, b.context)) out.push(entry(a, b, "kg_scene"));
      }
    }
    return out;
  }
}

export interface MotifSummary {
  groupKey: string;
  dimension: ContrastDimension;
  dimensionLabel: string;
  valueKey: string;
  valueLabel: string;
  /** 值的名字和别名（实体的） */
  valueNames: string[];
  claimId: string;
  statement: string;
  status: Claim["status"];
  confidence: Claim["confidence"];
  declinedEvidenceIds: string[];
  acceptedEvidenceIds: string[];
  /** 对照（只有这个属性不一样、他去了的） */
  controlEvidenceIds: string[];
  /** 图上的联系（这个人、这个地方在这几次邀约以外还出现在哪） */
  relatedEvidenceIds: string[];
  alternatives: { template: string; statement: string; status: Claim["status"] }[];
}

export interface ConflictSummary {
  key: string;
  /** rg：推理图谱建了根源假设；kg：知识图谱自己判成观点变化、场景不同 */
  source: "rg" | "kg";
  trigger: ConflictTrigger | "kg_change" | "kg_scene";
  objectName: string;
  evidenceIds: string[];
  sideA: { factIds: string[]; evidenceIds: string[] };
  sideB: { factIds: string[]; evidenceIds: string[] };
  hypotheses: { root: RootKind; claimId: string; status: Claim["status"]; confidence: Claim["confidence"]; statement: string }[];
  /** 胜出的根源（active 的那条）；分不出是 null */
  winner: RootKind | null;
  writeback: WritebackSummaryEntry | null;
}

/** 写回了什么（rg/writeback.ts） */
export interface WritebackSummaryEntry {
  claimId: string;
  root: RootKind;
  facts: { factId: string; before: Partial<Fact>; after: Partial<Fact> }[];
  marks: { factId: string; kind: string; ref: string }[];
}

export interface JointSummary {
  at: string;
  motifs: MotifSummary[];
  conflicts: ConflictSummary[];
  questions: KnowYouQuestion[];
}

// ---------- 问法（207 号票：能用"是 / 不是""会去 / 不会去"回答的具体的事） ----------

/** 两种回答各支持、反驳哪几个模板 */
const pair = (yes: [string[], string[]], no: [string[], string[]]): JointQuestion["answers"] => ({ yes: { supports: yes[0], refutes: yes[1] }, no: { supports: no[0], refutes: no[1] } });

/** 对比模式里这个值的说法：下次这个值再来 */
function contrastAgain(dimension: ContrastDimension, label: string): string {
  switch (dimension) {
    case "organizer":
    case "organizer_relation":
      return `下次${label}再约你`;
    case "participant":
      return `下次有${label}一起的邀约`;
    case "place":
    case "slot":
      return `下次约在${label}`;
    case "type":
      return `下次再有${label}的邀约`;
    case "lead_time":
      return `下次要是${label}`;
  }
}

/** 换掉这个值的说法 */
function contrastSwap(dimension: ContrastDimension, label: string): string {
  switch (dimension) {
    case "organizer":
      return "换成别人约";
    case "organizer_relation":
      return `换成不是${label}的人约`;
    case "participant":
      return `没有${label}一起`;
    case "place":
      return "换个地方";
    case "slot":
      return "换个时间";
    case "type":
      return "换成别的活动";
    case "lead_time":
      return label.startsWith("当天") ? "提前几天约" : "临时才约";
  }
}

/** 共有的别的属性的说法（"同样是工作日晚上的邀约"） */
function contrastSame(dimension: ContrastDimension, label: string): string {
  switch (dimension) {
    case "organizer":
    case "organizer_relation":
      return `${label}约的`;
    case "participant":
      return `有${label}一起的`;
    case "place":
      return `在${label}的`;
    default:
      return `${label}的`;
  }
}

/** 对比模式那组的一条追问：other 是 coincidence 时问"这个值再约你会去吗"，否则问"同样是别的那个属性、换掉这个值会去吗" */
function contrastAsk(p: ContrastParams, other: string): string {
  if (other === "coincidence") return `${contrastAgain(p.dimension, p.valueLabel)}，你会去吗？`;
  const w = p.alternativeLabels?.[other as ContrastDimension];
  const same = w ? `同样是${contrastSame(other as ContrastDimension, w)}邀约` : `同样的邀约`;
  return `${same}，要是${contrastSwap(p.dimension, p.valueLabel)}，你会去吗？`;
}

/** 矛盾根源那组的一条追问（是 / 不是能回答的） */
function rootAsk(template: string, p: RootParams, pa: string, pb: string, need: Claim | undefined): string {
  switch (template) {
    case "check_wording":
      return `「${pa}」和「${pb}」，有一条是记错了（或者我听错了）吗？`;
    case "check_time":
      return `你对「${p.objectName}」的想法，后来变过吗？`;
    case "check_scene":
      return `「${pa}」和「${pb}」，是在不同的场合（和谁、在哪）吗？`;
    case "check_constraint":
      return `是想「${p.objectName}」，只是这阵子被别的事耽误了（忙、钱、别人、天气）吗？`;
    case "check_need":
      return need ? `「${pa}」和「${pb}」，都跟「${need.statement.replace(/^用户/, "你")}」有关吗？` : `「${pa}」和「${pb}」背后，有没有一个你更在意的东西？`;
    default:
      return `「${pa}」和「${pb}」对不上，哪一条才对？`;
  }
}

/** 330 号票（矛盾根源，选 A）：两条事实的有效期不重叠（一条到期了另一条才开始） */
function validityDisjoint(a: Fact, b: Fact): boolean {
  return (a.validTo !== null && b.validFrom !== null && toMs(a.validTo) <= toMs(b.validFrom)) || (b.validTo !== null && a.validFrom !== null && toMs(b.validTo) <= toMs(a.validFrom));
}
