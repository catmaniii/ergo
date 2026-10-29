// 规则版推理（RuleReasoner，rule:1）：确定性，给测试和演示用。模板表在 templates.ts。
// - propose：在能当依据的本人事实里认观察模式，每个模式出一组竞争假设（至少两条）；观察本身对组里每条都是弱支持，
//   观察所在证据里的别的事实按各条的预期配一遍（"最近周末想好好休息"和"不去聚会"在同一句话里）；
//   用户的纠正直接按各条的预期判（纠正的多重升一档），不靠第二轮检索碰运气；
// - probesFor：组里两条假设预期不同的地方出追问（问具体的事，不问动机），带第二轮检索的短语；
// - judge：追问搜到的证据，抽出的事实按组里每条假设的预期配；能让被区分的两条此消彼长的证据算"找到了"，
//   什么都没配上是 not_found（inconclusive，不判负）。别人转述的只记成背景（context），不当依据；
// - lift：往上抽需求、价值层（195 号票，lift.ts）。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import type { Fact, Probe } from "../domain/types.ts";
import { WEIGHT_DB } from "./scoring.ts";
import { liftGroups, ruleProbeTemplates, ruleTemplateById } from "./lift.ts";
import { assessFact, detectPatterns, factInfo, HYPOTHESIS_TEMPLATES, type FactInfo, type HypothesisTemplate, type PatternInstance, type SceneParams } from "./templates.ts";
import type { GroupView, HypothesisDraft, HypothesisGroupDraft, JudgeHit, LiftInput, LiftLevel, LinkDraft, ProbeDraft, ProbeJudgement, Reasoner, ReasonerContext, RgView, TargetLink } from "./types.ts";

export class RuleReasoner implements Reasoner {
  readonly id = "rule:1";
  readonly exhaustive = true;

  async propose(observations: Fact[], ctx: ReasonerContext): Promise<HypothesisGroupDraft[]> {
    const { view } = ctx;
    const infos = observations.filter((f) => f.subjectId === USER_ENTITY_ID && view.usableFact(f)).map((f) => factInfo(f, view));
    // 纠正本身也是证据（第 7.3 节第 6 条）：直接按各条假设的预期判，不靠检索碰运气
    const corrections = infos.filter((i) => i.correction);
    const groups: HypothesisGroupDraft[] = [];
    for (const inst of detectPatterns(infos)) {
      const hypotheses = HYPOTHESIS_TEMPLATES.filter((t) => t.pattern === inst.pattern && t.applies(inst.params)).map((t) => this.draft(t, inst, view, corrections));
      if (hypotheses.length < 2) continue;
      groups.push({
        key: inst.key,
        pattern: inst.pattern,
        params: inst.params as unknown as Record<string, unknown>,
        description: inst.description,
        observationIds: inst.observations.map((o) => o.fact.id),
        hypotheses,
      });
    }
    return groups;
  }

  private draft(t: HypothesisTemplate, inst: PatternInstance, view: RgView, corrections: readonly FactInfo[]): HypothesisDraft {
    const links: TargetLink[] = inst.observations.map((o) => ({ target: o.fact.id, polarity: "supports", weight: "weak", rationale: `观察：${o.fact.statement}` }));
    links.push(...(t.groupChecks?.(inst.params, inst.observations) ?? []));
    // 观察所在的证据里别的事实（同一句话里说的理由）
    const observed = new Set(inst.observations.map((o) => o.fact.id));
    const seen = new Set<string>();
    for (const o of inst.observations) {
      for (const evidenceId of o.fact.evidenceIds) {
        for (const fact of view.factsOfEvidence(evidenceId)) {
          if (observed.has(fact.id) || seen.has(fact.id) || !view.usableFact(fact)) continue;
          seen.add(fact.id);
          const link = assessFact(t, inst.params, factInfo(fact, view));
          if (link) links.push(link);
        }
      }
    }
    for (const info of corrections) {
      if (observed.has(info.fact.id) || seen.has(info.fact.id)) continue;
      seen.add(info.fact.id);
      const link = assessFact(t, inst.params, info);
      if (link) links.push(link);
    }
    return {
      template: t.id,
      tier: t.tier,
      statement: t.statement(inst.params),
      context: t.context(inst.params),
      ...t.validity(inst.params),
      method: "abduction",
      links,
    };
  }

