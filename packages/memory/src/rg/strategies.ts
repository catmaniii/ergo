// 交互策略（196 号票，05 号调研 §6.2 的 P 层）：把成立的需求、价值断言编译成"什么场合 → 怎么做"的规则（规则版）。
//
// - 触发场合：领域（rg/domains.ts）、场景（往上抽那组的各场景）、活动（那组的活动）；做法来自通用模板，按主题选：
//   回避被别人安排好的时间（autonomy）→ "安排这类日子的活动时：留出空白，不要排满；替用户约人、定时间之前先问他"；
//   需要留出恢复时间（load）→ "安排日程、接新事情时：留出休息和恢复的时间，不要连着排；要加新事情时先问能不能推掉或挪后"；
//   对某样活动有稳定兴趣（interest）→ "有空闲、要推荐活动时：可以优先提议它；只是提议，去不去由用户定"；
//   别的（模型版出的、没有主题的需求、价值）→ "涉及这些领域的事时：考虑到这条；拿不准时先问"。
// - 每条策略挂着依据的断言（basisClaimIds），新编出来是 proposed；只有用户确认（confirm，只认本人有效的证据）才 active，
//   进用户模型快照的 strategies。用户确认的是"怎么为他服务"（权威），不是"他为什么这样"，所以不顺带确认依据的断言（05 号调研 §6.0）。
// - 330 号票（R6，ADR-0032）：长期做法可以建在猜测上——编（提议）要依据还活着（已验证、猜测都行）、把握不是 low、在有效期里；
//   编出来以后依据只要还活着（猜测不论把握高低）就算能用，
//   页面标"建在猜测上"（依据里能用的都是猜测）；照旧要用户点头才生效。复核标记不看（照真值状态）。
// - 跟着依据走（sync）：依据还能用 → 照旧（暂停的恢复：确认过的回到 active，没确认过的回到 proposed）；依据变成猜测、把握掉到 low、
//   标着复核都不暂停。依据都不在了（被推翻撤回、被取代）：用户点过头的（active，老库里的 paused 也算）不自动暂停、不自动撤，照旧在用，
//   由问题箱出一条"这条做法的理由没了，还要不要"（question-sources.ts 的 strategy_basis），用户说不要了才撤、说还要就记成重新确认；
//   还没点头的（proposed）只是个提议，依据没了就收回（retracted）——原始推理图谱 LIFECYCLE §2：决策的前提被撤只触发复审、不自动作废，
//   拍板之前的候选不算决策。确认它的那条证据被忘掉、纠正了 → 回到 proposed、要重新确认。每次改动都写修订日志，起因是依据那条断言
//   最近一次改状态的起因证据。
// - 什么时候同步：用的时候（列策略、编译、确认、给任务出建议之前）；不改引擎的 reflect 和传播钩子（和 192 号票并行，接线只加不改）。
//   快照（getUserModel）只读：按依据在 at 是否成立现算，不写库。
// - 模型版（201 号票）：推理实现有 writeStrategies 时，引擎在 reflect() 末尾把还没有模型写的策略的依据交给它（writeWithModel），
//   写出来的模板记 model_written；以后按模板编译时不覆盖它写的做法，只更新依据。模型给的主题（model:<主题>）同一个主题的
//   需求、价值编进同一条（和规则版的主题一样）。
import { toMs, validAt } from "../domain/time.ts";
import type { Claim, RevisionCause, Strategy, StrategyStatus, StrategyTrigger } from "../domain/types.ts";
import { canSupportUserClaims } from "../evidence/boundary.ts";
import { contextsCompatible, CONTEXT_DIMENSIONS } from "../kg/context.ts";
import type { MemoryStore } from "../store/store.ts";
import type { ClaimIndex } from "./claim-index.ts";
import { DAYTYPE_SHORT } from "./concepts.ts";
import { domainLabels, sortDomains, type Domain } from "./domains.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import type { StrategyEntry } from "./types.ts";
import type { Reasoner, ReasonerContext, StrategyBasisInput, UserModelEntry } from "./types.ts";

