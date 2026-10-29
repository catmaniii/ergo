// 推理库 rg.db 的只读视图（233 号票）：网页"记忆"页的概览、结论列表、一条结论的完整解释、问题箱从这里读。
//
// - 只读、随用随开、用完就关：每次调用都打开一次推理库（manifest 和表版本对不上就不打开，交给 rg-db.ts 判），读完立刻关掉，
//   不在守护进程里长期握着 SQLite 句柄。打开的那一下 @ergo/memory 会开一个写事务（建表语句、表版本），WAL 模式下和每晚整理
//   按 busy_timeout 排队；manifest 不写（openReasoningDb 的 readOnly），所以翻网页不会改动整理记录。
// - 什么时候不能用：库还没建（第一次整理跑过才有）、版本对不上、正被整理作业占着、读的时候出错——一律不抛给网关，
//   回 ready=false 和一句给人看的原因，数据是空的，网页上照空数据画（不要 500）。
// - 这一层是内核的（同 browse.ts）：推理库属于数据目录，记忆插件停用了照样能看已有的结论和问题（网页上的记忆页随插件收起，
//   但接口本身不因为插件停用就报错）；每晚整理的记录在 ergo.db 的派生视图里，由组合根现转进来。
// - 给人看的说法（层、状态、把握……）不在这里拼：只回原值，网页的状态层 state/memory-graph.ts 按协议包的取值表查当前语言。
import fs from "node:fs";
import {
  canSupportUserClaims,
  type Claim,
  DEEPSEEK_DEFAULT_MODEL,
  type Evidence,
  idKind,
  type Inference,
  type MemoryEngine,
  type Question,
  type ExplainedRevision,
  type StoredLink,
  basisGone,
  onGuessAt,
  type Strategy,
} from "@ergo/memory";
import {
  MEMORY_CLAIMS_DEFAULT,
  MEMORY_CLAIMS_MAX,
  MEMORY_CLAIM_STATUSES,
  MEMORY_CLAIM_TIERS,
  MEMORY_QUESTIONS_DEFAULT,
  MEMORY_QUESTIONS_MAX,
  type MemoryClaimBrief,
  type MemoryClaimDetailView,
  type MemoryClaimLinkView,
  type MemoryClaimListPage,
  type MemoryClaimQuery,
  type MemoryEvidenceQuote,
  type MemoryGraphStatus,
  type MemoryInferenceView,
  type MemoryLastNight,
  type MemoryAnswerVerdict,
  type MemoryQuestionEvent,
  type MemoryQuestionItem,
  type MemoryQuestionKind,
  type MemoryQuestionStatus,
  type MemoryQuestionsView,
  type MemoryRevisionOp,
  type MemoryRevisionView,
  type MemoryStatusCounts,
  type MemoryStrategiesView,
  type MemoryStrategyView,
  type MemorySummaryView,
  type MemoryTierCounts,
  t,
} from "@ergo/protocol";
import { clockIso, type Clock } from "../scheduler/clock.ts";
import type { MemoryNightlyRecord } from "./nightly-record.ts";
import { openReasoningDb, type ReasoningDbIssue } from "./rg-db.ts";

/** 记忆的推理库只读视图（网关的 GET /api/memory/… 经它取） */
export interface MemoryGraphReader {
  /** 概览：各层、各状态、问题箱开着几个、最近一次整理（GET /api/memory/summary） */
  summary(): MemorySummaryView;
  /** 结论列表：按层、按状态筛，一页（GET /api/memory/claims） */
  claims(query: MemoryClaimQuery): MemoryClaimListPage;
  /** 一条结论的完整解释；ready 着但没有这条结论时是 undefined（接口回 404） */
  claim(claimId: string): MemoryClaimDetailView | undefined;
  /** 问题箱（GET /api/memory/questions） */
  questions(query: { limit?: number | undefined }): MemoryQuestionsView;
  /** 330 号票：做法（交互策略），不含撤回的（GET /api/memory/strategies） */
  strategies(): MemoryStrategiesView;
}

