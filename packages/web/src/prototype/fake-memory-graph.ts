// 原型里的记忆推理库（233 号票）：结论、证据与推理、问题箱的假数据——照 weekend 那组"周末推掉活动"编的，
// 和 fake-materials.ts 里的假素材对得上（话是同一批）。
// 直接打开构建产物（file://）时没有守护进程，只读接口回这一份；地址带 ?demo-memory-empty（有库、空的）和
// ?demo-memory-off（库还没建）看空数据和降级的样子（截图、page-opens 测试）。
import type {
  MemoryClaimBrief,
  MemoryClaimDetailView,
  MemoryClaimLinkView,
  MemoryClaimListPage,
  MemoryClaimQuery,
  MemoryEvidenceQuote,
  MemoryInferenceView,
  MemoryLastNight,
  MemoryPremiseNode,
  MemoryQuestionItem,
  MemoryQuestionsView,
  MemoryRevisionView,
  MemoryStrategiesView,
  MemorySummaryView,
} from "../state/index.ts";
import { demoParam } from "./fake-connection.ts";

const QUOTE_RELAX: MemoryEvidenceQuote = {
  id: "ev-0001",
  text: "这周六的聚会我就不去了，最近周末想好好休息。",
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  status: "active",
  eventTime: "2026-10-09T20:00:00.000+08:00",
  observedAt: "2026-10-09T20:00:00.000+08:00",
  usable: true,
};

const QUOTE_NOT_FULL: MemoryEvidenceQuote = {
  id: "ev-0002",
  text: "我不反感见朋友，只是不喜欢周末被提前排满。",
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  status: "active",
  eventTime: "2026-10-09T22:00:00.000+08:00",
  observedAt: "2026-10-09T22:00:00.000+08:00",
  usable: true,
};

const QUOTE_HIKED: MemoryEvidenceQuote = {
  id: "ev-0003",
  text: "周末朋友约我去爬山，我还是去了。",
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  status: "active",
  eventTime: "2026-10-08T09:00:00.000+08:00",
  observedAt: "2026-10-08T09:00:00.000+08:00",
  usable: true,
};

const QUOTE_RELAYED: MemoryEvidenceQuote = {
  id: "ev-0004",
  text: "（同事转述）他说他最近喜欢一个人待着。",
  sourceLevel: "untrusted",
  mode: "say",
  kind: "utterance",
  status: "active",
  eventTime: "2026-10-09T22:30:00.000+08:00",
  observedAt: "2026-10-09T22:30:00.000+08:00",
  usable: false,
};

const CLAIMS: MemoryClaimBrief[] = [
  {
    id: "cl-0001",
    statement: "周末需要自己安排时间",
    tier: "need",
    status: "active",
    needsReview: false,
    confidence: "medium",
    epistemic: "inferred",
    updatedAt: "2026-10-10T03:00:00.000+08:00",
    context: ["weekend", "social"],
    competitors: 1,
    supports: 2,
    refutes: 1,
  },
  {
    id: "cl-0002",
    statement: "最近太累，先不想参加社交",
    tier: "need",
    status: "contested",
    needsReview: false,
    confidence: "low",
    epistemic: "inferred",
    updatedAt: "2026-10-09T03:00:00.000+08:00",
    context: ["weekend"],
    competitors: 1,
    supports: 1,
    refutes: 1,
  },
  {
    id: "cl-0003",
    statement: "不喜欢周末被提前排满",
    tier: "preference",
    status: "active",
    needsReview: false,
    confidence: "high",
    epistemic: "explicit",
    updatedAt: "2026-10-09T03:00:00.000+08:00",
    context: ["weekend"],
    competitors: 0,
    supports: 1,
    refutes: 0,
  },
  {
    id: "cl-0004",
    statement: "这阵子周末想在家休息",
    tier: "state",
    status: "active",
    needsReview: false,
    confidence: "medium",
    epistemic: "explicit",
    updatedAt: "2026-10-10T03:00:00.000+08:00",
    context: ["weekend"],
    competitors: 0,
    supports: 1,
    refutes: 0,
  },
];

const SUPPORTS: MemoryClaimLinkView[] = [
  { target: "ev-0001", kind: "evidence", statement: null, weight: "strong", rationale: "这周六的聚会推掉了", evidence: [QUOTE_RELAX] },
  { target: "ev-0002", kind: "evidence", statement: null, weight: "decisive", rationale: "明说只是不想被提前排满", evidence: [QUOTE_NOT_FULL] },
];