/** 和这次明说的要求冲突的说法：配上了就说明用户这次要的和这条做法相反。negatable：前面有"别、不要"的是同意，不算冲突 */
export interface ConflictPattern {
  re: RegExp;
  negatable: boolean;
}

export type StrategyFamily = "autonomy" | "load" | "interest" | "generic";

/** 编译一条策略时看的东西 */
export interface StrategyBasis {
  /** 这个依据对应的策略 key（模板 id | 主题） */
  key?: string;
  family: StrategyFamily;
  /** 主题（往上抽那组的 theme）；generic 是依据断言的 id */
  theme: string;
  claims: Claim[];
  scenes: string[][];
  activities: { id: string; name: string }[];
  domains: Domain[];
}

export interface StrategyTemplate {
  id: string;
  family: StrategyFamily;
  /** 模板自己的领域（和依据断言的领域合起来是触发的领域） */
  domains: readonly Domain[];
  when(b: StrategyBasis): string;
  actions(b: StrategyBasis): string[];
  /** 每条做法的冲突说法（按 actions 的顺序）；按存下来的策略算（给任务出建议时用） */
  conflicts(s: Pick<Strategy, "trigger">): ConflictPattern[][];
}

const NEG_BEFORE = /(?:别|不要|不用|不想|不必|不|勿|没|甭)$/;
const daytypesOf = (scenes: readonly (readonly string[])[]) => [...new Set(scenes.flat().filter((t) => CONTEXT_DIMENSIONS.daytype!.includes(t)))].map((t) => DAYTYPE_SHORT[t] ?? t);
const names = (activities: readonly { name: string }[]) => activities.map((a) => a.name).join("、");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const STRATEGY_TEMPLATES: readonly StrategyTemplate[] = [
  {
    id: "protect_autonomy",
    family: "autonomy",
    domains: ["schedule"],
    when: (b) => {
      const days = daytypesOf(b.scenes);
      return days.length > 0 ? `安排${days.join("、")}的活动时` : "安排活动、替用户约时间时";
    },
    actions: () => ["留出空白，不要排满", "替用户约人、定时间之前先问他"],
    conflicts: () => [
      [{ re: /排满|排得满|塞满|满满当当|都排上|全排上|安排满|排一整天|从早到晚/, negatable: true }],
      [{ re: /(?:直接|帮我|替我|你就)(?:约|定|订|报名|答应)|不用问|不用(?:跟我)?确认/, negatable: false }],
    ],
  },
  {
    id: "leave_recovery",
    family: "load",
    domains: ["schedule", "health"],
    when: () => "安排日程、接新事情时",
    actions: () => ["留出休息和恢复的时间，不要连着排", "要加新事情时先问能不能推掉或挪后"],
    conflicts: () => [
      [{ re: /排满|连着排|连轴|不用休息|从早到晚|排一整天/, negatable: true }],
      [{ re: /(?:直接|帮我|替我)(?:接|答应|加上|报名)/, negatable: false }],
    ],
  },
  {
    id: "offer_interest",
    family: "interest",
    domains: ["schedule"],
    when: (b) => `有空闲、要推荐活动时（${names(b.activities)}）`,
    actions: (b) => [`可以优先提议${names(b.activities)}`, "只是提议，去不去由用户定"],
    conflicts: (s) => {
      const alt = s.trigger.activities.map((a) => escape(a.name)).join("|");
      return [
        alt.length > 0 ? [{ re: new RegExp(`(?:别|不要|不想|不去|不用)[^，。；,;]{0,6}(?:${alt})`), negatable: false }] : [],
        [{ re: /(?:直接|帮我|替我)(?:报名|订|约)/, negatable: false }],
      ];
    },
  },
  {
    id: "consider_motive",
    family: "generic",
    domains: [],
    when: (b) => (b.domains.length > 0 ? `涉及${domainLabels(b.domains)}的事时` : "相关的事情上"),
    actions: (b) => [`考虑到：${b.claims[0]!.statement}`, "拿不准时先问"],
    conflicts: () => [[], []],
  },
];