export interface MemoryGraphReaderOptions {
  /** rg.db 的路径（338 号票起是 <数据目录>/memory/subtext/rg.db；以前在 db 区） */
  file: string;
  clock: Clock;
  /** manifest 里记的整理模型名（只读打开不写 manifest，这个名字只是打开引擎时要的参数） */
  model?: string;
  /** 最近一夜的整理记录（ergo.db 的 memory_nightly 视图）；视图还没建时返回 undefined */
  latestNightly?: () => MemoryNightlyRecord | undefined;
  log?: (line: string) => void;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isBusy = (message: string) => /SQLITE_BUSY|database is locked|database table is locked/i.test(message);

/** 一条结论在列表里的顺序：先按层（近期状态、偏好、需求、价值），同一层里新的在前 */
const tierIndex = (tier: Claim["tier"]): number => MEMORY_CLAIM_TIERS.indexOf(tier);

/** 修订里的前后值写成一行字（对象写成 JSON；太长的截断） */
function valueText(value: unknown): string {
  const text = typeof value === "string" ? value : value === null || value === undefined ? String(value) : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** 各层、各状态的结论数（没有的那种也是 0） */
function countsOf(claims: readonly Claim[]): { total: number; tiers: MemoryTierCounts; statuses: MemoryStatusCounts } {
  const tiers = Object.fromEntries(MEMORY_CLAIM_TIERS.map((tier) => [tier, 0])) as Record<Claim["tier"], number>;
  const statuses = Object.fromEntries(MEMORY_CLAIM_STATUSES.map((status) => [status, 0])) as Record<Claim["status"], number>;
  for (const claim of claims) {
    tiers[claim.tier] += 1;
    statuses[claim.status] += 1;
  }
  return { total: claims.length, tiers, statuses };
}

/** 库里的一行整理记录 → 概览上的那一行 */
function lastNightOf(record: MemoryNightlyRecord): MemoryLastNight {
  return {
    night: record.night,
    at: record.at,
    state: record.state,
    ...(record.ranAt === undefined ? {} : { ranAt: record.ranAt }),
    newClaims: record.newClaims,
    changedClaims: record.changedClaims,
    needsReview: record.needsReview,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    // 242 号票：管理员这一夜额外调了几次模型
    ...(record.curatorModelCalls === undefined ? {} : { curatorModelCalls: record.curatorModelCalls }),
  };
}

/** 一条证据怎么给网页看（能不能当依据也在里面） */
function evidenceViewOf(evidence: Evidence): MemoryEvidenceQuote {
  return {
    id: evidence.id,
    text: evidence.text,
    sourceLevel: evidence.sourceLevel,
    mode: evidence.mode,
    kind: evidence.kind,
    status: evidence.status,
    eventTime: evidence.eventTime,
    observedAt: evidence.observedAt,
    usable: canSupportUserClaims(evidence),
  };
}

/** 列表上的一条结论 */
function briefOf(engine: MemoryEngine, claim: Claim): MemoryClaimBrief {
  const links = engine.store.linksOf(claim.id);
  return {
    id: claim.id,
    statement: claim.statement,
    tier: claim.tier,
    status: claim.status,
    needsReview: claim.needsReview,
    confidence: claim.confidence,
    epistemic: claim.epistemic,
    updatedAt: claim.inferredAt,
    context: claim.context,
    competitors: claim.competesWith.length,
    supports: links.filter((link) => link.polarity === "supports").length,
    refutes: links.filter((link) => link.polarity === "refutes").length,
  };
}

/** 一条关联（证据或事实）连同它引的原话 */
function linkOf(engine: MemoryEngine, link: StoredLink): MemoryClaimLinkView {
  const fact = engine.store.getFact(link.target);
  const ids = fact ? fact.evidenceIds : [link.target];
  return {
    target: link.target,
    kind: idKind(link.target) === "fact" ? "fact" : "evidence",
    statement: fact?.statement ?? null,
    weight: link.weight,
    rationale: link.rationale,
    evidence: ids.flatMap((id) => {
      const evidence = engine.store.getEvidence(id);
      return evidence === undefined ? [] : [evidenceViewOf(evidence)];
    }),
  };
}

function inferenceOf(inference: Inference): MemoryInferenceView {
  return {
    id: inference.id,
    method: inference.method,
    rationale: inference.rationale,
    by: inference.by,
    status: inference.status,
    premiseIds: inference.premiseIds,
    createdAt: inference.createdAt,
  };
}

function revisionOf(revision: ExplainedRevision): MemoryRevisionView {
  return {
    seq: revision.seq,
    op: revision.op as MemoryRevisionOp,
    changes: Object.entries(revision.changes).map(([field, change]) => ({ field, from: valueText(change.from), to: valueText(change.to) })),
    reason: revision.reason,
    at: revision.at,
    // 267 号票：这条修订是哪一次写留下的（谁写的、哪种写操作、经谁转达）
    ...(revision.by === undefined ? {} : { by: { actor: revision.by.actor, op: revision.by.op, ...(revision.by.via === null ? {} : { via: revision.by.via }) } }),
  };
}

/** 问题要弄清的那一条现在什么样：断言的状态、事实的状态、做法的状态（330 号票）；不在了是 missing */
function targetOf(engine: MemoryEngine, target: Question["targets"][number]) {
  const claim = target.kind === "claim" ? engine.store.getClaim(target.id) : undefined;
  const fact = target.kind === "fact" ? engine.store.getFact(target.id) : undefined;
  const strategy = target.kind === "strategy" ? engine.store.getStrategy(target.id) : undefined;
  return {
    id: target.id,
    kind: target.kind,
    statement: claim?.statement ?? fact?.statement ?? target.statement,
    status: claim?.status ?? fact?.status ?? strategy?.status ?? "missing",
  };
}

/** 330 号票：一条做法给网页看（建在猜测上、理由没了照推理库现算，不写库） */
function strategyOf(engine: MemoryEngine, s: Strategy): MemoryStrategyView {
  const at = engine.store.now();
  return {
    id: s.id,
    when: s.when,
    actions: [...s.actions],
    status: s.status,
    onGuess: onGuessAt(engine.store, s, at),
    basisGone: basisGone(engine.store, s),
    basis: s.basisClaimIds.map((id) => {
      const claim = engine.store.getClaim(id);
      return { id, statement: claim?.statement ?? id, status: claim?.status ?? "missing", confidence: claim?.confidence ?? null };
    }),
    confirmedAt: s.confirmedAt,
    createdAt: s.createdAt,
  };
}

function questionOf(engine: MemoryEngine, question: Question): MemoryQuestionItem {
  return {
    id: question.id,
    text: question.text,
    why: question.why,
    kind: question.kind as MemoryQuestionKind,
    sources: question.sources as MemoryQuestionKind[],
    targets: question.targets.map((target) => targetOf(engine, target)),
    priority: question.priority,
    priorityDetail: {
      separation: question.priorityDetail.separation,
      closeness: question.priorityDetail.closeness,
      frequency: question.priorityDetail.frequency,
      fresh: question.priorityDetail.fresh,
    },
    status: question.status as MemoryQuestionStatus,
    domains: question.domains,
    askedCount: question.askedCount,
    skippedCount: question.skippedCount,
    outcome: question.outcome,
    answerEvidenceId: question.answerEvidenceId,
    // 264 号票：问过、答过、跳过都看得到——回答的原话（证据还能当依据时）、读成什么、经过
    answerText: answerTextOf(engine, question.answerEvidenceId),
    verdict: question.verdict as MemoryAnswerVerdict | null,
    clear: question.clear,
    lastAskedAt: question.lastAskedAt,
    answeredAt: question.answeredAt,
    history: engine.questions.history(question.id).map((entry) => ({ event: entry.event as MemoryQuestionEvent, detail: entry.detail, at: entry.at })),
    createdAt: question.createdAt,
    expiresAt: question.expiresAt,
  };
}

/** 回答的原话：那条证据还在、还能当依据（没被忘掉、纠正）才给；没答、删了是 null */
function answerTextOf(engine: MemoryEngine, evidenceId: string | null): string | null {
  if (evidenceId === null) return null;
  const evidence = engine.store.getEvidence(evidenceId);
  return evidence !== undefined && evidence.status === "active" ? evidence.text : null;
}

/** 结论列表：按层、按状态筛，排好序，截到上限 */
function claimsOf(engine: MemoryEngine, query: MemoryClaimQuery): MemoryClaimListPage {
  const found = engine.store.listClaims({
    ...(query.tier === undefined ? {} : { tier: query.tier }),
    ...(query.status === undefined ? {} : { status: query.status as Claim["status"] }),
  });
  const sorted = found.toSorted((a, b) => tierIndex(a.tier) - tierIndex(b.tier) || Date.parse(b.inferredAt) - Date.parse(a.inferredAt) || a.id.localeCompare(b.id));
  const limit = Math.max(0, Math.min(query.limit ?? MEMORY_CLAIMS_DEFAULT, MEMORY_CLAIMS_MAX));
  return { ready: true, total: sorted.length, items: sorted.slice(0, limit).map((claim) => briefOf(engine, claim)) };
}

/** 库不能用的原因 → 给人看的一句话（和每晚整理记进待我处理的是同一套说法） */
function issueText(issue: ReasoningDbIssue): string {
  switch (issue.code) {
    case "manifest_missing":
      return t("memory.nightly.issue.manifestMissing");
    case "schema_mismatch":
      return t("memory.nightly.issue.schemaMismatch", { found: issue.found, expected: issue.expected });
    case "store_schema_mismatch":
      return t("memory.nightly.issue.storeSchemaMismatch", { found: issue.found, expected: issue.expected });
    case "open_failed":
      return t("memory.nightly.issue.openFailed", { detail: issue.detail });
  }
}

export function createMemoryGraphReader(options: MemoryGraphReaderOptions): MemoryGraphReader {
  const { file } = options;
  const log = options.log ?? (() => {});
  const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;

  /**
   * 打开库、用一下、关掉。库里不能用（没建、版本不对、正被占着、读出错）时叫 empty 拿一份空数据，
   * 不把错抛给网关（网页上要的是空数据和一句原因，不是 500）。
   */
  const read = <T>(fn: (engine: MemoryEngine) => T, empty: (status: MemoryGraphStatus) => T): T => {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      return empty({ ready: false, reason: t("memory.graph.notBuilt") });
    }
    let opened;
    try {
      opened = openReasoningDb({ file, clock: () => clockIso(options.clock), model, readOnly: true });
    } catch (err) {
      const detail = messageOf(err);
      log(`记忆的推理库打不开：${detail}`);
      return empty({ ready: false, reason: t("memory.graph.readFailed", { detail }) });
    }
    if (!opened.ok) return empty({ ready: false, reason: issueText(opened.issue) });
    const engine = opened.engine;
    try {
      return fn(engine);
    } catch (err) {
      const detail = messageOf(err);
      log(`记忆的推理库读不出来：${detail}`);
      return empty({ ready: false, reason: isBusy(detail) ? t("memory.graph.busy") : t("memory.graph.readFailed", { detail }) });
    } finally {
      engine.close();
    }
  };

  return {
    summary() {
      return read<MemorySummaryView>(
        (engine) => {
          const claims = engine.store.listClaims();
          const counts = countsOf(claims);
          const openQuestions = engine.questions.listRaw({ status: ["open", "asked"] }).length;
          let latest: MemoryNightlyRecord | undefined;
          try {
            latest = options.latestNightly?.();
          } catch (err) {
            // 整理记录的派生视图还没建（记忆插件没启用过、旧的库）：概览照给，只是没有那一行
            log(`记忆的整理记录读不出来：${messageOf(err)}`);
          }
          return {
            ready: true,
            ...counts,
            openQuestions,
            ...(latest === undefined ? {} : { lastNight: lastNightOf(latest) }),
          } satisfies MemorySummaryView;
        },
        (status) => ({
          ...status,
          total: 0,
          tiers: Object.fromEntries(MEMORY_CLAIM_TIERS.map((tier) => [tier, 0])) as Record<Claim["tier"], number>,
          statuses: Object.fromEntries(MEMORY_CLAIM_STATUSES.map((s) => [s, 0])) as Record<Claim["status"], number>,
          openQuestions: 0,
        }),
      );
    },
    claims(query) {
      return read(
        (engine) => claimsOf(engine, query),
        (status) => ({ ...status, total: 0, items: [] }),
      );
    },
    claim(claimId) {
      return read<MemoryClaimDetailView | undefined>(
        (engine) => {
          const claim = engine.store.getClaim(claimId);
          if (claim === undefined) return undefined;
          const explanation = engine.explainClaim(claimId);
          const links = engine.store.linksOf(claimId);
          return {
            ready: true,
            claim: { ...briefOf(engine, claim), method: claim.method, validFrom: claim.validFrom, validTo: claim.validTo, inferredAt: claim.inferredAt, reviewedAt: claim.reviewedAt, retractedBy: claim.retractedBy, supersededBy: claim.supersededBy },
            ...(explanation.group === null ? {} : { group: { key: explanation.group.key, pattern: explanation.group.pattern, description: explanation.group.description } }),
            supports: links.filter((link) => link.polarity === "supports").map((link) => linkOf(engine, link)),
            refutes: links.filter((link) => link.polarity === "refutes").map((link) => linkOf(engine, link)),
            background: links.filter((link) => link.polarity === "context").map((link) => linkOf(engine, link)),
            competitors: explanation.competitors.map((other) => briefOf(engine, other)),
            inferences: explanation.inferences.map(inferenceOf),
            premises: explanation.premises,
            evidence: explanation.evidence,
            revisions: explanation.revisions.map(revisionOf),
            ...(explanation.whyGuess === null ? {} : { whyGuess: explanation.whyGuess }),
          } satisfies MemoryClaimDetailView;
        },
        (status) => ({ ...status, supports: [], refutes: [], background: [], competitors: [], inferences: [], evidence: [], revisions: [] }),
      );
    },
    questions(query) {
      return read<MemoryQuestionsView>(
        (engine) => {
          const all = engine.questions.listRaw();
          const open = all.filter((question) => question.status === "open" || question.status === "asked").length;
          const limit = Math.max(0, Math.min(query.limit ?? MEMORY_QUESTIONS_DEFAULT, MEMORY_QUESTIONS_MAX));
          return { ready: true, total: all.length, open, items: all.slice(0, limit).map((question) => questionOf(engine, question)) } satisfies MemoryQuestionsView;
        },
        (status) => ({ ...status, total: 0, open: 0, items: [] }),
      );
    },
    strategies() {
      return read<MemoryStrategiesView>(
        // 只读：直接列（不跑 StrategyBook 的同步，那一步要写库），在用的在前
        (engine) => ({
          ready: true,
          items: engine.store
            .listStrategies({ status: ["active", "proposed", "paused"] })
            .toSorted((a, b) => Number(b.status === "active") - Number(a.status === "active") || a.id.localeCompare(b.id))
            .map((s) => strategyOf(engine, s)),
        }),
        (status) => ({ ...status, items: [] }),
      );
    },
  };
}