const REFUTES: MemoryClaimLinkView[] = [{ target: "ev-0003", kind: "evidence", statement: null, weight: "weak", rationale: "周末也出去过", evidence: [QUOTE_HIKED] }];

const BACKGROUND: MemoryClaimLinkView[] = [{ target: "ev-0004", kind: "evidence", statement: null, weight: "weak", rationale: "别人转述的，不当依据", evidence: [QUOTE_RELAYED] }];

const INFERENCE: MemoryInferenceView = {
  id: "in-0001",
  method: "induction",
  rationale: "连着几次都在周末推掉需要出门的活动",
  by: "rule:4.1",
  status: "active",
  premiseIds: ["ev-0001", "ev-0002"],
  createdAt: "2026-10-10T03:00:00.000+08:00",
};

const PREMISES: MemoryPremiseNode = {
  id: "cl-0001",
  kind: "claim",
  label: "周末需要自己安排时间",
  status: "active",
  premises: [QUOTE_RELAX, QUOTE_NOT_FULL].map((quote) => ({ id: quote.id, kind: "evidence" as const, label: quote.text, status: quote.status, premises: [] })),
};

const REVISIONS: MemoryRevisionView[] = [
  { seq: 1, op: "create", changes: [{ field: "statement", from: "null", to: "周末需要自己安排时间" }], reason: "整理时推出来的", at: "2026-10-09T03:00:00.000+08:00", by: { actor: "nightly", op: "propose" } },
  { seq: 2, op: "update", changes: [{ field: "context", from: '["weekend"]', to: '["weekend","social"]' }], reason: "补上场景：两次都落在周末", at: "2026-10-10T03:00:00.000+08:00", by: { actor: "nightly", op: "decide" } },
];

const QUESTIONS: MemoryQuestionItem[] = [
  {
    id: "qu-0001",
    text: "上次推掉的周末活动，要是时间由你自己定，你会去吗？",
    why: "想自己安排和太累还分不出",
    kind: "unresolved",
    sources: ["unresolved"],
    targets: [
      { id: "cl-0001", kind: "claim", statement: "周末需要自己安排时间", status: "active" },
      { id: "cl-0002", kind: "claim", statement: "最近太累，先不想参加社交", status: "contested" },
    ],
    priority: 0.72,
    priorityDetail: { separation: 1, closeness: 0.8, frequency: 0.6, fresh: 1 },
    status: "open",
    domains: ["social"],
    askedCount: 0,
    skippedCount: 0,
    outcome: null,
    answerEvidenceId: null,
    answerText: null,
    verdict: null,
    clear: false,
    lastAskedAt: null,
    answeredAt: null,
    history: [{ event: "created", detail: "整理时生成（unresolved）", at: "2026-10-10T03:10:00.000+08:00" }],
    createdAt: "2026-10-10T03:10:00.000+08:00",
    expiresAt: "2026-11-09T03:10:00.000+08:00",
  },
  {
    id: "qu-0002",
    text: "工作日的晚上你还会自己约朋友吗？",
    why: "周末推掉活动是只落在周末，还是最近整体都想少社交",
    kind: "tension",
    sources: ["tension"],
    targets: [{ id: "cl-0002", kind: "claim", statement: "最近太累，先不想参加社交", status: "contested" }],
    priority: 0.48,
    priorityDetail: { separation: 0.5, closeness: 0.6, frequency: 0.7, fresh: 1 },
    status: "asked",
    domains: ["social", "work"],
    askedCount: 1,
    skippedCount: 0,
    outcome: null,
    answerEvidenceId: null,
    answerText: null,
    verdict: null,
    clear: false,
    lastAskedAt: "2026-10-10T20:01:00.000+08:00",
    answeredAt: null,
    history: [
      { event: "created", detail: "整理时生成（tension）", at: "2026-10-09T03:10:00.000+08:00" },
      { event: "asked", detail: "在聊天里顺口问了（话题对上了：社交）", at: "2026-10-10T20:01:00.000+08:00" },
    ],
    createdAt: "2026-10-09T03:10:00.000+08:00",
    expiresAt: "2026-11-08T03:10:00.000+08:00",
  },
  {
    id: "qu-0003",
    text: "这阵子工作或者身体上是不是特别忙、特别累？",
    why: "想自己安排和太累还分不出",
    kind: "unresolved",
    sources: ["unresolved"],
    targets: [{ id: "cl-0002", kind: "claim", statement: "最近太累，先不想参加社交", status: "contested" }],
    priority: 0.33,
    priorityDetail: { separation: 0.5, closeness: 0.8, frequency: 0.8, fresh: 1 },
    status: "answered",
    domains: ["schedule", "social"],
    askedCount: 1,
    skippedCount: 1,
    outcome: null,
    answerEvidenceId: "ev-0042",
    answerText: "还好，这阵子不忙，就是不想周末被别人提前排满",
    verdict: "no",
    clear: false,
    lastAskedAt: "2026-10-09T21:00:00.000+08:00",
    answeredAt: "2026-10-09T21:03:00.000+08:00",
    history: [
      { event: "created", detail: "整理时生成（unresolved）", at: "2026-10-08T03:10:00.000+08:00" },
      { event: "asked", detail: "在聊天里顺口问了（话题对上了：时间安排）", at: "2026-10-08T20:00:00.000+08:00" },
      { event: "skipped", detail: "问了以后到第二天还没回答，算跳过一次（第 1 次）", at: "2026-10-09T03:00:00.000+08:00" },
      { event: "asked", detail: "在聊天里顺口问了（话题对上了：时间安排；社交）", at: "2026-10-09T21:00:00.000+08:00" },
      { event: "answered", detail: '回答"还好，这阵子不忙，就是不想周末被别人提前排满"：读成"不是"，不算明确，下一夜按判法判', at: "2026-10-09T21:03:00.000+08:00" },
    ],
    createdAt: "2026-10-08T03:10:00.000+08:00",
    expiresAt: "2026-10-22T03:10:00.000+08:00",
  },
];

