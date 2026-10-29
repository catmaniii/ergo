// 图谱自检（326 号票；ADR-0030 第 5 条的每晚校验）：每晚整理完把整张推理图谱查一遍，不合格的结论由 nightly-validate.ts 转待复核。
// 记忆系统自己的 TypeScript，跑在守护进程里，不起别的程序、不用别的语言。
//
// 唯一写入口（write-gate.ts）每次写只查这一次改到的、不翻旧账；这里把同一份规矩（graph-rules.ts）铺到整张图上——旧数据、
// 没经写入口进来的坏数据都查得到——再加两样只有看整张图才查得了的：
//   1. readable 读得出来、字段合格：每条证据、事实、结论、推断、关联都读得出来（坏 JSON 也只记一条问题，不让整个检查停下），
//      字段过 domain/validate.ts 的 problemsOfX（和存储写入前同一份：词表、陈述非空、状态和配套字段……）；读不出来、
//      字段不合格的报一条，后面几样不再查它（字段可能是坏的），它的状态照样算数；
//   2. exists 引用都在：还活着的结论，成立推断写的前提、关联的目标、竞争的结论；还在的事实，它的证据（同写入口的 exists）；
//   3. cycle 依赖不绕圈：结论 → 成立推断写的前提结论，绕回自己的就是推不出来；
//   4. dependents 传播铁律（329 号票 R4，同写入口的 dependents）：已验证的结论，成立推断写的前提都得已验证——结论已验证、事实成立或
//      被取代、证据有效（猜测、拿不准、撤回的都不算）。写入口在依据变的那一刻查，这里查现在整张图上已验证的结论；
//      查出来的由 nightly-validate.ts 降回猜测（前提照挂、保留）。猜测的结论本来就没当真，不查；
//   5. dangling 不留悬空（329 号票补，同写入口的 dangling）：还活着的结论，成立推断写了前提、可一条都不在了；
//   6. premise 推论有前提（329 号票补）：还活着的结论连一条写了前提的成立推断都没有。
//   5、6 两样复核标记着的不查（依据在重推，等整理重判完再查）。
//   7. prediction 预测节点（330 号票 R10）：读得出来、字段合格；还开着的预测，来源都还在（来源撤回了它该跟着作废，R8）。
//   8. conflict（330 号票 R13）：互相竞争（competesWith）、场合对得上的两条结论都已验证（跨组也查）。
// 问题一条一行，主语是行首的 id（那条结论，或者那条事实、证据）；同一个结论的几处同类问题合成一行。
// 326 号票那份"要降成假设的结论"329 号票去掉了（身份锁死；没验证是状态，由铁律管）。
// 只读，不写任何东西（降回猜测、加复核标记由 nightly-validate.ts 经写入口写）。
import { problemsOfClaim, problemsOfEvidence, problemsOfFact, problemsOfInference, problemsOfLink, problemsOfPrediction } from "../domain/validate.ts";
import type { Claim, Fact, Inference, Link } from "../domain/types.ts";
import type { MemoryStore } from "../store/store.ts";
import { contextsCompatible } from "../kg/context.ts";
import { isDangling, lacksPremises, LIVE_CLAIM_STATUSES, premiseHolds, premiseVerified, refExists, type GraphLookup } from "./graph-rules.ts";

export const GRAPH_CHECKS = ["readable", "exists", "cycle", "dependents", "dangling", "premise", "prediction", "conflict"] as const;
export type GraphCheckName = (typeof GRAPH_CHECKS)[number];

/** 一处不合格：哪样检查、说的是谁（行首的 id）、怎么不合格 */
export interface GraphProblem {
  check: GraphCheckName;
  subject: string;
  message: string;
}

