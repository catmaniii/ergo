// 记忆 · 结论 / 证据与推理 / 问题箱（233 号票）的状态层推导：
// - 层、状态、把握、认知来源、关联的多重、证据的来源和有效性、问题的种类和状态、修订的哪种操作、最近一次整理跑成什么样，
//   都在这里按协议包的取值表现查当前语言（常量表取值时现查，换语言不用刷新）；
// - 列表：一行上的编号、层级、状态、把握、来源和更新时间；按层分组（层的先后固定，空层不出现）；状态筛的选项带条数；
// - 一条结论的完整解释：支持/反证/背景（为什么算、多重、引的原话）、推断（怎么推出来的）、证据链（一层层缩进）、修订记录；
// - 问题箱：问什么、为什么问、能区分哪几条（带它们现在的状态）、优先级、状态；
// - 概览：一共几条结论、各层各几条、问题箱开着几个、最近一次整理的时间和新增条数。
// - 330 号票：每条结论一行上有醒目的"已验证 / 猜测"小签（标着复核的再加"复核中"）；猜测的详情写"为什么还是猜测"；
//   做法（交互策略）一行：在用 / 待你确认、"建在猜测上"、"理由没了"的小签，下面是依据的结论和它们现在的状态。
// 推导都在这里，界面只画（MemoryGraphPages.tsx）；接口的形状和取值在协议包的 memory.ts。
import {
  MEMORY_CLAIM_STATUSES,
  MEMORY_CLAIM_TIERS,
  type MemoryClaimBrief,
  type MemoryClaimDetailView,
  type MemoryClaimLinkView,
  type MemoryClaimStatus,
  type MemoryClaimTier,
  type MemoryConfidence,
  type MemoryEpistemic,
  type MemoryEvidenceQuote,
  type MemoryEvidenceSource,
  type MemoryInferenceView,
  type MemoryLastNight,
  type MemoryLinkWeight,
  type MemoryNightlyState,
  type MemoryPremiseNode,
  type MemoryAnswerVerdict,
  type MemoryQuestionEvent,
  type MemoryQuestionItem,
  type MemoryQuestionKind,
  type MemoryQuestionStatus,
  type MemoryRevisionOp,
  type MemoryRevisionView,
  type MemoryWriteActor,
  type MemoryWriteOp,
  type MemoryStatusCounts,
  type MemoryStrategyStatus,
  type MemoryStrategyView,
  type MemorySummaryView,
  t,
  tTable,
} from "./protocol.ts";

/** 层的说法（顺序就是分组、筛选的先后） */
export const MEMORY_TIER_LABEL: Readonly<Record<MemoryClaimTier, string>> = tTable({
  state: "state.memoryGraph.tier.state",
  preference: "state.memoryGraph.tier.preference",
  need: "state.memoryGraph.tier.need",
  value: "state.memoryGraph.tier.value",
});

/** 结论的状态（329 号票：已验证、猜测、撤回、被取代；待复核不再是状态，是复核标记） */
export const MEMORY_CLAIM_STATUS_LABEL: Readonly<Record<MemoryClaimStatus, string>> = tTable({
  active: "state.memoryGraph.claimStatus.active",
  contested: "state.memoryGraph.claimStatus.contested",
  retracted: "state.memoryGraph.claimStatus.retracted",
  superseded: "state.memoryGraph.claimStatus.superseded",
});

/** 把握 */
export const MEMORY_CONFIDENCE_LABEL: Readonly<Record<MemoryConfidence, string>> = tTable({
  high: "state.memoryGraph.confidence.high",
  medium: "state.memoryGraph.confidence.medium",
  low: "state.memoryGraph.confidence.low",
});

/** 认知来源 */
export const MEMORY_EPISTEMIC_LABEL: Readonly<Record<MemoryEpistemic, string>> = tTable({
  explicit: "state.memoryGraph.epistemic.explicit",
  inferred: "state.memoryGraph.epistemic.inferred",
  user_confirmed: "state.memoryGraph.epistemic.userConfirmed",
});

/** 一条关联有多重 */
export const MEMORY_LINK_WEIGHT_LABEL: Readonly<Record<MemoryLinkWeight, string>> = tTable({
  weak: "state.memoryGraph.weight.weak",
  strong: "state.memoryGraph.weight.strong",
  decisive: "state.memoryGraph.weight.decisive",
});

