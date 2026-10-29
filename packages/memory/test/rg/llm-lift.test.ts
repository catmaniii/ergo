// 201 号票：模型版往上抽（偏好 → 需求 → 价值观）和模型版编交互策略。假模型按剧本回，不调 DeepSeek。例子都是自己写的。
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "../../src/domain/time.ts";
import type { Claim, EvidenceDraft } from "../../src/domain/types.ts";
import type { MemoryEngine } from "../../src/engine.ts";
import type { EvidenceSource } from "../../src/evidence/source.ts";
import { FakeChatModel, type ChatRequest } from "../../src/llm/chat.ts";
import { formatPlan, planModelRun } from "../../src/llm/plan.ts";
import { LIFT_SYSTEM_NEED, LIFT_SYSTEM_VALUE, liftThreshold } from "../../src/rg/llm-lift.ts";
import { STRATEGY_SYSTEM } from "../../src/rg/llm-strategies.ts";
import { LlmReasoner } from "../../src/rg/llm-reasoner.ts";
import { STRATEGY_RESERVE_CALLS } from "../../src/rg/reasoning-graph.ts";
import { effectiveWeight } from "../../src/rg/scoring.ts";
import type { LiftInput, RgView } from "../../src/rg/types.ts";
import { closeEngines, openEngine, say } from "./helpers.ts";

afterEach(closeEngines);

const NOW = "2026-10-12T12:00:00+08:00";

/** 223 号票：家里、休闲 和 家里、工作 两种场合（共享「家里」），八月两条、九月一条，三个证据两个月 */
const HOME_STORY: EvidenceDraft[] = [
  say("ev-h1", "我不喜欢在家里被提前排满", "2026-08-08T10:00:00+08:00", { context: ["family", "leisure"] }),
  say("ev-h2", "我也讨厌家里被安排聚会", "2026-08-16T10:00:00+08:00", { context: ["family", "leisure"] }),
  say("ev-h3", "我不喜欢家里给我安排的行程", "2026-09-06T10:00:00+08:00", { context: ["family", "work"] }),
];

/** 三种场景（周末社交、假期家里、工作日工作，229 号票起要方面不同才算两种）、三个月（4、8、10 月）都说不喜欢被排满 */
const STORY: EvidenceDraft[] = [
  say("ev-1", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-2", "假期我也不喜欢被提前排满", "2026-08-02T10:00:00+08:00", { context: ["holiday", "family"] }),
  say("ev-3", "工作日我也不喜欢被提前排满", "2026-10-09T10:00:00+08:00", { context: ["workday", "work"] }),
];

interface PremiseLine {
  claim_id: string;
  scenes: string[][];
  facts: { fact_id: string; role: string; assertion: string }[];
}

/** 从请求里读出下层断言（每行一个 JSON） */
function premisesOf(request: ChatRequest): PremiseLine[] {
  return request.user
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as PremiseLine)
    .filter((p) => typeof p.claim_id === "string");
}

const supportFacts = (ps: PremiseLine[]) => [...new Set(ps.flatMap((p) => p.facts.filter((f) => f.role === "supports").map((f) => f.fact_id)))];

interface Script {
  need?: (r: ChatRequest) => unknown;
  value?: (r: ChatRequest) => unknown;
  strategies?: (r: ChatRequest) => unknown;
}

/** 默认剧本：需求层一组两条（需要自己掌控时间 / 只是这几个月太忙），价值层一组两条，编一条策略 */
const needOutput = (r: ChatRequest) => {
  const ps = premisesOf(r);
  const facts = supportFacts(ps);
  return {
    groups: [
      {
        theme: "自己掌控时间",
        premise_ids: [...ps.map((p) => p.claim_id), "cl-9999"],
        description: "周末、假期、工作日都不愿被别人排满",
        hypotheses: [
          {
            tier: "need",
            statement: "用户需要自己掌控时间安排，不愿被别人排满",
            domains: ["schedule", "bogus"],
            expects: { supports: "主动说不喜欢被安排、自己安排的就去", refutes: "说喜欢别人定好的行程" },
            supports: [
              { target: facts[0], weight: "strong", rationale: "明说不喜欢被排满" },
              { target: facts[2], weight: "strong", rationale: "工作日也一样" },
              { target: "fa-9999", weight: "strong", rationale: "编的" },
            ],
            refutes: [],
            probe: { against: 1, ask: "要是时间由你自己定，同样的事你会去吗？", queries: ["自己定", "自己安排"] },
          },
          {
            tier: "state",
            statement: "用户只是这几个月整体太忙",
            domains: ["schedule", "health"],
            expects: { supports: "说忙、说累、加班", refutes: "说最近不忙" },
            supports: [],
            refutes: [],
            probe: { against: 0, ask: "这几个月有没有哪段特别忙？", queries: ["加班", "忙不过来"] },
          },
        ],
      },
    ],
  };
};

const valueOutput = (r: ChatRequest) => {
  const ps = premisesOf(r);
  const facts = supportFacts(ps);
  return {
    groups: [
      {
        theme: "自己掌控时间",
        premise_ids: ps.map((p) => p.claim_id),
        description: "需求跨了三种场景、三个月",
        hypotheses: [
          { tier: "value", statement: "用户长期看重自主，把掌控自己的时间当成重要的事", domains: ["schedule"], supports: [{ target: facts[0], weight: "strong", rationale: "半年前就这样" }, { target: facts[1], weight: "strong", rationale: "假期也一样" }], refutes: [], probe: { against: 1, ask: "一两年前你也这样吗？", queries: ["一直", "以前"] } },
          { tier: "need", statement: "掌控时间只是用户现阶段的需要", domains: ["schedule"], supports: [], refutes: [], probe: { against: 0, ask: "以前忙的时候也这样吗？", queries: ["以前"] } },
        ],
      },
    ],
  };
};

