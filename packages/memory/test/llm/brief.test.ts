// 216 号票：记忆简报（给大模型回答器看的上下文）。A、B、C 只有各组自己检索出的记录；D 是 C 的记录加上和问题相关的用户画像
// （196 号票三条路找到的结论、还没分出胜负的竞争解释、明说过的要求和硬约束）。简报有长度上限，只放挑出来的那些。
// 例子是 196 号票测试的那个人（自己写的，不看 fixtures/truth），外加一条别人转述、一条被本人纠正的话。
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import {
  BRIEF_DIRECT_BONUS,
  BRIEF_LIMITS,
  BRIEF_RANK_DEPTH,
  briefSearchOptions,
  briefTime,
  dedupeClaims,
  memoryBrief,
  orderClaims,
  similarStatements,
  type BriefClaim,
  type BriefQuote,
  type MemoryBrief,
} from "../../src/llm/brief.ts";
import type { SearchMode } from "../../src/retrieval/types.ts";
import { isRelayedGuess } from "../../src/rg/relayed.ts";
import { closeEngines, openEngine, say } from "../rg/helpers.ts";
import { autonomyStory, member, NEED, NOW, statedOf, storyEngine, VALUE, WEEKEND_GROUP } from "../rg/task-helpers.ts";

afterEach(closeEngines);

const EXTRA = [
  say("ev-h1", "小王说他觉得我周末就喜欢一个人宅着", "2026-09-20T10:00:00+08:00", { sourceLevel: "untrusted", context: ["weekend"] }),
  say("ev-c1", "我周六晚上一般都在加班", "2026-09-25T10:00:00+08:00", { context: ["weekend"] }),
  say("ev-c2", "刚才说错了，周六晚上我不加班，是在家休息", "2026-09-25T10:05:00+08:00", { context: ["weekend"], kind: "correction" }),
];

/** 另一个例子（自己写的）：喜欢聚会、去过几次、又推掉过两次——占上风的那条结论自己带着反对证据 */
const ENGAGE_STORY = [
  say("ev-e1", "我周末挺喜欢去参加朋友聚会的", "2026-03-07T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-e2", "上周六去了朋友的生日会", "2026-03-15T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-e3", "周六又去参加了聚餐", "2026-03-21T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-e4", "这周六的剧本杀我不去了", "2026-03-28T10:00:00+08:00", { context: ["weekend", "social"] }),
  say("ev-e5", "周日的饭局我也推掉了", "2026-04-05T10:00:00+08:00", { context: ["weekend", "social"] }),
];

async function story() {
  const t = await storyEngine({ embedder: new FakeEmbedder() }, EXTRA);
  t.engine.correct("ev-c1", "ev-c2");
  await t.engine.reflect();
  await t.engine.indexVectors();
  return t.engine;
}

const SELF_Q = "我是不是不喜欢周末被安排得满满的？";
const TASK_Q = "帮我安排下周六，别太累";

/** 简报里出现的 id（[ev-…]、cl-… 都算） */
const idsIn = (text: string, prefix: "ev" | "cl") => [...new Set(text.match(new RegExp(`${prefix}-[A-Za-z0-9]+`, "g")) ?? [])].toSorted();

