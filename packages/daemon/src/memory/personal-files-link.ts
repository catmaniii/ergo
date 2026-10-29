// 记忆插件这一侧的个人档案联动（283 号票，联动的六条规矩）。档案在内核（personal-files/），记忆插件只经 KERNEL.personalFiles 取：
// - "二狗了解到的"（learnedAbout，记忆插件的服务 MEMORY 露出去，档案页经内核现取）：档案里的人按称呼、别名对到事实图谱的人物实体
//   （@ergo/memory 的 entitiesForPerson，只读、不写别名），列和他有关的结论（支持、反驳、以那几条事实为前提的，陈述里提到他的）、
//   现在还成立的事实、那几条事实背后的原话；本人那份列对用户的理解里成立的结论和最近的事实。读不了的写原因，不报错；
// - 新值作废旧事实（createProfileFactExpiry）：档案的字段换了新值，事实图谱里说的是旧值的事实到期、依赖它的结论转待复核
//   （@ergo/memory 的 expireProfileFacts，经唯一写入口，用户发起 · 经个人档案）。换的时候马上做（随用随开的可写引擎）；
//   每晚整理时再对一遍（插件停用期间换的、当晚才抽出来的旧值事实）；
// - 每晚认人物信息（linkNightly 的后半）：这一夜新来的本人的话里认出关于某个人的固定信息（@ergo/memory 的 kg/person-info.ts，
//   模型版和整理同一个模型、同一份预算里剩下的，最多 PEOPLE_MAX_CALLS 次；配置 memory.extractor 写 rule 时用规则版），
//   交给档案攒成候选，再合成第二天的候选核对卡（一天一张）。推断出来的只当候选，用户勾了才写；
// - 整理的情境和号码（guardNightlyChat）：推理那几步的提示末尾加档案摘要（只当情境），每个请求里号码类、住址的值换成占位。
import {
  capBudget,
  type ChatModel,
  createBudget,
  entitiesForPerson,
  expireProfileFacts,
  type Fact,
  type KnownPerson,
  LlmPersonInfoExtractor,
  localDate,
  markPersonInfoScanned,
  type MemoryEngine,
  personInfoPending,
  RulePersonInfoExtractor,
  addDays,
  toMs,
  withBackground,
  withRedaction,
} from "@ergo/memory";
import { type PersonalFileKind, type PersonalFileLearnedView, type PersonalLearnedClaim, t } from "@ergo/protocol";
import type { MemoryConfig } from "../config/config.ts";
import type { CandidateInput, FieldReplaced, PersonalFilesForMemory } from "../personal-files/index.ts";
import { materialIdsOfRef } from "./data-source-evidence.ts";
import type { MemoryEngineUse } from "./engine-provider.ts";

/** 每晚认人物信息最多问几次模型（一次一批 20 条话） */
export const PEOPLE_MAX_CALLS = 5;
/** 第一次跑时只看最近几天的话（不把几个月前的全翻一遍；之后每条只看一次） */
const PEOPLE_LOOKBACK_DAYS = 2;
/** "二狗了解到的"各列几条 */
const LEARNED_LIMITS = { claims: 8, facts: 8, quotes: 5 } as const;
/** 还活着的结论（成立、还拿不准） */
const LIVE_CLAIMS = new Set(["active", "contested"]);
/** 结论的先后：价值观、需求、偏好、近期状态 */
const TIER_ORDER = ["value", "need", "preference", "state"];

const empty = (reason: string): PersonalFileLearnedView => ({ ready: false, reason, entities: [], claims: [], facts: [], quotes: [] });