const LAST_NIGHT: MemoryLastNight = {
  night: "2026-10-10",
  at: "2026-10-10T03:20:00.000+08:00",
  state: "ran",
  ranAt: "2026-10-10T03:05:00.000+08:00",
  newClaims: 2,
  changedClaims: 1,
  needsReview: 1,
};

/** 地址里带了 ?demo-memory-empty / ?demo-memory-off：看空数据、看降级的样子 */
const empty = (): boolean => demoParam("demo-memory-empty") !== null;
const off = (): boolean => demoParam("demo-memory-off") !== null;

const REASONS = { off: "推理库这会儿正被每晚整理占着，过一会儿再刷新" } as const;

/** 原型：概览 */
export function fakeMemorySummary(): MemorySummaryView {
  if (off()) return { ready: false, reason: REASONS.off, total: 0, tiers: { state: 0, preference: 0, need: 0, value: 0 }, statuses: { active: 0, contested: 0, retracted: 0, superseded: 0 }, openQuestions: 0 };
  if (empty()) return { ready: true, total: 0, tiers: { state: 0, preference: 0, need: 0, value: 0 }, statuses: { active: 0, contested: 0, retracted: 0, superseded: 0 }, openQuestions: 0, lastNight: LAST_NIGHT };
  const tiers = { state: 0, preference: 0, need: 0, value: 0 };
  const statuses = { active: 0, contested: 0, retracted: 0, superseded: 0 };
  for (const claim of CLAIMS) {
    tiers[claim.tier] += 1;
    statuses[claim.status] += 1;
  }
  return { ready: true, total: CLAIMS.length, tiers, statuses, openQuestions: QUESTIONS.filter((q) => q.status === "open" || q.status === "asked").length, lastNight: LAST_NIGHT };
}

/** 原型：结论列表（按层、按状态筛，limit 截条数；total 照旧是符合条件的全部） */
export function fakeMemoryClaims(query: MemoryClaimQuery = {}): MemoryClaimListPage {
  if (off()) return { ready: false, reason: REASONS.off, total: 0, items: [] };
  if (empty()) return { ready: true, total: 0, items: [] };
  const found = CLAIMS.filter((claim) => (query.tier === undefined || claim.tier === query.tier) && (query.status === undefined || claim.status === query.status));
  const limit = query.limit ?? 50;
  return { ready: true, total: found.length, items: found.slice(0, limit) };
}

