// 预测落空往回打（330 号票 R10，ADR-0032，照原始推理图谱 LIFECYCLE §8 的"假说-演绎法 + 证伪反向传播"）：
// 一条预测到期判成落空（rg/predictions.ts 先把它撤了：miss，墓碑指证伪它的那条观察），再回头打它的来源——
// - 可废止（"大概会"，归纳、溯因）：落空不牵连来源的真假（判断错了不代表它依据的前提错），每条来源只挨一条反证
//   （弱的：一条旁证的分量，按现在的分贝计分），它那组当场按证据重定（R9：削弱只降把握，不撤）；
// - 演绎（"必然推得出"）：modus tollens，来源的合取是假的。照原始"先怀疑前提"的顺序（§6b 第一阶段、第二幕 A 的排除法）定撤哪条：
//   · 来源里只有一条没验证（猜测）、别的都已验证 → 它就是错的那条（culprit）：记一条决定性反证、撤回，再按 R8 往上传；
//   · 没验证的不止一条（Duhem-Quine）→ 判不出，不乱撤；每条嫌疑往问题箱出一个问题（question-sources.ts），用户答了再判；
//   · 来源都已验证（§6：排除法在前提里指不到人，只能是漏了条件或反证有误）→ 每条挨一条有分量的反例（强的），出问题弄清（R12）。
//   证伪它的那条观察得是本人有效的（R3：别人转述的证伪不了关于用户的结论），判的时候只喂这种。
// 每晚判预测之前再看一遍还没找到错处的（reassessMisses）：嫌疑里有一条已经撤回了（比如用户答了"不对"）→ 就是它，别的不动；
// 用户确认了几条、没验证的只剩一条 → 排除法落到它，撤回；嫌疑都确认还对了 → 不撤来源，这次算例外。
// 应验了只刷新预测那一条（"证实的不对称"：结论真推不出前提真），来源不加支持、不因此变已验证；应验本身就直接证实了来源的情形
// （用户亲口确认、追问找到的独立证据）走原来的 R7 那几条路，不在这里替来源加分。
import type { Claim, PredictionBlame, PredictionRecord, RevisionCause } from "../domain/types.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";

const LIVE: ReadonlySet<string> = new Set(["active", "contested"]);

/** 关联有多重（同一个目标已经挂着更重的反证就不压低它） */
const RANK = { weak: 0, strong: 1, decisive: 2 } as const;

export class PredictionBackprop {
  private readonly rg: ReasoningGraph;

  constructor(rg: ReasoningGraph) {
    this.rg = rg;
  }

  private get store() {
    return this.rg.store;
  }

  private get w() {
    return this.rg.gate;
  }

  /** 落空的预测回头打来源（要在调用方开的那一次写里调）：交回打了谁 */
  missed(p: PredictionRecord, at: string): PredictionBlame {
    const evidenceId = p.retractedBy ?? p.evidenceId;
    const sources = p.premiseIds.map((id) => this.store.getClaim(id)).filter((c): c is Claim => c !== undefined);
    const live = sources.filter((c) => LIVE.has(c.status));
    const blame = (mode: PredictionBlame["mode"], claimIds: string[]): PredictionBlame => {
      const b: PredictionBlame = { mode, claimIds, at };
      this.w.updatePrediction(p.id, { blame: b }, { evidenceId, reason: blameReason(p, b) });
      return b;
    };
    if (evidenceId === null || live.length === 0) return blame("none", []);
    if (p.derivation === "defeasible") {
      for (const c of live) this.refute(c, evidenceId, "weak", `预测 ${p.id}「${p.predicts}」落空了（可废止，只算一条反证）`);
      this.resettle(live, at);
      return blame("counter", live.map((c) => c.id));
    }
    return this.deductive(p, evidenceId, sources, at, blame);
  }

  /**
   * 每晚判预测之前：还没找到错处的演绎落空再看一遍。嫌疑里有一条撤回了 → 就是它（别的不动）；没验证的只剩一条、别的都已验证 →
   * 排除法落到它，撤回。交回这一夜定下来的
   */
  reassess(at: string): PredictionRecord[] {
    const out: PredictionRecord[] = [];
    for (const p of this.store.listPredictions({ status: "miss" })) {
      if (p.blame?.mode !== "undetermined" || p.derivation !== "deductive") continue;
      const evidenceId = p.retractedBy ?? p.evidenceId;
      const fell = p.blame.claimIds.find((id) => this.store.getClaim(id)?.status === "retracted");
      const sources = p.premiseIds.map((id) => this.store.getClaim(id)).filter((c): c is Claim => c !== undefined);
      const settled = this.rg.gate.write({ op: "predict", actor: "nightly", reason: `再看一遍落空的演绎预测 ${p.id}（哪条前提错了）` }, () => {
        const blame = (mode: PredictionBlame["mode"], claimIds: string[]): PredictionBlame => {
          const b: PredictionBlame = { mode, claimIds, at };
          this.w.updatePrediction(p.id, { blame: b }, { evidenceId, reason: blameReason(p, b) });
          return b;
        };
        if (fell !== undefined) return blame("culprit", [fell]);
        if (evidenceId === null) return undefined;
        const before = p.blame!.claimIds.join();
        const b = this.deductive(p, evidenceId, sources, at, blame, false);
        return b.mode === "undetermined" && b.claimIds.join() === before ? undefined : b;
      });
      if (settled) out.push(this.store.getPrediction(p.id)!);
    }
    return out;
  }