/** 证据的来源等级（和记忆 · 素材那边不是一套取值：推理库的 untrusted 是别人转述的） */
export const MEMORY_EVIDENCE_SOURCE_LABEL: Readonly<Record<MemoryEvidenceSource, string>> = tTable({
  self: "state.memoryGraph.source.self",
  agent: "state.memoryGraph.source.agent",
  untrusted: "state.memoryGraph.source.untrusted",
  system: "state.memoryGraph.source.system",
});

/** 问题从哪来 */
export const MEMORY_QUESTION_KIND_LABEL: Readonly<Record<MemoryQuestionKind, string>> = tTable({
  unresolved: "state.memoryGraph.questionKind.unresolved",
  contradiction: "state.memoryGraph.questionKind.contradiction",
  low_confidence_high_value: "state.memoryGraph.questionKind.lowConfidenceHighValue",
  tension: "state.memoryGraph.questionKind.tension",
  normative: "state.memoryGraph.questionKind.normative",
  prediction_violation: "state.memoryGraph.questionKind.predictionViolation",
  out_of_character: "state.memoryGraph.questionKind.outOfCharacter",
  strategy_basis: "state.memoryGraph.questionKind.strategyBasis",
  relayed: "state.memoryGraph.questionKind.relayed",
  counterexample: "state.memoryGraph.questionKind.counterexample",
});

/** 330 号票：做法（交互策略）的状态 */
export const MEMORY_STRATEGY_STATUS_LABEL: Readonly<Record<MemoryStrategyStatus, string>> = tTable({
  proposed: "state.memoryGraph.strategyStatus.proposed",
  active: "state.memoryGraph.strategyStatus.active",
  paused: "state.memoryGraph.strategyStatus.paused",
  retracted: "state.memoryGraph.strategyStatus.retracted",
});

/** 330 号票：醒目的小签（已验证是绿的、猜测是橙的、别的是淡的） */
export interface MemoryBadge {
  readonly label: string;
  readonly tone: "ok" | "guess" | "quiet";
}

/** 330 号票：一条结论的真值小签——已验证 / 猜测（撤回、被取代的淡写），标着复核的再加一个"复核中" */
export function memoryClaimBadges(item: Pick<MemoryClaimBrief, "status" | "needsReview">): MemoryBadge[] {
  const tone: MemoryBadge["tone"] = item.status === "active" ? "ok" : item.status === "contested" ? "guess" : "quiet";
  return [{ label: MEMORY_CLAIM_STATUS_LABEL[item.status], tone }, ...(item.needsReview ? [{ label: t("state.memoryGraph.badge.review"), tone: "quiet" as const }] : [])];
}

/** 问题的状态 */
export const MEMORY_QUESTION_STATUS_LABEL: Readonly<Record<MemoryQuestionStatus, string>> = tTable({
  open: "state.memoryGraph.questionStatus.open",
  asked: "state.memoryGraph.questionStatus.asked",
  answered: "state.memoryGraph.questionStatus.answered",
  resolved: "state.memoryGraph.questionStatus.resolved",
  declined: "state.memoryGraph.questionStatus.declined",
  retired: "state.memoryGraph.questionStatus.retired",
  expired: "state.memoryGraph.questionStatus.expired",
  obsolete: "state.memoryGraph.questionStatus.obsolete",
});

/** 问题经过里的一笔（264 号票：问过、跳过、答了……） */
export const MEMORY_QUESTION_EVENT_LABEL: Readonly<Record<MemoryQuestionEvent, string>> = tTable({
  created: "state.memoryGraph.questionEvent.created",
  asked: "state.memoryGraph.questionEvent.asked",
  skipped: "state.memoryGraph.questionEvent.skipped",
  retired: "state.memoryGraph.questionEvent.retired",
  answered: "state.memoryGraph.questionEvent.answered",
  resolved: "state.memoryGraph.questionEvent.resolved",
  declined: "state.memoryGraph.questionEvent.declined",
  expired: "state.memoryGraph.questionEvent.expired",
  obsolete: "state.memoryGraph.questionEvent.obsolete",
  // 271 号票：每晚整理时记忆管理员拿不准你答没答，留到下一夜
  unsure: "state.memoryGraph.questionEvent.unsure",
});

/** 你的回答读成什么（264 号票） */
export const MEMORY_ANSWER_VERDICT_LABEL: Readonly<Record<MemoryAnswerVerdict, string>> = tTable({
  yes: "state.memoryGraph.verdict.yes",
  no: "state.memoryGraph.verdict.no",
  unclear: "state.memoryGraph.verdict.unclear",
});

