// 每晚校验（267 号票第 4 条，ADR-0030 第 5 条；329 号票按 ADR-0032 改）：每晚整理完，把推理图谱整张查一遍。
// - 326 号票起校验是记忆系统自己的图谱自检（graphSelfCheck → graph-check.ts，TypeScript，跑在守护进程里）；
//   不再起外面的程序，所以没有"本机缺什么就跳过"这回事。校验器照样从外面给（GraphValidator），测试给假的；
// - 校验器自己出错：按跳过记，原因写进整理报告，什么都不改，整理照常算跑成了；
// - 违反传播铁律（已验证的压在没验证的前提上，校验器交回 downgrade）：照规矩降回猜测（前提照挂、保留），往下的已验证跟着降
//   （status-keeper.ts 的 downgradeDependents）。经唯一写入口写（每晚校验，夜班），修订和留痕写明哪条前提没验证；
// - 别的不合格：每一行问题的主语（行首的 id）是结论的，这条结论加复核标记（下一次整理重判）；是事实、证据的，以它为前提或支持的
//   结论加复核标记（行首不是 id 的，按这一行里点名的全部 id 算）。复核标记不改真值状态。整理报告里列出标了哪几条、降了哪几条。
// - 坏数据读不出来的：问题照样列进报告，标不了的跳过，不让整夜失败。
// 326 号票那条"前提里有拿不准的事实就降成假设（改 kind）"329 号票去掉了（身份锁死，没验证是状态，ADR-0032）。
import type { MemoryEngine } from "../engine.ts";
import { checkReasoningGraph } from "./graph-check.ts";
import { ironLawReason, storeLookup, unverifiedPremises } from "./graph-rules.ts";

/** 校验器跑完的结果：通过、不合格（每条问题一行，行首是主语的 id；downgrade 是违反传播铁律、要降回猜测的结论）、跳过（为什么） */
export type GraphValidation = { state: "ok" } | { state: "failed"; problems: string[]; downgrade?: string[] } | { state: "skipped"; reason: string };

/** 推理图谱的校验器（默认是记忆系统自己的图谱自检 graphSelfCheck；测试里是假的） */
export interface GraphValidator {
  readonly name: string;
  validate(engine: MemoryEngine): GraphValidation | Promise<GraphValidation>;
}

/** 记忆系统自己的图谱自检（graph-check.ts）：只读，同步跑完 */
export const graphSelfCheck: GraphValidator = {
  name: "图谱自检",
  validate(engine) {
    const { problems, downgrade } = checkReasoningGraph(engine.store);
    if (problems.length === 0) return { state: "ok" };
    return { state: "failed", problems: problems.map((p) => `${p.subject}：${p.message}`), ...(downgrade.length === 0 ? {} : { downgrade }) };
  },
};

/** 这一夜的校验结果（进整理报告） */
export interface NightlyValidation {
  state: GraphValidation["state"];
  validator: string;
  /** 跳过的原因 */
  reason?: string;
  /** 校验器报的问题（原样，一行一条） */
  problems: string[];
  /** 因此加了复核标记的结论 */
  claimIds: string[];
  /** 329 号票：违反传播铁律、这一夜降回猜测的结论（连带往下降的也在里面） */
  downgraded: string[];
  /** 查了的节点数（证据、事实、结论） */
  nodes: number;
}