describe("记忆简报：A、B、C 只有记录，D 是 C 的记录加用户画像", () => {
  it("每组的记录来自这组自己的检索：原话、时间、谁说的、精炼陈述；别人转述的标不当依据", async () => {
    const engine = await story();
    const briefs = new Map<SearchMode, MemoryBrief>();
    for (const group of ["vector", "hybrid", "hybrid_kg", "hybrid_kg_rg"] as const) briefs.set(group, await memoryBrief(engine, SELF_Q, { at: NOW, group }));
    for (const group of ["vector", "hybrid", "hybrid_kg"] as const) {
      const b = briefs.get(group)!;
      expect(b.group).toBe(group);
      expect(b.profile).toBeNull();
      expect(b.records.length).toBeGreaterThan(0);
      expect(b.text).not.toContain("【对用户的理解】");
      // 记录按这组的检索结果排
      const hits = await engine.search(SELF_Q, briefSearchOptions(group, SELF_Q, NOW));
      expect(b.records.map((r) => r.evidenceId)).toEqual(hits.slice(0, BRIEF_LIMITS.records).map((h) => h.evidenceId));
    }
    const c = briefs.get("hybrid_kg")!;
    const d = briefs.get("hybrid_kg_rg")!;
    // D 的记录就是 C 的记录，另加用户画像
    expect(d.records).toEqual(c.records);
    expect(d.profile).not.toBeNull();
    expect(d.text.startsWith(c.text)).toBe(true);
    expect(d.text).toContain("【对用户的理解】");
    // 引擎上也有同一个操作
    expect(await engine.memoryBrief(SELF_Q, { at: NOW, group: "hybrid_kg" })).toEqual(c);

    const w3 = c.records.find((r) => r.evidenceId === "ev-w3")!;
    expect(w3).toMatchObject({ usable: true, time: "2026-04-04 10:00", label: "本人说的" });
    expect(w3.statements.length).toBeGreaterThan(0);
    expect(c.text).toContain("[ev-w3] 2026-04-04 10:00 · 本人说的");
    expect(c.text).toContain("原话：「我不喜欢周末被排得满满的」");
    expect(c.text).toContain(`精炼：${w3.statements[0]}`);
    const all = [...briefs.values()].flatMap((b) => b.records);
    const hearsay = all.find((r) => r.evidenceId === "ev-h1");
    expect(hearsay).toBeDefined();
    expect(hearsay).toMatchObject({ usable: false, label: "别人转述（不当依据）" });
  });

  it("被本人纠正过的记录标出来，写明以哪条为准", async () => {
    const engine = await story();
    const b = await memoryBrief(engine, "我周六晚上一般在干什么？", { at: NOW, group: "hybrid" });
    const old = b.records.find((r) => r.evidenceId === "ev-c1");
    expect(old).toMatchObject({ usable: false, status: "corrected", correctedBy: "ev-c2" });
    expect(b.text).toContain("已被本人纠正，以 ev-c2 为准");
  });

  it("D：结论写清楚层级、状态、把握、支持和反对的证据；有往上抽出来的需求、价值观；组里占上风的写明，排除的跟在后面；禁忌总在", async () => {
    const engine = await story();
    const d = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg" });
    const p = d.profile!;
    const need = member(engine, NEED, "need_autonomy");
    const value = member(engine, VALUE, "value_enduring");
    const stated = statedOf(engine, "ev-w3", "dislikes");
    const ids = p.claims.map((c) => c.claimId);
    expect(ids).toContain(stated.id);
    expect(ids).toContain(need.id);
    expect(ids).toContain(value.id);
    const n = p.claims.find((c) => c.claimId === need.id)!;
    expect(n).toMatchObject({ tier: "need", status: "active", confidence: need.confidence, epistemic: "inferred" });
    expect(n.supportIds.length).toBeGreaterThan(0);
    const conf = { low: "低", medium: "中", high: "高" }[need.confidence];
    // 330 号票（R5）：真值状态说"已验证 / 猜测"
    expect(d.text).toContain(`[${need.id}] 需求 · 推断的 · 已验证 · 把握${conf}：${need.statement}。支持 ${n.supportIds.length} 条、反对 ${n.refuteIds.length} 条`);
    expect(d.text).toContain(`[${stated.id}] 偏好 · 用户说的 · 已验证`);
    // 往上抽那组：重视自主安排占上风，"近期整体负荷高"被 ev-c2（周六晚上不加班、在家休息）推翻
    const load = member(engine, NEED, "overall_load");
    expect(load.status).toBe("retracted");
    const needLine = d.text.split("\n").find((l) => l.startsWith(`- [${need.id}]`))!;
    expect(needLine).toMatch(/同组 \d 种解释里占上风；已排除：\[cl-[0-9]+\]/);
    expect(needLine).toContain(`已排除：[${load.id}]`);
    // 222：同一组只留一条——同组里还拿不准的那条不再重复列（那组占上风的是上面这条需求）
    const unsure = member(engine, NEED, "no_interest");
    expect(ids).not.toContain(unsure.id);
    // 硬约束（忌口）总在
    expect(p.hardConstraints.map((h) => h.claimId)).toEqual([statedOf(engine, "ev-a1", "dislikes").id]);
    expect(d.text).toContain("【明说过的要求和禁忌】");
    // 不是任务就没有"这次明说的要求"
    expect(p.requirements).toEqual([]);
  });

  it("330 号票（R5）：猜测照样进简报、标'猜测'和把握，标着复核的再标'复核中'；抬头写清猜测可以照着说、拿来推荐，把握低的留余地", async () => {
    const engine = await story();
    // 工作日那句话被忘掉：需求退回推理链、成了猜测（标着复核，等下一次整理）
    engine.invalidateEvidence("ev-d3", "用户说忘掉");
    const need = engine.store.getClaim(member(engine, NEED, "need_autonomy").id)!;
    expect(need).toMatchObject({ status: "contested", needsReview: true });
    const d = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg" });
    // 这组现在分不出胜负，在"还没分出胜负的解释"里列（同组只列一处），每条照样写真值状态
    const members = d.profile!.groups.flatMap((g) => g.members);
    expect(members.find((m) => m.claimId === need.id)).toMatchObject({ status: "contested", needsReview: true });
    expect(d.text).toContain(`[${need.id}] 需求 · 推断的 · 猜测 · 复核中 · 把握`);
    expect(d.text).toContain("\"猜测\"是还没证实的——可以照着说、拿来推荐，说清是猜测，把握低的留余地");
  });

  it("D：还没分出胜负的竞争解释单列：几种解释各自的状态、支持、反对，加一个能区分的问题", async () => {
    // 只有三次周末推掉活动、没有明说的话：几种解释都还拿不准
    const t = openEngine(NOW, { embedder: new FakeEmbedder() });
    for (const e of [...autonomyStory(), ...EXTRA].filter((x) => ["ev-w1", "ev-w2", "ev-w4", "ev-a1", "ev-t1"].includes(x.id!))) t.engine.ingestEvidence(e);
    await t.engine.reflect();
    await t.engine.indexVectors();
    const d = await memoryBrief(t.engine, TASK_Q, { at: NOW, group: "hybrid_kg_rg" });
    const open = d.profile!.groups.find((g) => g.key === WEEKEND_GROUP);
    expect(open).toBeDefined();
    expect(open!.members.length).toBeGreaterThanOrEqual(2);
    expect(open!.members.every((m) => !(m.status === "active" && m.confidence !== "low"))).toBe(true);
    expect(open!.probe).toEqual(expect.any(String));
    expect(d.text).toContain("【还没分出胜负的解释】");
    expect(d.text).toContain("几种说得通的解释还没分出来");
    expect(d.text).toContain(`· 可能是：[${open!.members[0]!.claimId}]`);
    expect(d.text).toContain(`能区分的问题：${open!.probe}`);
    // 在组里单列的就不再在"对用户的理解"里重复
    const inGroup = new Set(open!.members.map((m) => m.claimId));
    expect(d.profile!.claims.some((c) => inGroup.has(c.claimId))).toBe(false);
  });

  it("D：反对的证据说出内容（原话），不只给编号", async () => {
    // 喜欢聚会、也去过几次、又推掉过一次：组里占上风的那条自己也带着一条反对证据（推掉的那次）
    const t = openEngine(NOW, { embedder: new FakeEmbedder() });
    for (const e of ENGAGE_STORY) t.engine.ingestEvidence(e);
    await t.engine.reflect();
    await t.engine.indexVectors();
    const d = await memoryBrief(t.engine, "我周末喜欢参加聚会吗？", { at: NOW, group: "hybrid_kg_rg", limits: { records: 0 } });
    const withCounter = d.profile!.claims.find((c) => c.refuteIds.length > 0);
    expect(withCounter).toBeDefined();
    const ref = withCounter!.quotes!.find((q) => q.polarity === "refutes")!;
    // 结论下面的反对证据（219）：原话写在那一行
    expect(d.text).toContain(`· 反对 [${ref.evidenceId}]`);
    expect(d.text).toContain(`[${ref.evidenceId}] ${ref.time} · ${ref.label}：「${ref.text}」`);
  });

  it("D、任务题：这次明说的要求排在最前面，交互策略也带上", async () => {
    const engine = await story();
    const d = await memoryBrief(engine, TASK_Q, { at: NOW, group: "hybrid_kg_rg" });
    expect(d.profile!.requirements).toEqual(["帮我安排下周六", "别太累"]);
    expect(d.text).toContain("这次明说的要求：「帮我安排下周六」「别太累」——以这些为准");
    expect(d.profile!.strategies.length).toBeGreaterThan(0);
    expect(d.profile!.claims.map((c) => c.claimId)).toContain(member(engine, WEEKEND_GROUP, "scene_autonomy").id);
  });
});

