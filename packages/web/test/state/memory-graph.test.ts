// 233 号票：记忆的结论、证据与推理、问题箱在状态层的推导——按层分组、状态筛的选项、列表上一行、
// 原话、支持/反证/背景、证据链、推断、修订、问题、概览和最近一次整理那两行。
import { describe, expect, test } from "vitest";
import {
  MEMORY_CLAIM_STATUS_LABEL,
  MEMORY_CONFIDENCE_LABEL,
  MEMORY_EPISTEMIC_LABEL,
  MEMORY_LINK_WEIGHT_LABEL,
  MEMORY_NIGHTLY_STATE_LABEL,
  MEMORY_QUESTION_KIND_LABEL,
  MEMORY_QUESTION_STATUS_LABEL,
  MEMORY_TIER_LABEL,
  memoryClaimBadges,
  memoryClaimDetailMeta,
  memoryClaimGroups,
  memoryClaimRow,
  memoryClaimStatusChoices,
  memoryClaimValidity,
  memoryInferenceRow,
  memoryGuessLines,
  memoryLastNightLine,
  memoryLinkRow,
  memoryPremiseRows,
  memoryQuestionRow,
  memoryQuestionsLine,
  memoryQuoteRow,
  memoryRevisionRow,
  memoryStrategyRow,
  memorySummaryLine,
  type MemoryClaimBrief,
  type MemoryClaimDetailView,
  type MemoryClaimLinkView,
  type MemoryEvidenceQuote,
  type MemoryInferenceView,
  type MemoryPremiseNode,
  type MemoryQuestionItem,
  type MemoryRevisionView,
  type MemoryStatusCounts,
  type MemoryStrategyView,
  type MemorySummaryView,
  t,
} from "../../src/state/index.ts";

const brief = (overrides: Partial<MemoryClaimBrief> = {}): MemoryClaimBrief => ({
  id: "cl-0001",
  statement: "周末需要自己安排时间",
  tier: "need",
  status: "active",
  needsReview: false,
  confidence: "medium",
  epistemic: "inferred",
  updatedAt: "2026-10-10T03:00:00.000+08:00",
  context: ["weekend"],
  competitors: 1,
  supports: 2,
  refutes: 1,
  ...overrides,
});

const quote = (overrides: Partial<MemoryEvidenceQuote> = {}): MemoryEvidenceQuote => ({
  id: "ev-0001",
  text: "这周六的聚会我就不去了",
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  status: "active",
  eventTime: "2026-10-09T20:00:00.000+08:00",
  observedAt: "2026-10-09T20:00:00.000+08:00",
  usable: true,
  ...overrides,
});

const link = (overrides: Partial<MemoryClaimLinkView> = {}): MemoryClaimLinkView => ({
  target: "ev-0001",
  kind: "evidence",
  statement: null,
  weight: "strong",
  rationale: "推掉了聚会",
  evidence: [quote()],
  ...overrides,
});

describe("层的说法和分组", () => {
  test("四层的说法、顺序固定；空层不出现", () => {
    expect(MEMORY_TIER_LABEL).toEqual({ state: "近期状态", preference: "偏好", need: "需求", value: "价值观" });
    const groups = memoryClaimGroups([brief({ id: "cl-1", tier: "need" }), brief({ id: "cl-2", tier: "state" }), brief({ id: "cl-3", tier: "need" })]);
    expect(groups.map((g) => [g.tier, g.label, g.items.map((i) => i.id)])).toEqual([
      ["state", "近期状态", ["cl-2"]],
      ["need", "需求", ["cl-1", "cl-3"]],
    ]);
    expect(memoryClaimGroups([])).toEqual([]);
  });

  test("状态、把握、来源、多重、问题、整理那几套说法都在", () => {
    // 329 号票：已验证、猜测、撤回、被取代（待复核不再是状态）
    expect(MEMORY_CLAIM_STATUS_LABEL.active).toBe("已验证");
    expect(MEMORY_CLAIM_STATUS_LABEL.contested).toBe("猜测");
    expect(MEMORY_CONFIDENCE_LABEL.high).toBe("把握高");
    expect(MEMORY_EPISTEMIC_LABEL.user_confirmed).toBe("你确认过的");
    expect(MEMORY_LINK_WEIGHT_LABEL.decisive).toBe("决定性");
    expect(MEMORY_QUESTION_STATUS_LABEL.retired).toBe("跳过两次退下了");
    expect(MEMORY_QUESTION_KIND_LABEL.tension).toBe("说的和做的不一样");
    expect(MEMORY_NIGHTLY_STATE_LABEL.rebuild_needed).toBe("要重建推理库");
  });
});