/** "二狗了解到的"：档案里的人对到的实体、和他有关的结论、事实、原话（只读） */
export function learnedAbout(engine: MemoryEngine | undefined, subject: { kind: PersonalFileKind; names: readonly string[] }): PersonalFileLearnedView {
  if (!engine) return empty(t("memory.learned.notReady"));
  try {
    const store = engine.store;
    const now = toMs(store.now());
    const entities = entitiesForPerson(store, { self: subject.kind === "self", names: subject.names });
    const current = (f: Fact) => f.validTo === null || toMs(f.validTo) > now;
    let facts: Fact[];
    if (subject.kind === "self") {
      facts = store.listFacts({ status: ["active", "contested"], subjectId: entities[0]?.id ?? "en-user" }).filter(current);
    } else {
      const seen = new Map<string, Fact>();
      for (const entity of entities) for (const f of store.factsTouching(entity.id, ["active", "contested"])) if (current(f)) seen.set(f.id, f);
      facts = [...seen.values()];
    }
    facts.sort((a, b) => toMs(b.observedAt) - toMs(a.observedAt));
    // 结论：本人的是成立的那些（价值观、需求、偏好在前）；别人的是和那几条事实连着的、陈述里提到他的
    const claimIds = new Set<string>();
    if (subject.kind === "self") {
      for (const claim of store.listClaims({ status: "active" })) claimIds.add(claim.id);
    } else {
      for (const f of facts) {
        for (const link of store.linksTo(f.id)) if (link.polarity !== "context") claimIds.add(link.claimId);
        for (const inference of store.inferencesByPremise(f.id)) claimIds.add(inference.conclusionClaimId);
        const explicit = engine.rg.registry.explicitClaimOf(f.id);
        if (explicit !== undefined) claimIds.add(explicit);
      }
      const names = [...new Set([...subject.names, ...entities.flatMap((e) => [e.name, ...e.aliases])])].filter((n) => [...n].length >= 2);
      if (names.length > 0) for (const claim of store.listClaims({ status: ["active", "contested"] })) if (names.some((n) => claim.statement.includes(n))) claimIds.add(claim.id);
    }
    const claims: PersonalLearnedClaim[] = [...claimIds]
      .map((id) => store.getClaim(id))
      .filter((c) => c !== undefined && LIVE_CLAIMS.has(c.status))
      .map((c) => c!)
      .toSorted((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.inferredAt.localeCompare(a.inferredAt))
      .slice(0, LEARNED_LIMITS.claims)
      .map((c) => ({ id: c.id, statement: c.statement, tier: c.tier, status: c.status, confidence: c.confidence, epistemic: c.epistemic }));
    const shownFacts = facts.slice(0, LEARNED_LIMITS.facts);
    const quotes = new Map<string, { id: string; text: string; at: string }>();
    for (const f of shownFacts) {
      for (const id of f.evidenceIds) {
        const evidence = store.getEvidence(id);
        if (!evidence || evidence.status !== "active" || evidence.sourceLevel !== "self" || evidence.text.trim() === "" || quotes.has(id)) continue;
        quotes.set(id, { id, text: evidence.text, at: evidence.eventTime ?? evidence.observedAt });
      }
    }
    return {
      ready: true,
      entities: entities.map((e) => e.name),
      claims,
      facts: shownFacts.map((f) => ({ id: f.id, statement: f.statement, observedAt: f.observedAt })),
      quotes: [...quotes.values()].toSorted((a, b) => toMs(b.at) - toMs(a.at)).slice(0, LEARNED_LIMITS.quotes),
    };
  } catch (err) {
    return empty(t("memory.learned.failed", { reason: err instanceof Error ? err.message : String(err) }));
  }
}

/** 一条字段换了新值 → 让旧值的事实到期（经唯一写入口） */
function expireOne(engine: MemoryEngine, change: FieldReplaced): { expired: number; reviewed: number } {
  const result = expireProfileFacts(engine, { person: { self: change.kind === "self", names: change.names }, label: change.label, oldValue: change.oldValue, at: change.at });
  return { expired: result.expired.length, reviewed: result.reviewed.length };
}

/** 档案的字段换了新值时马上做（随用随开的可写引擎；库用不了、出错只记日志） */
export function createProfileFactExpiry(options: { withEngine: MemoryEngineUse; log: (line: string) => void }): (change: FieldReplaced) => void {
  return (change) => {
    try {
      const result = options.withEngine((engine) => expireOne(engine, change));
      if (result && result.expired > 0) options.log(`个人档案的「${change.label}」换了新值：事实图谱里 ${result.expired} 条旧事实到期，${result.reviewed} 条结论转待复核`);
    } catch (err) {
      options.log(`个人档案的「${change.label}」换了新值，让旧事实到期没成（下一夜整理时再对一遍）：${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** 每晚整理的模型包两层：推理那几步加档案摘要当情境，每个请求里号码类、住址的值换成占位 */
export function guardNightlyChat(chat: ChatModel, files: PersonalFilesForMemory | undefined): ChatModel {
  if (files === undefined) return chat;
  return withBackground(
    withRedaction(chat, () => files.withheld().map((w) => ({ value: w.value, placeholder: w.placeholder, digits: w.digits }))),
    () => files.background(),
  );
}

/** 这一夜的联动做了什么（进整理记录） */
export interface NightlyPeopleRecord {
  /** 认人物信息问了几次模型 */
  calls: number;
  /** 看了几条话 */
  scanned: number;
  /** 认出几个人 */
  mentions: number;
  /** 新攒了几条候选 */
  candidates: number;
  /** 合成（或者往里加了）的候选核对卡 */
  cardId?: string;
  /** 旧值到期的事实几条 */
  expiredFacts: number;
}

/** 认出来的人 → 交给档案的候选（素材编号、哪几天说的） */
function inputsOf(engine: MemoryEngine, mentions: Awaited<ReturnType<LlmPersonInfoExtractor["extract"]>>["mentions"]): CandidateInput[] {
  return mentions.map((m) => {
    const evidence = m.evidenceIds.map((id) => engine.store.getEvidence(id)).filter((e) => e !== undefined);
    return {
      name: m.name,
      aliases: m.aliases,
      ...(m.relation === undefined ? {} : { relation: m.relation }),
      materialIds: evidence.flatMap((e) => materialIdsOfRef(e.sourceRef)),
      heard: [...new Set(evidence.map((e) => localDate(e.eventTime ?? e.observedAt)))],
      fields: m.fields.map((f) => ({ field: f.field, value: f.value })),
    };
  });
}

/**
 * 每晚整理跑完以后的联动：先把档案里换过的值对一遍（旧值的事实到期），再从这一夜新来的话里认人物信息、攒成候选、合成候选核对卡。
 * remaining 是这一夜预算剩下几次（认人物信息最多用 PEOPLE_MAX_CALLS 次）
 */
export async function linkNightly(engine: MemoryEngine, options: { files: PersonalFilesForMemory; chat: ChatModel; config: MemoryConfig; remaining: number; night: string; at: string; log: (line: string) => void }): Promise<NightlyPeopleRecord> {
  const { files, log } = options;
  let expiredFacts = 0;
  for (const change of files.replacedValues()) {
    try {
      expiredFacts += expireOne(engine, change).expired;
    } catch (err) {
      log(`每晚整理：让档案里换过的「${change.label}」的旧事实到期没成：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const known: KnownPerson[] = files.people().map((p) => ({ name: p.name ?? (p.kind === "self" ? "我" : p.id), aliases: p.aliases, ...(p.relation === undefined ? {} : { relation: p.relation }), ...(p.kind === "self" ? { self: true } : {}) })); // @i18n-ignore model：给模型看的"我"
  const pending = personInfoPending(engine.store, { since: addDays(options.at, -PEOPLE_LOOKBACK_DAYS) });
  const extractor = options.config.extractor === "rule" ? new RulePersonInfoExtractor() : new LlmPersonInfoExtractor(options.chat);
  const budget = capBudget(createBudget(Math.max(0, options.remaining)), PEOPLE_MAX_CALLS);
  const result = await extractor.extract(pending, known, { budget });
  markPersonInfoScanned(engine.store, result.scanned, extractor.id, options.at);
  const candidates = result.mentions.length === 0 ? 0 : files.addCandidates("nightly", inputsOf(engine, result.mentions));
  const cardId = files.composeCandidates({ date: options.night });
  if (result.dropped.length > 0) log(`每晚整理认人物信息：丢掉 ${result.dropped.length} 处（${result.dropped.slice(0, 3).map((d) => d.reason).join("；")}）`);
  return { calls: result.calls, scanned: result.scanned.length, mentions: result.mentions.length, candidates, ...(cardId === undefined ? {} : { cardId }), expiredFacts };
}