describe("记忆简报：长度上限", () => {
  it("默认上限：记录 10 条以内、记录那节 2000 字以内、用户画像 2400 字以内", async () => {
    const engine = await story();
    for (const q of [SELF_Q, TASK_Q, "为什么我老推掉周末的饭局？"]) {
      const d = await memoryBrief(engine, q, { at: NOW, group: "hybrid_kg_rg" });
      expect(d.records.length).toBeLessThanOrEqual(BRIEF_LIMITS.records);
      expect(d.sections.records.length).toBeLessThanOrEqual(BRIEF_LIMITS.recordChars);
      expect(d.sections.profile.length).toBeLessThanOrEqual(BRIEF_LIMITS.profileChars);
      expect(d.profile!.claims.length).toBeLessThanOrEqual(BRIEF_LIMITS.claims);
      expect(d.text.length).toBeLessThanOrEqual(BRIEF_LIMITS.recordChars + BRIEF_LIMITS.profileChars + 2);
    }
  });

  it("上限调小时整条整条地少放，记下没放进来的条数；简报里能引用的 id 就是正文里出现的那些", async () => {
    const engine = await story();
    const full = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg" });
    const small = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg", limits: { records: 3, recordChars: 260, profileChars: 420, claims: 2, groups: 1 } });
    expect(small.records.length).toBeLessThanOrEqual(3);
    expect(small.sections.records.length).toBeLessThanOrEqual(260);
    expect(small.sections.profile.length).toBeLessThanOrEqual(420);
    expect(small.omitted.records + small.omitted.claims + small.omitted.groups).toBeGreaterThan(0);
    expect(small.text.length).toBeLessThan(full.text.length);
    for (const b of [full, small]) {
      expect(b.evidenceIds.toSorted()).toEqual(idsIn(b.text, "ev"));
      expect(b.claimIds.toSorted()).toEqual(idsIn(b.text, "cl"));
    }
  });
});

/** "对用户的理解"那一节 */
function claimSection(b: MemoryBrief): string {
  const s = b.sections.profile;
  const end = s.indexOf("\n【");
  return end < 0 ? s : s.slice(0, end);
}
const count = (text: string, part: string) => text.split(part).length - 1;
const idsOf = (quotes: readonly BriefQuote[] | undefined, polarity?: BriefQuote["polarity"]) => (quotes ?? []).filter((q) => polarity === undefined || q.polarity === polarity).map((q) => q.evidenceId);

