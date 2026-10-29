// 结论写回知识图谱（199 号票）：矛盾的根源定了（那组里有一条 active）以后，照结论改知识图谱，写修订日志，两张图保持一致：
// - 有一条记错了 → 那条事实 corrected（retractedBy 指向另一边的证据），和它冲突的另一边恢复；依赖它的推断、断言经传播钩子待复核
//   （这组根源假设自己不算：它的前提里就有这条事实）；
// - 时间变了 → 补有效期：早的那边到晚的那边开始时为止（superseded，supersededBy 是晚的那条）；说的和做的不一样时，说的那条到第一次没做到时为止；
// - 场景不同 → 补场景：从图上人和人的关系补出来的标签加到事实上（规则版的精炼陈述跟着重写），两边按日子先后判成"观点变化"的、冲突的恢复；
// - 说的和做的不一样 → 两条都保留，互相标 gap（kg/marks.ts）；
// - 更深的需求 → 两边的事实关联到那条需求断言（标 explained_by），需求断言那边记背景关联（不计分）。
// 每组同一时间最多一份写回（joint_writebacks）；根源变了、分不出了，按记下的"改之前"撤回（当前的值还是写回时写的才撤），再写新的。
// 写回只看推理图谱已经定了的结论，幂等：重复跑不重复写。
import type { Fact, RevisionCause } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { FactMarks } from "../kg/marks.ts";
import { HELD_STATUSES, rgSession, rgWriter, type RgWriter } from "../store/store.ts";
import { ROOT_LABELS, type RootKind } from "./conflict-roots.ts";
import { isRootGroup, type RootParams, type WritebackSummaryEntry } from "./joint.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";

/** 一份写回：哪组、哪条根源、改了哪些事实（改之前、改之后）、加了哪些标记、记了哪些背景关联 */
export interface WritebackRecord {
  groupKey: string;
  claimId: string;
  root: RootKind;
  facts: { factId: string; before: Partial<Fact>; after: Partial<Fact> }[];
  marks: { factId: string; kind: "gap" | "explained_by"; ref: string }[];
  links: { claimId: string; target: string }[];
  status: "applied" | "reverted";
  at: string;
}

