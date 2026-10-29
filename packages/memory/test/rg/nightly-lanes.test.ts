// 270 号票：每晚整理的预算按道花（模型版，假模型）。线上 10-22 到 10-25 连着四夜"新证据 0 条"：每夜把全部旧追问按建组先后重判一遍，
// 前段 150 次用光，新组的追问排在最后轮不上（预算用完时还被写成"没找到"），记整理过又是全有或全无——一次被挡就一条都不记。
// 这里搭一个小世界：十个旧话题各两条证据（一组竞争假设、三条追问），新证据进来以后看预算先花在哪。
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceDraft } from "../../src/domain/types.ts";
import { LlmFactExtractor } from "../../src/kg/llm-extractor.ts";
import { FakeChatModel, type ChatRequest } from "../../src/llm/chat.ts";
import { runNightly } from "../../src/nightly.ts";
import { LIFT_BUDGET_SHARE } from "../../src/rg/reasoning-graph.ts";
import { LlmReasoner } from "../../src/rg/llm-reasoner.ts";
import { closeEngines, openEngine, type TestEngine } from "./helpers.ts";

afterEach(closeEngines);

/** 旧话题（每个关键词三个字，互相没有相同的两字词，检索时不串） */
const OLD = ["皮划艇", "羽毛球", "电子琴", "乒乓球", "冲浪板", "天文台", "陶艺课", "书法帖", "围棋谱", "烘焙坊"] as const;
const NEW = "攀岩馆";
const TOPICS = [...OLD, NEW];

const ids = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]!);
const topicOf = (text: string) => TOPICS.find((k) => text.includes(k));

/** 一条本人说的话（第 day 天、第 hour 点） */
const said = (id: string, topic: string, day: number, hour = 20): EvidenceDraft => {
  const at = `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`;
  return { id, sourceLevel: "self", mode: "say", kind: "utterance", text: `这周我又去弄了${topic}，挺喜欢的。`, context: ["leisure"], eventTime: at, observedAt: at };
};

/**
 * 假模型：抽事实一条证据一条"喜欢某话题"；出假设把这一批里同一话题两条以上的观察并成一组（喜欢 / 最近在试）；
 * 每组三条追问，查询就是话题词；判证据什么都不认（只记问了哪条）——support 里的话题例外：检索到的最后一条证据决定性地支持"喜欢"。
 */
function world(support: readonly string[] = [], merge: readonly string[] = []) {
  const asked: string[] = [];
  const model = new FakeChatModel((req: ChatRequest) => {
    if (req.purpose === "extract") {
      const lines = req.user.split("\n").filter((l) => l.startsWith("{"));
      return {
        // 272：说的不是哪个话题的抽不出观察；merge 里的话题每次说都是同一条观察（多一条证据），别的每次一条新观察
        facts: lines.flatMap((l) => {
          const e = JSON.parse(l) as { evidence_id: string; text: string };
          const topic = topicOf(e.text);
          if (topic === undefined) return [];
          const name = merge.includes(topic) ? topic : `${topic}（${e.evidence_id}）`;
          return [{ evidence_id: e.evidence_id, predicate: "prefers", object: { name, type: "activity" }, negated: false, context: ["leisure"], statement: `用户喜欢${name}`, span: topic }];
        }),
      };
    }
    if (req.purpose === "propose") {
      const batch = req.user.split("这一批的观察")[1]!.split("别的事实")[0]!;
      const byTopic = new Map<string, string[]>();
      for (const line of batch.split("\n").filter((l) => l.startsWith("{"))) {
        const f = JSON.parse(line) as { fact_id: string; evidence: { text: string }[] };
        const topic = topicOf(f.evidence.map((e) => e.text).join(""));
        if (topic) byTopic.set(topic, [...(byTopic.get(topic) ?? []), f.fact_id]);
      }
      return {
        groups: [...byTopic]
          .filter(([, facts]) => facts.length >= 2)
          .map(([topic, facts]) => ({
            observation_ids: facts,
            description: `${topic}这件事`,
            hypotheses: [
              { tier: "preference", statement: `用户喜欢${topic}`, context: ["leisure"], supports: [{ target: facts[0], weight: "strong", rationale: "说喜欢" }], refutes: [] },
              { tier: "state", statement: `用户最近在试${topic}`, context: ["leisure"], valid_to: null, supports: [{ target: facts[1], weight: "weak", rationale: "最近又去" }], refutes: [] },
            ],
          })),
      };
    }
    if (req.purpose === "probes") {
      const topic = topicOf(req.user)!;
      const claims = ids(/"claim_id":"(cl-\d+)"/g, req.user);
      return { probes: [1, 2, 3].map((i) => ({ discriminates: [claims[0], claims[1]], ask: `${topic}第${i}问`, queries: [topic], if_found: claims[0] })) };
    }
    if (req.purpose === "judge") {
      const ask = /追问：(\S+?)（/.exec(req.user)![1]!;
      asked.push(ask);
      const topic = topicOf(ask)!;
      if (!support.includes(topic)) return { found_evidence_ids: [], if_found: null, links: [] };
      const claims = ids(/"claim_id":"(cl-\d+)"/g, req.user);
      const evidence = ids(/"evidence_id":"(ev-[^"]+)"/g, req.user);
      const last = evidence.at(-1)!;
      return { found_evidence_ids: [last], if_found: claims[0], links: [{ claim_id: claims[0], evidence_id: last, polarity: "supports", weight: "decisive", rationale: "自己说喜欢" }] };
    }
    return {};
  }, "fake-lanes");
  return { model, asked };
}