describe("记忆简报 D：结论下面带上相关证据的原话（219 号票）", () => {
  const D = "hybrid_kg_rg" as const;

  it("每条结论下面带上支持的（最多 3 条）、反对的（最多 2 条）证据：时间、谁说的、原话", async () => {
    const engine = await story();
    const d = await memoryBrief(engine, SELF_Q, { at: NOW, group: D, limits: { records: 0 } });
    const claims = d.profile!.claims;
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      expect(idsOf(c.quotes, "supports").length).toBe(Math.min(BRIEF_LIMITS.supportQuotes, c.supportIds.length));
      expect(idsOf(c.quotes, "refutes").length).toBe(Math.min(BRIEF_LIMITS.refuteQuotes, c.refuteIds.length));
      for (const id of idsOf(c.quotes, "supports")) expect(c.supportIds).toContain(id);
      for (const id of idsOf(c.quotes, "refutes")) expect(c.refuteIds).toContain(id);
    }
    expect(BRIEF_LIMITS).toMatchObject({ supportQuotes: 3, refuteQuotes: 2 });
    // 需求"重视自主安排"：支持的不止 3 条，只带 3 条，挂在结论那一行下面
    const need = member(engine, NEED, "need_autonomy");
    const n = claims.find((c) => c.claimId === need.id)!;
    expect(n.supportIds.length).toBeGreaterThan(3);
    const first = n.quotes![0]!;
    const e = engine.getEvidence(first.evidenceId)!;
    expect(first).toEqual({ evidenceId: e.id, polarity: "supports", time: briefTime(e.eventTime ?? e.observedAt), label: "本人说的", text: e.text });
    const lines = d.text.split("\n");
    const at = lines.findIndex((l) => l.startsWith(`- [${need.id}]`));
    expect(lines[at + 1]!.startsWith(`  · 支持 [${e.id}]`)).toBe(true);
    // 原话写在第一次带它的那条结论下面（后面的只写编号，见下面"不重复"）
    expect(claimSection(d)).toContain(`· 支持 [${e.id}] ${first.time} · 本人说的：「${e.text}」`);
    // 回答器认得这些编号
    for (const c of claims) for (const id of idsOf(c.quotes)) expect(d.evidenceIds).toContain(id);
  });

  it("挑和问题最相关的：按检索的相关程度排，问工作日先带工作日的话、问周末先带周末的话", async () => {
    const engine = await story();
    const need = member(engine, NEED, "need_autonomy");
    const WORKDAY_Q = "我工作日是不是也不喜欢被提前排满？";
    const supportsFor = async (q: string) => {
      const d = await memoryBrief(engine, q, { at: NOW, group: D, limits: { records: 0 } });
      const c = d.profile!.claims.find((x) => x.claimId === need.id);
      expect(c).toBeDefined();
      return { claim: c!, ids: idsOf(c!.quotes, "supports") };
    };
    const workday = await supportsFor(WORKDAY_Q);
    const weekend = await supportsFor(SELF_Q);
    expect(workday.ids[0]).toMatch(/^ev-d/);
    expect(weekend.ids[0]).toMatch(/^ev-w/);
    // 一般地：按 C 组检索（记录那节的设置，往深里搜）的名次排，搜不到的排在后面、按原来的顺序
    const ranked = (await engine.search(WORKDAY_Q, { ...briefSearchOptions("hybrid_kg", WORKDAY_Q, NOW), limit: BRIEF_RANK_DEPTH })).map((h) => h.evidenceId);
    const rank = (id: string) => (ranked.includes(id) ? ranked.indexOf(id) : Infinity);
    const expected = workday.claim.supportIds
      .map((id, i) => ({ id, i }))
      .toSorted((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
      .slice(0, 3)
      .map((x) => x.id);
    expect(workday.ids).toEqual(expected);
  });

  it("不重复：记录那节已经有的只写编号，上面的结论带过的也只写编号；一条原话在简报里只写一次", async () => {
    const engine = await story();
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const records of [0, 3, 10]) {
      const d = await memoryBrief(engine, SELF_Q, { at: NOW, group: D, limits: { records } });
      const inRecords = new Set(d.records.map((r) => r.evidenceId));
      const section = claimSection(d);
      const quoted = new Set<string>();
      for (const c of d.profile!.claims) {
        for (const q of c.quotes!) {
          // 记录那节有了 → 只写编号；上面的结论带过 → 只写编号；第一次 → 写原话
          const kind = inRecords.has(q.evidenceId) ? "records" : quoted.has(q.evidenceId) ? "above" : "first";
          seen.add(kind);
          const want = { records: `[${q.evidenceId}]（原话见记录）`, above: `[${q.evidenceId}]（原话见上）`, first: `[${q.evidenceId}] ${q.time} · ${q.label}：「` }[kind];
          if (!section.includes(want)) problems.push(`记录 ${records} 条：没有 ${want}`);
          if (kind === "records" && section.includes(`[${q.evidenceId}] ${q.time}`)) problems.push(`记录 ${records} 条：${q.evidenceId} 在记录那节有了，结论下面又写了原话`);
          quoted.add(q.evidenceId);
        }
      }
      for (const id of [...quoted, ...inRecords]) expect(count(`${d.sections.records}\n${section}`, `「${engine.getEvidence(id)!.text}」`)).toBe(1);
    }
    expect(problems).toEqual([]);
    expect([...seen].toSorted()).toEqual(["above", "first", "records"]);
  });

  it("长度上限：放不下时先砍还没分出胜负的解释，再砍结论的条数，原话最后砍", async () => {
    // 工作日只推掉过两次、没说为什么：周末那边有结论，工作日那组还没分出胜负
    const t = openEngine(NOW, { embedder: new FakeEmbedder() });
    for (const e of [...autonomyStory(), ...EXTRA].filter((x) => ["ev-w1", "ev-w2", "ev-w3", "ev-w4", "ev-d1", "ev-d2", "ev-a1", "ev-t1", "ev-c1", "ev-c2"].includes(x.id!))) t.engine.ingestEvidence(e);
    t.engine.correct("ev-c1", "ev-c2");
    await t.engine.reflect();
    await t.engine.indexVectors();
    const ask = (limits: Partial<typeof BRIEF_LIMITS>) => memoryBrief(t.engine, "为什么我老推掉周末的饭局？", { at: NOW, group: D, limits: { records: 0, ...limits } });
    const full = await ask({ profileChars: 100_000 });
    const p = full.profile!;
    expect(p.claims.length).toBeGreaterThanOrEqual(2);
    expect(p.groups.length).toBeGreaterThan(0);
    expect(p.claims.some((c) => (c.quotes ?? []).length >= 2)).toBe(true);
    const text = full.sections.profile;
    const groupsStart = text.indexOf("\n【还没分出胜负的解释】");
    const groupsEnd = text.indexOf("\n【明说过的要求和禁忌】");
    expect(groupsStart).toBeGreaterThan(0);
    const withoutGroups = text.length - ((groupsEnd < 0 ? text.length : groupsEnd) - groupsStart);

    // 先砍竞争解释：刚好放下全部结论（连原话）时，组一个都不放，结论一条不少
    const noGroups = await ask({ profileChars: withoutGroups });
    expect(noGroups.sections.profile.length).toBeLessThanOrEqual(withoutGroups);
    expect(noGroups.profile!.groups).toEqual([]);
    expect(noGroups.omitted.groups).toBe(p.groups.length);
    expect(noGroups.profile!.claims).toEqual(p.claims);

    // 再砍结论的条数：少放一条结论，放进来的结论原话一条不少（去重去掉的那些两次都记在 omitted.claims 里）
    const fewer = await ask({ profileChars: withoutGroups - 1 });
    expect(fewer.profile!.claims.length).toBeLessThan(p.claims.length);
    expect(fewer.omitted.claims - full.omitted.claims).toBe(p.claims.length - fewer.profile!.claims.length);
    for (const c of fewer.profile!.claims) expect(idsOf(c.quotes)).toEqual(idsOf(p.claims.find((x) => x.claimId === c.claimId)!.quotes));

    // 原话最后砍：一条结论连原话都放不下时，才减这条的原话（先减不太相关的一条），不是整条不要
    const one = await ask({ claims: 1, groups: 0, profileChars: 100_000 });
    const tight = one.sections.profile.length - 1;
    const trimmed = await ask({ claims: 1, profileChars: tight });
    expect(trimmed.sections.profile.length).toBeLessThanOrEqual(tight);
    expect(trimmed.omitted.claims - full.omitted.claims).toBe(p.claims.length - 1);
    expect(trimmed.profile!.claims.map((c) => c.claimId)).toEqual([p.claims[0]!.claimId]);
    const kept = trimmed.profile!.claims[0]!;
    expect(idsOf(kept.quotes).length).toBe(idsOf(p.claims[0]!.quotes).length - 1);
    for (const polarity of ["supports", "refutes"] as const) {
      const before = idsOf(p.claims[0]!.quotes, polarity);
      expect(idsOf(kept.quotes, polarity)).toEqual(before.slice(0, idsOf(kept.quotes, polarity).length));
    }
  });

  it("A、B、C 的简报不变：没有用户画像，也不带结论的原话", async () => {
    const engine = await story();
    for (const group of ["vector", "hybrid", "hybrid_kg"] as const) {
      const b = await memoryBrief(engine, SELF_Q, { at: NOW, group });
      expect(b.profile).toBeNull();
      expect(b.text).not.toContain("· 支持 [");
      expect(b.text).toBe(b.sections.records);
    }
  });
});