describe("列表上的一行", () => {
  test("陈述；编号、层级、状态、把握、来源；更新时间；支持、反证、竞争的小签（0 的不出现）", () => {
    expect(memoryClaimRow(brief())).toEqual({
      id: "cl-0001",
      statement: "周末需要自己安排时间",
      meta: "cl-0001 · 需求 · 已验证 · 把握中 · 推断的",
      updated: "10-10 03:00 更新",
      chips: ["支持 2", "反证 1", "竞争 1"],
      badges: [{ label: "已验证", tone: "ok" }],
    });
    expect(memoryClaimRow(brief({ supports: 0, refutes: 0, competitors: 0 })).chips).toEqual([]);
  });

  test("330 号票：醒目的真值小签——已验证绿、猜测橙、撤回的淡写；标着复核的再加'复核中'", () => {
    expect(memoryClaimBadges(brief())).toEqual([{ label: "已验证", tone: "ok" }]);
    expect(memoryClaimBadges(brief({ status: "contested" }))).toEqual([{ label: "猜测", tone: "guess" }]);
    expect(memoryClaimBadges(brief({ status: "contested", needsReview: true }))).toEqual([
      { label: "猜测", tone: "guess" },
      { label: "复核中", tone: "quiet" },
    ]);
    expect(memoryClaimBadges(brief({ status: "retracted" }))).toEqual([{ label: "已撤回", tone: "quiet" }]);
  });

  test("330 号票：做法一行——状态、'建在猜测上'、'理由没了'，依据带现在的状态", () => {
    const view: MemoryStrategyView = {
      id: "st-0002",
      when: "安排日程时",
      actions: ["留出休息的时间", "加事情前先问"],
      status: "proposed",
      onGuess: true,
      basisGone: false,
      basis: [{ id: "cl-0002", statement: "最近太累", status: "contested", confidence: "medium" }],
      confirmedAt: null,
      createdAt: "2026-10-10T03:00:00.000+08:00",
    };
    const row = memoryStrategyRow(view);
    expect(row.text).toBe("安排日程时：留出休息的时间；加事情前先问");
    expect(row.badges).toEqual([
      { label: "待你确认", tone: "quiet" },
      { label: "建在猜测上", tone: "guess" },
    ]);
    expect(row.basis).toBe("依据：cl-0002「最近太累」（猜测）");
    expect(row.note).toContain("依据还只是猜测");
    const gone = memoryStrategyRow({ ...view, status: "active", onGuess: false, basisGone: true, basis: [{ id: "cl-0002", statement: "最近太累", status: "retracted", confidence: "low" }, { id: "cl-0009", statement: "cl-0009", status: "missing", confidence: null }] });
    expect(gone.badges).toEqual([
      { label: "在用", tone: "ok" },
      { label: "理由没了", tone: "guess" },
    ]);
    expect(gone.basis).toBe("依据：cl-0002「最近太累」（已撤回）；cl-0009「cl-0009」（不在了）");
    expect(gone.note).toContain("会问你还要不要");
  });

  test("330 号票（R5）：猜测为什么还是猜测——没证实的前提、证据哪里不够，一行一条；不是猜测是空的", () => {
    expect(memoryGuessLines(undefined)).toEqual([]);
    expect(
      memoryGuessLines({ unverifiedPremises: [{ id: "cl-0003", statement: "周末想休息", status: "contested" }], evidence: "竞争的假设还没分出来" }),
    ).toEqual(["前提 cl-0003「周末想休息」还是猜测，没证实", "证据：竞争的假设还没分出来"]);
  });

  test("状态筛的选项：全部在前，各种状态带条数；没有概览时不写条数", () => {
    expect(memoryClaimStatusChoices().map((c) => c.value)).toEqual(["all", "active", "contested", "retracted", "superseded"]);
    expect(memoryClaimStatusChoices().every((c) => c.count === undefined)).toBe(true);
    const counts: MemoryStatusCounts = { active: 2, contested: 1, retracted: 1, superseded: 0 };
    expect(memoryClaimStatusChoices(counts).map((c) => [c.value, c.count])).toEqual([
      ["all", undefined],
      ["active", 2],
      ["contested", 1],
      ["retracted", 1],
      ["superseded", 0],
    ]);
  });
});