export interface GraphCheckResult {
  /** 查了几个节点（证据、事实、结论） */
  nodes: number;
  problems: GraphProblem[];
  /** 违反传播铁律的已验证结论（dependents 那几行的主语）：nightly-validate.ts 把它们降回猜测 */
  downgrade: string[];
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 状态的说法（问题里用，人看的；数据，不随界面语言变） */
const STATUS_TEXT: Readonly<Record<string, string>> = {
  contested: "猜测或拿不准",
  retracted: "撤回了",
  superseded: "被取代了",
  corrected: "被纠正了",
  forgotten: "被忘掉了",
};

type Row = Readonly<Record<string, unknown>>;

/** 整张图查一遍（见文件开头） */
export function checkReasoningGraph(store: MemoryStore): GraphCheckResult {
  const problems: GraphProblem[] = [];
  const push = (check: GraphCheckName, subject: string, message: string) => problems.push({ check, subject, message });
  const rows = (sql: string): Row[] => store.db.all<Row>(sql);

  // ---- 1. 读得出来、字段合格；顺手记下每个节点的状态（后面几样按它查，不再读库） ----
  const statuses = new Map<string, string>();
  /** 每条结论的成立推断（读得出来的；下面读推断时填） */
  const activeInferences = new Map<string, Inference[]>();
  /** 有复核标记的结论 */
  const flagged = new Set<string>();
  /** 330 号票（R3）：别人转述的（转述的事实、别人转述的证据）——不算已验证的前提 */
  const relayed = new Set<string>();
  const lookup: GraphLookup = {
    statusOf: (id) => statuses.get(id),
    premisesOf: (id) => (activeInferences.get(id) ?? []).flatMap((i) => i.premiseIds),
    flagged: (id) => flagged.has(id),
    relayed: (id) => relayed.has(id),
  };

  /** 读一个对象、查字段；读不出来、字段不合格的报一条，交回 undefined（后面几样不再查它，字段可能是坏的） */
  const read = <T>(id: string, what: string, get: () => T | undefined, check: (value: T) => string[]): T | undefined => {
    try {
      const value = get();
      if (value === undefined) return undefined;
      const found = check(value);
      if (found.length === 0) return value;
      push("readable", id, `${what}字段不合格：${found.join("；")}`);
      return undefined;
    } catch (err) {
      push("readable", id, `${what}读不出来（${messageOf(err)}）`);
      return undefined;
    }
  };

  const evidenceRows = rows("SELECT id, status, source_level FROM evidence ORDER BY rowid");
  for (const row of evidenceRows) {
    const id = String(row.id);
    statuses.set(id, String(row.status));
    if (row.source_level === "untrusted") relayed.add(id);
    read(id, "证据", () => store.getEvidence(id), problemsOfEvidence);
  }
  const facts: Fact[] = [];
  const factRows = rows("SELECT id, status, assertion FROM facts ORDER BY rowid");
  for (const row of factRows) {
    const id = String(row.id);
    statuses.set(id, String(row.status));
    if (row.assertion === "third_party_reported") relayed.add(id);
    const fact = read(id, "事实", () => store.getFact(id), problemsOfFact);
    if (fact) facts.push(fact);
  }
  const claims: Claim[] = [];
  const claimRows = rows("SELECT id, status, needs_review FROM claims ORDER BY rowid");
  for (const row of claimRows) {
    const id = String(row.id);
    statuses.set(id, String(row.status));
    if (Number(row.needs_review) === 1) flagged.add(id);
    const claim = read(id, "结论", () => store.getClaim(id), problemsOfClaim);
    if (claim) claims.push(claim);
  }
  for (const row of rows("SELECT id, conclusion_claim_id FROM inferences ORDER BY rowid")) {
    const id = String(row.id);
    const conclusion = String(row.conclusion_claim_id);
    const inference = read(conclusion, `推断 ${id} `, () => store.getInference(id), problemsOfInference);
    if (inference?.status !== "active") continue;
    const list = activeInferences.get(conclusion) ?? [];
    list.push(inference);
    activeInferences.set(conclusion, list);
  }
  /** 每条结论的关联 */
  const linksOf = new Map<string, Link[]>();
  for (const row of rows("SELECT claim_id, target, polarity, rationale, weight FROM links ORDER BY rowid")) {
    const link = { claimId: String(row.claim_id), target: String(row.target), polarity: row.polarity, rationale: row.rationale, weight: row.weight } as Link;
    read(link.claimId, `关联（→ ${link.target}）`, () => link, problemsOfLink);
    const list = linksOf.get(link.claimId) ?? [];
    list.push(link);
    linksOf.set(link.claimId, list);
  }

  // ---- 2. 引用都在 ----
  for (const claim of claims) {
    if (!LIVE_CLAIM_STATUSES.includes(claim.status)) continue;
    const missing = new Map<string, string>();
    for (const inference of activeInferences.get(claim.id) ?? []) for (const id of inference.premiseIds) if (!refExists(lookup, id)) missing.set(id, `推断 ${inference.id} 的前提`);
    for (const link of linksOf.get(claim.id) ?? []) if (!refExists(lookup, link.target)) missing.set(link.target, "关联的目标");
    for (const id of claim.competesWith) if (!refExists(lookup, id)) missing.set(id, "竞争的结论");
    if (missing.size > 0) push("exists", claim.id, `引用的${[...missing].map(([id, what]) => `${what} ${id}`).join("、")} 不存在（不能编造，被删的也不能再引用）`);
  }
  for (const fact of facts) {
    if (!premiseHolds(lookup, fact.id)) continue;
    const missing = fact.evidenceIds.filter((id) => !refExists(lookup, id));
    if (missing.length > 0) push("exists", fact.id, `事实的证据 ${missing.join("、")} 不存在`);
  }

  // ---- 3. 依赖不绕圈（结论 → 成立推断写的前提结论） ----
  const claimIds = new Set(claims.map((c) => c.id));
  const premisesOf = (id: string): string[] => [...new Set((activeInferences.get(id) ?? []).flatMap((i) => i.premiseIds).filter((p) => claimIds.has(p)))];
  for (const cycle of findCycles([...claimIds], premisesOf)) {
    push("cycle", cycle[0]!, `依赖绕成了环：${[...cycle, cycle[0]].join(" → ")}（几条结论互为前提，哪条都推不出来）`);
  }

  // ---- 4. 传播铁律：已验证的结论，成立推断写的前提都得已验证 ----
  const downgrade: string[] = [];
  for (const claim of claims) {
    if (claim.status !== "active") continue;
    const fallen = new Map<string, string>();
    for (const inference of activeInferences.get(claim.id) ?? []) {
      for (const id of inference.premiseIds) {
        if (!refExists(lookup, id) || premiseVerified(lookup, id)) continue;
        fallen.set(id, STATUS_TEXT[lookup.statusOf(id)!] ?? lookup.statusOf(id)!);
      }
    }
    if (fallen.size === 0) continue;
    downgrade.push(claim.id);
    push("dependents", claim.id, `已验证，但推出它的前提 ${[...fallen].map(([id, why]) => `${id}（${why}）`).join("、")}没验证——已验证的不能压在猜测上，降回猜测（前提照挂、保留）`);
  }

  // ---- 5、6. 不留悬空、推论有前提（复核标记着的等整理重判完再查） ----
  for (const claim of claims) {
    if (isDangling(lookup, claim.id)) push("dangling", claim.id, `悬空了：推出它的前提 ${[...new Set(lookup.premisesOf(claim.id))].join("、")} 都不在了（撤回、被取代、被忘掉或删了）`);
    else if (lacksPremises(lookup, claim.id)) push("premise", claim.id, "还活着，可没有一条写了前提的成立推断（推论必须有前提）");
  }

  // ---- 7. 预测节点：字段合格；开着的，来源都还在 ----
  for (const row of rows("SELECT id FROM predictions ORDER BY rowid")) {
    const id = String(row.id);
    let prediction;
    try {
      prediction = store.getPrediction(id);
    } catch (err) {
      push("prediction", id, `预测读不出来（${messageOf(err)}）`);
      continue;
    }
    if (!prediction) continue;
    const bad = problemsOfPrediction(prediction);
    if (bad.length > 0) {
      push("prediction", id, `预测字段不合格：${bad.join("；")}`);
      continue;
    }
    if (prediction.status !== "open") continue;
    const gone = prediction.premiseIds.filter((p) => lookup.statusOf(p) === undefined || lookup.statusOf(p) === "retracted");
    if (gone.length > 0) push("prediction", id, `还开着，可来源 ${gone.join("、")} 撤回了或不在了——预测该跟着作废（R8）`);
  }

  // ---- 8. 330 号票（R13）：互相矛盾却都已验证（互相竞争、场合对得上，跨组也查） ----
  const activeClaims = new Map(claims.filter((c) => c.status === "active").map((c) => [c.id, c]));
  const reported = new Set<string>();
  for (const c of activeClaims.values()) {
    for (const id of c.competesWith) {
      const other = activeClaims.get(id);
      if (!other || !contextsCompatible(c.context, other.context)) continue;
      const pair = [c.id, other.id].toSorted().join("|");
      if (reported.has(pair)) continue;
      reported.add(pair);
      push("conflict", c.id, `${c.id}「${c.statement}」和 ${other.id}「${other.statement}」互相矛盾却都已验证——要都降回猜测、先试收窄、分不清问用户（R13）`);
    }
  }

  const order = (p: GraphProblem) => GRAPH_CHECKS.indexOf(p.check);
  return { nodes: evidenceRows.length + factRows.length + claimRows.length, problems: problems.toSorted((a, b) => order(a) - order(b)), downgrade };
}

/**
 * 有向图里的环（迭代的深度优先，不设深度上限）：每个环只报一次，从环里 id 最小的那个起头。
 * 自己指向自己的也算环。
 */
export function findCycles(nodes: readonly string[], next: (id: string) => readonly string[]): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of nodes) {
    if ((color.get(start) ?? WHITE) !== WHITE) continue;
    const stack: Array<{ id: string; children: readonly string[]; at: number }> = [{ id: start, children: next(start), at: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const top = stack.at(-1)!;
      if (top.at >= top.children.length) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const child = top.children[top.at]!;
      top.at += 1;
      const c = color.get(child) ?? WHITE;
      if (c === GRAY) {
        const path = stack.map((s) => s.id);
        const cycle = path.slice(path.indexOf(child));
        const min = cycle.indexOf(cycle.toSorted()[0]!);
        const rotated = [...cycle.slice(min), ...cycle.slice(0, min)];
        const key = rotated.join("|");
        if (!seen.has(key)) {
          seen.add(key);
          out.push(rotated);
        }
      } else if (c === WHITE) {
        color.set(child, GRAY);
        stack.push({ id: child, children: next(child), at: 0 });
      }
    }
  }
  return out;
}