/** 一条合成的结论：222 号票排序、去重的单元测试用（不建库、不调模型） */
const fakeClaim = (over: Partial<BriefClaim> & { claimId: string }): BriefClaim => ({
  statement: "用户重视自主安排",
  tier: "need",
  status: "active",
  confidence: "medium",
  epistemic: "inferred",
  supportIds: [],
  refuteIds: [],
  reason: "related",
  groupKey: null,
  ...over,
});
const ordered = (claims: readonly BriefClaim[], rank: ReadonlyMap<string, number>, score: ReadonlyMap<string, number> = new Map()) =>
  orderClaims(claims, rank, score).map((c) => c.claimId);
const idsOfDedupe = (claims: readonly BriefClaim[], winners?: ReadonlySet<string>) =>
  dedupeClaims(claims, winners).claims.map((c) => c.claimId);

describe("记忆简报 D：结论按和问题的相关程度挑、去掉重复（222 号票）", () => {
  it("先看支持证据在 C 组检索里的最好名次（没有的算最差），再看分数、层级、把握", () => {
    // 一条支持证据在检索前 10 里，一条在 200 名外（不在名次表里）
    expect(ordered([fakeClaim({ claimId: "cl-late", supportIds: ["ev-far"] }), fakeClaim({ claimId: "cl-early", supportIds: ["ev-near"] })], new Map([["ev-near", 4]]))).toEqual(["cl-early", "cl-late"]);
    // 支持证据有好几条时看最好的名次
    expect(ordered([fakeClaim({ claimId: "cl-far", supportIds: ["ev-a", "ev-b"] }), fakeClaim({ claimId: "cl-best", supportIds: ["ev-c", "ev-d"] })], new Map([["ev-a", 30], ["ev-b", 190], ["ev-c", 12], ["ev-d", 40]]))).toEqual(["cl-best", "cl-far"]);
    // 名次相同：三条路合并的分高的在前（同层、同把握）
    expect(ordered([fakeClaim({ claimId: "cl-low", supportIds: ["ev-1"] }), fakeClaim({ claimId: "cl-high", supportIds: ["ev-2"] })], new Map([["ev-1", 3], ["ev-2", 3]]), new Map([["cl-low", 0.1], ["cl-high", 0.2]]))).toEqual(["cl-high", "cl-low"]);
    // 分也相同：需求、价值观在偏好、状态前；同一层把握高的在前
    const sameRank = new Map([["ev-1", 1], ["ev-2", 1], ["ev-3", 1], ["ev-4", 1]]);
    expect(
      ordered(
        [
          fakeClaim({ claimId: "cl-state", tier: "state", supportIds: ["ev-1"] }),
          fakeClaim({ claimId: "cl-pref", tier: "preference", supportIds: ["ev-2"] }),
          fakeClaim({ claimId: "cl-value", tier: "value", supportIds: ["ev-3"] }),
          fakeClaim({ claimId: "cl-need", tier: "need", supportIds: ["ev-4"] }),
        ],
        sameRank,
      ),
    ).toEqual(["cl-need", "cl-value", "cl-pref", "cl-state"]);
    expect(ordered([fakeClaim({ claimId: "cl-lowconf", confidence: "low", supportIds: ["ev-1"] }), fakeClaim({ claimId: "cl-highconf", confidence: "high", supportIds: ["ev-2"] })], new Map([["ev-1", 1], ["ev-2", 1]]))).toEqual(["cl-highconf", "cl-lowconf"]);
  });

  it("direct 有加成，但压不过证据名次的差别，也不会让一长串 direct 占满名额", () => {
    expect(BRIEF_DIRECT_BONUS).toBeGreaterThan(0);
    expect(BRIEF_DIRECT_BONUS).toBeLessThan(BRIEF_RANK_DEPTH);
    // 名次只差一点：direct 的排前面（加成生效）
    const directMid = fakeClaim({ claimId: "cl-direct-mid", reason: "direct", supportIds: ["ev-mid"] });
    const plainBest = fakeClaim({ claimId: "cl-plain-best", supportIds: ["ev-best"] });
    expect(ordered([plainBest, directMid], new Map([["ev-mid", 30], ["ev-best", 10]]))).toEqual(["cl-direct-mid", "cl-plain-best"]);
    // 名次差得多：direct 的照样排在后面
    expect(ordered([fakeClaim({ claimId: "cl-direct-far", reason: "direct", supportIds: ["ev-far"] }), plainBest], new Map([["ev-best", 1]]))).toEqual(["cl-plain-best", "cl-direct-far"]);
    // 一长串 direct 的证据都在 190 名以后、非 direct 的证据排第 1：非 direct 的还是在最前面
    const directs = [
      fakeClaim({ claimId: "cl-d1", reason: "direct", supportIds: ["ev-x"] }),
      fakeClaim({ claimId: "cl-d2", reason: "direct", supportIds: ["ev-y"] }),
      fakeClaim({ claimId: "cl-d3", reason: "direct", supportIds: ["ev-z"] }),
    ];
    expect(ordered([...directs, fakeClaim({ claimId: "cl-plain", supportIds: ["ev-best"] })], new Map([["ev-x", 190], ["ev-y", 195], ["ev-z", 199], ["ev-best", 0]]))).toEqual(["cl-plain", "cl-d1", "cl-d2", "cl-d3"]);
  });

  it("去重：同一组、近乎同文的只留一条；把握高、支持证据多（组里占上风）的留下", () => {
    // 同一组：把握高的留下（哪怕它支持证据少）
    const better = fakeClaim({ claimId: "cl-better", groupKey: "g", confidence: "high", supportIds: ["ev-1"] });
    const worse = fakeClaim({ claimId: "cl-worse", groupKey: "g", confidence: "medium", supportIds: ["ev-1", "ev-2", "ev-3"] });
    expect(dedupeClaims([worse, better])).toMatchObject({ claims: [better], dropped: 1 });
    // 把握一样：支持证据多的留下
    const many = fakeClaim({ claimId: "cl-many", groupKey: "g2", supportIds: ["ev-1", "ev-2"] });
    const few = fakeClaim({ claimId: "cl-few", groupKey: "g2", supportIds: ["ev-1"] });
    expect(idsOfDedupe([few, many])).toEqual(["cl-many"]);
    // 把握、支持条数都一样：组里占上风的那条留下（还没分出胜负的组没有占上风的）
    const winner = fakeClaim({ claimId: "cl-winner", groupKey: "g3", supportIds: ["ev-1"] });
    const contender = fakeClaim({ claimId: "cl-contender", groupKey: "g3", supportIds: ["ev-2"] });
    expect(idsOfDedupe([contender, winner], new Set(["cl-winner"]))).toEqual(["cl-winner"]);
    // 近乎同文：去掉标点后一条包含另一条、或者字符重合度高
    expect(similarStatements("用户周末不喜欢被排得满满的。", "用户周末不喜欢被排得满满当当")).toBe(true);
    expect(similarStatements("用户不喜欢社交活动", "用户不喜欢社交活动（周末）")).toBe(true);
    expect(similarStatements("用户重视自主安排", "用户不喜欢社交活动")).toBe(false);
    expect(idsOfDedupe([fakeClaim({ claimId: "cl-a", statement: "用户周末不喜欢被排得满满的", supportIds: ["ev-1"] }), fakeClaim({ claimId: "cl-b", statement: "用户周末不喜欢被排得满满当当", confidence: "high", supportIds: ["ev-2"] })])).toEqual(["cl-b"]);
    // 不同组、陈述不一样的都留着
    expect(dedupeClaims([fakeClaim({ claimId: "cl-x", groupKey: "g4" }), fakeClaim({ claimId: "cl-y", statement: "用户近期很忙", groupKey: "g5" })])).toMatchObject({ dropped: 0 });
  });
});

