// 矛盾追根溯源（199 号票）：知识图谱里出现矛盾时，推理图谱建一组"矛盾的根源"竞争假设，按证据定输赢（rg/joint.ts 建组，这里认矛盾、配证据）。
//
// 什么算矛盾（detectConflicts）：
// - 真冲突（contested）：事实这一层同一天、同一场景互相排斥的几条（188 的变化判定），按说法分两边；
// - 说的和做的不一样（say_do）：用户说要 X（喜欢、打算、在做），之后的行为至少两次是非 X（没做、推掉）；或者说不要 X，行为一再去做（05 号调研 L1'）；
// - 观点来回变（flip_flop）：同一样东西喜欢 → 不喜欢 → 又喜欢（188 按日子先后各判一次"观点变化"，合起来是来回变），场景标签又对得上。
// 认过的矛盾记在 joint_conflicts，下次整理照旧有这组假设（写回改了事实以后也不散）。
//
// 五种根源（assessRoots 给每种配支持、反证，都指向证据，写回改事实不影响打分；两边的事实对每种都是弱支持，是观察）：
// 1. 有一条记错了（抽取错、听错）：场景对得上的别的本人证据都和另一边一致（第一条强、再有的弱）；这边原话里有"差点、好像、可能"（弱）。
//    两边各有两条以上证据是强反证；原话说得清楚、没有含糊的说法是弱反证。说的和做的不一样不看"多数"（说的和做的不是一类证据）；
// 2. 时间变了（其实是观点变化）：两边隔了 30 天以上（弱）；后来那边的原话有"开始、现在、不再"（强）。后来又变回去是强反证，同一天是弱反证；
//    说的和做的不一样时：后来说不想要了是强支持，后来又说要是强反证；
// 3. 场景不同（场景标签不全）：从图上的人和人的关系补出场景（家人 → 家里，同事、客户 → 工作）以后两边对不上（强）、部分对不上或者涉及的人不同（弱）；
//    补完还对得上、涉及的人也一样是弱反证；
// 4. 说的和做的不一样（愿望和现实约束：忙、钱、别人、天气）：做的那几次前后两周里有约束的证据（强，最多两条）；说的时候带着"等……了"（强）；
//    后来又说一遍（弱）。两边都是说的话是弱反证，后来说不想要了是强反证；
// 5. 更深的需求同时解释两边：拿成立的需求、价值断言去对（推出它的证据和这两边有交集，适用领域也对得上另一边）是强支持，只对上一边是弱支持；
//    没有成立的需求、价值不算反证（搜不到不判负）。
// 每种都有能区分的追问（查原话、查时间、查场景和图上的属性、查约束证据、查需求和价值断言），见 rg/joint.ts。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import { addDays, localDate, toMs } from "../domain/time.ts";
import type { Claim, Fact, LinkWeight } from "../domain/types.ts";
import { contextsCompatible } from "../kg/context.ts";
import { RELATION_PREDICATES, RELATION_SCENES, type RelationPredicate } from "../kg/relations.ts";
import { changeSignals } from "../kg/signals.ts";
import { HELD_STATUSES, type MemoryStore } from "../store/store.ts";
import { domainsOfTags, domainsOfText } from "./domains.ts";
import type { RgView, TargetLink } from "./types.ts";

export const ROOT_KINDS = ["misrecorded", "changed_over_time", "scene_differs", "say_do_gap", "deeper_need"] as const;
export type RootKind = (typeof ROOT_KINDS)[number];

export const ROOT_LABELS: Readonly<Record<RootKind, string>> = {
  misrecorded: "有一条记错了",
  changed_over_time: "时间变了",
  scene_differs: "场景不同",
  say_do_gap: "说的和做的不一样",
  deeper_need: "更深的需求",
};

export const CONFLICT_TRIGGERS = ["contested", "say_do", "flip_flop"] as const;
export type ConflictTrigger = (typeof CONFLICT_TRIGGERS)[number];