describe("证据与推理", () => {
  test("原话：编号、谁说的、什么时候；忘掉的是空串；别人转述的写明不当依据", () => {
    expect(memoryQuoteRow(quote())).toEqual({ id: "ev-0001", text: "这周六的聚会我就不去了", meta: "ev-0001 · 本人 · 10-09 20:00", usable: true });
    expect(memoryQuoteRow(quote({ text: "", status: "forgotten" })).text).toBe("（原文已忘掉）");
    expect(memoryQuoteRow(quote({ id: "ev-0003", sourceLevel: "untrusted", usable: false, eventTime: null }))).toMatchObject({
      meta: "ev-0003 · 别人转述的 · 不知道什么时候，不当依据",
      usable: false,
    });
  });

  test("一条关联：编号、是支持还是反证、多重、为什么，目标是事实时写事实的陈述", () => {
    expect(memoryLinkRow(link(), "supports")).toEqual({
      id: "ev-0001",
      title: "ev-0001 · 支持 · 强",
      rationale: "推掉了聚会",
      quotes: [{ id: "ev-0001", text: "这周六的聚会我就不去了", meta: "ev-0001 · 本人 · 10-09 20:00", usable: true }],
    });
    expect(memoryLinkRow(link({ target: "fa-0002", kind: "fact", statement: "喜欢周末自己安排", evidence: [] }), "refutes")).toMatchObject({
      title: "fa-0002 · 反证 · 强",
      statement: "喜欢周末自己安排",
    });
  });

  test("证据链摊平：一层一层缩进，结论、事实、原话各有各的 kind", () => {
    const chain: MemoryPremiseNode = {
      id: "cl-0001",
      kind: "claim",
      label: "周末需要自己安排时间",
      status: "active",
      premises: [
        {
          id: "fa-0001",
          kind: "fact",
          label: "周六推掉了聚会",
          status: "active",
          premises: [quote()].map((e) => ({ id: e.id, kind: "evidence" as const, label: e.text, status: e.status, premises: [] })),
        },
      ],
    };
    expect(memoryPremiseRows(chain)).toEqual([
      { depth: 0, kind: "claim", id: "cl-0001", label: "周末需要自己安排时间", status: "active", truncated: false },
      { depth: 1, kind: "fact", id: "fa-0001", label: "周六推掉了聚会", status: "active", truncated: false },
      { depth: 2, kind: "evidence", id: "ev-0001", label: "这周六的聚会我就不去了", status: "active", truncated: false },
    ]);
    expect(memoryPremiseRows(undefined)).toEqual([]);
  });

  test("推断：编号、推法、状态、谁推的、为什么，前提编号连起来", () => {
    const inference: MemoryInferenceView = {
      id: "in-0001",
      method: "induction",
      rationale: "两次都在周末推掉活动",
      by: "rule:4.1",
      status: "active",
      premiseIds: ["ev-0001", "ev-0002"],
      createdAt: "2026-10-10T03:00:00.000+08:00",
    };
    expect(memoryInferenceRow(inference)).toEqual({ id: "in-0001", title: "in-0001 · 归纳出来的 · 成立 · rule:4.1", rationale: "两次都在周末推掉活动", premises: "ev-0001、ev-0002" });
  });

  test("修订：第几条、哪种操作、什么时候、为什么，改了的字段一行一个", () => {
    const revision: MemoryRevisionView = {
      seq: 7,
      op: "update",
      changes: [{ field: "context", from: '["weekend"]', to: '["weekend","social"]' }],
      reason: "补上场景：两次都落在周末",
      at: "2026-10-10T03:00:00.000+08:00",
    };
    expect(memoryRevisionRow(revision)).toEqual({
      seq: 7,
      title: "第 7 条 · 改了",
      when: "10-10 03:00",
      reason: "补上场景：两次都落在周末",
      by: "",
      changes: ['context：["weekend"] → ["weekend","social"]'],
    });
  });

  test("267 号票：修订带上是谁写的（唯一写入口的留痕）——谁、做什么，经谁转达的写在谁后面", () => {
    const base: MemoryRevisionView = { seq: 9, op: "update", changes: [], reason: "判成立", at: "2026-10-10T03:00:00.000+08:00" };
    expect(memoryRevisionRow({ ...base, by: { actor: "nightly", op: "decide" } }).by).toBe("记忆管理员（夜班） · 判成立或推翻");
    expect(memoryRevisionRow({ ...base, by: { actor: "user_verdict", op: "verdict", via: "经记忆管理员" } }).by).toBe("你的表态（经记忆管理员）· 记下你的表态");
    expect(memoryRevisionRow({ ...base, by: { actor: "user", op: "forget", via: "经记忆删除卡" } }).by).toBe("你发起的（经记忆删除卡）· 忘掉");
  });

  test("详情顶上的一行：层级、状态、把握、来源、推法；有效期两头都不知道就不写", () => {
    const claim: MemoryClaimDetailView["claim"] = {
      ...brief(),
      method: "induction",
      validFrom: "2026-10-01T00:00:00.000+08:00",
      validTo: null,
      inferredAt: "2026-10-10T03:00:00.000+08:00",
      reviewedAt: null,
      retractedBy: null,
      supersededBy: null,
    };
    expect(memoryClaimDetailMeta(claim)).toBe("cl-0001 · 需求 · 已验证 · 把握中 · 推断的 · 归纳出来的");
    expect(memoryClaimValidity(claim)).toBe("有效期：10-01 00:00 到 现在");
    expect(memoryClaimValidity({ ...claim, validFrom: null, validTo: null })).toBeUndefined();
    expect(memoryClaimDetailMeta(undefined)).toBe("");
  });
});