/** 第一夜：十个旧话题各两条证据，预算够，建好十组、三十条追问 */
async function builtWorld(support: readonly string[] = [], merge: readonly string[] = []): Promise<TestEngine & ReturnType<typeof world>> {
  const w = world(support, merge);
  const t = openEngine("2026-10-11T03:00:00+08:00", { reasoner: new LlmReasoner(w.model), extractor: new LlmFactExtractor(w.model), joint: false });
  OLD.forEach((topic, i) => {
    t.engine.ingestEvidence(said(`ev-${i}a`, topic, i + 1, 9));
    t.engine.ingestEvidence(said(`ev-${i}b`, topic, i + 1, 21));
  });
  const first = await t.engine.reflect({ maxModelCalls: 500 });
  expect(first.processedEvidenceIds).toHaveLength(20);
  expect(t.engine.rg.registry.listGroups({ live: true })).toHaveLength(10);
  expect(t.engine.store.listProbes()).toHaveLength(30);
  w.asked.length = 0;
  w.model.calls.length = 0;
  return { ...t, ...w };
}

/** 前段（新证据、重跑旧追问）最多几次：总数减掉留给往上抽的那 1/4 */
const early = (limit: number) => limit - Math.floor(limit * LIFT_BUDGET_SHARE);

describe("270：每晚整理先读新证据", () => {
  it("新证据先：新组的追问、检索结果里有新证据的旧追问先问；别的旧追问没有新东西，不重判；整理完的新证据记下来", async () => {
    const t = await builtWorld();
    t.setNow("2026-10-13T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-n1", NEW, 12, 9));
    t.engine.ingestEvidence(said("ev-n2", NEW, 12, 21));
    t.engine.ingestEvidence(said("ev-t6", "天文台", 11, 20));
    // 12 次：前段 9 次 = 抽事实 1 + 出假设 1 + 新组出追问 1 + 新组三条追问 3 + 天文台三条旧追问 3（它们的检索结果里有新证据）
    expect(early(12)).toBe(9);
    const report = await t.engine.reflect({ maxModelCalls: 12 });
    expect(t.asked.toSorted()).toEqual(["天文台第1问", "天文台第2问", "天文台第3问", `${NEW}第1问`, `${NEW}第2问`, `${NEW}第3问`].toSorted());
    // 新组的追问排在最前面（没问过的先问）
    expect(t.asked.slice(0, 3)).toEqual([`${NEW}第1问`, `${NEW}第2问`, `${NEW}第3问`]);
    expect(report.processedEvidenceIds.toSorted()).toEqual(["ev-n1", "ev-n2", "ev-t6"]);
    expect(report.backlog).toBe(0);
    expect(report.budgetExhausted).toBe(false);
    expect(report.spend).toEqual({ limit: 12, newEvidence: 9, replies: 0, rejudge: 0, lift: 0, predictions: 0, strategies: 0 });
    expect(report.modelCalls).toBe(9);
    // 跑了的追问只算真问了的
    expect(report.probeIds).toHaveLength(6);
    // 下一夜没有新证据、也没有待复核的：跳过，不再重判旧追问
    t.setNow("2026-10-14T03:00:00+08:00");
    const quiet = await t.engine.reflect({ maxModelCalls: 12 });
    expect(quiet.skipped).toBeDefined();
    expect(quiet.modelCalls).toBe(0);
  });

  it("积压比一夜的预算多：按时间先后，最早的先整理完；没轮到的留着，下一夜接着从最早的做，几夜消化完", async () => {
    const t = await builtWorld();
    t.setNow("2026-10-20T03:00:00+08:00");
    // 六条新证据各提到一个旧话题（先后：皮划艇最早），每条都在那个话题三条旧追问的检索结果里
    OLD.slice(0, 6).forEach((topic, i) => t.engine.ingestEvidence(said(`ev-new${i}`, topic, 12 + i)));
    // 13 次：前段 10 次 = 抽事实 1 + 出假设 1 + 判证据 8 → 皮划艇、羽毛球两条的追问问全了，电子琴问了两条
    expect(early(13)).toBe(10);
    const night1 = await t.engine.reflect({ maxModelCalls: 13 });
    expect(t.asked).toEqual(["皮划艇第1问", "皮划艇第2问", "皮划艇第3问", "羽毛球第1问", "羽毛球第2问", "羽毛球第3问", "电子琴第1问", "电子琴第2问"]);
    expect(night1.processedEvidenceIds).toEqual(["ev-new0", "ev-new1"]);
    expect(night1.backlog).toBe(4);
    expect(night1.budgetExhausted).toBe(true);
    expect(night1.spend).toMatchObject({ newEvidence: 10, rejudge: 0 });

    t.asked.length = 0;
    t.setNow("2026-10-21T03:00:00+08:00");
    const night2 = await t.engine.reflect({ maxModelCalls: 13 });
    // 抽过的不再抽；272 号票起第一夜问过、没进组的观察没变化，不再拿去出假设：判证据 10（电子琴、乒乓球、冲浪板，天文台问了一条）
    expect(t.asked).toEqual(["电子琴第1问", "电子琴第2问", "电子琴第3问", "乒乓球第1问", "乒乓球第2问", "乒乓球第3问", "冲浪板第1问", "冲浪板第2问", "冲浪板第3问", "天文台第1问"]);
    expect(night2.processedEvidenceIds).toEqual(["ev-new2", "ev-new3", "ev-new4"]);
    expect(night2.backlog).toBe(1);

    t.setNow("2026-10-22T03:00:00+08:00");
    const night3 = await t.engine.reflect({ maxModelCalls: 13 });
    expect(night3.processedEvidenceIds).toEqual(["ev-new5"]);
    expect(night3.backlog).toBe(0);
    expect(night3.budgetExhausted).toBe(false);
  });

  it("保底：重跑旧追问（待复核的组）只用新证据剩下的；预算够时才轮到它，花了几次单独记", async () => {
    const t = await builtWorld();
    const doubted = t.engine.rg.registry.members(t.engine.rg.registry.listGroups({ live: true })[8]!.key)[0]!.claimId; // 围棋谱那组
    t.engine.rg.markClaimForReview(doubted, { reason: "测试：拿不准" });
    t.setNow("2026-10-13T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-n1", NEW, 12, 9));
    t.engine.ingestEvidence(said("ev-n2", NEW, 12, 21));

    // 预算只够新证据：新组的三条问完就停，待复核那组一条没轮到（它照旧按现有证据重判，这是待复核本来的意思）
    expect(early(8)).toBe(6);
    const tight = await t.engine.reflect({ maxModelCalls: 8 });
    expect(t.asked).toEqual([`${NEW}第1问`, `${NEW}第2问`, `${NEW}第3问`]);
    expect(tight.processedEvidenceIds.toSorted()).toEqual(["ev-n1", "ev-n2"]);
    expect(tight.spend).toMatchObject({ newEvidence: 6, rejudge: 0 });
    expect(tight.budgetExhausted).toBe(true);

    // 下一夜（又来一条新证据、那条又拿不准了）预算宽：新证据先，剩下的重跑待复核那组；别的组没有新东西，不重判
    t.engine.rg.markClaimForReview(doubted, { reason: "测试：又拿不准" });
    t.asked.length = 0;
    t.setNow("2026-10-14T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-t1", "皮划艇", 13));
    const roomy = await t.engine.reflect({ maxModelCalls: 40 });
    expect(t.asked).toEqual(["皮划艇第1问", "皮划艇第2问", "皮划艇第3问", "围棋谱第1问", "围棋谱第2问", "围棋谱第3问"]);
    expect(roomy.spend).toMatchObject({ newEvidence: 5, rejudge: 3 });
    expect(roomy.spend!.newEvidence + roomy.spend!.rejudge + roomy.spend!.lift + roomy.spend!.predictions + roomy.spend!.strategies).toBe(roomy.modelCalls);
  });

  it("新组的追问没轮上就留着没问过（open），下一夜最先问；欠着追问的新证据不算整理过", async () => {
    const t = await builtWorld();
    t.setNow("2026-10-13T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-n1", NEW, 12, 9));
    t.engine.ingestEvidence(said("ev-n2", NEW, 12, 21));
    // 5 次：前段 4 次 = 抽事实 1 + 出假设 1 + 出追问 1 + 判证据 1
    const night1 = await t.engine.reflect({ maxModelCalls: 5 });
    expect(t.asked).toEqual([`${NEW}第1问`]);
    expect(night1.processedEvidenceIds).toEqual([]);
    expect(night1.backlog).toBe(2);
    const open = t.engine.store.listProbes().filter((p) => p.outcome === "open").map((p) => p.ask);
    expect(open).toEqual([`${NEW}第2问`, `${NEW}第3问`]);

    t.asked.length = 0;
    t.setNow("2026-10-14T03:00:00+08:00");
    const night2 = await t.engine.reflect({ maxModelCalls: 12 });
    expect(t.asked.slice(0, 2)).toEqual([`${NEW}第2问`, `${NEW}第3问`]);
    expect(night2.processedEvidenceIds.toSorted()).toEqual(["ev-n1", "ev-n2"]);
  });

  it("到期复评：剩下的预算重跑有到期结论的组，追问全问过一遍就记下复核时间，30 天里不再当到期的重跑", async () => {
    const t = await builtWorld(["皮划艇"]);
    const liked = t.engine.store.listClaims().find((c) => c.statement === "用户喜欢皮划艇")!;
    expect(liked.status).toBe("active");
    // 过了 30 多天：它到期复评了；来了两条新话题的新证据
    t.setNow("2026-11-15T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-n1", NEW, 14, 9));
    t.engine.ingestEvidence(said("ev-n2", NEW, 14, 21));
    const night1 = await t.engine.reflect({ maxModelCalls: 40 });
    // 新证据先（新组的三条），剩下的重跑到期的那组；别的组没有到期的结论、检索结果里也没新东西，不重判
    expect(t.asked).toEqual([`${NEW}第1问`, `${NEW}第2问`, `${NEW}第3问`, "皮划艇第1问", "皮划艇第2问", "皮划艇第3问"]);
    expect(night1.spend).toMatchObject({ newEvidence: 6, rejudge: 3 });
    expect(t.engine.store.getClaim(liked.id)!.reviewedAt).toBe("2026-11-15T03:00:00+08:00");

    // 第二天又有新证据：皮划艇那组刚复核过，不再重跑
    t.asked.length = 0;
    t.setNow("2026-11-16T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-t2", "羽毛球", 15));
    const night2 = await t.engine.reflect({ maxModelCalls: 40 });
    expect(t.asked).toEqual(["羽毛球第1问", "羽毛球第2问", "羽毛球第3问"]);
    expect(night2.spend).toMatchObject({ rejudge: 0 });
  });

  it("整理报告写清每一道花了几次、按步骤几次、还积压几条", async () => {
    const t = await builtWorld();
    t.setNow("2026-10-20T03:00:00+08:00");
    OLD.slice(0, 6).forEach((topic, i) => t.engine.ingestEvidence(said(`ev-new${i}`, topic, 12 + i)));
    const result = await runNightly(t.engine, { manual: true, maxModelCalls: 13, userActive: false });
    if (!result.ran) throw new Error("应该跑了");
    const text = result.report.text;
    expect(text).toContain("新证据整理完 2 条、还积压 4 条");
    expect(text).toContain("预算：调了 10 次（上限 13）：新证据 10、判回答 0、重跑旧追问 0、往上抽 0、判预测 0、编策略 0");
    expect(text).toContain("按步骤：抽事实 1、出假设 1、判证据 8");
    expect(result.report.backlog).toBe(4);
  });
});