/** 认出的一个矛盾：两边的事实 */
export interface ConflictRecord {
  key: string;
  trigger: ConflictTrigger;
  objectId: string;
  objectName: string;
  /** 真冲突、来回变：A 是最早那条的说法、B 是另一种；说的和做的不一样：A 是说的、B 是做的 */
  sideA: string[];
  sideB: string[];
}

/** "差点、好像"这类含糊的说法 */
export const HEDGES: readonly string[] = ["差点", "好像", "可能", "应该是", "记不清", "大概", "似乎", "也许", "听说"];
/** 现实约束：忙、钱、别人、天气、身体 */
export const CONSTRAINTS = /加班|忙|没时间|没空|出差|下雨|下了[^，。]{0,4}雨|雨天|太贵|没钱|预算|生病|受伤|不舒服|家里有事|走不开|累|起不来|睁不开眼/;
/** 一段话里有现实约束（"不用出差""没下雨"前面带否定的不算） */
export function hasConstraint(text: string): boolean {
  const re = new RegExp(CONSTRAINTS.source, "g");
  for (const m of text.matchAll(re)) if (!/(?:不用|不|没有|没|无)$/.test(text.slice(Math.max(0, m.index - 2), m.index))) return true;
  return false;
}

/** 说的时候带着条件："等这个版本发了" */
const CONDITIONAL = /等[^，。]{1,12}?(?:了|完|以后|之后)/;
/** 说的想要的和做的对得上的几组（"找工作"和工作机会） */
export const CONCEPT_LINKS: Readonly<Record<string, readonly string[]>> = { 找工作: ["工作机会", "面试", "offer", "岗位", "二面", "终面"] };

const SELF = new Set(["user_stated", "observed"]);
const timeOf = (f: Fact) => f.eventTime ?? f.validFrom ?? f.observedAt;
const ms = (f: Fact) => toMs(timeOf(f));
const held = (f: Fact) => (HELD_STATUSES as readonly string[]).includes(f.status);
const stance = (x: Fact) => `${x.predicate}|${x.negated}`;
const stated = (fs: readonly Fact[]) => fs.length > 0 && fs.every((f) => f.assertion === "user_stated");
const objKey = (f: Fact) => (f.object.type === "entity" ? f.object.id : `value:${f.object.value}`);

/** 喜欢还是不喜欢（喜欢 X、不反感 X 是喜欢；不喜欢 X、不想要 X 是不喜欢） */
export function polarityOf(f: Fact): "like" | "dislike" | undefined {
  if (f.predicate === "prefers") return f.negated ? "dislike" : "like";
  if (f.predicate === "dislikes") return f.negated ? "like" : "dislike";
  return undefined;
}

/** 说要还是说不要：喜欢、打算、在做是要 */
function wantOf(f: Fact): "want" | "avoid" | undefined {
  if (f.assertion !== "user_stated") return undefined;
  if ((f.predicate === "prefers" || f.predicate === "works_on") && !f.negated) return "want";
  if ((f.predicate === "dislikes" && !f.negated) || (f.predicate === "prefers" && f.negated)) return "avoid";
  return undefined;
}

/** 行为和说的相反：说要 → 没做、推掉；说不要 → 去做、主动约 */
function against(want: "want" | "avoid", f: Fact): boolean {
  if (want === "want") return (f.predicate === "participated_in" && f.negated) || (f.predicate === "declined" && !f.negated);
  return (f.predicate === "participated_in" && !f.negated) || (f.predicate === "initiated" && !f.negated);
}

function nameOf(store: MemoryStore, f: Fact): string {
  return f.object.type === "entity" ? (store.getEntity(f.object.id)?.name ?? f.object.id) : f.object.value;
}

/** 行为的宾语和说的那样东西是一回事：同一个实体；事件的活动类型、名字对得上；说法表里连着 */
function relatedObject(store: MemoryStore, statedId: string, statedName: string, f: Fact): boolean {
  if (f.object.type !== "entity") return false;
  if (f.object.id === statedId) return true;
  const e = store.getEntity(f.object.id);
  if (!e) return false;
  const names = [e.name];
  if (e.type === "event") {
    for (const a of store.factsTouching(e.id)) {
      if (a.subjectId === e.id && a.predicate === "of_type" && a.object.type === "entity") {
        if (a.object.id === statedId) return true;
        names.push(store.getEntity(a.object.id)?.name ?? "");
      }
    }
  }
  const linked = CONCEPT_LINKS[statedName] ?? [];
  return names.some((n) => n.length > 0 && (n.includes(statedName) || linked.some((l) => n.includes(l))));
}

