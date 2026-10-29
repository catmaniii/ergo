// 彻底删除登记进推理库（234 号票，ADR-0008、接入设计第 7 节）。
//
// 一条素材被彻底删除时，守护进程按素材 id 找到证据（sourceRef），交给这里：
// 1. 删证据、删只靠它的事实；还有别的证据的事实去掉这条证据（照 kg/graph.ts 的 dropEvidence，恢复被它取代、冲突的旧事实）；
// 2. 依赖这些证据、事实的结论加复核标记（329 号票起"待复核"是标记，不占真值状态），结论不删，下次整理重新推：
//    前提就是被删的证据、事实的推断停用（needs_review，前提不在库里了，墓碑没处指），这几条结论已验证的先降回猜测、往下按传播铁律降；
//    支持、反证被拿掉的那几条，它们的组当场按剩下的关联重定；
// 3. 指向被删证据、事实的关联（支持、反证、背景）拿掉（修订日志记 delete）；
// 4. 问题箱里要弄清这些结论、事实的问题标过期（expired），以后不再问；
// 5. 写一条审计（rg_purges：什么时候、为什么、删了哪些证据和事实、哪些结论转了待复核、哪些问题过期），只记 id，不记原文；
// 6. 所有改动走修订日志（删证据、删事实、结论改状态、拿掉关联都是 update/delete 修订）。
//
// 事实被彻底删除（不经过素材）走 purgeFacts；问题箱的过期见 rg/questions.ts 的 expireForTargets。
// 删完在 rg.db 里搜不到原文：证据的原文只存在 evidence.text 和两套索引里（修订日志记长度不记内容），三处一起删；
// 事实的精炼陈述是派生文本，也不留；调用方删完做一次 WAL 检查点（MemoryStore.checkpoint）。
//
// 和"忘掉"的区别：忘掉走 engine.invalidateEvidence（证据留墓碑、原文清空、事实撤回，派生内容留着）；
// 彻底删除连证据、事实、索引一起删，依赖的结论留墓碑等重新整理。
import type { Evidence, Fact, RevisionCause, WriteActor } from "./domain/types.ts";
import type { MemoryEngine } from "./engine.ts";
import { rgSession, rgWriter } from "./store/store.ts";

export interface PurgeOptions {
  /** 为什么删（修订日志、审计里写），比如"彻底删除素材"、"别推断"、"事实彻底删除" */
  reason: string;
  /** 审计里的"现在"；不给用引擎的时钟 */
  at?: string;
  /** 审计里记的素材 id（记忆包不知道素材，调用方给） */
  materialIds?: readonly string[];
  /**
   * 267 号票：经唯一写入口时记成哪种写操作——purge 彻底删除（默认）、no_infer 别推断（同样连证据、事实一起从推理库撤掉）。
   * 两种都只由用户发起
   */
  op?: "purge" | "no_infer";
  /** 谁发起的（默认用户；写入口只认用户） */
  actor?: WriteActor;
  /** 经谁转达（"经记忆管理员"、"设置页"） */
  via?: string;
}

/** 一条彻底删除的审计（rg_purges 一行）；只有 id 和原因，没有原文 */
export interface PurgeRecord {
  at: string;
  reason: string;
  materialIds: string[];
  evidenceIds: string[];
  factIds: string[];
  /** 这次加了复核标记的结论（已经标着的不重复记；329 号票前是转成 needs_review 的） */
  claimIds: string[];
  /** 这次标过期的问题 */
  questionIds: string[];
}

/** 一次彻底删除删了什么、影响了哪些结论（就是写进审计的那一条） */
export type PurgeReport = PurgeRecord;

/**
 * 彻底删除这些证据：删证据和只靠它的事实，依赖的结论加复核标记、相关问题过期，写审计。
 * 不存在的 id 跳过（重复删同一个素材是幂等的）。
 */