// 272 号票第 6 条：整理里两处重复花钱——一直没进组的新观察每夜再拿去出一次假设、往上抽每夜把同一批没被用上的下层断言再问一遍
// （往上抽那一处在 llm-lift.test.ts）。没变化就跳过，有新证据才再问。
const proposeRequests = (t: { model: FakeChatModel }) => t.model.calls.filter((c) => c.purpose === "propose");
const factIdsIn = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => (JSON.parse(l) as { fact_id: string }).fact_id);
/** 出假设时"这一批的观察"（要模型解释的）里的观察 */
const batchFacts = (requests: readonly ChatRequest[]) => requests.flatMap((r) => factIdsIn(r.user.split("这一批的观察")[1]!.split("别的事实")[0]!));
/** "别的事实"（只有摘要，可以并进组）里的观察 */
const otherFacts = (request: ChatRequest) => factIdsIn(request.user.split("别的事实")[1]!);

describe("272：没变化就不再问出假设", () => {
  it("一直没进组的新观察问过一次就不再当这一批的观察（只在别的事实里给模型看）；它有了新证据才再问；一条要问的观察都没有的夜里不问出假设", async () => {
    const t = await builtWorld([], [NEW]);
    // 第二夜：攀岩馆说了一次——一条观察，进不了组
    t.setNow("2026-10-13T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-n1", NEW, 12, 9));
    await t.engine.reflect({ maxModelCalls: 50 });
    const climbing = t.engine.store.factsByEvidence("ev-n1")[0]!;
    expect(batchFacts(proposeRequests(t))).toEqual([climbing.id]);
    expect(t.engine.rg.registry.listGroups({ live: true }).some((g) => g.observationIds.includes(climbing.id))).toBe(false);
    t.model.calls.length = 0;

    // 第三夜：别的新观察（皮划艇第三次）：只问新的那条；攀岩馆那条没变化，不再当这一批的观察，只在别的事实里
    t.setNow("2026-10-14T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-k3", "皮划艇", 13, 9));
    const third = await t.engine.reflect({ maxModelCalls: 50 });
    const kayak = t.engine.store.factsByEvidence("ev-k3")[0]!;
    expect(proposeRequests(t)).toHaveLength(1);
    expect(batchFacts(proposeRequests(t))).toEqual([kayak.id]);
    expect(otherFacts(proposeRequests(t)[0]!)).toContain(climbing.id);
    expect(third.stats?.steps.propose).toMatchObject({ calls: 1, unchanged: 1 });
    t.model.calls.length = 0;

    // 第四夜：一句不涉及哪个话题的话（抽不出观察）：没有要问的观察，出假设一次都不问
    t.setNow("2026-10-15T03:00:00+08:00");
    t.engine.ingestEvidence({ ...said("ev-x1", NEW, 14, 9), text: "今天天气不错。" });
    const fourth = await t.engine.reflect({ maxModelCalls: 50 });
    expect(proposeRequests(t)).toEqual([]);
    expect(fourth.stats?.steps.propose?.calls ?? 0).toBe(0);
    t.model.calls.length = 0;

    // 第五夜：攀岩馆又说了一次（同一条观察多了一条证据）：有新证据了，再问一次
    t.setNow("2026-10-16T03:00:00+08:00");
    t.engine.ingestEvidence(said("ev-n2", NEW, 15, 9));
    await t.engine.reflect({ maxModelCalls: 50 });
    expect(t.engine.store.getFact(climbing.id)!.evidenceIds).toEqual(["ev-n1", "ev-n2"]);
    expect(batchFacts(proposeRequests(t))).toEqual([climbing.id]);
  });
});