/** 模型写的策略记的模板（201 号票）：按模板重新编译时不覆盖它的做法 */
export const MODEL_STRATEGY_TEMPLATE = "model_written";

export function strategyTemplate(id: string): StrategyTemplate | undefined {
  return STRATEGY_TEMPLATES.find((t) => t.id === id);
}

/**
 * 能当依据（330 号票 R6）：还活着（已验证 active、猜测 contested 都行，猜测不论把握高低）、在 at 的有效期里。复核标记不看（照真值状态）
 */
export function establishedAt(claim: Claim | undefined, at: string): claim is Claim {
  return claim !== undefined && (claim.status === "active" || claim.status === "contested") && validAt(claim, at);
}

const GONE = new Set(["retracted", "superseded"]);

/** 330 号票（R6）：建在猜测上——依据里在 at 能用的都是猜测（没有已验证的） */
export function onGuessAt(store: MemoryStore, s: Pick<Strategy, "basisClaimIds">, at: string): boolean {
  const usable = s.basisClaimIds.map((id) => store.getClaim(id)).filter((c): c is Claim => establishedAt(c, at));
  return usable.length > 0 && usable.every((c) => c.status === "contested");
}

/** 330 号票（R6）：依据都不在了（每条都撤回、被取代或者没有了） */
export function basisGone(store: MemoryStore, s: Pick<Strategy, "basisClaimIds">): boolean {
  return s.basisClaimIds.every((id) => {
    const c = store.getClaim(id);
    return c === undefined || GONE.has(c.status);
  });
}

/** 依据最晚是什么时候不在了的（最后一条撤回、被取代的修订时间）；还有活着的是 null */
export function basisGoneAt(store: MemoryStore, s: Pick<Strategy, "basisClaimIds">): string | null {
  if (!basisGone(store, s)) return null;
  let latest: string | null = null;
  for (const id of s.basisClaimIds) {
    const r = store
      .revisions(id, "claim")
      .toReversed()
      .find((x) => typeof x.changes.status?.to === "string" && GONE.has(x.changes.status.to));
    if (r && (latest === null || toMs(r.at) > toMs(latest))) latest = r.at;
  }
  return latest;
}

/** 330 号票（R6）：要问用户"这条做法的理由没了，还要不要"——用户点过头、依据都不在了、点头在依据没了之前（之后点的是知道理由没了还要） */
export function basisQuestionDue(store: MemoryStore, s: Strategy): boolean {
  if ((s.status !== "active" && s.status !== "paused") || s.confirmedAt === null) return false;
  const gone = basisGoneAt(store, s);
  return gone !== null && toMs(s.confirmedAt) <= toMs(gone);
}
const LABELS: Record<Claim["epistemic"], UserModelEntry["label"]> = { explicit: "user_stated", inferred: "inferred", user_confirmed: "user_confirmed" };

/** 策略的说法：触发场合：做法一；做法二 */
export function strategyText(s: Pick<Strategy, "when" | "actions">): string {
  return `${s.when}：${s.actions.join("；")}`;
}