describe("问题箱", () => {
  const question: MemoryQuestionItem = {
    id: "qu-0001",
    text: "上次推掉的周末活动，要是时间由你自己定，你会去吗？",
    why: "想自己安排和太累还分不出",
    kind: "unresolved",
    sources: ["unresolved"],
    targets: [
      { id: "cl-0001", kind: "claim", statement: "周末需要自己安排时间", status: "active" },
      { id: "cl-0002", kind: "claim", statement: "最近太累，先不想参加社交", status: "contested" },
    ],
    priority: 0.723,
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
  };

  test("问什么、为什么问、能区分哪几条（带它们现在的状态）、优先级、状态", () => {
    expect(memoryQuestionRow(question)).toEqual({
      id: "qu-0001",
      text: "上次推掉的周末活动，要是时间由你自己定，你会去吗？",
      why: "想自己安排和太累还分不出",
      targets: ["周末需要自己安排时间（已验证）", "最近太累，先不想参加社交（猜测）"],
      priority: "优先级 72%",
      meta: "竞争解释分不清 · 优先级 72% · 在问题箱里",
      status: "在问题箱里",
      history: ["10-10 03:10 放进问题箱"],
    });
    // 问过几次、目标不在了也写明
    expect(memoryQuestionRow({ ...question, askedCount: 2, status: "asked", targets: [{ id: "cl-9", kind: "claim", statement: "旧的解释", status: "missing" }] })).toMatchObject({
      targets: ["旧的解释（不在了）"],
      meta: "竞争解释分不清 · 优先级 72% · 问过了 · 问过 2 次",
    });
  });

  test("264 号票：顺口问过、跳过、答了——跳过几次、你的回答（原话和读成什么）、判的结果、经过都写明", () => {
    const answered: MemoryQuestionItem = {
      ...question,
      status: "resolved",
      askedCount: 2,
      skippedCount: 1,
      answerEvidenceId: "ev-0042",
      answerText: "会啊，时间我自己定的话就去",
      verdict: "yes",
      clear: false,
      lastAskedAt: "2026-10-11T20:01:00.000+08:00",
      answeredAt: "2026-10-11T20:05:00.000+08:00",
      outcome: "下一夜按\"是\"判。定了：cl-0001 胜出。",
      history: [
        { event: "created", detail: "整理时生成", at: "2026-10-10T03:10:00.000+08:00" },
        { event: "asked", detail: "在聊天里顺口问了", at: "2026-10-10T20:01:00.000+08:00" },
        { event: "skipped", detail: "问了以后到第二天还没回答，算跳过一次（第 1 次）", at: "2026-10-11T03:00:00.000+08:00" },
        { event: "asked", detail: "在聊天里顺口问了", at: "2026-10-11T20:01:00.000+08:00" },
        { event: "answered", detail: "回答……", at: "2026-10-11T20:05:00.000+08:00" },
        { event: "resolved", detail: "判了", at: "2026-10-12T03:00:00.000+08:00" },
      ],
    };
    expect(memoryQuestionRow(answered)).toMatchObject({
      meta: "竞争解释分不清 · 优先级 72% · 判过了 · 问过 2 次 · 跳过 1 次",
      answer: "你的回答：「会啊，时间我自己定的话就去」（读成「是」）",
      outcome: "结果：下一夜按\"是\"判。定了：cl-0001 胜出。",
      history: ["10-10 03:10 放进问题箱", "10-10 20:01 顺口问了", "10-11 03:00 跳过一次", "10-11 20:01 顺口问了", "10-11 20:05 你答了", "10-12 03:00 判过了"],
    });
    // 说得很明确的另写一句；原话不在了（被忘掉）就不写回答
    expect(memoryQuestionRow({ ...answered, clear: true }).answer).toBe("你的回答：「会啊，时间我自己定的话就去」（读成「是」，说得很明确）");
    expect(memoryQuestionRow({ ...answered, answerText: null }).answer).toBeUndefined();
  });

  test("顶上的一行：开着的、一共的；空的是空那句话；读不到是那一句", () => {
    expect(memoryQuestionsLine({ ready: true, open: 1, total: 2 })).toBe("问题箱：开着 1 个，一共 2 个");
    expect(memoryQuestionsLine({ ready: true, open: 0, total: 0 })).toBe("问题箱是空的：整理时还拿不准的地方会变成问题放在这里");
    expect(memoryQuestionsLine({ ready: false, open: 0, total: 0 })).toBe(t("state.memoryGraph.notReady"));
  });
});