export function purgeEvidence(engine: MemoryEngine, evidenceIds: readonly string[], options: PurgeOptions): PurgeReport {
  const ids = [...new Set(evidenceIds)];
  const evidence = ids.map((id) => engine.store.getEvidence(id)).filter((e): e is Evidence => e !== undefined);
  const evidenceSet = new Set(evidence.map((e) => e.id));
  // 要删的事实：只靠这些证据的（别的证据也都不是有效的）
  const touched = new Map<string, Fact>();
  for (const e of evidence) for (const f of engine.store.factsByEvidence(e.id)) touched.set(f.id, f);
  const doomed: string[] = [];
  for (const f of touched.values()) {
    const survives = f.evidenceIds.some((id) => !evidenceSet.has(id) && engine.store.getEvidence(id)?.status === "active");
    if (!survives) doomed.push(f.id);
  }
  return purge(engine, { evidence, facts: [], factIds: doomed }, options);
}

/** 彻底删除这些事实（不经素材）：删事实、依赖的结论加复核标记、相关问题过期，写审计 */
export function purgeFacts(engine: MemoryEngine, factIds: readonly string[], options: PurgeOptions): PurgeReport {
  const facts = [...new Set(factIds)].map((id) => engine.store.getFact(id)).filter((f): f is Fact => f !== undefined);
  return purge(engine, { evidence: [], facts, factIds: [] }, options);
}

/** 改修订日志用的原因（每步写清为什么） */
const cause = (reason: string): RevisionCause => ({ reason });

function purge(engine: MemoryEngine, targets: { evidence: Evidence[]; facts: Fact[]; factIds: readonly string[] }, options: PurgeOptions): PurgeReport {
  const store = engine.store;
  const at = options.at ?? store.now();
  const report: PurgeReport = {
    at,
    reason: options.reason,
    materialIds: [...new Set(options.materialIds ?? [])],
    evidenceIds: targets.evidence.map((e) => e.id),
    factIds: [...new Set([...targets.factIds, ...targets.facts.map((f) => f.id)])],
    claimIds: [],
    questionIds: [],
  };
  if (report.evidenceIds.length === 0 && report.factIds.length === 0) return report;

  // 267 号票：经唯一写入口（彻底删除 / 别推断，只由用户发起）
  const intent = { op: options.op ?? "purge", reason: options.reason, ...(options.actor === undefined ? {} : { actor: options.actor }), ...(options.via === undefined ? {} : { via: options.via }) } as const;
  const w = rgWriter(store);
  rgSession(store, intent, () => {
    // 哪些结论会被影响：沿"前提 → 推断的结论"和"关联"走，走之前先把它们都记下来（删完就查不到了）
    const targetIds = new Set<string>([...report.evidenceIds, ...report.factIds]);
    const affected = collectAffectedClaims(engine, targetIds);
    // 证据这一层：还有别的证据的事实去掉这条证据；只靠它的撤回（随后整条删掉）
    for (const evidence of targets.evidence) engine.kg.dropEvidence(evidence.id, "purged", evidence.id);
    // 被删的事实可能有明说的断言，直接按事实找到
    for (const factId of report.factIds) {
      const claimId = engine.rg.registry.explicitClaimOf(factId);
      if (claimId !== undefined) affected.add(claimId);
    }
    // 329 号票：依赖的结论加复核标记（之前就标着的不重复记），结论不删，下次整理重新判
    const reviewed = new Set<string>();
    const flagged = new Set(store.listClaims({ needsReview: true }).map((c) => c.id));
    const view = engine.rg.view(at);
    // 前提就是被删的证据、事实：推断停用、结论已验证的降回猜测、往下按传播铁律降（来源失效，前提不在库里了，不撤——墓碑没处指）
    for (const id of targetIds) engine.rg.keeper.sourceLost(id, at, cause(`${options.reason}：前提 ${id} 被删`), view, { deleting: true });
    // 指向被删证据、事实的关联拿掉（修订日志记 delete；支持、反证、背景都拿掉）；它们的组当场按剩下的关联重定
    const regroup = new Set<string>();
    for (const id of targetIds) {
      for (const link of store.linksTo(id)) {
        w.removeLink(link, cause(`${options.reason}：拿掉指向 ${id} 的关联`));
        const member = engine.rg.registry.memberOf(link.claimId);
        if (member) regroup.add(member.groupKey);
      }
    }
    for (const claimId of affected) engine.rg.keeper.flag(claimId, cause(`${options.reason}：依赖的证据、事实被删，下一次整理重判`));
    for (const key of regroup) engine.rg.settleGroupNow(key, at);
    for (const claimId of affected) {
      const claim = store.getClaim(claimId);
      if (claim !== undefined && claim.needsReview && !flagged.has(claimId)) reviewed.add(claimId);
    }
    // 问题箱：要弄清这些结论、事实的问题标过期
    const expired = engine.questions.expireForTargets({ claimIds: [...new Set([...affected, ...reviewed])], factIds: report.factIds }, at, `${options.reason}：相关依据被删，问题过期`);
    report.claimIds = [...reviewed];
    report.questionIds = expired.map((q) => q.id);
    // 连派生内容一起删：事实先删，证据后删（顺序不影响结果，事实关联要清干净）
    for (const factId of report.factIds) w.deleteFact(factId, cause(`${options.reason}：事实 ${factId} 连派生内容一起删`));
    for (const evidence of targets.evidence) w.deleteEvidence(evidence.id, cause(`${options.reason}：证据 ${evidence.id} 连原文、索引、向量一起删`));
    // 审计（只记 id 和原因；原文不在修订日志里，也不在这里）
    insertAudit(engine, report);
  });
  store.checkpoint();
  return report;
}