const strategyOutput = (r: ChatRequest) => {  const keys = r.user
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => (JSON.parse(l) as { key: string }).key);
  return {
    strategies: [
      { key: keys[0], when: "替用户安排周末、假期或工作日的时间时", actions: ["每天至少留出半天不排任何事", "注意用户的感受", "要替他约人或定时间，先发消息问他行不行"], domains: ["schedule", "social"] },
      { key: "bogus-key", when: "随便什么时候", actions: ["照做"], domains: [] },
    ],
  };
};

/** 226：往剧本的一组解释上写 predicts（模型输出里的字段，类型没写在剧本上） */
function withPredicts<T extends { groups: { hypotheses: object[] }[] }>(out: T, texts: (string | undefined)[]): T {
  texts.forEach((text, i) => {
    if (text !== undefined) (out.groups[0]!.hypotheses[i] as { predicts?: string }).predicts = text;
  });
  return out;
}

function fakeModel(script: Script = {}): FakeChatModel {
  return new FakeChatModel((r) => {
    if (r.purpose === "propose") return { groups: [] };
    if (r.purpose === "lift") return r.system === LIFT_SYSTEM_VALUE ? (script.value ?? valueOutput)(r) : (script.need ?? needOutput)(r);
    if (r.purpose === "strategies") return (script.strategies ?? strategyOutput)(r);
    if (r.purpose === "judge") return { found_evidence_ids: [], if_found: null, links: [] };
    return { probes: [] };
  }, "fake-lift");
}

async function run(script: Script = {}, story: EvidenceDraft[] = STORY, maxModelCalls?: number) {
  const model = fakeModel(script);
  const t = openEngine(NOW, { reasoner: new LlmReasoner(model) });
  for (const e of story) t.engine.ingestEvidence(e);
  const report = await t.engine.reflect(maxModelCalls === undefined ? {} : { maxModelCalls });
  return { ...t, model, report };
}

const source = (events: EvidenceDraft[]): EvidenceSource => ({ name: "test", now: NOW, read: () => events });
const purposes = (m: FakeChatModel) => m.calls.map((c) => c.purpose);
const liftGroup = (engine: MemoryEngine, level: "need" | "value") => engine.rg.registry.listGroups().find((g) => g.pattern === `lift:${level}`);
const members = (engine: MemoryEngine, key: string): Claim[] => engine.rg.registry.members(key).map((m) => engine.store.getClaim(m.claimId)!);
const stated = (engine: MemoryEngine, evidenceId: string): Claim => {
  const fact = engine.store.factsByEvidence(evidenceId).find((f) => f.predicate === "dislikes")!;
  return engine.store.getClaim(engine.rg.registry.explicitClaimOf(fact.id)!)!;
};

