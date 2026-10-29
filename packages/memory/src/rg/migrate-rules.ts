// 老库照新规矩迁移一次（329 号票 R16 ①，ADR-0032）。只改状态和标记，不重判证据（那是 333 号票的"全量重判一次"）：
// 1. 待复核不再是真值状态：status 还是 needs_review 的结论改成复核标记（needs_review 列），真值状态回到转待复核之前的那个
//    （修订日志里找；找不到算猜测）；当时一起停用的推断（needs_review）前提都还在库里的恢复成立（R4：前提照挂），前提被删了的照旧停用；
// 2. 恢复被 326 号票改过的身份：修订日志里改过 kind 的，改回建号时的那个（R1 身份锁死，没验证是状态不是身份）；
// 3. 用户亲口确认过、还没改挂依据的：依据改挂到确认上（R7），已验证；
// 4. 传播铁律（R4）：已验证、前提有没验证的降回猜测（前提照挂、保留），往下的已验证跟着降，到不动为止；
// 5. 悬空的（前提都不在了）、推论没前提的：加复核标记，下一次整理重判（rejudge：悬空的撤回、墓碑指不在了的前提）。
// 被错撤的（墓碑指着只是拿不准的前提）不在这里复活，留给 333 号票的全量重判（R16 ②）。
// 每一步经唯一写入口（规矩迁移 migrate，夜班），一条结论一次写：一条被拒只记进报告，不连累别的。跑两遍结果一样（第二遍什么都不写）。
// 329 号票只写代码和测试，不接进守护进程、不在真库上跑：333 号票先在副本上跑、出前后对照，用户点头再上真库（先备份）。
import type { Claim, RevisionCause } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { isDangling, lacksPremises, refExists, storeLookup, unverifiedPremises, ironLawReason } from "./graph-rules.ts";
import { isDirectInference } from "./status-keeper.ts";

/** 迁移报告：每一步动了哪几条结论；被写入口拒了的记原因 */
export interface RulesMigrationReport {
  /** 第 1 步：待复核改成复核标记的 */
  reviewToFlag: string[];
  /** 第 2 步：身份改回建号时的 */
  kindsRestored: string[];
  /** 第 3 步：依据改挂到用户确认上的 */
  directAttached: string[];
  /** 第 4 步：照传播铁律降回猜测的（连带往下降的也在里面） */
  downgraded: string[];
  /** 第 5 步：悬空、推论没前提，加复核标记的 */
  flagged: string[];
  /** 被写入口拒了的 */
  refused: Array<{ claimId: string; step: string; reason: string }>;
  /** 这一遍改了东西没有（第二遍应该是 false） */
  changed: boolean;
}

const LEGACY_REVIEW = "needs_review";

/** 迁移每一笔修订的起因（没有起因证据） */
const cause = (reason: string): RevisionCause => ({ evidenceId: null, reason: `规矩迁移（329 号票）：${reason}` });
const LIVE: ReadonlySet<string> = new Set(["active", "contested"]);