/** 问题里的 id：证据、事实、结论 */
const ID_PATTERN = /\b(?:cl|fa|ev)-[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*/g;
/** 行首的 id（这一行说的是谁） */
const SUBJECT_PATTERN = /^\s*((?:cl|fa|ev)-[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)*)/;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 一行问题牵连到的结论：主语是结论的就是它；是事实、证据的，以它为前提、支持它的那些 */
function claimsOfProblem(engine: MemoryEngine, line: string): string[] {
  const store = engine.store;
  const subject = SUBJECT_PATTERN.exec(line)?.[1];
  const ids = subject === undefined ? [...new Set(line.match(ID_PATTERN) ?? [])] : [subject];
  const out = new Set<string>();
  const named = ids.filter((id) => store.getClaim(id) !== undefined);
  for (const id of named) out.add(id);
  if (named.length > 0) return [...out];
  const factIds = new Set<string>();
  for (const id of ids) {
    if (store.getFact(id)) factIds.add(id);
    if (store.getEvidence(id)) for (const f of store.factsByEvidence(id)) factIds.add(f.id);
  }
  const targets = [...factIds, ...ids.filter((id) => store.getEvidence(id) !== undefined)];
  for (const target of targets) {
    for (const inference of store.inferencesByPremise(target)) if (inference.status === "active") out.add(inference.conclusionClaimId);
    for (const link of store.linksTo(target)) if (link.polarity === "supports") out.add(link.claimId);
  }
  return [...out];
}

/** 查了几个节点（证据、事实、结论） */
function countNodes(engine: MemoryEngine): number {
  try {
    const [row] = engine.store.db.all<{ n: number }>("SELECT (SELECT count(*) FROM evidence) + (SELECT count(*) FROM facts) + (SELECT count(*) FROM claims) AS n");
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/** 跑一次每晚校验（见文件开头） */
export async function validateNightly(engine: MemoryEngine, validator: GraphValidator = graphSelfCheck): Promise<NightlyValidation> {
  const base = { validator: validator.name, problems: [], claimIds: [], downgraded: [], nodes: countNodes(engine) };
  let result: GraphValidation;
  try {
    result = await validator.validate(engine);
  } catch (err) {
    return { ...base, state: "skipped", reason: `校验器出错：${messageOf(err)}` };
  }
  if (result.state === "skipped") return { ...base, state: "skipped", reason: result.reason };
  if (result.state === "ok") return { ...base, state: "ok" };

  const downgraded = applyDowngrades(engine, result.downgrade ?? []);
  const flagged: string[] = [];
  for (const line of result.problems) {
    let targets: string[];
    try {
      targets = claimsOfProblem(engine, line);
    } catch {
      continue; // 坏数据读不出来：这一行照样进报告，标不了
    }
    for (const claimId of targets) {
      if (flagged.includes(claimId) || downgraded.includes(claimId)) continue;
      try {
        const claim = engine.store.getClaim(claimId);
        if (!claim || (claim.status !== "active" && claim.status !== "contested") || claim.needsReview) continue;
        engine.rg.markClaimForReview(claimId, { reason: `每晚校验不合格：${line}` }, { op: "validate", actor: "nightly" });
        flagged.push(claimId);
      } catch {
        // 写入口拒了（ReasoningWriteRefused），或者这条结论连着的坏数据读不出来：跳过这一条，别的照标
      }
    }
  }
  return { ...base, state: "failed", problems: [...result.problems], claimIds: flagged, downgraded };
}

/** 违反传播铁律的降回猜测（经写入口，每晚校验，夜班），往下的已验证跟着降；已经不是已验证的、写不进去的跳过。交回降了的 */
function applyDowngrades(engine: MemoryEngine, claimIds: readonly string[]): string[] {
  const done: string[] = [];
  for (const claimId of claimIds) {
    if (done.includes(claimId)) continue;
    try {
      const claim = engine.store.getClaim(claimId);
      if (!claim || claim.status !== "active") continue;
      const bad = unverifiedPremises(storeLookup(engine.store), claimId);
      if (bad.length === 0) continue;
      const reason = `每晚校验：${ironLawReason(bad)}`;
      const at = engine.store.now();
      const down = engine.gate.write({ op: "validate", actor: "nightly", reason }, () => {
        engine.gate.updateClaim(claimId, { status: "contested", reviewedAt: at }, { evidenceId: null, reason });
        return engine.rg.keeper.downgradeDependents(claimId, at, { evidenceId: null, reason: `每晚校验：前提 ${claimId} 降回猜测` }, engine.rg.view(at));
      });
      done.push(claimId, ...down.filter((id) => !done.includes(id)));
    } catch {
      // 写入口拒了，或者这条连着的坏数据读不出来：跳过，别的照降
    }
  }
  return done;
}