export interface WritebackReport {
  applied: WritebackRecord[];
  reverted: WritebackRecord[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const timeOf = (f: Fact) => f.eventTime ?? f.validFrom ?? f.observedAt;
const held = (f: Fact) => (HELD_STATUSES as readonly string[]).includes(f.status);

export class KgWriteback {
  readonly marks: FactMarks;
  private readonly engine: MemoryEngine;
  private readonly rg: ReasoningGraph;

  constructor(engine: MemoryEngine, rg: ReasoningGraph) {
    this.engine = engine;
    this.rg = rg;
    this.marks = new FactMarks(engine.store);
  }

  private get store() {
    return this.engine.store;
  }

  /** 267 号票：写事实、关联经唯一写入口（在调用方开的那一次写里） */
  private get w(): RgWriter {
    return rgWriter(this.engine.store);
  }

  /** 每组定了根源的照结论写回；根源变了、分不出了的撤回上次写的。在调用方的事务里做 */
  sync(at: string): WritebackReport {
    const report: WritebackReport = { applied: [], reverted: [] };
    for (const g of this.rg.registry.listGroups()) {
      if (!isRootGroup(g)) continue;
      const view = this.rg.groupView(g.key);
      const winner = g.live && view ? view.members.find((m) => m.claim.status === "active") : undefined;
      const current = this.current(g.key);
      // 267 号票：每份写回各开一次写；这组根源假设自己不算"依赖被改掉的事实的"（它们就是起因，同传播的 sparedClaimIds）
      const members = this.rg.registry.members(g.key).map((m) => m.claimId);
      if (current && (!winner || current.claimId !== winner.claim.id)) {
        const why = winner ? `根源换成了 ${winner.claim.id}` : "根源不再成立";
        report.reverted.push(rgSession(this.store, { op: "writeback", reason: `写回撤销（${current.claimId}）：${why}`, spares: members }, () => this.revert(current, why)));
      }
      if (winner && (!current || current.claimId !== winner.claim.id)) {
        const rec = rgSession(this.store, { op: "writeback", reason: `写回：${winner.claim.id} 定了根源`, spares: members }, () =>
          this.apply(g.key, g.params as unknown as RootParams, winner.claim.id, winner.template.slice("root:".length) as RootKind, view!.members.map((m) => m.claim.id), at),
        );
        report.applied.push(rec);
      }
    }
    return report;
  }

  /** 现在生效的那份写回 */
  current(groupKey: string): WritebackRecord | undefined {
    const row = this.store.db.get<{ changes: string }>("SELECT changes FROM joint_writebacks WHERE group_key = ? AND status = 'applied'", groupKey);
    return row ? (JSON.parse(row.changes) as WritebackRecord) : undefined;
  }

  list(options: { all?: boolean } = {}): WritebackRecord[] {
    return this.store.db
      .all(`SELECT changes FROM joint_writebacks ${options.all ? "" : "WHERE status = 'applied'"} ORDER BY rowid`)
      .map((r) => JSON.parse(String(r.changes)) as WritebackRecord);
  }

  /** 给联动结果看的：这组现在写回了什么 */
  appliedFor(groupKey: string): WritebackSummaryEntry | null {
    const r = this.current(groupKey);
    return r ? { claimId: r.claimId, root: r.root, facts: r.facts, marks: r.marks } : null;
  }

  private save(rec: WritebackRecord): void {
    this.store.db.run(
      `INSERT INTO joint_writebacks (group_key, claim_id, root, changes, status, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (group_key, claim_id) DO UPDATE SET root = excluded.root, changes = excluded.changes, status = excluded.status, at = excluded.at`,
      rec.groupKey,
      rec.claimId,
      rec.root,
      JSON.stringify(rec),
      rec.status,
      rec.at,
    );
  }

  private apply(groupKey: string, p: RootParams, claimId: string, root: RootKind, members: readonly string[], at: string): WritebackRecord {
    const rec: WritebackRecord = { groupKey, claimId, root, facts: [], marks: [], links: [], status: "applied", at };
    const facts = (ids: readonly string[]) => ids.map((id) => this.store.getFact(id)).filter((f): f is Fact => f !== undefined);
    const A = facts(p.sideA);
    const B = facts(p.sideB);
    const evidence = [...A, ...B].flatMap((f) => f.evidenceIds)[0] ?? null;
    const cause = (reason: string): RevisionCause => ({ evidenceId: evidence, reason: `写回：${ROOT_LABELS[root]}（${claimId}）：${reason}` });
    const update = (f: Fact, patch: Partial<Fact>, reason: string) => {
      const next: Partial<Fact> = { ...patch };
      if (f.extractedBy.startsWith("rule:") && (patch.context !== undefined || patch.validTo !== undefined)) next.statement = this.engine.kg.statementOf({ ...f, ...patch });
      const before = Object.fromEntries(Object.keys(next).map((k) => [k, f[k as keyof Fact]])) as Partial<Fact>;
      if (Object.keys(next).every((k) => same(before[k as keyof Fact], next[k as keyof Fact]))) return;
      this.w.updateFact(f.id, next, cause(reason));
      rec.facts.push({ factId: f.id, before, after: next });
    };
    const uncontest = (fs: readonly Fact[], others: ReadonlySet<string>, reason: string) => {
      for (const f of fs) {
        const now = this.store.getFact(f.id)!;
        if (now.status !== "contested") continue;
        const rest = now.contestedWith.filter((id) => !others.has(id));
        update(now, { contestedWith: rest, status: rest.length > 0 ? "contested" : "active" }, reason);
      }
    };

    if (root === "misrecorded" && p.minority) {
      const wrong = p.minority === "A" ? A : B;
      const right = p.minority === "A" ? B : A;
      const by = right.flatMap((f) => f.evidenceIds)[0] ?? evidence;
      const wrongIds = new Set(wrong.map((f) => f.id));
      // contestedWith 留着：另一边的证据被忘掉时，事实层按 188 的规矩把这条纠正撤销、恢复成冲突（kg/graph.ts dropEvidence）
      for (const f of wrong) if (held(f)) update(f, { status: "corrected", retractedBy: by }, `这条记错了，另一边（${right.map((x) => x.id).join("、")}）才对`);
      uncontest(right, wrongIds, "和它冲突的那条记错了");
      const corrected = rec.facts.filter((c) => wrongIds.has(c.factId)).map((c) => c.factId);
      const restored = rec.facts.filter((c) => !wrongIds.has(c.factId)).map((c) => c.factId);
      if (corrected.length > 0 && by) {
        this.rg.onInvalidation({ cause: "fact_corrected", evidenceId: by, byEvidenceId: null, reason: `写回：推理图谱判定 ${corrected.join("、")} 记错了（${claimId}）`, retractedFactIds: corrected, weakenedFactIds: [], restoredFactIds: restored, sparedClaimIds: [...members] });
      }
    } else if (root === "changed_over_time") {
      const [E, L] = p.earlier === "A" ? [A, B] : [B, A];
      if (p.trigger === "say_do") {
        // 说的那条（愿望）到第一次没做到时为止
        const firstDid = L.map(timeOf).toSorted((x, y) => Date.parse(x) - Date.parse(y))[0];
        for (const f of A) if (held(f) && f.validTo === null && firstDid) update(f, { validTo: firstDid }, `愿望到 ${firstDid.slice(0, 10)} 为止`);
      } else {
        const head = L.toSorted((x, y) => Date.parse(timeOf(x)) - Date.parse(timeOf(y)))[0]!;
        const until = head.validFrom ?? timeOf(head);
        const later = new Set(L.map((f) => f.id));
        for (const f of E) {
          if (!held(f) || f.status === "superseded") continue;
          update(f, { status: "superseded", supersededBy: head.id, validTo: until, contestedWith: f.contestedWith.filter((id) => !later.has(id)) }, `观点变了：到 ${until.slice(0, 10)} 为止，由 ${head.id} 接上`);
        }
        uncontest(L, new Set(E.map((f) => f.id)), "和它冲突的那条是以前的想法");
      }
    } else if (root === "scene_differs") {
      for (const [factId, tags] of Object.entries(p.sceneTags)) {
        const f = this.store.getFact(factId);
        if (!f) continue;
        const context = [...f.context, ...tags.filter((t) => !f.context.includes(t))];
        update(f, { context }, `补场景：${tags.join("、")}（从图上人和人的关系补的）`);
      }
      const ids = { A: new Set(A.map((f) => f.id)), B: new Set(B.map((f) => f.id)) };
      for (const [side, other] of [
        [A, ids.B],
        [B, ids.A],
      ] as const) {
        for (const f0 of side) {
          const f = this.store.getFact(f0.id)!;
          if (f.status === "superseded" && f.supersededBy && other.has(f.supersededBy)) {
            const r = this.store
              .revisions(f.id, "fact")
              .toReversed()
              .find((x) => x.op === "update" && x.changes.supersededBy?.to === f.supersededBy);
            const validTo = r && "validTo" in r.changes ? (r.changes.validTo!.from as string | null) : null;
            update(f, { status: "active", supersededBy: null, validTo }, "场景不同，不是观点变化，恢复");
          }
        }
        uncontest(side, other, "场景不同，不算冲突");
      }
    } else if (root === "say_do_gap") {
      for (const [side, other] of [
        [A, B],
        [B, A],
      ] as const) {
        for (const f of side) {
          const changed = this.marks.put({ factId: f.id, kind: "gap", ref: claimId, detail: { with: other.map((x) => x.id), reason: "说的和做的不一样，两条都保留" } }, cause("两条都保留，标 gap"));
          if (changed || this.marks.get(f.id, "gap", claimId)?.active) rec.marks.push({ factId: f.id, kind: "gap", ref: claimId });
        }
      }
    } else if (root === "deeper_need" && p.needId) {
      const need = p.needId;
      for (const f of [...A, ...B]) {
        this.marks.put({ factId: f.id, kind: "explained_by", ref: need, detail: { rootClaimId: claimId, reason: "矛盾的两边都能用这条需求解释" } }, cause(`关联到需求断言 ${need}`));
        rec.marks.push({ factId: f.id, kind: "explained_by", ref: need });
      }
      for (const side of [A, B]) {
        const target = side.flatMap((f) => f.evidenceIds)[0];
        if (!target) continue;
        this.w.putLink({ claimId: need, target, polarity: "context", weight: "weak", rationale: `矛盾的这一边也能用它解释（${claimId}）` }, cause("需求断言记一条背景关联"));
        rec.links.push({ claimId: need, target });
      }
    }
    this.save(rec);
    return rec;
  }

  private revert(rec: WritebackRecord, why: string): WritebackRecord {
    const cause = (reason: string): RevisionCause => ({ evidenceId: null, reason: `写回撤销：${ROOT_LABELS[rec.root]}（${rec.claimId}）${why}：${reason}` });
    const restored: string[] = [];
    for (const c of rec.facts.toReversed()) {
      const f = this.store.getFact(c.factId);
      if (!f) continue;
      const untouched = Object.keys(c.after).every((k) => same(f[k as keyof Fact], c.after[k as keyof Fact]));
      if (!untouched) continue;
      this.w.updateFact(f.id, c.before, cause("恢复成写回之前的样子"));
      restored.push(f.id);
    }
    for (const m of rec.marks) this.marks.clear(m.factId, m.kind, m.ref, cause("撤掉标记"));
    // 冲突的另一边都不在了（证据被忘掉）的，不再算冲突
    const p = this.rg.registry.getGroup(rec.groupKey)?.params as unknown as RootParams | undefined;
    for (const id of [...(p?.sideA ?? []), ...(p?.sideB ?? [])]) {
      const f = this.store.getFact(id);
      if (!f || f.status !== "contested") continue;
      const alive = f.contestedWith.filter((x) => {
        const o = this.store.getFact(x);
        return o !== undefined && (o.status === "contested" || o.status === "active");
      });
      if (alive.length === f.contestedWith.length) continue;
      this.w.updateFact(f.id, { contestedWith: alive, status: alive.length > 0 ? "contested" : "active" }, cause("冲突的另一边不在了"));
      if (!restored.includes(f.id)) restored.push(f.id);
    }
    for (const l of rec.links) this.w.removeLink({ claimId: l.claimId, target: l.target, polarity: "context" }, cause("拿掉背景关联"));
    if (restored.length > 0) {
      const members = this.rg.registry.members(rec.groupKey).map((m) => m.claimId);
      const evidenceId = restored.flatMap((id) => this.store.getFact(id)?.evidenceIds ?? [])[0];
      if (evidenceId) this.rg.onInvalidation({ cause: "fact_corrected", evidenceId, byEvidenceId: null, reason: `写回撤销（${rec.claimId}）`, retractedFactIds: [], weakenedFactIds: [], restoredFactIds: restored, sparedClaimIds: members });
    }
    const out: WritebackRecord = { ...rec, status: "reverted", at: this.store.now() };
    this.save(out);
    return out;
  }
}