describe("概览和最近一次整理", () => {
  const summary: Pick<MemorySummaryView, "ready" | "total" | "tiers"> = {
    ready: true,
    total: 3,
    tiers: { state: 1, preference: 1, need: 1, value: 0 },
  };

  test("一共几条、各层各几条；没有结论、读不到各说各的", () => {
    expect(memorySummaryLine(summary)).toBe("结论一共 3 条：近期状态 1、偏好 1、需求 1、价值观 0");
    expect(memorySummaryLine({ ready: true, total: 0, tiers: { state: 0, preference: 0, need: 0, value: 0 } })).toBe("还没有结论：每晚整理时从素材里推断出来的会出现在这里");
    expect(memorySummaryLine({ ...summary, ready: false })).toBe(t("state.memoryGraph.notReady"));
  });

  test("最近一次整理：哪一夜、跑成什么样、新出几条；一次都没跑过写明；要重建时也照实写", () => {
    expect(memoryLastNightLine(undefined)).toBe("还没整理过：每晚 03:00 整理一次，第一次跑过之后这里才有内容");
    expect(memoryLastNightLine({ night: "2026-10-10", at: "2026-10-10T03:20:00.000+08:00", state: "ran", newClaims: 3, changedClaims: 1, needsReview: 1 })).toBe(
      "最近一次整理是 2026-10-10（整理过了）：新出 3 条、变了 1 条、待复核 1 条",
    );
    expect(memoryLastNightLine({ night: "2026-10-10", at: "2026-10-10T03:20:00.000+08:00", state: "rebuild_needed", newClaims: 0, changedClaims: 0, needsReview: 0 })).toContain("要重建推理库");
  });
});
