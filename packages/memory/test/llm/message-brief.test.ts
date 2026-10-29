// 266 号票：每条消息的记忆简报（messageBrief）。用户发来一句话，只用本机检索和相关门槛（202、206 号票）判有没有相关的记忆，
// 有才带一份：D 组"对用户的理解"那几节（结论连支撑它的原话，219 号票的格式；还没分出胜负的解释；明说过的禁忌），上限照 BRIEF_LIMITS；
// 没过相关门槛的（三条路每层最相关的那几条）不带，记录那节（检索到的原话，总有 10 条）不带。同一段对话里带过、没变的不再带，只补新的。
// 例子是 196 号票测试的那个人（自己写的，不看 fixtures/truth）。
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import { BRIEF_LIMITS, messageBrief, type MessageBrief } from "../../src/llm/brief.ts";
import { closeEngines } from "../rg/helpers.ts";
import { NOW, statedOf, storyEngine } from "../rg/task-helpers.ts";

afterEach(closeEngines);

async function story() {
  const t = await storyEngine({ embedder: new FakeEmbedder() });
  await t.engine.indexVectors();
  return t.engine;
}

const WEEKEND = "这周六同事又约我去团建，周末被排得满满的好烦";
const WEATHER = "明天上海会下雨吗";

/** 简报里出现的 id */
const idsIn = (text: string, prefix: "ev" | "cl") => [...new Set(text.match(new RegExp(`${prefix}-[A-Za-z0-9]+`, "g")) ?? [])].toSorted();
const known = (b: MessageBrief) => new Map(Object.entries(b.brought));

describe("每条消息的记忆简报：有相关的才带", () => {
  it("相关时带：只有过了相关门槛的结论，下面带着支撑它的原话；不带记录那节；明说的禁忌也在", async () => {
    const engine = await story();
    const b = await messageBrief(engine, WEEKEND, { at: NOW });
    expect(b.relevant).toBe(true);
    expect(b.text).not.toBe("");
    expect(b.text).toContain("【对用户的理解】");
    expect(b.text).not.toContain("【记录】");
    const stated = statedOf(engine, "ev-w3", "dislikes");
    expect(b.profile.claims.map((c) => c.claimId)).toContain(stated.id);
    expect(b.text).toContain(`[${stated.id}] 偏好 · 用户说的 · 已验证`);
    // 原话（219 号票的格式）挂在结论下面
    expect(b.text).toContain("· 支持 [ev-w3] 2026-04-04 10:00 · 本人说的：「我不喜欢周末被排得满满的」");
    // 只有过了门槛的：直接说到这件事的，或者同一方面的；三条路每层最相关、没过门槛的不带
    expect(b.profile.claims.every((c) => c.reason === "direct" || c.reason === "area")).toBe(true);
    expect(b.items.filter((i) => i.kind === "claim").every((i) => i.reason === "direct" || i.reason === "area")).toBe(true);
    // 明说的禁忌（香菜过敏）照 D 组带上
    expect(b.text).toContain("【明说过的要求和禁忌】");
    expect(b.items.some((i) => i.kind === "hard")).toBe(true);
    // 引用得到的编号就是正文里出现的
    expect(b.evidenceIds.toSorted()).toEqual(idsIn(b.text, "ev"));
    expect(b.claimIds.toSorted()).toEqual(idsIn(b.text, "cl"));
    // 上限照 BRIEF_LIMITS（D 组那档）
    expect(b.text.length).toBeLessThanOrEqual(BRIEF_LIMITS.profileChars);
    expect(b.profile.claims.length).toBeLessThanOrEqual(BRIEF_LIMITS.claims);
  });

  it("不相关时不带：过不了相关门槛就是空的（禁忌也不单独带）", async () => {
    const engine = await story();
    const b = await messageBrief(engine, WEATHER, { at: NOW });
    expect(b.relevant).toBe(false);
    expect(b.text).toBe("");
    expect(b.items).toEqual([]);
    expect(b.brought).toEqual({});
  });

  it("同一段对话里带过、没变的不再带：再说一句同样的话什么都不带；只补新的；结论变了再带", async () => {
    const engine = await story();
    const first = await messageBrief(engine, WEEKEND, { at: NOW });
    expect(Object.keys(first.brought).length).toBeGreaterThan(0);
    // 带过的都记下了：每条结论、禁忌、组一个指纹（只有编号和哈希，没有原话）
    for (const item of first.items) expect(first.brought[item.key]).toMatch(/^[0-9a-f]{12}$/);

    const again = await messageBrief(engine, WEEKEND, { at: NOW, known: known(first) });
    expect(again.relevant).toBe(true);
    expect(again.text).toBe("");
    expect(again.items).toEqual([]);
    expect(again.repeated.length).toBeGreaterThan(0);

    // 只带过一部分：剩下的补上，带过的不再写
    const stated = statedOf(engine, "ev-w3", "dislikes");
    const partial = new Map([[`claim:${stated.id}`, first.brought[`claim:${stated.id}`]!]]);
    const rest = await messageBrief(engine, WEEKEND, { at: NOW, known: partial });
    expect(rest.text).not.toBe("");
    expect(rest.profile.claims.map((c) => c.claimId)).not.toContain(stated.id);
    expect(rest.repeated).toContain(stated.id);
    // 说一句带过的没重复
    expect(rest.text).toContain(`前面带过、没变的不再重复：${stated.id}`);

    // 结论变了（把握、状态、说法）：再带
    engine.store.updateClaim(stated.id, { confidence: "low" }, { reason: "测试：把握掉了" });
    const changed = await messageBrief(engine, WEEKEND, { at: NOW, known: known(first) });
    expect(changed.profile.claims.map((c) => c.claimId)).toContain(stated.id);
    expect(changed.brought[`claim:${stated.id}`]).not.toBe(first.brought[`claim:${stated.id}`]);
  });

  it("为什么带它：每条写明是直接说到这件事、同一方面、明说过的禁忌还是还没分出胜负，直接说到的还写着从哪条路找到的", async () => {
    const engine = await story();
    const b = await messageBrief(engine, WEEKEND, { at: NOW });
    const direct = b.items.find((i) => i.kind === "claim" && i.reason === "direct");
    expect(direct).toBeDefined();
    expect(direct!.routes.length).toBeGreaterThan(0);
    expect(direct!.routes.every((r) => ["upward", "index", "domain"].includes(r))).toBe(true);
    expect(b.items.filter((i) => i.kind !== "strategy" && i.claimIds.length === 0)).toEqual([]);
  });
});
