// 196 号票：为任务调出相关的用户模型（往上走、结论索引、领域三条路）。例子都是自己写的（test/rg/task-helpers.ts）。
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import { domainsOfTags, domainsOfText, taskDomains } from "../../src/rg/domains.ts";
import type { RelevantUserModel } from "../../src/rg/value-retrieval.ts";
import { closeEngines, say } from "./helpers.ts";
import { ids, member, NEED, statedOf, storyEngine, VALUE, WEEKEND_GROUP, WORKDAY_GROUP } from "./task-helpers.ts";

afterEach(closeEngines);

const all = (m: RelevantUserModel) => [...m.state, ...m.preferences, ...m.needs, ...m.values, ...m.uncertain];
const find = (m: RelevantUserModel, claimId: string) => all(m).find((e) => e.claimId === claimId);

describe("领域：一张通用的'场景和活动 → 领域'词表", () => {
  it("情境标签、说法、任务都能归到领域", () => {
    expect(domainsOfTags(["weekend", "social"])).toEqual(["schedule", "social"]);
    expect(domainsOfTags(["work", "business_trip"])).toEqual(["career", "travel"]);
    expect(domainsOfText("被提前排满")).toEqual(["schedule"]);
    expect(domainsOfText("香菜")).toEqual(["health"]);
    expect(taskDomains("帮我安排下周六")).toEqual(["schedule"]);
    expect(taskDomains("周日中午帮我订个餐厅，和同学聚餐")).toEqual(["schedule", "social", "spending"]);
    expect(taskDomains("帮我想想要不要转岗", ["work"])).toEqual(["career"]);
    expect(taskDomains("今天天气怎么样")).toEqual([]);
  });

  it("断言的领域由它的证据和下层断言算：需求跨了周末社交和工作日工作，忌口在健康", async () => {
    const { engine } = await storyEngine();
    engine.claimIndex.sync();
    expect(engine.claimIndex.domainsOf(member(engine, NEED, "need_autonomy").id)).toEqual(["schedule", "social", "career"]);
    expect(engine.claimIndex.domainsOf(member(engine, VALUE, "value_enduring").id)).toEqual(["schedule", "social", "career"]);
    expect(engine.claimIndex.domainsOf(member(engine, WEEKEND_GROUP, "scene_autonomy").id)).toEqual(["schedule", "social"]);
    expect(engine.claimIndex.domainsOf(statedOf(engine, "ev-a1", "dislikes").id)).toEqual(["health"]);
  });
});

describe("往上走：从具体任务找到抽象的需求和价值", () => {
  it("'帮我安排下周六' → 命中周六推掉饭局的原话 → '重视周末的自主安排' → 需求'重视自主安排' → 价值'长期看重自主安排'", async () => {
    const { engine } = await storyEngine();
    const weekend = member(engine, WEEKEND_GROUP, "scene_autonomy");
    const need = member(engine, NEED, "need_autonomy");
    const value = member(engine, VALUE, "value_enduring");
    expect([need.status, value.status]).toEqual(["active", "active"]);
    const m = await engine.relevantUserModel("帮我安排下周六");
    expect(m).toMatchObject({ context: ["weekend"], contextFrom: "task", domains: ["schedule"] });
    expect(ids(m.needs)).toEqual([need.id]);
    expect(ids(m.values)).toEqual([value.id]);
    const up = m.needs[0]!.routes.find((r) => r.route === "upward")!;
    expect(up.hitEvidenceIds).toContain("ev-w1");
    expect(up.viaClaimIds).toEqual([weekend.id]);
    const valueUp = m.values[0]!.routes.find((r) => r.route === "upward")!;
    expect(valueUp.viaClaimIds).toEqual([weekend.id, need.id]);
    // 每条带置信度、"推断的"标记和支持证据（只有本人的）
    expect(m.needs[0]).toMatchObject({ label: "inferred", confidence: "medium", status: "active", tier: "need" });
    expect(m.needs[0]!.evidenceIds.toSorted()).toEqual(["ev-d1", "ev-d2", "ev-d3", "ev-w1", "ev-w2", "ev-w3", "ev-w4"]);
  });

  it("字面不沾边也能找到：'下周六帮我看看去哪玩'和'重视自主安排'没有共同的词，结论索引找不到，往上走找得到", async () => {
    const { engine } = await storyEngine();
    const need = member(engine, NEED, "need_autonomy");
    const task = "下周六帮我看看去哪玩";
    const byIndex = await engine.relevantUserModel(task, { routes: ["index"] });
    expect(byIndex.routes.index).not.toContain(need.id);
    const byUpward = await engine.relevantUserModel(task, { routes: ["upward"] });
    expect(ids(byUpward.needs)).toEqual([need.id]);
    expect(ids(byUpward.values)).toEqual([member(engine, VALUE, "value_enduring").id]);
    expect(byUpward.needs[0]!.routes.map((r) => r.route)).toEqual(["upward"]);
  });

  it("往上走不经过待复核、撤回的下层断言；场景对不上的下层断言照样能当路（工作日的偏好也是需求的依据）", async () => {
    const { engine } = await storyEngine();
    const need = member(engine, NEED, "need_autonomy");
    const workday = member(engine, WORKDAY_GROUP, "scene_autonomy");
    // 工作日的事：命中工作日推掉分享会的原话，经"重视工作日的自主安排"到需求
    const m = await engine.relevantUserModel("周二那个分享会要不要去", { routes: ["upward"] });
    expect(m.context).toEqual(["workday"]);
    expect(m.needs[0]!.claimId).toBe(need.id);
    expect(m.needs[0]!.routes[0]!.viaClaimIds).toContain(workday.id);
  });
});