  /** 演绎落空：照"先怀疑前提"的顺序定撤哪条（见文件开头） */
  private deductive(
    p: PredictionRecord,
    evidenceId: string,
    sources: readonly Claim[],
    at: string,
    blame: (mode: PredictionBlame["mode"], claimIds: string[]) => PredictionBlame,
    act = true,
  ): PredictionBlame {
    const missing = p.premiseIds.length - sources.length;
    const suspects = sources.filter((c) => c.status === "contested");
    // 来源里有不在了的（被取代、被删了）：那条推不出来了，排除法不成立
    const settled = missing === 0 && sources.every((c) => c.status === "active" || c.status === "contested");
    // 明说的结论跟着用户那句话走，不由预测撤回：它当嫌疑时只能问
    if (settled && suspects.length === 1 && suspects[0]!.epistemic !== "explicit") {
      const culprit = suspects[0]!;
      this.refute(culprit, evidenceId, "decisive", `演绎预测 ${p.id}「${p.predicts}」落空了：${sources.length > 1 ? "别的前提都已验证，" : ""}这条没验证的前提就是错的（modus tollens）`);
      this.retract(culprit, evidenceId, at, p);
      return blame("culprit", [culprit.id]);
    }
    if (settled && suspects.length === 0) {
      // 再看一遍时嫌疑都已验证了（用户答了"还对"）：这次落空不撤来源，算例外（漏了条件还是反证有误，R12 那边接着管）
      if (!act) return blame("exception", sources.map((c) => c.id));
      for (const c of sources) this.refute(c, evidenceId, "strong", `演绎预测 ${p.id}「${p.predicts}」落空了，前提都已验证：只能是漏了条件或这条反证有误（要弄清）`);
      this.resettle(sources, at);
      return blame("counterexample", sources.map((c) => c.id));
    }
    return blame(
      "undetermined",
      sources.filter((c) => LIVE.has(c.status) && c.status !== "active").map((c) => c.id),
    );
  }

  /** 挂一条反证（同一个目标已经挂着更重的就不动） */
  private refute(claim: Claim, target: string, weight: "weak" | "strong" | "decisive", rationale: string): void {
    const existing = this.store.linksOf(claim.id).find((l) => l.target === target && l.polarity === "refutes");
    if (existing && RANK[existing.weight] >= RANK[weight]) return;
    this.w.putLink({ claimId: claim.id, target, polarity: "refutes", weight, rationale }, { evidenceId: target, reason: rationale });
  }

  /** 撤回错的那条前提，往上按 R8 传：在活着的组里由那组按证据重定（决定性反证就撤），不在组里的直接撤 */
  private retract(claim: Claim, evidenceId: string, at: string, p: PredictionRecord): void {
    const member = this.rg.registry.memberOf(claim.id);
    if (member && this.rg.registry.getGroup(member.groupKey)?.live) {
      this.rg.settleGroupNow(member.groupKey, at);
      if (this.store.getClaim(claim.id)?.status === "retracted") return;
    }
    const cause: RevisionCause = { evidenceId, reason: `演绎预测 ${p.id} 落空了，前提 ${claim.id} 是错的那条，撤回` };
    this.w.updateClaim(claim.id, { status: "retracted", retractedBy: evidenceId, needsReview: false, reviewedAt: at }, cause);
    for (const inf of this.store.inferencesOf(claim.id)) if (inf.status === "active" || inf.status === "needs_review") this.w.updateInference(inf.id, { status: "retracted" }, cause);
    this.rg.keeper.retractDependents(claim.id, at, { ...cause, reason: `前提 ${claim.id} 被证伪了（演绎预测 ${p.id} 落空）` }, this.rg.view(at));
  }

  /** 挨了反证的几条，它们的组当场按证据重定 */
  private resettle(claims: readonly Claim[], at: string): void {
    const keys = new Set<string>();
    for (const c of claims) {
      const member = this.rg.registry.memberOf(c.id);
      if (member) keys.add(member.groupKey);
    }
    for (const key of keys) this.rg.settleGroupNow(key, at);
  }
}

/** 往回打的结果写进修订的一句话（数据，不随界面语言变） */
function blameReason(p: PredictionRecord, b: PredictionBlame): string {
  switch (b.mode) {
    case "culprit":
      return `预测 ${p.id} 落空：错的那条前提是 ${b.claimIds.join("、")}，撤回`;
    case "undetermined":
      return `演绎预测 ${p.id} 落空：没验证的前提不止一条（${b.claimIds.join("、")}），判不出是哪条错了（Duhem-Quine），不乱撤、出问题`;
    case "counterexample":
      return `演绎预测 ${p.id} 落空：前提都已验证（${b.claimIds.join("、")}），只能是漏了条件或反证有误，各挨一条反例、出问题弄清`;
    case "counter":
      return `可废止的预测 ${p.id} 落空：来源 ${b.claimIds.join("、")} 各挨一条反证`;
    case "exception":
      return `演绎预测 ${p.id} 落空：嫌疑的几条用户都确认还对（${b.claimIds.join("、")}），不撤来源，这次算例外`;
    default:
      return `预测 ${p.id} 落空：来源都已经不在了`;
  }
}