  /** 往上抽一层（195 号票）：同一主题在两种以上场合、两个以上时期成立 → 上位解释（lift.ts；223 号票起过了门槛的组记进统计） */
  async lift(level: LiftLevel, inputs: LiftInput[], ctx: ReasonerContext): Promise<HypothesisGroupDraft[]> {
    return liftGroups(level, inputs, ctx.view, ctx.stats?.lift);
  }

  async probesFor(group: GroupView, _ctx: ReasonerContext): Promise<ProbeDraft[]> {
    const claimOf = new Map(group.members.map((m) => [m.template, m.claim.id]));
    const params = group.params as unknown as SceneParams;
    return ruleProbeTemplates().filter((pt) => pt.pattern === group.pattern && claimOf.has(pt.pair[0]) && claimOf.has(pt.pair[1])).map((pt) => ({
      template: pt.id,
      discriminates: [claimOf.get(pt.pair[0])!, claimOf.get(pt.pair[1])!],
      ask: pt.ask(params),
      queries: pt.queries(params),
      ifFound: claimOf.get(pt.ifFound)!,
    }));
  }

  async judge(probe: Probe, group: GroupView, hits: JudgeHit[], ctx: ReasonerContext): Promise<ProbeJudgement> {
    const { view } = ctx;
    const params = group.params as unknown as SceneParams;
    const observed = new Set(group.observationIds);
    const links: LinkDraft[] = [];
    const found: string[] = [];
    const effect = new Map<string, number>();
    for (const { evidence, facts } of hits) {
      const usable = view.usableEvidence(evidence.id);
      let a = 0;
      let b = 0;
      for (const fact of facts) {
        if (observed.has(fact.id) || fact.subjectId !== USER_ENTITY_ID) continue;
        const grounded = usable && view.usableFact(fact);
        // 别人转述的按"它声称的"配（当成明说），只为认出它和哪条假设有关、记成背景
        const info = grounded ? factInfo(fact, view) : { ...factInfo(fact, view), stated: true };
        for (const m of group.members) {
          const template = ruleTemplateById(m.template);
          if (!template) continue;
          const link = assessFact(template, params, info);
          if (!link) continue;
          if (!grounded) {
            // 别人转述的：只当背景，不当依据
            links.push({ claimId: m.claim.id, target: link.target, polarity: "context", weight: "weak", rationale: `别人转述（${evidence.sourceLevel}）：${link.rationale}——只当背景，不当依据` });
            continue;
          }
          links.push({ claimId: m.claim.id, ...link });
          const db = (link.polarity === "supports" ? 1 : -1) * WEIGHT_DB[link.weight];
          if (m.claim.id === probe.discriminates[0]) a += db;
          if (m.claim.id === probe.discriminates[1]) b += db;
        }
      }
      if (usable && a !== b) {
        found.push(evidence.id);
        effect.set(probe.discriminates[0]!, (effect.get(probe.discriminates[0]!) ?? 0) + a);
        effect.set(probe.discriminates[1]!, (effect.get(probe.discriminates[1]!) ?? 0) + b);
      }
    }
    let ifFound = probe.ifFound;
    if (ifFound === null && found.length > 0) {
      const [x, y] = probe.discriminates as [string, string];
      ifFound = (effect.get(x) ?? 0) >= (effect.get(y) ?? 0) ? x : y;
    }
    return { outcome: found.length > 0 ? "found" : "not_found", foundEvidenceIds: found, ifFound, links };
  }
}