describe("结论索引、领域两条路各自能找到", () => {
  it("结论索引的关键词：任务文字直接对上断言陈述", async () => {
    const { engine } = await storyEngine();
    const need = member(engine, NEED, "need_autonomy");
    const task = "我是不是特别看重自主安排";
    expect((await engine.relevantUserModel(task, { routes: ["upward"] })).needs).toEqual([]);
    const m = await engine.relevantUserModel(task, { routes: ["index"] });
    expect(ids(m.needs)).toEqual([need.id]);
    expect(m.needs[0]!.routes).toEqual([expect.objectContaining({ route: "index", channels: { keyword: expect.objectContaining({ rank: expect.any(Number) }) } })]);
  });

  it("结论索引的向量：没有共同关键词、意思相近（双休 ≈ 周末）的也能找到；没有向量函数时这一路只有关键词", async () => {
    const embedder = new FakeEmbedder();
    const { engine } = await storyEngine({ embedder });
    const weekend = member(engine, WEEKEND_GROUP, "scene_autonomy");
    const task = "双休怎么过比较好";
    const m = await engine.relevantUserModel(task, { routes: ["index"] });
    const hit = find(m, weekend.id)!;
    expect(hit.routes).toEqual([expect.objectContaining({ route: "index", channels: { vector: expect.objectContaining({ score: expect.any(Number) }) } })]);
    expect(hit.routes[0]!.channels!.vector!.score).toBeGreaterThanOrEqual(0.5);
    // 断言陈述的向量按文档角色算、记模型名；再调一次不重算
    expect(engine.claimIndex.getClaimVector(weekend.id, embedder.model)).toBeDefined();
    const calls = embedder.calls.filter((c) => c.role === "document").length;
    await engine.relevantUserModel(task, { routes: ["index"] });
    expect(embedder.calls.filter((c) => c.role === "document").length).toBe(calls);
    const report = await engine.indexClaims();
    expect(report.vectors).toMatchObject({ model: embedder.model, claims: 0 });
  });

  it("领域：任务归到'时间安排'，和断言的领域对上（任务的词既不在原话里、也不在断言陈述里）", async () => {
    const { engine } = await storyEngine();
    const need = member(engine, NEED, "need_autonomy");
    const task = "下个月的日程怎么排比较好";
    const others = await engine.relevantUserModel(task, { routes: ["upward", "index"] });
    expect(ids(all(others))).not.toContain(need.id);
    const m = await engine.relevantUserModel(task, { routes: ["domain"] });
    expect(m.domains).toEqual(["schedule"]);
    expect(ids(m.needs)).toEqual([need.id]);
    expect(m.needs[0]!.routes).toEqual([expect.objectContaining({ route: "domain", domains: ["schedule"] })]);
  });

  it("三条路 RRF 合并：几条路都找到的排在只有一条路找到的前面；每层默认最多 2 条，k 可以改", async () => {
    const { engine } = await storyEngine();
    const m = await engine.relevantUserModel("帮我安排下周六");
    const weekend = member(engine, WEEKEND_GROUP, "scene_autonomy");
    expect(m.preferences[0]!.claimId).toBe(weekend.id);
    expect(m.preferences[0]!.routes.map((r) => r.route)).toEqual(["upward", "index", "domain"]);
    for (const tier of [m.state, m.preferences, m.needs, m.values]) expect(tier.length).toBeLessThanOrEqual(2);
    // 明说的"周末不喜欢被排得满满"只有领域这一路找到，排第二
    expect(m.preferences[1]!.claimId).toBe(statedOf(engine, "ev-w3", "dislikes").id);
    const one = await engine.relevantUserModel("帮我安排下周六", { k: 1 });
    expect(ids(one.preferences)).toEqual([weekend.id]);
  });
});