/** 认矛盾（见文件开头）：真冲突、说的和做的不一样、观点来回变 */
export function detectConflicts(store: MemoryStore, view: RgView): ConflictRecord[] {
  const out: ConflictRecord[] = [];
  const mine = store.listFacts({ subjectId: USER_ENTITY_ID }).filter((f) => SELF.has(f.assertion) && view.usableFact(f));

  // 真冲突：按 contestedWith 连成一团，按说法分两边
  const contested = mine.filter((f) => f.status === "contested");
  const seen = new Set<string>();
  for (const f of contested) {
    if (seen.has(f.id)) continue;
    const group: Fact[] = [];
    const queue = [f];
    while (queue.length > 0) {
      const x = queue.shift()!;
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      group.push(x);
      for (const id of x.contestedWith) {
        const y = store.getFact(id);
        if (y && y.status === "contested" && !seen.has(y.id) && view.usableFact(y)) queue.push(y);
      }
    }
    if (group.length < 2) continue;
    const sorted = group.toSorted((a, b) => ms(a) - ms(b) || a.id.localeCompare(b.id));
    const first = sorted[0]!;
    out.push({
      key: `contested|${objKey(first)}|${localDate(timeOf(first))}`,
      trigger: "contested",
      objectId: objKey(first),
      objectName: nameOf(store, first),
      sideA: sorted.filter((x) => stance(x) === stance(first)).map((x) => x.id),
      sideB: sorted.filter((x) => stance(x) !== stance(first)).map((x) => x.id),
    });
  }

  // 说的和做的不一样：说要 X，之后至少两次（两条证据）是非 X
  const live = mine.filter(held);
  const behaviors = live.filter((f) => f.predicate === "participated_in" || f.predicate === "declined" || f.predicate === "initiated");
  const byStance = new Map<string, { stated: Fact[]; against: Map<string, Fact>; name: string; id: string; want: "want" | "avoid" }>();
  for (const s of live) {
    const want = wantOf(s);
    if (!want || s.object.type !== "entity") continue;
    const objectId = s.object.id;
    const name = nameOf(store, s);
    const start = toMs(s.validFrom ?? timeOf(s));
    const end = s.validTo === null ? Infinity : toMs(s.validTo);
    const hits = behaviors.filter((b) => against(want, b) && ms(b) >= start && ms(b) < end && relatedObject(store, objectId, name, b));
    const key = `${objectId}|${want}`;
    const entry = byStance.get(key) ?? { stated: [] as Fact[], against: new Map<string, Fact>(), name, id: objectId, want };
    entry.stated.push(s);
    if (new Set(hits.flatMap((h) => h.evidenceIds)).size >= 2) for (const h of hits) entry.against.set(h.id, h);
    byStance.set(key, entry);
  }
  for (const [key, e] of byStance) {
    if (e.against.size === 0) continue;
    out.push({ key: `say_do|${key}`, trigger: "say_do", objectId: e.id, objectName: e.name, sideA: e.stated.map((f) => f.id), sideB: [...e.against.values()].toSorted((a, b) => ms(a) - ms(b)).map((f) => f.id) });
  }

  // 观点来回变：同一样东西的喜欢、不喜欢按时间排，出现 A → B → A，场景标签两两对得上
  const byObject = new Map<string, Fact[]>();
  for (const f of mine) {
    if (!held(f) || f.assertion !== "user_stated" || polarityOf(f) === undefined) continue;
    byObject.set(objKey(f), [...(byObject.get(objKey(f)) ?? []), f]);
  }
  for (const [key, facts] of byObject) {
    const sorted = facts.toSorted((a, b) => ms(a) - ms(b));
    const p = sorted.map((f) => polarityOf(f)!);
    const reverts = p.some((x, k) => k >= 2 && p.slice(0, k).some((y, i) => y === x && p.slice(i + 1, k).some((z) => z !== x)));
    if (!reverts) continue;
    if (!sorted.every((a, i) => sorted.slice(i + 1).every((b) => contextsCompatible(a.context, b.context)))) continue;
    out.push({ key: `flip_flop|${key}`, trigger: "flip_flop", objectId: key, objectName: nameOf(store, sorted[0]!), sideA: sorted.filter((_, i) => p[i] === p[0]).map((f) => f.id), sideB: sorted.filter((_, i) => p[i] !== p[0]).map((f) => f.id) });
  }
  return out;
}

