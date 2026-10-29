// 个人档案和事实图谱怎么对上（283 号票，联动的规矩：档案是推理图谱的背景，不是推断，不走推理图谱的检查）：
// - 对齐：档案里的人和事实图谱的人物实体按称呼、别名对（同名同别名就是同一个人，按实体的名字和别名找）；本人那份对的是用户自己
//   （en-user）。只读，不往事实图谱里写别名、不合并实体——档案的名字不是证据；
// - 新值作废旧事实：档案的一个字段换了新值（比如住址），事实图谱里说的是旧值的那几条状态类事实标到期（validTo 写成换的那一刻，
//   状态不变：到期了的不再"现在成立"，以前问得出），依赖它们的结论加复核标记（以它为前提的推断、强的支持和反证、
//   它的明说断言；329 号票起复核标记不改真值状态，事实在它那段时间里还是对的，往下的不动）。经唯一写入口，记成"用户发起 · 经个人档案"
//   （档案里的新值都是用户确认过的）。
//   怎么算"说的是旧值"：事实的宾语（值、或者实体的名字）就是旧值（或者互相包含、都不短于 4 个字），或者旧值够长（6 个字以上，
//   住址这类）原样出现在精炼陈述里。事情类的（某天去了哪）不动；换值那一刻以后才知道的、从那以后才开始的也不动。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import { toMs } from "../domain/time.ts";
import { EPISODIC_PREDICATES, type Entity, type Fact, type RevisionCause } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import type { MemoryStore } from "../store/store.ts";

/** 档案里的一个人：本人，或者一组叫法（称呼和别名） */
export interface ProfilePerson {
  self?: boolean;
  names: readonly string[];
}

/** 档案里的人对到的人物实体（同名同别名就是同一个；本人是用户自己） */
export function entitiesForPerson(store: MemoryStore, person: ProfilePerson): Entity[] {
  if (person.self) {
    const user = store.getEntity(USER_ENTITY_ID);
    return user ? [user] : [];
  }
  const found = new Map<string, Entity>();
  for (const name of person.names) {
    const trimmed = name.trim();
    if (trimmed === "") continue;
    const entity = store.findEntityByName(trimmed);
    if (entity && entity.type === "person" && entity.id !== USER_ENTITY_ID) found.set(entity.id, entity);
  }
  return [...found.values()];
}

/** 比较时去掉空白和常见标点 */
const norm = (text: string) => text.replace(/[\s，。,.、·:：;；\-－—()（）"“”'‘’]/gu, "").toLowerCase();

/** 宾语、陈述是不是说的这个值 */
function mentionsValue(store: MemoryStore, fact: Fact, target: string): boolean {
  const object = fact.object.type === "value" ? fact.object.value : (store.getEntity(fact.object.id)?.name ?? "");
  const o = norm(object);
  if (o !== "" && (o === target || (Math.min(o.length, target.length) >= 4 && (o.includes(target) || target.includes(o))))) return true;
  return target.length >= 6 && norm(fact.statement).includes(target);
}

/**
 * 事实图谱里说的是这个值、到 at 还成立的状态类事实（这几个实体的；at 以后才知道的、从那以后才开始的不算）
 */
export function factsMatchingValue(store: MemoryStore, entityIds: readonly string[], value: string, at: string): Fact[] {
  const target = norm(value);
  if (target.length < 2) return [];
  const atMs = toMs(at);
  const seen = new Map<string, Fact>();
  for (const id of entityIds) for (const fact of store.factsTouching(id, ["active", "contested"])) seen.set(fact.id, fact);
  return [...seen.values()].filter(
    (f) =>
      !EPISODIC_PREDICATES.has(f.predicate) &&
      (f.validTo === null || toMs(f.validTo) > atMs) &&
      (f.validFrom === null || toMs(f.validFrom) <= atMs) &&
      toMs(f.observedAt) <= atMs &&
      mentionsValue(store, f, target),
  );
}

export interface ProfileExpiry {
  /** 标到期的事实 */
  expired: string[];
  /** 因此加了复核标记的结论（329 号票起"待复核"是标记，不改真值状态） */
  reviewed: string[];
}

/**
 * 一条事实的依赖加复核标记：以它为前提的推断的结论、强的支持和反证的那条、它的明说断言。
 * 329 号票："待复核"不占真值状态——事实只是到期（在它那段时间里还是对的），结论的已验证 / 猜测不动，只等下一次整理重判
 */
function reviewFactDependents(engine: MemoryEngine, factId: string, cause: RevisionCause, reviewed: Set<string>): void {
  const store = engine.store;
  const review = (claimId: string) => {
    const claim = store.getClaim(claimId);
    if (!claim || claim.needsReview || claim.status === "retracted" || claim.status === "superseded") return;
    engine.rg.keeper.flag(claimId, cause);
    reviewed.add(claimId);
  };
  for (const inference of store.inferencesByPremise(factId)) if (inference.status === "active") review(inference.conclusionClaimId);
  for (const link of store.linksTo(factId)) if (link.polarity !== "context" && link.weight !== "weak") review(link.claimId);
  const explicit = engine.rg.registry.explicitClaimOf(factId);
  if (explicit !== undefined) review(explicit);
}

/**
 * 档案的一个字段换了新值：事实图谱里说的是旧值的事实到期（到 at 为止），依赖它们的结论加复核标记。经唯一写入口（用户发起 · 经个人档案），
 * 一次写；没有要动的事实时什么都不写
 */
export function expireProfileFacts(engine: MemoryEngine, change: { person: ProfilePerson; label: string; oldValue: string; at: string }, options: { via?: string } = {}): ProfileExpiry {
  const entityIds = entitiesForPerson(engine.store, change.person).map((e) => e.id);
  const facts = factsMatchingValue(engine.store, entityIds, change.oldValue, change.at);
  if (facts.length === 0) return { expired: [], reviewed: [] };
  const reason = `个人档案的「${change.label}」换了新值，旧值到 ${change.at} 为止`;
  const cause: RevisionCause = { evidenceId: null, reason };
  const reviewed = new Set<string>();
  engine.gate.write({ op: "correct", actor: "user", via: options.via ?? "个人档案", reason }, () => {
    for (const fact of facts) {
      const patch: Partial<Fact> = { validTo: change.at };
      if (fact.extractedBy.startsWith("rule:")) patch.statement = engine.kg.statementOf({ ...fact, validTo: change.at });
      engine.gate.updateFact(fact.id, patch, cause);
      reviewFactDependents(engine, fact.id, cause, reviewed);
    }
  });
  return { expired: facts.map((f) => f.id), reviewed: [...reviewed] };
}