describe("记忆简报 D：极性相反的陈述永远不合并（228 号票）", () => {
  it("只差否定词的两条算极性相反：不、没、没有、别、未、无、非", () => {
    // 票上的两个例子
    expect(similarStatements("用户喜欢加班", "用户不喜欢加班")).toBe(false);
    expect(similarStatements("用户不在意署名", "用户在意署名")).toBe(false);
    // 字面上重合度到 0.8 的也拦住（228 之前这种会被当成近乎同文并掉）
    expect(similarStatements("用户喜欢周末去参加朋友的聚会", "用户不喜欢周末去参加朋友的聚会")).toBe(false);
    expect(similarStatements("用户不在意作品署名的方式", "用户在意作品署名的方式")).toBe(false);
    // 否定词表里的其余几个
    const opposites: [string, string][] = [
      ["用户去参加聚会", "用户没去参加聚会"],
      ["用户有朋友", "用户没有朋友"],
      ["用户去开会", "用户别去开会"],
      ["用户交稿了", "用户未交稿了"],
      ["用户有安排", "用户无安排"],
      ["用户是本地人", "用户非本地人"],
    ];
    for (const [positive, negative] of opposites) {
      expect(similarStatements(positive, negative)).toBe(false);
      expect(idsOfDedupe([fakeClaim({ claimId: "cl-positive", statement: positive }), fakeClaim({ claimId: "cl-negative", statement: negative })])).toEqual(["cl-positive", "cl-negative"]);
    }
    // 反过来也一样
    expect(similarStatements("用户不喜欢加班", "用户喜欢加班")).toBe(false);
  });

  it("同一组里两条相反的也不合并：那正是竞争解释，并掉就少一种", () => {
    const yes = fakeClaim({ claimId: "cl-yes", statement: "用户喜欢加班", groupKey: "g" });
    const no = fakeClaim({ claimId: "cl-no", statement: "用户不喜欢加班", groupKey: "g", confidence: "high", supportIds: ["ev-1", "ev-2"] });
    // 把握高、支持证据多也不并掉（222 的组内斗法不适用于相反的两条）
    expect(dedupeClaims([yes, no])).toMatchObject({ claims: [yes, no], dropped: 0 });
    expect(idsOfDedupe([yes, no], new Set(["cl-no"]))).toEqual(["cl-yes", "cl-no"]);
    // 组里还有别的同组结论时照旧并别的，只把相反的那条留下
    const other = fakeClaim({ claimId: "cl-other", statement: "用户近期很忙", groupKey: "g", confidence: "low" });
    expect(idsOfDedupe([yes, no, other], new Set(["cl-no"]))).toEqual(["cl-yes", "cl-no"]);
  });

  it("其余去重照旧：同组、近乎同文的照旧只留一条；两条都带否定词的不算相反", () => {
    // 同一组、陈述不一样也不是相反的：照旧只留一条
    expect(idsOfDedupe([fakeClaim({ claimId: "cl-group-a", statement: "用户重视自主安排", groupKey: "g" }), fakeClaim({ claimId: "cl-group-b", statement: "用户近期很忙", groupKey: "g", confidence: "high" })])).toEqual(["cl-group-b"]);
    // 近乎同文：去掉标点后互相包含，照旧只留一条
    expect(idsOfDedupe([fakeClaim({ claimId: "cl-near-a", statement: "用户不喜欢社交活动", supportIds: ["ev-1"] }), fakeClaim({ claimId: "cl-near-b", statement: "用户不喜欢社交活动（周末）", confidence: "high" })])).toEqual(["cl-near-b"]);
    expect(similarStatements("用户周末不喜欢被排得满满的。", "用户周末不喜欢被排得满满当当")).toBe(true);
    // 两条都带否定词、说的是同一件事：还是一条
    expect(idsOfDedupe([fakeClaim({ claimId: "cl-neg-a", statement: "用户不喜欢社交活动", groupKey: "g2" }), fakeClaim({ claimId: "cl-neg-b", statement: "用户最近不太想见人", groupKey: "g2" })])).toEqual(["cl-neg-a"]);
  });

  it("上限 10 条 / 4800 字、omitted.claims、编号契约不变", async () => {
    expect(BRIEF_LIMITS).toMatchObject({ claims: 10, profileChars: 4800 });
    const engine = await story();
    const d = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg" });
    expect(d.profile!.claims.length).toBeLessThanOrEqual(BRIEF_LIMITS.claims);
    expect(d.sections.profile.length).toBeLessThanOrEqual(BRIEF_LIMITS.profileChars);
    expect(d.omitted.claims).toBeGreaterThanOrEqual(0);
    // 简报里出现的编号就是 claimIds、evidenceIds 里的
    expect(d.claimIds.toSorted()).toEqual(idsIn(d.text, "cl"));
    expect(d.evidenceIds.toSorted()).toEqual(idsIn(d.text, "ev"));
  });
});