// ---------- 配证据 ----------

export interface RootContext {
  store: MemoryStore;
  view: RgView;
  /** 成立的需求、价值断言（active、至少 medium，或者用户确认过） */
  needs: readonly Claim[];
  /** 断言的适用领域（196 的 claimDomains） */
  domainsOfClaim(claim: Claim): string[];
}

export interface RootAssessment {
  links: Record<RootKind, TargetLink[]>;
  /** 记错时是哪一边（证据少的、原话含糊的那边）；分不出是 null */
  minority: "A" | "B" | null;
  /** 场景不同时每条事实要补的场景（从图上人和人的关系补出来的） */
  sceneTags: Record<string, string[]>;
  /** 能同时解释两边的需求、价值断言 */
  needId: string | null;
  /** 现实约束的证据 */
  constraintEvidenceIds: string[];
  /** 哪边早 */
  earlier: "A" | "B";
  /** 两边涉及的人（查场景的追问用） */
  persons: string[];
}

const RANK: Readonly<Record<LinkWeight, number>> = { weak: 1, strong: 2, decisive: 3 };

/** 原话：抽出这条事实的那段（存在建事实那条修订的原因里），没有就用整条证据 */
export function spanOf(store: MemoryStore, f: Fact): string {
  const r = store.revisions(f.id, "fact").find((x) => x.op === "create");
  if (r && r.reason.startsWith("抽取：")) return r.reason.slice("抽取：".length);
  return f.evidenceIds.map((id) => store.getEvidence(id)?.text ?? "").join(" ");
}

/** 一条证据里涉及的人（提到的、一起的、组织的、参加的），和他们和用户的关系 */
function personsOf(store: MemoryStore, evidenceIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of evidenceIds) {
    for (const x of store.factsByEvidence(id)) {
      if (x.object.type !== "entity") continue;
      if (x.subjectId === USER_ENTITY_ID && (x.predicate === "mentioned" || x.predicate === "went_with")) out.add(x.object.id);
      else if (x.predicate === "organized_by" || x.predicate === "involves") out.add(x.object.id);
      else if ((RELATION_PREDICATES as readonly string[]).includes(x.predicate)) out.add(x.subjectId);
    }
  }
  return [...out];
}

function relationScenes(store: MemoryStore, personIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of personIds) {
    for (const r of store.factsTouching(p)) {
      if (r.subjectId !== p || !(RELATION_PREDICATES as readonly string[]).includes(r.predicate) || !held(r)) continue;
      out.add(RELATION_SCENES[r.predicate as RelationPredicate]);
    }
  }
  return [...out];
}

/** 补出来的场景：事实自己的标签，加上这条证据里涉及的人和用户的关系对应的场景 */
export function inferredScene(store: MemoryStore, f: Fact): { tags: string[]; added: string[]; persons: string[] } {
  const persons = personsOf(store, f.evidenceIds);
  const added = relationScenes(store, persons).filter((t) => !f.context.includes(t));
  return { tags: [...f.context, ...added], added, persons };
}