/** 一条明说的要求和这条做法冲突吗（配上了冲突说法；可否定的、前面带"别、不要"的是同意） */
export function conflictIn(clause: string, patterns: readonly ConflictPattern[]): boolean {
  for (const p of patterns) {
    const global = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`);
    for (const m of clause.matchAll(global)) {
      if (p.negatable && NEG_BEFORE.test(clause.slice(Math.max(0, m.index - 3), m.index))) continue;
      return true;
    }
  }
  return false;
}

/** 策略和任务对得上：触发的领域和任务的领域有交集，或者任务里提到了它的活动 */
export function strategyApplies(s: Pick<Strategy, "trigger">, domains: readonly string[], task: string): boolean {
  return s.trigger.domains.some((d) => domains.includes(d)) || s.trigger.activities.some((a) => task.includes(a.name));
}

/**
 * 快照用（只读）：在 at 用得上的策略——用户确认过（确认的证据还有效、确认在 at 之前）；给了场景的再看场景。
 * 330 号票（R6）：建在猜测上的照样用（标 onGuess）；依据都不在了也不自动停（标 basisGone，等用户回答"还要不要"）
 */
export function activeStrategyEntries(store: MemoryStore, at: string, context: readonly string[] = []): StrategyEntry[] {
  const out: StrategyEntry[] = [];
  for (const s of store.listStrategies({ status: "active" })) {
    if (s.confirmedBy === null || s.confirmedAt === null || toMs(s.confirmedAt) > toMs(at)) continue;
    const ev = store.getEvidence(s.confirmedBy);
    if (!ev || !canSupportUserClaims(ev)) continue;
    if (context.length > 0 && s.trigger.scenes.length > 0 && !s.trigger.scenes.some((scene) => contextsCompatible(scene, context))) continue;
    out.push(entryOf(s, { onGuess: onGuessAt(store, s, at), basisGone: basisGone(store, s) }));
  }
  return out;
}

export function entryOf(s: Strategy, flags: { onGuess: boolean; basisGone: boolean }): StrategyEntry {
  return {
    strategyId: s.id,
    when: s.when,
    actions: [...s.actions],
    text: strategyText(s),
    basisClaimIds: [...s.basisClaimIds],
    domains: [...s.trigger.domains],
    confirmedBy: s.confirmedBy,
    onGuess: flags.onGuess,
    basisGone: flags.basisGone,
  };
}

export interface CompileReport {
  created: string[];
  updated: string[];
  /** 同步时状态变了的（暂停、恢复、撤回、要重新确认） */
  statusChanged: string[];
  /** 现在还在的策略（不含撤回的） */
  strategies: Strategy[];
}

/** 交互策略的编译、同步、确认（引擎的 compileStrategies、listStrategies、confirmStrategy 转给它） */
export class StrategyBook {
  private readonly rg: ReasoningGraph;
  private readonly index: ClaimIndex;

  constructor(rg: ReasoningGraph, index: ClaimIndex) {
    this.rg = rg;
    this.index = index;
  }

  private get store(): MemoryStore {
    return this.rg.store;
  }

  /** 一条断言最近一次改状态的起因（证据、原因），给策略的修订日志 */
  private lastStatusCause(claimId: string): { evidenceId: string | null; reason: string } {
    const r = this.store
      .revisions(claimId, "claim")
      .toReversed()
      .find((x) => x.changes.status !== undefined);
    return { evidenceId: r?.causeEvidenceId ?? null, reason: r?.reason ?? "" };
  }

  /** 跟着依据走（见文件开头）；返回状态变了的策略 id */
  sync(at: string = this.store.now()): string[] {
    return this.store.transaction(() => {
      const changed: string[] = [];
      for (const s of this.store.listStrategies({ status: ["proposed", "active", "paused"] })) {
        const basis = s.basisClaimIds.map((id) => ({ id, claim: this.store.getClaim(id) }));
        const held = basis.filter((b) => establishedAt(b.claim, at));
        let patch: Partial<Strategy> | null = null;
        let cause: RevisionCause | null = null;
        if (held.length > 0) {
          const confirmation = s.confirmedBy ? this.store.getEvidence(s.confirmedBy) : undefined;
          if (s.confirmedBy && (!confirmation || !canSupportUserClaims(confirmation))) {
            patch = { status: "proposed", confirmedBy: null, confirmedAt: null };
            cause = { evidenceId: s.confirmedBy, reason: `确认它的证据 ${s.confirmedBy} 不能再当依据（${confirmation?.status ?? "没有了"}），要重新确认` };
          } else {
            const desired: StrategyStatus = s.confirmedBy ? "active" : "proposed";
            if (s.status !== desired) {
              const c = this.lastStatusCause(held[0]!.id);
              patch = { status: desired };
              cause = { evidenceId: c.evidenceId, reason: `依据 ${held.map((b) => b.id).join("、")} 恢复成立，${desired === "active" ? "恢复使用" : "回到待确认"}` };
            }
          }
        } else if (basis.every((b) => !b.claim || GONE.has(b.claim.status))) {
          // 330 号票（R6）：依据都不在了。还没点头的提议收回；点过头的不自动暂停、不自动撤，问题箱问"还要不要"（question-sources.ts）
          if (s.status === "proposed") {
            const first = basis.find((b) => b.claim) ?? basis[0]!;
            const c = this.lastStatusCause(first.id);
            patch = { status: "retracted" };
            cause = { evidenceId: c.evidenceId, reason: `还没确认的提议，依据都不在了（${basis.map((b) => `${b.id} ${b.claim?.status ?? "没有了"}`).join("、")}${c.reason ? `；${c.reason}` : ""}），收回` };
          }
        }
        // 330 号票（R6）：依据变成猜测、把握掉到 low、在有效期外、标着复核，都不再暂停（没点头的照旧要用户点头才生效）
        if (patch && cause) {
          this.store.updateStrategy(s.id, patch, cause);
          changed.push(s.id);
        }
      }
      return changed;
    });
  }

  /** 成立的需求、价值断言按主题归拢成策略的依据 */
  private bases(at: string): StrategyBasis[] {
    const byKey = new Map<string, StrategyBasis & { template: StrategyTemplate }>();
    // 330 号票（R6）：猜测也能编；提议只从把握不是 low 的编（低把握的猜测不拿来烦用户点头，编出来以后掉到 low 也不停）
    for (const claim of this.store.listClaims({ status: ["active", "contested"] })) {
      if ((claim.tier !== "need" && claim.tier !== "value") || claim.confidence === "low" || !establishedAt(claim, at)) continue;
      const member = this.rg.registry.memberOf(claim.id);
      const group = member ? this.rg.registry.getGroup(member.groupKey) : undefined;
      const params = (group?.pattern.startsWith("lift:") ? group.params : {}) as { theme?: string; scenes?: string[][]; activities?: { id: string; name: string }[] };
      const theme = params.theme;
      const family: StrategyFamily = theme === "autonomy" ? "autonomy" : theme === "load" ? "load" : theme?.startsWith("interest:") ? "interest" : "generic";
      const template = STRATEGY_TEMPLATES.find((t) => t.family === family)!;
      // 没有主题的按断言各自一条；模型版往上抽给了主题的（model:<主题>），同一个主题的需求、价值编进同一条（201 号票）
      const groupTheme = family === "generic" ? (theme?.startsWith("model:") ? theme : claim.id) : theme!;
      const key = `${template.id}|${groupTheme}`;
      const b = byKey.get(key) ?? { key, family, theme: groupTheme, claims: [], scenes: [], activities: [], domains: [], template };
      b.claims.push(claim);
      for (const scene of params.scenes ?? []) if (!b.scenes.some((x) => x.join("+") === scene.join("+"))) b.scenes.push([...scene]);
      for (const a of params.activities ?? []) if (!b.activities.some((x) => x.id === a.id)) b.activities.push(a);
      b.domains = sortDomains([...b.domains, ...this.index.domainsOf(claim.id)]);
      byKey.set(key, b);
    }
    return [...byKey.values()];
  }

  /** 编译：先同步，再把成立的需求、价值编成策略（新的 proposed；已有的更新触发场合和依据，做法变了的要重新确认） */
  compile(at: string = this.store.now()): CompileReport {
    this.index.sync();
    return this.store.transaction(() => {
      const report: CompileReport = { created: [], updated: [], statusChanged: this.sync(at), strategies: [] };
      for (const b of this.bases(at)) {
        const template = STRATEGY_TEMPLATES.find((t) => t.family === b.family)!;
        const key = `${template.id}|${b.theme}`;
        const trigger: StrategyTrigger = { domains: sortDomains([...template.domains, ...b.domains]), scenes: b.scenes, activities: b.activities };
        const when = template.when(b);
        const actions = template.actions(b);
        const statement = b.claims.map((c) => `${c.id}「${c.statement}」`).join("、");
        const existing = this.store.listStrategies({ key, status: ["proposed", "active", "paused"] })[0];
        if (!existing) {
          const created = this.store.insertStrategy(
            { key, template: template.id, trigger, when, actions, basisClaimIds: b.claims.map((c) => c.id), status: "proposed", confirmedBy: null, confirmedAt: null },
            { evidenceId: this.lastStatusCause(b.claims[0]!.id).evidenceId, reason: `由成立的${b.claims.map((c) => c.tier).join("、")}编译：${statement}` },
          );
          report.created.push(created.id);
          continue;
        }
        const basisClaimIds = [...new Set([...existing.basisClaimIds.filter((id) => !GONE.has(this.store.getClaim(id)?.status ?? "retracted")), ...b.claims.map((c) => c.id)])];
        // 模型写的（201 号票）：不拿模板覆盖它的做法和触发场合，只更新依据
        if (existing.template === MODEL_STRATEGY_TEMPLATE) {
          if (JSON.stringify(existing.basisClaimIds) !== JSON.stringify(basisClaimIds)) {
            this.store.updateStrategy(existing.id, { basisClaimIds }, { evidenceId: this.lastStatusCause(b.claims[0]!.id).evidenceId, reason: `重新编译（模型写的做法不动）：${statement}` });
            report.updated.push(existing.id);
          }
          continue;
        }
        const patch: Partial<Strategy> = { trigger, when, actions, basisClaimIds };
        const contentChanged = existing.when !== when || JSON.stringify(existing.actions) !== JSON.stringify(actions);
        if (contentChanged && existing.confirmedBy !== null) Object.assign(patch, { status: existing.status === "paused" ? "paused" : "proposed", confirmedBy: null, confirmedAt: null });
        const before = JSON.stringify(existing);
        const after = this.store.updateStrategy(existing.id, patch, {
          evidenceId: this.lastStatusCause(b.claims[0]!.id).evidenceId,
          reason: contentChanged ? `重新编译，做法变了${existing.confirmedBy ? "，要重新确认" : ""}：${statement}` : `重新编译：${statement}`,
        });
        if (JSON.stringify(after) !== before) report.updated.push(existing.id);
      }
      report.strategies = this.store.listStrategies({ status: ["proposed", "active", "paused"] });
      return report;
    });
  }

  /** 还没有模型写的策略的依据（交给推理实现写；--dry-run 也用） */
  basisInputs(at: string = this.store.now()): StrategyBasisInput[] {
    this.index.sync();
    return this.bases(at)
      .filter((b) => this.store.listStrategies({ key: b.key!, status: ["proposed", "active", "paused"] })[0]?.template !== MODEL_STRATEGY_TEMPLATE)
      .map((b) => ({
        key: b.key!,
        claims: b.claims.map((c) => ({ claimId: c.id, tier: c.tier, statement: c.statement, label: LABELS[c.epistemic], confidence: c.confidence })),
        scenes: b.scenes,
        activities: b.activities.map((a) => a.name),
        domains: b.domains,
      }));
  }

  /**
   * 模型版编策略（201 号票）：先同步，把还没有模型写的策略的依据交给推理实现写，写出来的落库——新的 proposed；
   * 已有的（模板编的）换成模型写的做法，确认过的要重新确认。返回新建、改动的，和预算不够没写成的（leftover）
   */
  async writeWithModel(writer: Pick<Reasoner, "id"> & Required<Pick<Reasoner, "writeStrategies">>, ctx: Pick<ReasonerContext, "budget" | "dropped" | "stats">, at: string = this.store.now()): Promise<{ created: string[]; updated: string[]; leftover: boolean }> {
    this.sync(at);
    const inputs = this.basisInputs(at);
    if (inputs.length === 0) return { created: [], updated: [], leftover: false };
    const before = ctx.budget.used;
    const written = await writer.writeStrategies(inputs, ctx);
    const leftover = ctx.budget.used === before;
    const bases = new Map(this.bases(at).map((b) => [b.key!, b]));
    return this.store.transaction(() => {
      const created: string[] = [];
      const updated: string[] = [];
      for (const w of written) {
        const b = bases.get(w.key);
        if (!b) continue;
        const trigger: StrategyTrigger = { domains: sortDomains([...w.domains, ...b.domains]), scenes: b.scenes, activities: b.activities };
        const basisClaimIds = b.claims.map((c) => c.id);
        const statement = b.claims.map((c) => `${c.id}「${c.statement}」`).join("、");
        const cause = { evidenceId: this.lastStatusCause(b.claims[0]!.id).evidenceId, reason: `模型（${writer.id}）由成立的${b.claims.map((c) => c.tier).join("、")}写的：${statement}` };
        const existing = this.store.listStrategies({ key: w.key, status: ["proposed", "active", "paused"] })[0];
        if (!existing) {
          created.push(this.store.insertStrategy({ key: w.key, template: MODEL_STRATEGY_TEMPLATE, trigger, when: w.when, actions: w.actions, basisClaimIds, status: "proposed", confirmedBy: null, confirmedAt: null }, cause).id);
          continue;
        }
        const patch: Partial<Strategy> = { template: MODEL_STRATEGY_TEMPLATE, trigger, when: w.when, actions: w.actions, basisClaimIds: [...new Set([...existing.basisClaimIds, ...basisClaimIds])] };
        if (existing.confirmedBy !== null) Object.assign(patch, { status: existing.status === "paused" ? "paused" : "proposed", confirmedBy: null, confirmedAt: null });
        this.store.updateStrategy(existing.id, patch, { ...cause, reason: `${cause.reason}（换掉模板编的做法${existing.confirmedBy ? "，要重新确认" : ""}）` });
        updated.push(existing.id);
      }
      return { created, updated, leftover };
    });
  }

  /** 用户确认一条策略（by 是本人有效的证据，比如他回答"以后就这样"）：proposed → active */
  confirm(strategyId: string, byEvidenceId: string): Strategy {
    return this.store.transaction(() => {
      this.sync();
      const s = this.store.getStrategy(strategyId);
      if (!s) throw new Error(`没有这条策略：${strategyId}`);
      const evidence = this.store.getEvidence(byEvidenceId);
      if (!evidence) throw new Error(`没有这条证据：${byEvidenceId}`);
      if (!canSupportUserClaims(evidence)) throw new Error(`只有本人有效的证据能确认策略（${byEvidenceId} 的来源是 ${evidence.sourceLevel}、状态是 ${evidence.status}）`);
      if (s.status === "active") return s;
      if (s.status !== "proposed") throw new Error(`策略 ${strategyId} 现在是 ${s.status}：依据都不在了，不能确认`);
      return this.store.updateStrategy(strategyId, { status: "active", confirmedBy: byEvidenceId, confirmedAt: this.store.now() }, { evidenceId: byEvidenceId, reason: `用户确认：${evidence.text}` });
    });
  }

  /**
   * 330 号票（R6）：用户回答了"这条做法的理由没了，还要不要"（by 是他那句话，本人有效的证据）。还要 → 记成重新确认（确认的证据换成这句，
   * 以后不再问）；不要了 → 撤回（墓碑是这句话）
   */
  answerBasisGone(strategyId: string, keep: boolean, byEvidenceId: string): Strategy {
    return this.store.transaction(() => {
      const s = this.store.getStrategy(strategyId);
      if (!s) throw new Error(`没有这条策略：${strategyId}`);
      const evidence = this.store.getEvidence(byEvidenceId);
      if (!evidence || !canSupportUserClaims(evidence)) throw new Error(`只有本人有效的证据能回答（${byEvidenceId}）`);
      if (s.status === "retracted") return s;
      if (!keep) return this.store.updateStrategy(strategyId, { status: "retracted" }, { evidenceId: byEvidenceId, reason: `理由没了，用户说不要了：${evidence.text}` });
      return this.store.updateStrategy(
        strategyId,
        { status: "active", confirmedBy: byEvidenceId, confirmedAt: this.store.now() },
        { evidenceId: byEvidenceId, reason: `理由没了，用户说还要：${evidence.text}（记成重新确认）` },
      );
    });
  }

  /** 列策略（先同步）；默认不含撤回的 */
  list(filter: { status?: StrategyStatus | readonly StrategyStatus[] } = {}): Strategy[] {
    this.sync();
    return this.store.listStrategies({ status: filter.status ?? ["proposed", "active", "paused"] });
  }
}