/**
 * 受影响（要待复核）的结论：从被删的证据、事实出发，沿推断的前提→结论、关联的目标→结论走；
 * 明说的断言按事实找。和失效传播一样一路走到底（267 号票起不设深度上限），走过的不再走。
 */
function collectAffectedClaims(engine: MemoryEngine, targets: ReadonlySet<string>): Set<string> {
  const store = engine.store;
  const claims = new Set<string>();
  const queue: string[] = [...targets];
  for (const factId of targets) {
    const claimId = engine.rg.registry.explicitClaimOf(factId);
    if (claimId !== undefined) queue.push(claimId);
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (store.getClaim(id) !== undefined) claims.add(id);
    for (const inference of store.inferencesByPremise(id)) queue.push(inference.conclusionClaimId);
    for (const link of store.linksTo(id)) queue.push(link.claimId);
  }
  return claims;
}

function insertAudit(engine: MemoryEngine, report: PurgeReport): void {
  engine.store.db.run(
    "INSERT INTO rg_purges (at, reason, material_ids, evidence_ids, fact_ids, claim_ids, question_ids) VALUES (?, ?, ?, ?, ?, ?, ?)",
    report.at,
    report.reason,
    JSON.stringify(report.materialIds),
    JSON.stringify(report.evidenceIds),
    JSON.stringify(report.factIds),
    JSON.stringify(report.claimIds),
    JSON.stringify(report.questionIds),
  );
}

/** 彻底删除的审计（新的在后） */
export function purgeRecords(engine: MemoryEngine): PurgeRecord[] {
  return engine.store.db.all<Record<string, unknown>>("SELECT * FROM rg_purges ORDER BY seq").map((row) => ({
    at: String(row.at),
    reason: String(row.reason),
    materialIds: JSON.parse(String(row.material_ids)) as string[],
    evidenceIds: JSON.parse(String(row.evidence_ids)) as string[],
    factIds: JSON.parse(String(row.fact_ids)) as string[],
    claimIds: JSON.parse(String(row.claim_ids)) as string[],
    questionIds: JSON.parse(String(row.question_ids)) as string[],
  }));
}