/** 一条需求、价值断言背后的事实和证据（支持它的、推出它的下层断言的，往下最多 4 层） */
function basisOf(store: MemoryStore, claimId: string): { facts: Set<string>; evidence: Set<string> } {
  const facts = new Set<string>();
  const evidence = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: claimId, depth: 0 }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id) || depth > 4) continue;
    visited.add(id);
    const addTarget = (t: string) => {
      const f = store.getFact(t);
      if (f) {
        facts.add(f.id);
        for (const e of f.evidenceIds) evidence.add(e);
      } else if (store.getEvidence(t)) evidence.add(t);
      else if (store.getClaim(t)) queue.push({ id: t, depth: depth + 1 });
    };
    for (const l of store.linksOf(id)) if (l.polarity === "supports") addTarget(l.target);
    for (const inf of store.inferencesOf(id)) for (const p of inf.premiseIds) addTarget(p);
  }
  return { facts, evidence };
}

/** 给一个矛盾的五种根源配支持、反证（见文件开头） */
export function assessRoots(c: ConflictRecord, ctx: RootContext): RootAssessment {
  const { store, view } = ctx;
  const facts = (ids: readonly string[]) => ids.map((id) => store.getFact(id)).filter((f): f is Fact => f !== undefined);
  const A = facts(c.sideA);
  const B = facts(c.sideB);
  const evOf = (f: Fact) => f.evidenceIds.filter((id) => view.usableEvidence(id));
  const evA = [...new Set(A.flatMap(evOf))];
  const evB = [...new Set(B.flatMap(evOf))];
  const text = (id: string) => (store.getEvidence(id)?.text ?? "").slice(0, 30);
  const maps = Object.fromEntries(ROOT_KINDS.map((k) => [k, new Map<string, TargetLink>()])) as Record<RootKind, Map<string, TargetLink>>;
  const add = (root: RootKind, target: string | undefined, polarity: "supports" | "refutes", weight: LinkWeight, rationale: string) => {
    if (!target) return;
    const key = `${target}|${polarity}`;
    const prev = maps[root].get(key);
    if (!prev || RANK[weight] > RANK[prev.weight]) maps[root].set(key, { target, polarity, weight, rationale });
  };

  // 观察：两边的事实对每种根源都是弱支持
  for (const root of ROOT_KINDS) {
    for (const f of A) add(root, f.id, "supports", "weak", `矛盾的一边：${f.statement}`);
    for (const f of B) add(root, f.id, "supports", "weak", `矛盾的另一边：${f.statement}`);
  }

  const scenes = new Map([...A, ...B].map((f) => [f.id, inferredScene(store, f)]));
  const sceneOf = (f: Fact) => scenes.get(f.id)!;
  const minA = Math.min(...A.map(ms));
  const minB = Math.min(...B.map(ms));
  const earlier: "A" | "B" = minA <= minB ? "A" : "B";
  const [E, L] = earlier === "A" ? [A, B] : [B, A];
  const hedged = (f: Fact) => HEDGES.some((h) => spanOf(store, f).includes(h));
  const sameKind = c.trigger !== "say_do";
  const sayVsDo = c.trigger === "say_do" || (stated(A) && B.some((f) => f.assertion === "observed")) || (stated(B) && A.some((f) => f.assertion === "observed"));

  // 1. 有一条记错了
  let minority: "A" | "B" | null = null;
  if (sameKind) {
    const compatible = (xs: Fact[], ys: Fact[]) => [...new Set(xs.filter((x) => ys.every((y) => contextsCompatible(sceneOf(x).tags, sceneOf(y).tags))).flatMap(evOf))];
    const cA = compatible(A, B);
    const cB = compatible(B, A);
    if (cA.length > cB.length) minority = "B";
    else if (cB.length > cA.length) minority = "A";
    if (minority) {
      const backing = minority === "B" ? cA : cB;
      backing.forEach((id, i) => add("misrecorded", id, "supports", i === 0 ? "strong" : "weak", `场景对得上的另一条证据和另一边一致：${text(id)}`));
    }
    if (evA.length >= 2 && evB.length >= 2) add("misrecorded", evB[0], "refutes", "strong", "两边各有两条以上证据，不像是一条记错了");
  }
  for (const f of [...A, ...B]) if (hedged(f)) add("misrecorded", evOf(f)[0], "supports", "weak", `原话含糊：${spanOf(store, f)}`);
  if (minority === null) {
    const hA = A.some(hedged);
    const hB = B.some(hedged);
    if (hA !== hB) minority = hA ? "A" : "B";
  }
  const suspect = minority === "A" ? A : minority === "B" ? B : [...A, ...B];
  if (!suspect.some(hedged) && stated(suspect)) add("misrecorded", evOf(suspect[0]!)[0], "refutes", "weak", "原话说得清楚，没有含糊的说法");

  // 2. 时间变了
  const objectFacts = store.listFacts({ subjectId: USER_ENTITY_ID }).filter((f) => held(f) && SELF.has(f.assertion) && view.usableFact(f) && objKey(f) === c.objectId);
  if (c.trigger === "say_do") {
    const firstBehavior = minB;
    const want = wantOf(A[0]!) ?? "want";
    const flipped = objectFacts.filter((f) => f.assertion === "user_stated" && ms(f) > firstBehavior && wantOf(f) !== undefined && wantOf(f) !== want);
    for (const f of flipped) add("changed_over_time", evOf(f)[0], "supports", "strong", `后来说不想要了：${f.statement}`);
    for (const f of A) if (ms(f) > firstBehavior) add("changed_over_time", evOf(f)[0], "refutes", "strong", `做不到以后又说了一遍：${f.statement}`);
  } else {
    const gapDays = Math.abs(minA - minB) / 86_400_000;
    if (gapDays >= 30) add("changed_over_time", evOf(L[0]!)[0], "supports", "weak", `两边隔了 ${Math.round(gapDays)} 天`);
    if (gapDays < 1) add("changed_over_time", evOf(L[0]!)[0], "refutes", "weak", "两边是同一天的事");
    for (const f of L) if (changeSignals(spanOf(store, f)).length > 0) add("changed_over_time", evOf(f)[0], "supports", "strong", `后来那边说了变化：${spanOf(store, f)}`);
    const firstLater = Math.min(...L.map(ms));
    for (const f of E) if (ms(f) > firstLater) add("changed_over_time", evOf(f)[0], "refutes", "strong", `后来又变回去了：${f.statement}`);
  }

  // 3. 场景不同
  const sceneTags: Record<string, string[]> = {};
  for (const f of [...A, ...B]) if (sceneOf(f).added.length > 0) sceneTags[f.id] = sceneOf(f).added;
  const pairs = A.flatMap((a) => B.map((b) => [a, b] as const));
  const apart = pairs.filter(([a, b]) => !contextsCompatible(sceneOf(a).tags, sceneOf(b).tags));
  const personsA = new Set(A.flatMap((f) => sceneOf(f).persons));
  const personsB = new Set(B.flatMap((f) => sceneOf(f).persons));
  const scenePivot = [...A, ...B].find((f) => sceneOf(f).added.length > 0) ?? B[0]!;
  if (c.trigger === "say_do") {
    const doneElsewhere = objectFacts.filter((f) => f.predicate === "participated_in" && !f.negated && B.every((b) => !contextsCompatible(f.context, b.context)));
    for (const f of doneElsewhere) add("scene_differs", evOf(f)[0], "supports", "weak", `做到的那次在别的场合：${f.statement}`);
  } else if (pairs.length > 0 && apart.length === pairs.length) {
    add("scene_differs", evOf(scenePivot)[0], "supports", "strong", `补上图上的关系以后两边场景对不上（${[...A, ...B].map((f) => `${f.statement}：${sceneOf(f).tags.join("、")}`).join("；")}）`);
  } else if (apart.length > 0) {
    add("scene_differs", evOf(scenePivot)[0], "supports", "weak", "补上图上的关系以后有几对场景对不上");
  }
  const disjointPeople = personsA.size > 0 && personsB.size > 0 && ![...personsA].some((p) => personsB.has(p));
  if (disjointPeople && c.trigger !== "say_do") add("scene_differs", evOf(B[0]!)[0], "supports", "weak", "两边涉及的人不一样");
  if (apart.length === 0 && c.trigger !== "say_do" && !disjointPeople) add("scene_differs", evOf(A[0]!)[0], "refutes", "weak", "补上图上的关系以后两边场景还是对得上，涉及的人也一样");

  // 4. 说的和做的不一样
  const constraintEvidenceIds: string[] = [];
  if (sayVsDo) {
    const did = c.trigger === "say_do" ? B : [...A, ...B].filter((f) => f.assertion === "observed");
    const said = c.trigger === "say_do" ? A : [...A, ...B].filter((f) => f.assertion === "user_stated");
    const sideEvidence = new Set(said.flatMap(evOf));
    for (const b of did) {
      const from = toMs(addDays(timeOf(b), -14));
      const to = toMs(addDays(timeOf(b), 3));
      for (const e of store.listEvidence({ status: "active" })) {
        if (constraintEvidenceIds.length >= 2) break;
        if (!view.usableEvidence(e.id) || sideEvidence.has(e.id) || constraintEvidenceIds.includes(e.id)) continue;
        const t = toMs(e.eventTime ?? e.observedAt);
        if (t < from || t > to) continue;
        const busy = store.factsByEvidence(e.id).some((x) => x.predicate === "said_about" && !x.negated && x.subjectId === USER_ENTITY_ID);
        if (busy || hasConstraint(e.text)) constraintEvidenceIds.push(e.id);
      }
    }
    for (const id of constraintEvidenceIds) add("say_do_gap", id, "supports", "strong", `做不到的那段时间有现实约束：${text(id)}`);
    for (const f of said) if (CONDITIONAL.test(spanOf(store, f)) || f.evidenceIds.some((id) => CONDITIONAL.test(store.getEvidence(id)?.text ?? ""))) add("say_do_gap", evOf(f)[0], "supports", "strong", `说的时候带着条件：${text(evOf(f)[0] ?? "")}`);
    const firstDid = Math.min(...did.map(ms));
    for (const f of said) if (ms(f) > firstDid) add("say_do_gap", evOf(f)[0], "supports", "weak", `做不到以后又说了一遍：${f.statement}`);
    if (c.trigger === "say_do") {
      const want = wantOf(A[0]!) ?? "want";
      for (const f of objectFacts) if (f.assertion === "user_stated" && ms(f) > firstDid && wantOf(f) !== undefined && wantOf(f) !== want) add("say_do_gap", evOf(f)[0], "refutes", "strong", `后来说不想要了：${f.statement}`);
    }
  } else {
    add("say_do_gap", evOf(A[0]!)[0], "refutes", "weak", "两边都是他说的话，不是说一套做一套");
  }

  // 5. 更深的需求
  let needId: string | null = null;
  const domsOf = (fs: Fact[]) => new Set(fs.flatMap((f) => [...domainsOfTags(sceneOf(f).tags), ...domainsOfText(nameOf(store, f))]).filter((d) => d !== "schedule"));
  const domA = domsOf(A);
  const domB = domsOf(B);
  const ranked = ctx.needs.toSorted((x, y) => Number(y.epistemic === "user_confirmed") - Number(x.epistemic === "user_confirmed"));
  for (const n of ranked) {
    const basis = basisOf(store, n.id);
    const relA = A.some((f) => basis.facts.has(f.id)) || evA.some((e) => basis.evidence.has(e));
    const relB = B.some((f) => basis.facts.has(f.id)) || evB.some((e) => basis.evidence.has(e));
    const nd = new Set(ctx.domainsOfClaim(n).filter((d) => d !== "schedule"));
    const inA = [...domA].some((d) => nd.has(d));
    const inB = [...domB].some((d) => nd.has(d));
    if ((relA || relB) && (relA || inA) && (relB || inB)) {
      add("deeper_need", relB ? evB[0] : evA[0], "supports", "strong", `两边都能用这条解释：${n.statement}`);
      needId ??= n.id;
    } else if (relA || relB) {
      add("deeper_need", relB ? evB[0] : evA[0], "supports", "weak", `只有一边对得上：${n.statement}`);
    }
  }

  const links = Object.fromEntries(ROOT_KINDS.map((k) => [k, [...maps[k].values()]])) as Record<RootKind, TargetLink[]>;
  return { links, minority, sceneTags, needId, constraintEvidenceIds, earlier, persons: [...new Set([...personsA, ...personsB])] };
}