describe("记忆简报 D：同样字数里按相关程度挑（222 号票）", () => {
  const spacious = { records: 0, profileChars: 100_000 } as const;

  it("同一组、近乎同文的只出现一条：组里占上风的那条留下，去掉的照旧记进 omitted.claims", async () => {
    const engine = await story();
    const d = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg", limits: spacious });
    const keys = d.profile!.claims.map((c) => c.groupKey).filter((k): k is string => k !== null);
    expect(new Set(keys).size).toBe(keys.length);
    // 组里占上风、把握高的三条都留下了（这三组各有好几条结论进了候选）
    expect(d.profile!.claims.map((c) => c.claimId)).toEqual(expect.arrayContaining([statedOf(engine, "ev-w3", "dislikes").id, member(engine, NEED, "need_autonomy").id, member(engine, VALUE, "value_enduring").id, member(engine, WEEKEND_GROUP, "scene_autonomy").id]));
    // 候选一共 9 条：同一组去掉了 4 条，写进去 5 条——330 号票（R3）起 ev-h1 那句转述起了一条猜测（不在组里，标"猜测"照样给）
    expect(d.profile!.claims.length).toBe(5);
    expect(d.omitted.claims).toBe(4);
    const relayed = d.profile!.claims.filter((c) => isRelayedGuess(engine.store, c.claimId));
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ status: "contested", supportIds: [] });
  });

  it("结论按支持证据在 C 组检索里的名次排：名次越靠前越前", async () => {
    const engine = await story();
    const d = await memoryBrief(engine, TASK_Q, { at: NOW, group: "hybrid_kg_rg", limits: spacious });
    const ranked = (await engine.search(TASK_Q, { ...briefSearchOptions("hybrid_kg", TASK_Q, NOW), limit: BRIEF_RANK_DEPTH })).map((h) => h.evidenceId);
    const rank = new Map(ranked.map((id, i) => [id, i]));
    // 330 号票（R3）：转述起的猜测没有支持证据（转述只当背景），名次算最差、排在最后
    const supported = d.profile!.claims.filter((c) => !isRelayedGuess(engine.store, c.claimId));
    expect(d.profile!.claims.slice(supported.length).every((c) => isRelayedGuess(engine.store, c.claimId))).toBe(true);
    const best = supported.map((c) => Math.min(...c.supportIds.map((id) => rank.get(id) ?? Number.POSITIVE_INFINITY)));
    expect(best.every((r) => Number.isFinite(r))).toBe(true);
    expect(best).toEqual(best.toSorted((a, b) => a - b));
    // 任务题明调出来的那条证据排在 5 名上，比直接说到这件事的那几条都靠后：有支持证据的里排最后
    expect(supported.at(-1)!.claimId).toBe(statedOf(engine, "ev-w3", "dislikes").id);
  });

  it("上限照旧 10 条、4800 字；去重省下的名额放别的结论，omitted 数对得上", async () => {
    const engine = await story();
    const full = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg", limits: spacious });
    const total = full.profile!.claims.length + full.omitted.claims;
    // 330 号票（R3）：多了 ev-h1 那句转述起的一条猜测
    expect(total).toBe(9);
    const small = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg", limits: { ...spacious, claims: 2 } });
    expect(small.profile!.claims.length).toBe(2);
    expect(small.omitted.claims).toBe(total - 2);
    expect(BRIEF_LIMITS).toMatchObject({ claims: 10, profileChars: 4800 });
    const capped = await memoryBrief(engine, SELF_Q, { at: NOW, group: "hybrid_kg_rg" });
    expect(capped.profile!.claims.length).toBeLessThanOrEqual(BRIEF_LIMITS.claims);
    expect(capped.sections.profile.length).toBeLessThanOrEqual(BRIEF_LIMITS.profileChars);
    // 简报里出现的编号就是 claimIds、evidenceIds 里的（去掉的那些结论不出现）
    expect(capped.claimIds.toSorted()).toEqual(idsIn(capped.text, "cl"));
    expect(capped.evidenceIds.toSorted()).toEqual(idsIn(capped.text, "ev"));
  });
});

// "记忆简报的检索设置和评测一样"（briefSearchOptions 对评测的 searchOptionsFor）：326 号票起在评测包的 test/eval/brief-search-options.test.ts