/** 最近一次整理跑成什么样 */
export const MEMORY_NIGHTLY_STATE_LABEL: Readonly<Record<MemoryNightlyState, string>> = tTable({
  ran: "state.memoryGraph.nightly.ran",
  deferred: "state.memoryGraph.nightly.deferred",
  skipped: "state.memoryGraph.nightly.skipped",
  failed: "state.memoryGraph.nightly.failed",
  rebuild_needed: "state.memoryGraph.nightly.rebuildNeeded",
});

/** 修订的哪种操作 */
const REVISION_OP_LABEL: Readonly<Record<MemoryRevisionOp, string>> = tTable({
  create: "state.memoryGraph.revisionOp.create",
  update: "state.memoryGraph.revisionOp.update",
  delete: "state.memoryGraph.revisionOp.delete",
});

/** 267 号票：推理图谱是谁写的（唯一写入口的留痕） */
const WRITE_ACTOR_LABEL: Readonly<Record<MemoryWriteActor, string>> = tTable({
  nightly: "state.memoryGraph.writeActor.nightly",
  curator: "state.memoryGraph.writeActor.curator",
  user_verdict: "state.memoryGraph.writeActor.userVerdict",
  user: "state.memoryGraph.writeActor.user",
});

/** 267 号票：唯一写入口的哪种写操作 */
const WRITE_OP_LABEL: Readonly<Record<MemoryWriteOp, string>> = tTable({
  ingest: "state.memoryGraph.writeOp.ingest",
  extract: "state.memoryGraph.writeOp.extract",
  explicit: "state.memoryGraph.writeOp.explicit",
  propose: "state.memoryGraph.writeOp.propose",
  attach: "state.memoryGraph.writeOp.attach",
  probe: "state.memoryGraph.writeOp.probe",
  mark_review: "state.memoryGraph.writeOp.markReview",
  verdict: "state.memoryGraph.writeOp.verdict",
  predict: "state.memoryGraph.writeOp.predict",
  decide: "state.memoryGraph.writeOp.decide",
  lift: "state.memoryGraph.writeOp.lift",
  writeback: "state.memoryGraph.writeOp.writeback",
  validate: "state.memoryGraph.writeOp.validate",
  correct: "state.memoryGraph.writeOp.correct",
  forget: "state.memoryGraph.writeOp.forget",
  purge: "state.memoryGraph.writeOp.purge",
  no_infer: "state.memoryGraph.writeOp.noInfer",
  question: "state.memoryGraph.writeOp.question",
  ask: "state.memoryGraph.writeOp.ask",
  skip: "state.memoryGraph.writeOp.skip",
  decline: "state.memoryGraph.writeOp.decline",
  migrate: "state.memoryGraph.writeOp.migrate",
  rejudge: "state.memoryGraph.writeOp.rejudge",
});

/** 推断的状态：成立、停用（等重推）、撤回、历史（329 号票：被直接证实以后原来的推理链） */
const INFERENCE_STATUS_LABEL: Readonly<Record<MemoryInferenceView["status"], string>> = tTable({
  active: "state.memoryGraph.inference.active",
  needs_review: "state.memoryGraph.inference.needsReview",
  retracted: "state.memoryGraph.inference.retracted",
  history: "state.memoryGraph.inference.history",
});

/** 事实的状态（问题要弄清的事实才用得上；断言的用 MEMORY_CLAIM_STATUS_LABEL） */
const FACT_STATUS_LABEL: Readonly<Record<string, string>> = tTable({
  active: "state.memoryGraph.factStatus.active",
  contested: "state.memoryGraph.factStatus.contested",
  superseded: "state.memoryGraph.factStatus.superseded",
  corrected: "state.memoryGraph.factStatus.corrected",
  retracted: "state.memoryGraph.factStatus.retracted",
});