/** 原型：一条结论的完整解释；没有这条结论是 undefined */
export function fakeMemoryClaim(claimId: string): MemoryClaimDetailView | undefined {
  if (off()) return { ready: false, reason: REASONS.off, supports: [], refutes: [], background: [], competitors: [], inferences: [], evidence: [], revisions: [] };
  const claim = CLAIMS.find((c) => c.id === claimId);
  if (claim === undefined) return undefined;
  const detail = {
    ...claim,
    method: claim.epistemic === "explicit" ? ("explicit" as const) : ("induction" as const),
    validFrom: claim.tier === "state" ? "2026-10-01T00:00:00.000+08:00" : null,
    validTo: claim.tier === "state" ? "2026-10-15T00:00:00.000+08:00" : null,
    inferredAt: claim.updatedAt,
    reviewedAt: null,
    retractedBy: null,
    supersededBy: null,
  };
  if (claim.id !== "cl-0001") {
    return {
      ready: true,
      claim: detail,
      ...(claim.id === "cl-0002" ? { group: { key: "weekend_autonomy", pattern: "weekend_autonomy", description: "周末连着几次推掉活动" } } : {}),
      supports: claim.id === "cl-0002" ? [{ target: "ev-0004", kind: "evidence", statement: null, weight: "weak", rationale: "转述里说想一个人待着", evidence: [QUOTE_RELAYED] }] : [],
      refutes: [],
      background: [],
      competitors: claim.id === "cl-0002" ? CLAIMS.filter((c) => c.id === "cl-0001") : [],
      inferences: [],
      premises: { id: claim.id, kind: "claim", label: claim.statement, status: claim.status, premises: [] },
      evidence: [],
      revisions: [REVISIONS[0]!],
      // 330 号票：猜测写明为什么还是猜测
      ...(claim.status === "contested" ? { whyGuess: { unverifiedPremises: [], evidence: "竞争的假设还没分出来（领先 3 分贝，不到 6）" } } : {}),
    };
  }
  return {
    ready: true,
    claim: detail,
    group: { key: "weekend_autonomy", pattern: "weekend_autonomy", description: "周末连着几次推掉活动" },
    supports: SUPPORTS,
    refutes: REFUTES,
    background: BACKGROUND,
    competitors: CLAIMS.filter((c) => c.id === "cl-0002"),
    inferences: [INFERENCE],
    premises: PREMISES,
    evidence: [QUOTE_RELAX, QUOTE_NOT_FULL, QUOTE_HIKED, QUOTE_RELAYED],
    revisions: REVISIONS,
  };
}

/** 原型：做法（330 号票）——一条在用、建在已验证上的，一条待你确认、建在猜测上的 */
export function fakeMemoryStrategies(): MemoryStrategiesView {
  if (off()) return { ready: false, reason: REASONS.off, items: [] };
  if (empty()) return { ready: true, items: [] };
  return {
    ready: true,
    items: [
      {
        id: "st-0001",
        when: "安排周末的活动时",
        actions: ["留出空白，不要排满", "替用户约人、定时间之前先问他"],
        status: "active",
        onGuess: false,
        basisGone: false,
        basis: [{ id: "cl-0001", statement: "周末需要自己安排时间", status: "active", confidence: "medium" }],
        confirmedAt: "2026-10-10T09:00:00.000+08:00",
        createdAt: "2026-10-10T03:00:00.000+08:00",
      },
      {
        id: "st-0002",
        when: "安排日程、接新事情时",
        actions: ["留出休息和恢复的时间，不要连着排", "要加新事情时先问能不能推掉或挪后"],
        status: "proposed",
        onGuess: true,
        basisGone: false,
        basis: [{ id: "cl-0002", statement: "最近太累，先不想参加社交", status: "contested", confidence: "medium" }],
        confirmedAt: null,
        createdAt: "2026-10-10T03:00:00.000+08:00",
      },
    ],
  };
}

/** 原型：问题箱（limit 截条数） */
export function fakeMemoryQuestions(query: { limit?: number } = {}): MemoryQuestionsView {
  if (off()) return { ready: false, reason: REASONS.off, total: 0, open: 0, items: [] };
  if (empty()) return { ready: true, total: 0, open: 0, items: [] };
  const limit = query.limit ?? 50;
  return { ready: true, total: QUESTIONS.length, open: QUESTIONS.filter((q) => q.status === "open" || q.status === "asked").length, items: QUESTIONS.slice(0, limit) };
}
