// 守卫切面：planguard 的规划时审查（58 号票搬来的 reviewer.ts、search.ts、spec.ts 的 prepareScenario / normalizePlan）。
// 用例原样搬自 AgentSense 的 scripts/planguard-cases（storage、office 两个场景的审查用例，travel 场景的"调整顺序"用例 reorder），
// 场景文档是 AgentSense 的 src/agent/scenarios/*.planguard.json，事实是 scripts/planguard-cases/facts.json 里这三个场景的那份。
// 每条用例按 planguard 的 cases.ts（runReviewCase）核对：审查结果的摘要（状态、违规、推迟、修补动作、目标冲突）和用例写的一样，
// 修补后的计划复查通过。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type Goal, review, summary } from "../../src/guard/planguard/reviewer.ts";
import { searchBackend } from "../../src/guard/planguard/search.ts";
import { type Plan, prepareScenario, type Scenario } from "../../src/guard/planguard/spec.ts";

const DIR = path.join(import.meta.dirname, "planguard-review");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));

const facts: Record<string, unknown> = readJson(path.join(DIR, "facts.json"));
const scenarios: Record<string, Scenario> = {};
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".planguard.json"))) {
  const doc = readJson(path.join(DIR, file));
  scenarios[doc.id] = prepareScenario({ ...doc, facts: facts[doc.id] ?? {} });
}

interface ReviewCase {
  kind: "review";
  scenario: string;
  name: string;
  plan: Plan;
  goals?: Goal[];
  expect: Record<string, unknown>;
}

const cases: Array<{ file: string; c: ReviewCase }> = [];
for (const dir of fs.readdirSync(DIR).filter((d) => fs.statSync(path.join(DIR, d)).isDirectory())) {
  for (const file of fs.readdirSync(path.join(DIR, dir)).filter((f) => f.endsWith(".json"))) cases.push({ file: `${dir}/${file}`, c: readJson(path.join(DIR, dir, file)) });
}

/** 和 planguard 的 cases.ts 一样比：数组不论先后 */
function digestOf(result: Record<string, unknown>, expected: Record<string, unknown>): Record<string, unknown> {
  const digest = summary(result) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(expected).map((k) => [k, Array.isArray(digest[k]) ? (digest[k] as unknown[]).toSorted() : digest[k]]));
}

const sortedExpect = (expected: Record<string, unknown>) => Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, Array.isArray(v) ? v.toSorted() : v]));

describe("planguard 的规划时审查：AgentSense 的 storage、office 用例和 travel 的调整顺序", () => {
  it("三个场景、八条用例都在", () => {
    expect(Object.keys(scenarios).toSorted()).toEqual(["office", "storage", "travel"]);
    expect(cases.length).toBe(8);
  });

  for (const { file, c } of cases) {
    it(`${file}：${c.name}`, async () => {
      const result = (await review(scenarios[c.scenario]!, c.plan, c.goals, searchBackend)) as Record<string, unknown>;
      expect(digestOf(result, c.expect)).toEqual(sortedExpect(c.expect));
      expect(result.verified).toBe(true);
    });
  }

  it("插入的步骤编号 p1、p2……排在触发它的那一步之前，触发的那一步的前置步骤记上它", async () => {
    const c = cases.find((x) => x.file === "storage/goal1500.json")!.c;
    const result = (await review(scenarios.storage!, c.plan, c.goals, searchBackend)) as { patched_plan: { steps: Array<{ id: string; tool: string; after: string[]; inserted?: boolean; patches?: string[] }> } };
    const steps = result.patched_plan.steps;
    const inserted = steps.filter((s) => s.inserted);
    expect(inserted.map((s) => s.tool)).toEqual(["storage_scan", "storage_scan"]);
    for (const step of inserted) {
      const dependent = steps.find((s) => s.after.includes(step.id))!;
      expect(steps.indexOf(step)).toBeLessThan(steps.indexOf(dependent));
    }
    // 改写过的步骤记着一句修补摘要
    expect(steps.filter((s) => s.patches?.length).map((s) => s.id).toSorted()).toEqual(["s5", "s7"]);
  });

  it("调整顺序（travel/reorder）：取消、预约接机排在改签之前的，挪到改签之后（前置步骤记上改签），不插入、不改写", async () => {
    const c = cases.find((x) => x.file === "travel/reorder.json")!.c;
    const result = (await review(scenarios.travel!, c.plan, c.goals, searchBackend)) as { patched_plan: { steps: Array<{ id: string; tool: string; after: string[]; inserted?: boolean }> } };
    const steps = result.patched_plan.steps;
    const position = (id: string) => steps.findIndex((s) => s.id === id);
    expect(position("s3")).toBeGreaterThan(position("s5"));
    expect(position("s4")).toBeGreaterThan(position("s5"));
    expect(steps.find((s) => s.id === "s3")!.after).toContain("s5");
    expect(steps.find((s) => s.id === "s4")!.after).toContain("s5");
    expect(steps.some((s) => s.inserted)).toBe(false);
  });
});