/** "2026-10-06T22:40:00.000+08:00" → "10-06 22:40" */
function minuteOf(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

/** 一条结论在列表里的样子 */
export interface MemoryClaimRow {
  readonly id: string;
  readonly statement: string;
  /** 编号 · 层级 · 状态 · 把握 · 来源 */
  readonly meta: string;
  /** "10-10 03:00 更新" */
  readonly updated: string;
  /** 支持、反证、竞争解释的条数小签（0 的不出现） */
  readonly chips: readonly string[];
  /** 330 号票：醒目的"已验证 / 猜测"小签 */
  readonly badges: readonly MemoryBadge[];
}

export function memoryClaimRow(item: MemoryClaimBrief): MemoryClaimRow {
  return {
    id: item.id,
    statement: item.statement,
    meta: [item.id, MEMORY_TIER_LABEL[item.tier], MEMORY_CLAIM_STATUS_LABEL[item.status], MEMORY_CONFIDENCE_LABEL[item.confidence], MEMORY_EPISTEMIC_LABEL[item.epistemic]].join(" · "),
    updated: t("state.memoryGraph.updated", { time: minuteOf(item.updatedAt) }),
    chips: [
      ...(item.supports > 0 ? [t("state.memoryGraph.chip.supports", { count: item.supports })] : []),
      ...(item.refutes > 0 ? [t("state.memoryGraph.chip.refutes", { count: item.refutes })] : []),
      ...(item.competitors > 0 ? [t("state.memoryGraph.chip.competitors", { count: item.competitors })] : []),
    ],
    badges: memoryClaimBadges(item),
  };
}

/** 330 号票：一条做法在列表里的样子 */
export interface MemoryStrategyRow {
  readonly id: string;
  /** 触发场合：做法一；做法二 */
  readonly text: string;
  /** 状态、"建在猜测上"、"理由没了" */
  readonly badges: readonly MemoryBadge[];
  /** 依据：编号「陈述」（状态） */
  readonly basis: string;
  /** 建在猜测上 / 理由没了时多一句说明（没有是 undefined） */
  readonly note?: string;
}

export function memoryStrategyRow(view: MemoryStrategyView): MemoryStrategyRow {
  const badges: MemoryBadge[] = [{ label: MEMORY_STRATEGY_STATUS_LABEL[view.status], tone: view.status === "active" ? "ok" : "quiet" }];
  if (view.onGuess) badges.push({ label: t("state.memoryGraph.badge.onGuess"), tone: "guess" });
  if (view.basisGone) badges.push({ label: t("state.memoryGraph.badge.basisGone"), tone: "guess" });
  const basis = view.basis
    .map((b) => t("state.memoryGraph.strategyBasisItem", { id: b.id, statement: b.statement, status: b.status === "missing" ? t("state.memoryGraph.strategyBasisMissing") : MEMORY_CLAIM_STATUS_LABEL[b.status] }))
    .join(t("state.memoryGraph.strategySep"));
  const note = view.basisGone ? t("state.memoryGraph.strategyNote.basisGone") : view.onGuess ? t("state.memoryGraph.strategyNote.onGuess") : undefined;
  return {
    id: view.id,
    text: t("state.memoryGraph.strategyText", { when: view.when, actions: view.actions.join(t("state.memoryGraph.strategySep")) }),
    badges,
    basis: t("state.memoryGraph.strategyBasis", { basis }),
    ...(note === undefined ? {} : { note }),
  };
}

/** 330 号票（R5）：猜测为什么还是猜测——一行一条（没证实的前提、证据哪里不够）；不是猜测是空的 */
export function memoryGuessLines(why: MemoryClaimDetailView["whyGuess"]): string[] {
  if (why === undefined) return [];
  return [
    ...why.unverifiedPremises.map((p) =>
      t("state.memoryGraph.guessPremise", { id: p.id, statement: p.statement, status: (MEMORY_CLAIM_STATUS_LABEL as Readonly<Record<string, string>>)[p.status] ?? p.status }),
    ),
    ...(why.evidence === null ? [] : [t("state.memoryGraph.guessEvidence", { reason: why.evidence })]),
  ];
}

/** 列表里的一层 */
export interface MemoryClaimGroup {
  readonly tier: MemoryClaimTier;
  readonly label: string;
  readonly items: readonly MemoryClaimBrief[];
}

/** 按层分组：层的先后固定（近期状态、偏好、需求、价值），没有结论的层不出现 */
export function memoryClaimGroups(items: readonly MemoryClaimBrief[]): MemoryClaimGroup[] {
  return MEMORY_CLAIM_TIERS.map((tier) => ({ tier, label: MEMORY_TIER_LABEL[tier], items: items.filter((item) => item.tier === tier) })).filter((group) => group.items.length > 0);
}

/** 状态筛的一个选项（全部 + 各种状态）；条数从概览来，取不到就不写 */
export interface MemoryClaimStatusChoice {
  readonly value: MemoryClaimStatus | "all";
  readonly label: string;
  readonly count?: number;
}

export function memoryClaimStatusChoices(counts?: MemoryStatusCounts): MemoryClaimStatusChoice[] {
  return [
    { value: "all", label: t("state.memoryGraph.statusAll") },
    ...MEMORY_CLAIM_STATUSES.map((status) => ({ value: status, label: MEMORY_CLAIM_STATUS_LABEL[status], ...(counts === undefined ? {} : { count: counts[status] }) })),
  ];
}

/** 一条原话在网页上的样子 */
export interface MemoryQuoteRow {
  readonly id: string;
  /** 原话（忘掉的是"（原文已忘掉）"） */
  readonly text: string;
  /** 编号 · 谁说的 · 什么时候（· 不当依据） */
  readonly meta: string;
  readonly usable: boolean;
}

export function memoryQuoteRow(evidence: MemoryEvidenceQuote): MemoryQuoteRow {
  const when = evidence.eventTime === null ? t("state.memoryGraph.timeUnknown") : minuteOf(evidence.eventTime);
  const meta = `${evidence.id} · ${MEMORY_EVIDENCE_SOURCE_LABEL[evidence.sourceLevel]} · ${when}${evidence.usable ? "" : t("state.memoryGraph.notBasis")}`;
  return { id: evidence.id, text: evidence.text.trim().length > 0 ? evidence.text : t("state.memoryGraph.quoteGone"), meta, usable: evidence.usable };
}

/** 一条支持、反证或背景 */
export interface MemoryLinkRow {
  /** 证据编号或事实编号 */
  readonly id: string;
  /** "fa-0002 · 支持 · 强" 或 "ev-0001 · 支持 · 决定性" */
  readonly title: string;
  /** 为什么算支持、反证、背景 */
  readonly rationale: string;
  /** 目标是事实时它的精炼陈述 */
  readonly statement?: string;
  readonly quotes: readonly MemoryQuoteRow[];
}

export function memoryLinkRow(link: MemoryClaimLinkView, polarity: "supports" | "refutes" | "context"): MemoryLinkRow {
  const role = t(`state.memoryGraph.polarity.${polarity}`);
  return {
    id: link.target,
    title: [link.target, role, MEMORY_LINK_WEIGHT_LABEL[link.weight]].join(" · "),
    rationale: link.rationale,
    ...(link.statement === null ? {} : { statement: link.statement }),
    quotes: link.evidence.map(memoryQuoteRow),
  };
}

/** 证据链上的一行（一层缩进一层） */
export interface MemoryPremiseRow {
  readonly depth: number;
  readonly kind: MemoryPremiseNode["kind"];
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly truncated: boolean;
}

/** 把证据链一层层摊平：结论 → 前提 → 事实 → 原话 */
export function memoryPremiseRows(root: MemoryPremiseNode | undefined): MemoryPremiseRow[] {
  if (root === undefined) return [];
  const rows: MemoryPremiseRow[] = [];
  const walk = (node: MemoryPremiseNode, depth: number): void => {
    rows.push({ depth, kind: node.kind, id: node.id, label: node.label, status: node.status, truncated: node.truncated === true });
    for (const premise of node.premises) walk(premise, depth + 1);
  };
  walk(root, 0);
  return rows;
}

/** 证据链上的每一种（结论、事实、原话） */
export const MEMORY_PREMISE_KIND_LABEL: Readonly<Record<MemoryPremiseNode["kind"], string>> = tTable({
  claim: "state.memoryGraph.premise.claim",
  fact: "state.memoryGraph.premise.fact",
  evidence: "state.memoryGraph.premise.evidence",
});

/** 证据的有效性（证据链、原话上写） */
const EVIDENCE_STATUS_LABEL: Readonly<Record<string, string>> = tTable({
  active: "state.memoryGraph.evidenceStatus.active",
  forgotten: "state.memoryGraph.evidenceStatus.forgotten",
  corrected: "state.memoryGraph.evidenceStatus.corrected",
});

/** 证据链一行的状态：结论用断言的说法、事实用事实的、原话用证据的 */
export function memoryPremiseStatusText(row: Pick<MemoryPremiseRow, "kind" | "status">): string {
  if (row.kind === "claim") return MEMORY_CLAIM_STATUS_LABEL[row.status as MemoryClaimStatus] ?? t("state.memoryGraph.targetGone");
  if (row.kind === "fact") return FACT_STATUS_LABEL[row.status] ?? t("state.memoryGraph.targetGone");
  return EVIDENCE_STATUS_LABEL[row.status] ?? t("state.memoryGraph.targetGone");
}

/** 一条推断（这条结论是怎么推出来的） */
export interface MemoryInferenceRow {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly premises: string;
}

export function memoryInferenceRow(inference: MemoryInferenceView): MemoryInferenceRow {
  return {
    id: inference.id,
    title: [inference.id, t(`state.memoryGraph.method.${inference.method}`), INFERENCE_STATUS_LABEL[inference.status], inference.by].join(" · "),
    rationale: inference.rationale,
    premises: inference.premiseIds.join(t("state.memoryGraph.listSep")),
  };
}

/** 一条修订 */
export interface MemoryRevisionRow {
  readonly seq: number;
  readonly title: string;
  readonly when: string;
  readonly reason: string;
  /** 267 号票：谁写的、做什么（"记忆管理员（夜班）· 判成立或推翻"）；写入口以前的老修订是空串 */
  readonly by: string;
  /** 改了的字段：一行一个"字段：之前 → 之后" */
  readonly changes: readonly string[];
}

export function memoryRevisionRow(revision: MemoryRevisionView): MemoryRevisionRow {
  const by = revision.by;
  return {
    seq: revision.seq,
    by:
      by === undefined
        ? ""
        : by.via === undefined
          ? t("state.memoryGraph.revision.by", { actor: WRITE_ACTOR_LABEL[by.actor], op: WRITE_OP_LABEL[by.op] })
          : t("state.memoryGraph.revision.byVia", { actor: WRITE_ACTOR_LABEL[by.actor], op: WRITE_OP_LABEL[by.op], via: by.via }),
    title: t("state.memoryGraph.revision.title", { seq: revision.seq, op: REVISION_OP_LABEL[revision.op] }),
    when: minuteOf(revision.at),
    reason: revision.reason,
    changes: revision.changes.map((change) => t("state.memoryGraph.revision.change", { field: change.field, from: change.from, to: change.to })),
  };
}

/** 一条问题在网页上的样子 */
export interface MemoryQuestionRow {
  readonly id: string;
  readonly text: string;
  readonly why: string;
  /** 能区分哪几条：陈述（它们现在的状态） */
  readonly targets: readonly string[];
  /** "优先级 72%" */
  readonly priority: string;
  /** 种类 · 优先级 · 状态 · 问过几次 · 跳过几次 */
  readonly meta: string;
  readonly status: string;
  /** 你的回答：原话和读成什么（264 号票）；没答、原话不在了是 undefined */
  readonly answer?: string;
  /** 判的结果（之前 → 之后，谁胜出）；没判是 undefined */
  readonly outcome?: string;
  /** 经过：每一笔"10-10 20:01 顺口问了"，按先后（264 号票） */
  readonly history: readonly string[];
}

/** 目标现在的状态：断言用断言的状态说法，事实用事实的；不在了的也写明 */
function targetStatusText(target: MemoryQuestionItem["targets"][number]): string {
  if (target.kind === "claim") return MEMORY_CLAIM_STATUS_LABEL[target.status as MemoryClaimStatus] ?? t("state.memoryGraph.targetGone");
  return FACT_STATUS_LABEL[target.status] ?? t("state.memoryGraph.targetGone");
}

export function memoryQuestionRow(item: MemoryQuestionItem): MemoryQuestionRow {
  const priority = t("state.memoryGraph.priority", { percent: Math.round(item.priority * 100) });
  const status = MEMORY_QUESTION_STATUS_LABEL[item.status];
  const asked = item.askedCount > 0 ? t("state.memoryGraph.askedCount", { count: item.askedCount }) : undefined;
  const skipped = item.skippedCount > 0 ? t("state.memoryGraph.skippedCount", { count: item.skippedCount }) : undefined;
  const answer =
    item.answerText !== null && item.verdict !== null
      ? t(item.clear ? "state.memoryGraph.answerClear" : "state.memoryGraph.answer", { text: item.answerText, verdict: MEMORY_ANSWER_VERDICT_LABEL[item.verdict] })
      : undefined;
  return {
    id: item.id,
    text: item.text,
    why: item.why,
    targets: item.targets.map((target) => t("state.memoryGraph.questionTarget", { statement: target.statement, status: targetStatusText(target) })),
    priority,
    meta: [MEMORY_QUESTION_KIND_LABEL[item.kind], priority, status, ...(asked === undefined ? [] : [asked]), ...(skipped === undefined ? [] : [skipped])].join(" · "),
    status,
    ...(answer === undefined ? {} : { answer }),
    ...(item.outcome === null ? {} : { outcome: t("state.memoryGraph.outcome", { outcome: item.outcome }) }),
    history: item.history.map((entry) => t("state.memoryGraph.historyEntry", { time: minuteOf(entry.at), event: MEMORY_QUESTION_EVENT_LABEL[entry.event] })),
  };
}

/** 结论列表顶上的一行：一共几条，各层各几条 */
export function memorySummaryLine(summary: Pick<MemorySummaryView, "ready" | "total" | "tiers">): string {
  if (!summary.ready) return t("state.memoryGraph.notReady");
  if (summary.total === 0) return t("state.memoryGraph.noClaims");
  const tiers = MEMORY_CLAIM_TIERS.map((tier) => t("state.memoryGraph.tierCount", { tier: MEMORY_TIER_LABEL[tier], count: summary.tiers[tier] })).join(t("state.memoryGraph.listSep"));
  return t("state.memoryGraph.summaryLine", { count: summary.total, tiers });
}

/** 问题箱顶上的一行：开着几个、一共几个 */
export function memoryQuestionsLine(view: { ready: boolean; open: number; total: number }): string {
  if (!view.ready) return t("state.memoryGraph.notReady");
  return view.total === 0 ? t("state.memoryGraph.noQuestions") : t("state.memoryGraph.questionsLine", { open: view.open, count: view.total });
}

/** 最近一次整理那一行；一次都没跑过写明白 */
export function memoryLastNightLine(lastNight: MemoryLastNight | undefined): string {
  if (lastNight === undefined) return t("state.memoryGraph.nightly.none");
  return t("state.memoryGraph.nightly.line", {
    night: lastNight.night,
    state: MEMORY_NIGHTLY_STATE_LABEL[lastNight.state],
    newClaims: lastNight.newClaims,
    changedClaims: lastNight.changedClaims,
    needsReview: lastNight.needsReview,
  });
}

/** 一条结论详情顶上的一行（层级 · 状态 · 把握 · 来源 · 推法） */
export function memoryClaimDetailMeta(claim: MemoryClaimDetailView["claim"]): string {
  if (claim === undefined) return "";
  return [claim.id, MEMORY_TIER_LABEL[claim.tier], MEMORY_CLAIM_STATUS_LABEL[claim.status], MEMORY_CONFIDENCE_LABEL[claim.confidence], MEMORY_EPISTEMIC_LABEL[claim.epistemic], t(`state.memoryGraph.method.${claim.method}`)].join(" · ");
}

/**
 * 记忆管理员那一层顶上的一行（242 号票）：最近一次整理跑成什么样，外加管理员自己额外花了几次模型调用。
 * 一次都没跑过时写"还没整理过"（整理第一次要配好模型 key）。
 */
export function memoryCuratorNightLine(lastNight: MemoryLastNight | undefined): string {
  if (lastNight === undefined) return t("state.memoryGraph.curator.none");
  const line = memoryLastNightLine(lastNight);
  return lastNight.curatorModelCalls === undefined ? line : `${line}${t("state.memoryGraph.curator.calls", { calls: lastNight.curatorModelCalls })}`;
}

/** 有效期那一行；两头都不知道是 undefined */
export function memoryClaimValidity(claim: MemoryClaimDetailView["claim"]): string | undefined {
  if (claim === undefined || (claim.validFrom === null && claim.validTo === null)) return undefined;
  return t("state.memoryGraph.validity", {
    from: claim.validFrom === null ? t("state.memoryGraph.validityUnknown") : minuteOf(claim.validFrom),
    to: claim.validTo === null ? t("state.memoryGraph.validityNow") : minuteOf(claim.validTo),
  });
}

/** 撤回、取代它的那一条（有才写） */
export function memoryClaimEndedBy(claim: MemoryClaimDetailView["claim"]): string | undefined {
  if (claim === undefined) return undefined;
  if (claim.retractedBy !== null) return t("state.memoryGraph.retractedBy", { id: claim.retractedBy });
  if (claim.supersededBy !== null) return t("state.memoryGraph.supersededBy", { id: claim.supersededBy });
  return undefined;
}