describe("门槛由代码判，不交给模型", () => {
  it("只落一种场景的组结构上就不问；差月份、差证据条数的先出临时结论（256 号票）", async () => {
    // 只在一个场景（周末）里反复出现：结构门槛（两种以上的场合）没过，不问模型
    const oneScene = await run({}, [
      say("ev-1", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend"] }),
      say("ev-2", "周六我也不喜欢被提前排满", "2026-08-01T10:00:00+08:00", { context: ["weekend"] }),
      say("ev-3", "周日也不喜欢被排满", "2026-10-11T10:00:00+08:00", { context: ["weekend"] }),
    ]);
    expect(purposes(oneScene.model)).not.toContain("lift");
    expect(oneScene.engine.rg.registry.listGroups().filter((g) => g.pattern.startsWith("lift:"))).toEqual([]);

    // 三条证据全落在同一个月：结构过了、时期不够 → 照样问、照样出，但标成临时结论
    const oneMonth = await run({}, STORY.map((e, i) => ({ ...e, eventTime: `2026-10-0${i + 1}T10:00:00+08:00`, observedAt: `2026-10-0${i + 1}T10:00:00+08:00` })));
    expect(purposes(oneMonth.model)).toContain("lift");
    const group = oneMonth.engine.rg.registry.listGroups().find((g) => g.pattern === "lift:need")!;
    expect((group.params as { provisional?: boolean }).provisional).toBe(true);
    expect(group.description).toContain("临时结论");
    // 临时结论的置信度按"证据薄、不跨时期"压到 low（need/value 那条）
    expect(members(oneMonth.engine, group.key).find((c) => c.tier === "need")!.confidence).toBe("low");

    // 只有两条证据（不到三条）：也是先出、标临时
    const two = await run({}, STORY.slice(0, 2));
    expect(purposes(two.model)).toContain("lift");
  });

  it("liftThreshold：场景、月份、证据条数都算出来，说明差在哪", async () => {
    const { engine } = await run({}, STORY.slice(0, 2));
    const view = engine.rg.view();
    const inputs = engine.rg.liftInputs("need", view);
    expect(inputs).toHaveLength(2);
    const t = liftThreshold("need", inputs, view);
    // 两种场合、两条证据够硬下限 → 能出结论；证据不到三条，先标临时
    expect(t).toMatchObject({ ok: true, provisional: true, months: 2 });
    expect(t.hardFailed).toEqual([]);
    expect(t.softFailed).toEqual(["证据条数不够"]);
    expect(t.evidenceIds).toHaveLength(2);
    expect(t.reason).toMatch(/证据/);
  });
});

describe("门槛过了才问模型：结构化输出写成需求层一组竞争假设", () => {
  it("请求里有下层断言的陈述、场景、时间跨度、证据 id；输出写成一组：至少两条、互相登记、推断是'结论 ← 这几条断言'", async () => {
    const { engine, model, report } = await run();
    const lift = model.calls.find((c) => c.purpose === "lift" && c.system === LIFT_SYSTEM_NEED)!;
    const premises = [stated(engine, "ev-1"), stated(engine, "ev-2"), stated(engine, "ev-3")];
    for (const c of premises) expect(lift.user).toContain(c.id);
    for (const ev of ["ev-1", "ev-2", "ev-3"]) expect(lift.user).toContain(ev);
    expect(lift.user).toContain("2026-04-04 到 2026-10-09");
    expect(lift.user).toContain("weekend");

    const group = liftGroup(engine, "need")!;
    expect(group).toMatchObject({ live: true, by: "model:fake-lift" });
    expect(group.key).toBe("lift:need|model:自己掌控时间");
    expect(group.observationIds.toSorted()).toEqual(premises.map((c) => c.id).toSorted());
    const [need, busy] = members(engine, group.key);
    expect(need).toMatchObject({ tier: "need", kind: "hypothesis", epistemic: "inferred", method: "induction", statement: "用户需要自己掌控时间安排，不愿被别人排满", context: [] });
    expect(busy).toMatchObject({ tier: "state" });
    expect(busy!.validTo).not.toBeNull();
    expect(need!.competesWith).toEqual([busy!.id]);
    expect(engine.store.inferencesOf(need!.id)[0]!.premiseIds.toSorted()).toEqual(premises.map((c) => c.id).toSorted());
    // 每条事先写好的支持、反证的样子和适用领域记在组里
    const params = group.params as { model?: { hypotheses: { template: string; domains: string[]; expects: { supports: string; refutes: string } }[] } };
    expect(params.model!.hypotheses[0]).toMatchObject({ domains: ["schedule"], expects: { supports: "主动说不喜欢被安排、自己安排的就去", refutes: "说喜欢别人定好的行程" } });
    // 追问直接用模型给的（不再另问一次），找到了算支持出这条追问的那一条
    expect(purposes(model)).not.toContain("probes");
    const probes = engine.rg.registry.probesOf(group.key).map((p) => engine.store.getProbe(p.probeId)!);
    expect(probes.map((p) => [p.discriminates, p.ifFound, p.ask])).toEqual([
      [[need!.id, busy!.id], need!.id, "要是时间由你自己定，同样的事你会去吗？"],
      [[busy!.id, need!.id], busy!.id, "这几个月有没有哪段特别忙？"],
    ]);
    expect(report.dropped.filter((d) => d.stage === "lift").length).toBeGreaterThan(0);
  });

  it("伪造的下层断言 id、事实 id，不认得的领域写入前丢掉，记进 dropped", async () => {
    const { engine, report } = await run();
    const reasons = report.dropped.filter((d) => d.stage === "lift").map((d) => d.reason).join("\n");
    expect(reasons).toContain("伪造的或不在输入里的下层断言 id：cl-9999");
    expect(reasons).toContain("伪造的或不能当依据的目标 id：fa-9999");
    expect(reasons).toContain("不认得的领域：bogus");
    const group = liftGroup(engine, "need")!;
    expect(group.observationIds).not.toContain("cl-9999");
    for (const c of members(engine, group.key)) expect(engine.store.linksOf(c.id).map((l) => l.target)).not.toContain("fa-9999");
  });

  it("至少两条：只给一条上位解释的组丢掉", async () => {
    const { engine, report } = await run({
      need: (r) => {
        const out = needOutput(r);
        out.groups[0]!.hypotheses = out.groups[0]!.hypotheses.slice(0, 1);
        return out;
      },
    });
    expect(liftGroup(engine, "need")).toBeUndefined();
    expect(report.dropped.map((d) => d.reason)).toContain("上位解释不到两条");
  });

  it("每组再按门槛判一次：模型只拿两条断言（证据不够）→ 先出一组临时结论，记进统计", async () => {
    const { engine, report } = await run({
      need: (r) => {
        const out = needOutput(r);
        out.groups[0]!.premise_ids = premisesOf(r)
          .slice(0, 2)
          .map((p) => p.claim_id);
        return out;
      },
    });
    const group = liftGroup(engine, "need")!;
    expect(group.description).toContain("临时结论");
    expect((group.params as { provisional?: boolean }).provisional).toBe(true);
    // 329 号票（R4）：临时结论（猜测）也能往上推——价值层拿它再抽一组，也是临时结论
    expect(report.stats!.lift.provisional).toBe(2);
    expect(report.stats!.lift.provisionalByReason).toEqual({ 证据条数不够: 2, 月份不够: 1 });
    expect(liftGroup(engine, "value")!.description).toContain("临时结论");
    expect(report.dropped.map((d) => d.reason).join("\n")).not.toMatch(/没过门槛/);
  });
});

describe("计分接上：状态、置信上限、用户模型照旧", () => {
  it("有强的判别性支持、领先 6 分贝 → 需求 active，置信度封顶 medium；对手 contested；用户模型里标推断的", async () => {
    const { engine } = await run();
    const group = liftGroup(engine, "need")!;
    const [need, busy] = members(engine, group.key);
    expect(need).toMatchObject({ status: "active", confidence: "medium" });
    expect(busy!.status).toBe("contested");
    expect(engine.store.linksOf(need!.id).filter((l) => l.weight === "strong").length).toBe(2);
    // 观察（下层断言的支持事实）对每条都至少是弱支持
    expect(engine.store.linksOf(busy!.id).filter((l) => l.polarity === "supports").map((l) => l.weight)).toEqual(["weak", "weak", "weak"]);
    expect(engine.getUserModel({}).values.map((e) => [e.claimId, e.label, e.confidence])).toContainEqual([need!.id, "inferred", "medium"]);
  });

  // 330 号票（R14）：随口说的不再自动算决定性——模型判给用户明说事实的"决定性"计分时按强的算，不撤回（当面确认、纠正的才撤）
  it("模型把决定性给了用户随口明说的事实：按强的算，不撤回、还是猜测", async () => {
    const { engine } = await run({
      need: (r) => {
        const out = needOutput(r);
        const facts = supportFacts(premisesOf(r));
        (out.groups[0]!.hypotheses[1] as { refutes: unknown[] }).refutes = [{ target: facts[1], weight: "decisive", rationale: "用户明说的" }];
        return out;
      },
    });
    const [, busy] = members(engine, liftGroup(engine, "need")!.key);
    expect(busy).toMatchObject({ status: "contested", retractedBy: null });
    const refute = engine.store.linksOf(busy!.id).find((l) => l.polarity === "refutes")!;
    expect(refute.weight).toBe("decisive");
    expect(effectiveWeight(refute, engine.rg.view())).toBe("strong");
  });
});

describe("价值层照 195 的条件再抽一次", () => {
  it("需求成立、跨三种场景三个月 → 再问一次模型，出价值层一组；和需求同一个主题", async () => {
    const { engine, model } = await run();
    const need = members(engine, liftGroup(engine, "need")!.key)[0]!;
    const valueCall = model.calls.find((c) => c.purpose === "lift" && c.system === LIFT_SYSTEM_VALUE)!;
    expect(valueCall.user).toContain(need.id);
    const group = liftGroup(engine, "value")!;
    expect(group.observationIds).toEqual([need.id]);
    const [value, phase] = members(engine, group.key);
    expect(value).toMatchObject({ tier: "value", status: "active", confidence: "medium", method: "induction" });
    expect(phase).toMatchObject({ tier: "need", status: "contested" });
    expect((group.params as { theme: string }).theme).toBe((liftGroup(engine, "need")!.params as { theme: string }).theme);
  });
});

describe("已有的组：下次整理不重复问模型", () => {
  it("新来无关的证据 → 不再问往上抽，组照样在；下层断言不成立了（忘掉一句）→ 结构门槛还过得了，降成临时结论接着挂着", async () => {
    const t = await run();
    const liftCalls = () => purposes(t.model).filter((p) => p === "lift").length;
    expect(liftCalls()).toBe(2);
    const need = members(t.engine, liftGroup(t.engine, "need")!.key)[0]!;
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-4", "今天去公司开了个会", "2026-10-13T10:00:00+08:00", { context: ["workday", "work"] }));
    await t.engine.reflect();
    expect(liftCalls()).toBe(2);
    expect(liftGroup(t.engine, "need")!.live).toBe(true);
    expect(t.engine.store.getClaim(need.id)!.status).toBe("active");

    t.engine.invalidateEvidence("ev-3", "用户说忘掉");
    // 329 号票：少了一条支持，组当场按剩下的证据重判，不再静默成立（以前是转待复核）
    expect(t.engine.store.getClaim(need.id)!.status).toBe("contested");
    await t.engine.reflect();
    // 256 号票：少了一条依据，但结构门槛（两种场合 + 两条证据）还过得了 → 不再整组撤回，
    // 降成临时结论接着挂着，置信度按薄的压到 low；再少到条件不够才组撤下，组里的结论也不撤、留成猜测（Q2，没有推翻者）
    const kept = liftGroup(t.engine, "need")!;
    expect(kept.live).toBe(true);
    expect(kept.description).toContain("临时结论");
    expect(t.engine.store.getClaim(need.id)!.confidence).toBe("low");
    expect(liftCalls()).toBe(2);
  });
});

describe("预算：往上抽、编策略都算进 reflect() 的调用预算", () => {
  it("预算只够一次（出假设用掉了）→ 不往上抽、不编策略，报预算用完", async () => {
    const { model, report } = await run({}, STORY, 1);
    expect(purposes(model)).toEqual(["propose"]);
    expect(report).toMatchObject({ modelCalls: 1, budgetExhausted: true });
  });

  it("够用时每次调用都记在 modelCalls 里（含往上抽两次、编策略一次）", async () => {
    const { model, report } = await run();
    expect(purposes(model).filter((p) => p === "lift")).toHaveLength(2);
    expect(purposes(model).filter((p) => p === "strategies")).toHaveLength(1);
    expect(report.modelCalls).toBe(model.calls.length);
    expect(report.budgetExhausted).toBe(false);
  });

  it("编策略那一次预算不够 → 留到下次整理再编", async () => {
    const first = await run();
    const calls = first.model.calls.length;
    const t = await run({}, STORY, calls - 1);
    expect(purposes(t.model)).not.toContain("strategies");
    expect(t.report.budgetExhausted).toBe(true);
    expect(t.engine.store.listStrategies()).toEqual([]);
    t.setNow("2026-10-13T12:00:00+08:00");
    await t.engine.reflect();
    expect(purposes(t.model).filter((p) => p === "strategies")).toHaveLength(1);
    expect(t.engine.store.listStrategies()).toHaveLength(1);
  });
});

/** 334：库里结论的样子（比两次整理的结果） */
const claimShape = (e: MemoryEngine) => e.store.listClaims().map((c) => `${c.id}:${c.status}:${c.confidence}`);

/** 需求层一次出 n 组（主题各不同，每组两条追问，查询都搜得到原话），判这些追问会把预算吃光 */
const manyNeeds = (n: number) => (r: ChatRequest) => {
  const ps = premisesOf(r);
  const facts = supportFacts(ps);
  return {
    groups: Array.from({ length: n }, (_, i) => ({
      theme: `主题${i}`,
      premise_ids: ps.map((p) => p.claim_id),
      description: `第 ${i} 种说法：周末、假期、工作日都不愿被别人排满`,
      hypotheses: [
        { tier: "need", statement: `用户需要自己掌控时间安排（说法${i}）`, domains: ["schedule"], supports: [{ target: facts[0], weight: "strong", rationale: "明说" }, { target: facts[2], weight: "strong", rationale: "工作日也一样" }], refutes: [], probe: { against: 1, ask: `说法${i}：时间自己定的话会去吗？`, queries: ["排满", "不喜欢"] } },
        { tier: "state", statement: `用户只是这几个月太忙（说法${i}）`, domains: ["schedule"], supports: [], refutes: [], probe: { against: 0, ask: `说法${i}：这几个月忙吗？`, queries: ["排满", "提前"] } },
      ],
    })),
  };
};

describe("334：每晚的预算——编交互策略留几次，出问题照跑，往上抽用剩下的", () => {
  /** STORY 加上同一天说喜欢又说不喜欢爬山（事实这一层真冲突，出问题不用模型） */
  const CLASH: EvidenceDraft[] = [...STORY, say("ev-x1", "我喜欢爬山", "2026-10-10T08:00:00+08:00"), say("ev-x2", "我不喜欢爬山", "2026-10-10T20:00:00+08:00")];

  async function night(maxModelCalls: number) {
    const model = fakeModel({ need: manyNeeds(10) });
    const t = openEngine("2026-10-13T03:00:00+08:00", { reasoner: new LlmReasoner(model) });
    for (const e of CLASH) t.engine.ingestEvidence(e);
    const result = await t.engine.runNightly({ userActive: false, maxModelCalls });
    if (!result.ran) throw new Error(`没跑整理：${result.detail}`);
    return { ...t, model, report: result.report };
  }

  it("预算很紧（20 次）：编策略照样问到、写出来，出问题照跑；往上抽、判它的证据只用剩下的", async () => {
    const { engine, model, report } = await night(20);
    const spend = report.reflect.spend!;
    expect(spend.strategies).toBeGreaterThanOrEqual(1);
    expect(purposes(model)).toContain("strategies");
    expect(engine.listStrategies().length).toBeGreaterThan(0);
    // 往上抽没问完（还有追问没判）——它只用到 20 − 4（给编策略留的）− 新证据那一道
    expect(spend.lift).toBeLessThanOrEqual(20 - STRATEGY_RESERVE_CALLS - spend.newEvidence);
    expect(report.reflect.budgetExhausted).toBe(true);
    expect(spend.newEvidence + spend.lift + spend.strategies + spend.predictions + spend.rejudge + spend.replies).toBeLessThanOrEqual(20);
    // 出问题：事实这一层的矛盾照样进了问题箱
    expect(engine.listQuestions().some((q) => q.kind === "contradiction")).toBe(true);
  });

  it("预算够的时候留的那几次不起作用：结果和预算再多十倍一样", async () => {
    const enough = await night(500);
    const more = await night(5000);
    expect(enough.report.reflect.budgetExhausted).toBe(false);
    expect(purposes(enough.model)).toEqual(purposes(more.model));
    expect(enough.report.reflect.spend).toEqual({ ...more.report.reflect.spend!, limit: 500 });
    expect(claimShape(enough.engine)).toEqual(claimShape(more.engine));
    expect(enough.engine.listStrategies().map((s) => s.key)).toEqual(more.engine.listStrategies().map((s) => s.key));
    expect(enough.engine.listQuestions().map((q) => q.key)).toEqual(more.engine.listQuestions().map((q) => q.key));
  });
});

describe("模型版编交互策略", () => {
  it("成立的需求、价值交给模型写成'什么场合 → 怎么做'：空话、伪造的 key 丢掉；照旧 proposed，本人确认才 active；再按模板编译不覆盖", async () => {
    const { engine, model, report } = await run();
    const call = model.calls.find((c) => c.purpose === "strategies")!;
    expect(call.system).toBe(STRATEGY_SYSTEM);
    const need = members(engine, liftGroup(engine, "need")!.key)[0]!;
    const value = members(engine, liftGroup(engine, "value")!.key)[0]!;
    expect(call.user).toContain(need.statement);
    const [s] = engine.listStrategies();
    expect(s).toMatchObject({
      template: "model_written",
      when: "替用户安排周末、假期或工作日的时间时",
      actions: ["每天至少留出半天不排任何事", "要替他约人或定时间，先发消息问他行不行"],
      status: "proposed",
      confirmedBy: null,
    });
    // 330 号票（R6）：同主题的猜测（把握不是 low 的）也挂进依据
    expect(s!.basisClaimIds).toEqual(expect.arrayContaining([need.id, value.id]));
    expect(s!.basisClaimIds.filter((id) => id !== need.id && id !== value.id).map((id) => engine.store.getClaim(id)!.status)).toEqual(
      s!.basisClaimIds.filter((id) => id !== need.id && id !== value.id).map(() => "contested"),
    );
    expect(s!.trigger.domains).toEqual(expect.arrayContaining(["schedule", "social"]));
    const reasons = report.dropped.filter((d) => d.stage === "strategies").map((d) => d.reason).join("\n");
    expect(reasons).toContain("空话：注意用户的感受");
    expect(reasons).toContain("伪造的依据 key：bogus-key");
    expect(engine.getUserModel({}).strategies).toEqual([]);

    engine.ingestEvidence(say("ev-ok", "对，以后就这样安排", NOW));
    expect(engine.confirmStrategy(s!.id, "ev-ok")).toMatchObject({ status: "active" });
    expect(engine.getUserModel({}).strategies).toEqual([expect.objectContaining({ strategyId: s!.id })]);
    const again = engine.compileStrategies();
    expect(again).toMatchObject({ created: [], updated: [] });
    expect(engine.store.getStrategy(s!.id)).toMatchObject({ template: "model_written", status: "active", when: "替用户安排周末、假期或工作日的时间时" });
  });

  it("模型一条能用的做法都没写 → 不建策略（以后按需编译时用通用模板顶上）", async () => {
    const { engine, report } = await run({ strategies: () => ({ strategies: [] }) });
    expect(engine.store.listStrategies()).toEqual([]);
    expect(report.dropped.filter((d) => d.stage === "strategies").map((d) => d.reason)).toContain("模型没写出能用的策略");
    const [s] = engine.compileStrategies().strategies;
    expect(s).toMatchObject({ template: "consider_motive", status: "proposed" });
  });
});

describe("预计费用（--dry-run）加上往上抽、编策略两步", () => {
  it("门槛过了就估需求层、价值层各一次往上抽和一次编策略；门槛不过就不估", async () => {
    const plan = await planModelRun(source(STORY));
    expect(plan.estimate.byPurpose.lift).toMatchObject({ calls: 2 });
    expect(plan.estimate.byPurpose.strategies).toMatchObject({ calls: 1 });
    expect(plan.estimate.byPurpose.lift!.inputTokens).toBeGreaterThan(0);
    expect(formatPlan(plan, "test")).toMatch(/\| lift \| 2 \|/);
    const small = await planModelRun(source(STORY.slice(0, 2)));
    // 256 号票：两条证据也过了结构门槛（先出临时结论），所以这次照样估往上抽两次（需求层、价值层）；
    // 估算还按"会出需求"算了一次编策略（实际编策略要成立的需求、价值）
    expect(small.estimate.byPurpose.lift).toMatchObject({ calls: 2 });
    expect(small.estimate.byPurpose.strategies).toMatchObject({ calls: 1 });
  });
});

describe("226：往上抽的每条解释写一条预测（进结论的 predicts，成立的进预测账本）", () => {
  it("模型输出带 predicts → 结论上有；需求 +14 天、价值 +30 天记进账本", async () => {
    const { engine } = await run({
      need: (r) => {
        const out = needOutput(r);
        return withPredicts(out, ["接下来两周再被约周末，他还会推掉", "接下来两周他还会说忙"]);
      },
      value: (r) => {
        const out = valueOutput(r);
        return withPredicts(out, ["接下来两周遇到安排冲突，他还会先保自主"]);
      },
    });
    const group = liftGroup(engine, "need")!;
    const [need, busy] = members(engine, group.key);
    // 330 号票：没写推法的按可废止（原始推理图谱：缺省按弱的算）
    expect(need!.predicts).toEqual([{ claim: "接下来两周再被约周末，他还会推掉", outcome: "pending", evidenceIds: [], derivation: "defeasible" }]);
    expect(busy!.predicts.map((p) => p.claim)).toEqual(["接下来两周他还会说忙"]);
    const value = members(engine, liftGroup(engine, "value")!.key)[0]!;
    expect(value.predicts.map((p) => p.claim)).toEqual(["接下来两周遇到安排冲突，他还会先保自主"]);

    // 账本：成立的需求、价值各一条；需求 +14 天、价值 +30 天；还拿不准的 state 不记
    const open = engine.store.listPredictions({ status: "open" });
    expect(open.map((p) => p.claimId).toSorted()).toEqual([need!.id, value.id].toSorted());
    expect(open.find((p) => p.claimId === need!.id)?.dueAt).toBe(addDays(NOW, 14));
    expect(open.find((p) => p.claimId === value.id)?.dueAt).toBe(addDays(NOW, 30));
  });

  it("330：模型说预测是演绎的，只有结论陈述里真有全称说法（每次、从不……）才认 deductive，别的照样按可废止；账本节点带着推法", async () => {
    const { engine } = await run({
      need: (r) => {
        const out = withPredicts(needOutput(r), ["下次再被约周末，他还会推掉", "接下来两周他还会说忙"]);
        const [first, second] = out.groups[0]!.hypotheses as { statement: string; derivation?: string }[];
        first!.statement = `${first!.statement}（每次被提前排满都推掉）`;
        first!.derivation = "deductive";
        second!.derivation = "deductive";
        return out;
      },
    });
    const [need, busy] = members(engine, liftGroup(engine, "need")!.key);
    expect(need!.predicts[0]).toMatchObject({ derivation: "deductive" });
    expect(busy!.predicts[0]).toMatchObject({ derivation: "defeasible" });
    expect(engine.store.listPredictions({ claimId: need!.id })[0]).toMatchObject({ derivation: "deductive", premiseIds: [need!.id], retractedBy: null, blame: null });
    expect(LIFT_SYSTEM_NEED).toContain("derivation");
  });

  it("缺了、太长、不像预测的：留空，结论照建（不因此丢这条解释）", async () => {
    const { engine } = await run({
      need: (r) => {
        const out = needOutput(r);
        return withPredicts(out, ["接下来两周遇到类似的情况他还会再推掉而且还会找各种理由不参加这些活动", "因为那天天气不错"]);
      },
    });
    const group = liftGroup(engine, "need")!;
    const [need, busy] = members(engine, group.key);
    expect(need!.predicts).toEqual([]);
    expect(busy!.predicts).toEqual([]);
    expect(engine.store.listPredictions()).toEqual([]);
  });

  it("模型没写 predicts（缺字段）：结论照建，账本空的", async () => {
    const { engine } = await run();
    for (const c of members(engine, liftGroup(engine, "need")!.key)) expect(c.predicts).toEqual([]);
    expect(engine.store.listPredictions()).toEqual([]);
  });

  it("已有的组下次整理照旧交回：预测不会因为再整理一次丢掉", async () => {
    const t = await run({
      need: (r) => {
        const out = needOutput(r);
        return withPredicts(out, ["接下来两周再被约周末，他还会推掉"]);
      },
    });
    const need = members(t.engine, liftGroup(t.engine, "need")!.key)[0]!;
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-4", "今天去公司开了个会", "2026-10-13T10:00:00+08:00", { context: ["workday", "work"] }));
    await t.engine.reflect();
    expect(t.engine.store.getClaim(need.id)!.predicts.map((p) => p.claim)).toEqual(["接下来两周再被约周末，他还会推掉"]);
    expect(t.engine.store.listPredictions({ status: "open" })).toHaveLength(1);
  });
});

describe("221：往上抽的提示词讲清一组要跨两种以上互不重叠的场景", () => {
  /** 周末三条（跨 4、6、8 月）+ 假期、工作日各一条：整体过门槛（假期家里 vs 工作日工作，方面不同），只挑周末的归组就只落一种场景 */
  const ONE_SCENE_STORY: EvidenceDraft[] = [
    say("ev-w1", "我不喜欢周末被排得满满的", "2026-04-04T10:00:00+08:00", { context: ["weekend"] }),
    say("ev-w2", "我不喜欢周末去聚餐", "2026-06-06T10:00:00+08:00", { context: ["weekend"] }),
    say("ev-w3", "我不喜欢周末去爬山", "2026-08-08T10:00:00+08:00", { context: ["weekend"] }),
    say("ev-h1", "假期我也不喜欢被提前排满", "2026-08-02T10:00:00+08:00", { context: ["holiday", "family"] }),
    say("ev-d1", "工作日我也不喜欢被临时安排", "2026-09-09T10:00:00+08:00", { context: ["workday", "work"] }),
  ];

  it("两条系统提示词都要求每组自己跨两种以上互相不重叠的场景；标签互相包含的不算两种；只落一种场景的不要归组、宁可少给组", () => {
    for (const prompt of [LIFT_SYSTEM_NEED, LIFT_SYSTEM_VALUE]) {
      expect(prompt).toContain("每一组");
      expect(prompt).toContain("两种以上互相不重叠的场景");
      expect(prompt).toMatch(/谁也包含不了谁/);
      expect(prompt).toContain("只落一种场景");
      expect(prompt).toContain("宁可少给组");
    }
  });

  it("模型交回的组只落一种场景（三条、跨三个月、证据也够）：代码仍按“场景不够”丢掉，记进 dropped 和统计", async () => {
    let picked: string[] = [];
    const { engine, report } = await run(
      {
        need: (r) => {
          const out = needOutput(r);
          picked = premisesOf(r)
            .filter((p) => JSON.stringify(p.scenes) === JSON.stringify([["weekend"]]))
            .map((p) => p.claim_id);
          out.groups[0]!.premise_ids = picked;
          return out;
        },
      },
      ONE_SCENE_STORY,
    );
    expect(picked).toHaveLength(3);
    expect(liftGroup(engine, "need")).toBeUndefined();
    expect(report.dropped.filter((d) => d.stage === "lift").map((d) => d.reason)).toContainEqual(expect.stringMatching(/^没过门槛：场景不够：/));
    expect(report.stats!.lift.failures).toEqual([
      expect.objectContaining({ level: "need", reasons: ["场景不够"], premises: 3, disjointScenes: false, scenes: 1, months: 3, evidence: 3 }),
    ]);
    expect(report.stats!.lift.byReason).toMatchObject({ 场景不够: 1 });
  });
});

// 223 号票：往上抽的"两种场合"按维度判不同（共享一个标签也算），老严格判定只用来统计；
// 月份、证据条数的门槛一个没改。
describe("223：两种场合按维度判不同，严格判定只做统计", () => {
  const TIMES: Readonly<Record<string, string>> = {
    "ev-aug-1": "2026-08-08T10:00:00+08:00",
    "ev-aug-2": "2026-08-16T10:00:00+08:00",
    "ev-aug-3": "2026-08-24T10:00:00+08:00",
    "ev-sep": "2026-09-06T10:00:00+08:00",
  };
  /** 只给 liftThreshold 用的最小视图：它只看证据的时间 */
  const view = { evidence: (id: string) => ({ id, eventTime: TIMES[id], observedAt: TIMES[id] }) } as unknown as RgView;
  const premise = (scene: string[], evidenceIds: string[]): LiftInput => ({ scenes: [scene], supportEvidenceIds: evidenceIds }) as unknown as LiftInput;
  const homeLeisure = ["family", "leisure"];
  const homeWork = ["family", "work"];

  it("共享「家里」的两组场景现在的门槛算过了；月份、证据条数不够的降成临时结论，差在哪照旧写（256 号票）", () => {
    const ok = liftThreshold("need", [premise(homeLeisure, ["ev-aug-1", "ev-aug-2"]), premise(homeWork, ["ev-sep"])], view);
    expect(ok).toMatchObject({ ok: true, provisional: false, disjoint: true, months: 2 });
    expect(ok.evidenceIds).toHaveLength(3);
    // 两个月、两种场合，只有两条证据 → 能出，但先标临时（软的只剩证据条数这一条）
    const thin = liftThreshold("need", [premise(homeLeisure, ["ev-aug-1"]), premise(homeWork, ["ev-sep"])], view);
    expect(thin).toMatchObject({ ok: true, provisional: true, disjoint: true, months: 2, softFailed: ["证据条数不够"] });
    expect(thin.reason).toMatch(/证据条数不够/);
    // 三条证据都在八月 → 月份不够，也是临时
    const oneMonth = liftThreshold("need", [premise(homeLeisure, ["ev-aug-1", "ev-aug-2"]), premise(homeWork, ["ev-aug-3"])], view);
    expect(oneMonth).toMatchObject({ ok: true, provisional: true, months: 1, evidenceIds: ["ev-aug-1", "ev-aug-2", "ev-aug-3"], softFailed: ["月份不够"] });
    // 只落一种场合 → 结构门槛，出不了
    const oneScene = liftThreshold("need", [premise(homeLeisure, ["ev-aug-1", "ev-aug-2", "ev-sep"])], view);
    expect(oneScene).toMatchObject({ ok: false, provisional: false, disjoint: false, scenes: [homeLeisure], failed: ["场景不够"] });
  });

  it("模型交回的组：共享一个标签的记 passedLoose，老严格判定也过的记 passedStrict", async () => {
    // 周末、假期、工作日完全不相交：老严格判定也过
    const strict = await run();
    expect(strict.report.stats!.lift).toMatchObject({ passed: 2, passedStrict: 2, passedLoose: 0 });
    // 家里、休闲 和 家里、工作 共享「家里」：新判定过、老判定不算
    const loose = await run({}, HOME_STORY);
    expect(loose.report.stats!.lift).toMatchObject({ passed: 1, passedStrict: 0, passedLoose: 1 });
    expect(liftGroup(loose.engine, "need")).toBeDefined();
  });
});

// 272 号票第 6 条：往上抽每夜把同一批没被用上的下层断言再问一遍模型（线上 10-25 一夜 9 次、270 号票试跑每夜 7 次）。
// 问过一次、模型没归组的，没变化就不再问；其中哪条有了新证据，只把它当这一批再问（别的照旧给摘要，可以一起归组）
const premiseIds = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => (JSON.parse(l) as { claim_id: string }).claim_id);