/** 跑一次迁移（见文件开头） */
export function migrateToRules(engine: MemoryEngine, options: { at?: string } = {}): RulesMigrationReport {
  const store = engine.store;
  const at = options.at ?? store.now();
  const report: RulesMigrationReport = { reviewToFlag: [], kindsRestored: [], directAttached: [], downgraded: [], flagged: [], refused: [], changed: false };
  const before = store.latestRevisionSeq();
  /** 一次写；被写入口拒了记进报告（quiet 时不记，留给调用方再试一种写法），交回写成没有 */
  const write = <T>(claimId: string, step: string, reason: string, fn: () => T, quiet = false): { ok: true; value: T } | { ok: false } => {
    try {
      return { ok: true, value: engine.gate.write({ op: "migrate", reason: `规矩迁移（329 号票）：${reason}` }, fn) };
    } catch (err) {
      if (!quiet) report.refused.push({ claimId, step, reason: err instanceof Error ? err.message : String(err) });
      return { ok: false };
    }
  };

  // 1. 待复核 → 复核标记（真值状态回到转待复核之前）
  const legacy = store.db.all<{ id: string }>("SELECT id FROM claims WHERE status = ? ORDER BY rowid", LEGACY_REVIEW).map((r) => String(r.id));
  for (const id of legacy) {
    const previous = previousStatus(engine, id);
    const restore = () =>
      store
        .inferencesOf(id)
        .filter((i) => i.status === LEGACY_REVIEW && !isDirectInference(i) && i.premiseIds.every((p) => refExists(storeLookup(store), p)))
        .map((i) => i.id);
    const apply = (withChain: boolean) => () => {
      if (withChain) for (const inf of restore()) engine.gate.updateInference(inf, { status: "active" }, cause("待复核时停用的推断，前提都还在，恢复（前提照挂）"));
      const lookup = storeLookup(store);
      const hasBasis = store.inferencesOf(id).some((i) => i.status === "active");
      const verified = previous === "active" && hasBasis && unverifiedPremises(lookup, id).length === 0;
      engine.gate.updateClaim(id, { status: verified ? "active" : "contested", needsReview: true, reviewedAt: at }, cause(`待复核不再是真值状态，改成复核标记；状态回到${verified ? "已验证" : "猜测"}`));
    };
    // 恢复推断可能过不了往上抽的结构门槛之类的检查：那就只改状态和标记（推断照旧停用，等整理重推）
    const done = write(id, "待复核改成标记", "待复核改成复核标记", apply(true), true).ok || write(id, "待复核改成标记", "待复核改成复核标记（推断照旧停用）", apply(false)).ok;
    if (done) report.reviewToFlag.push(id);
  }

  // 2. 身份改回建号时的
  for (const claim of store.listClaims()) {
    const original = originalKind(engine, claim.id);
    if (original === undefined || original === claim.kind) continue;
    if (write(claim.id, "恢复身份", `恢复身份 ${claim.id}`, () => engine.gate.updateClaim(claim.id, { kind: original }, cause(`恢复建号时的身份（${claim.kind} → ${original}）：身份锁死，没验证是状态`))).ok) {
      report.kindsRestored.push(claim.id);
    }
  }

  // 3. 用户确认过、还没改挂依据的 → 改挂到确认上，已验证
  for (const claim of store.listClaims({ status: ["active", "contested"] })) {
    if (claim.epistemic === "explicit") continue;
    const confirmations = engine.rg.keeper.userConfirmations(claim.id);
    if (confirmations.length === 0) continue;
    const direct = store.inferencesOf(claim.id).find((i) => isDirectInference(i) && i.status === "active");
    if (direct && JSON.stringify(direct.premiseIds) === JSON.stringify(confirmations) && claim.status === "active") continue;
    const by = store.inferencesOf(claim.id).find((i) => !isDirectInference(i))?.by ?? "migrate";
    const attached = write(claim.id, "改挂到用户确认", `${claim.id} 用户确认过，依据改挂到确认上`, () => {
      engine.rg.keeper.attachDirect(claim, { kind: "user", targets: confirmations }, by, cause("用户亲口确认过（直接证实）"));
      if (claim.status !== "active") engine.gate.updateClaim(claim.id, { status: "active", reviewedAt: at }, cause("用户亲口确认过（直接证实），已验证"));
    });
    if (attached.ok) report.directAttached.push(claim.id);
  }

  // 4. 传播铁律：降到不动为止（一次降会连带往下降；再扫一遍兜住绕过写入口留下的）
  for (let round = 0; round < 1000; round += 1) {
    const lookup = storeLookup(store);
    const violating = store.listClaims({ status: "active" }).filter((c) => unverifiedPremises(lookup, c.id).length > 0 && !report.refused.some((r) => r.claimId === c.id && r.step === "传播铁律"));
    if (violating.length === 0) break;
    const claim = violating[0]!;
    const bad = unverifiedPremises(lookup, claim.id);
    const down = write(claim.id, "传播铁律", `${claim.id} 照传播铁律降回猜测`, () => {
      engine.gate.updateClaim(claim.id, { status: "contested", reviewedAt: at }, cause(ironLawReason(bad)));
      return engine.rg.keeper.downgradeDependents(claim.id, at, cause(`前提 ${claim.id} 降回猜测`), engine.rg.view(at));
    });
    if (down.ok) report.downgraded.push(claim.id, ...down.value.filter((id) => id !== claim.id && !report.downgraded.includes(id)));
  }

  // 5. 悬空、推论没前提 → 加复核标记（下一次整理重判）
  const lookup = storeLookup(store);
  for (const claim of store.listClaims({ status: ["active", "contested"] })) {
    if (!isDangling(lookup, claim.id) && !lacksPremises(lookup, claim.id)) continue;
    const why = isDangling(lookup, claim.id) ? "前提都不在了（悬空）" : "没有写了前提的成立推断";
    if (write(claim.id, "加复核标记", `${claim.id} ${why}，加复核标记`, () => engine.gate.updateClaim(claim.id, { needsReview: true }, cause(`${why}，加复核标记，下一次整理重判`))).ok) {
      report.flagged.push(claim.id);
    }
  }

  report.changed = store.latestRevisionSeq() !== before;
  return report;
}

/** 转待复核之前的真值状态（修订日志里最后一次改成 needs_review 的那一笔的 from）；找不到算猜测 */
function previousStatus(engine: MemoryEngine, claimId: string): Claim["status"] {
  const r = engine.store
    .revisions(claimId, "claim")
    .toReversed()
    .find((x) => x.changes.status?.to === LEGACY_REVIEW);
  const from = r?.changes.status?.from;
  return typeof from === "string" && LIVE.has(from) ? (from as Claim["status"]) : "contested";
}

/** 建号时的身份：修订日志里第一次改 kind 的那一笔的 from（没改过就是 undefined） */
function originalKind(engine: MemoryEngine, claimId: string): Claim["kind"] | undefined {
  const r = engine.store.revisions(claimId, "claim").find((x) => x.changes.kind !== undefined);
  const from = r?.changes.kind?.from;
  return from === "hypothesis" || from === "conclusion" ? from : undefined;
}