describe("只要成立的：不成立、过期的不返回，还拿不准的单列", () => {
  it("场景对不上的不返回：问周六不出工作日的偏好；给了场景按给的", async () => {
    const { engine } = await storyEngine();
    const workday = member(engine, WORKDAY_GROUP, "scene_autonomy");
    expect(ids(all(await engine.relevantUserModel("帮我安排下周六")))).not.toContain(workday.id);
    expect(ids(all(await engine.relevantUserModel("帮我安排下周六", { context: [] })))).toContain(workday.id);
  });

  it("过期的近期状态不返回：9 月初说的'最近太累'到 10 月已经过期，问 9 月初时还在", async () => {
    const { engine } = await storyEngine();
    const tired = statedOf(engine, "ev-t1", "said_about");
    expect(tired.validTo).not.toBeNull();
    expect(ids(all(await engine.relevantUserModel("最近累不累，要不要休息")))).not.toContain(tired.id);
    const before = await engine.relevantUserModel("最近累不累，要不要休息", { at: "2026-09-05T12:00:00+08:00" });
    expect(ids(before.state)).toContain(tired.id);
  });

  it("还拿不准的（contested）单列，带竞争的那几条；不进成立的那几层", async () => {
    const { engine } = await storyEngine();
    const noInterest = member(engine, NEED, "no_interest");
    expect(noInterest.status).toBe("contested");
    const m = await engine.relevantUserModel("帮我安排下周六");
    const u = m.uncertain.find((x) => x.claimId === noInterest.id)!;
    expect(u).toMatchObject({ reason: "contested", tier: "preference" });
    expect(u.competesWith).toContain(member(engine, NEED, "need_autonomy").id);
    expect(ids([...m.preferences, ...m.needs])).not.toContain(noInterest.id);
  });

  it("依据被忘掉 → 需求、价值降成猜测、标着复核：不当已验证的用；330 号票（R5）起照样返回、在猜测那一栏、标着复核；reflect 后还是猜测：只在猜测那一栏", async () => {
    const { engine } = await storyEngine();
    const need = member(engine, NEED, "need_autonomy");
    const value = member(engine, VALUE, "value_enduring");
    engine.invalidateEvidence("ev-d3", "用户说忘掉");
    expect(engine.store.getClaim(need.id)).toMatchObject({ status: "contested", needsReview: true });
    const m = await engine.relevantUserModel("帮我安排下周六");
    expect(ids([...m.state, ...m.preferences, ...m.needs, ...m.values])).not.toContain(need.id);
    expect(ids([...m.state, ...m.preferences, ...m.needs, ...m.values])).not.toContain(value.id);
    expect(m.uncertain.find((u) => u.claimId === need.id)).toMatchObject({ status: "contested", needsReview: true });
    await engine.reflect();
    // 329 号票（R4）：工作日那条退回推理链、是猜测，猜测也能往上抽——需求还在、是猜测，不当成立的用
    expect(engine.store.getClaim(need.id)).toMatchObject({ status: "contested", needsReview: false });
    const after = await engine.relevantUserModel("帮我安排下周六");
    expect(ids([...after.state, ...after.preferences, ...after.needs, ...after.values])).not.toContain(need.id);
  });

  it("at 之后才知道的原话不当往上走的起点", async () => {
    const { engine } = await storyEngine({}, [say("ev-late", "下周六的露营我不去了", "2026-10-20T10:00:00+08:00", { context: ["weekend"] })]);
    const m = await engine.relevantUserModel("下周六的露营", { routes: ["upward"], at: "2026-10-12T12:00:00+08:00" });
    expect(m.needs.flatMap((e) => e.routes.flatMap((r) => r.hitEvidenceIds ?? []))).not.toContain("ev-late");
  });
});