describe("272：往上抽没变化就不再问", () => {
  it("没被用上的下层断言问过一次、模型没归组：之后的夜里没变化就不问（记成下层断言没有变化）；其中一条有了新证据，只把它当这一批再问", async () => {
    const t = await run({ need: () => ({ groups: [] }) });
    const liftCalls = () => t.model.calls.filter((c) => c.purpose === "lift");
    expect(liftCalls()).toHaveLength(1);

    // 第二夜：来了无关的证据——三条下层断言都没变，不再问
    t.setNow("2026-10-13T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-4", "今天去公司开了个会", "2026-10-13T10:00:00+08:00", { context: ["workday", "work"] }));
    const quiet = await t.engine.reflect();
    expect(liftCalls()).toHaveLength(1);
    expect(quiet.stats?.lift.notAsked["need：下层断言没有变化"]).toBe(1);
    expect(quiet.stats?.steps.lift?.unchanged).toBe(3);

    // 第三夜：工作日那句又说了一次（同一条事实多了一条证据）：只把它当这一批再问，另两条给摘要
    t.setNow("2026-10-14T12:00:00+08:00");
    t.engine.ingestEvidence(say("ev-5", "工作日我也不喜欢被提前排满", "2026-10-14T10:00:00+08:00", { context: ["workday", "work"] }));
    await t.engine.reflect();
    expect(liftCalls()).toHaveLength(2);
    const user = liftCalls()[1]!.user;
    expect(premiseIds(user.split("这一批要归纳的下层断言")[1]!.split("别的下层断言")[0]!)).toEqual([stated(t.engine, "ev-3").id]);
    expect(premiseIds(user.split("别的下层断言")[1]!).toSorted()).toEqual([stated(t.engine, "ev-1").id, stated(t.engine, "ev-2").id].toSorted());
  });
});
