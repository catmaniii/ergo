// 守卫切面：planguard 的执行时监控（59 号票搬来的 monitor.ts）。
// 用例原样搬自 AgentSense 的 scripts/planguard-cases/*/runtime.json（storage、office、travel 三个场景各一条执行序列，
// travel 的审查用例 evening.json 是它的出处），场景文档和事实沿用 planguard-review/ 里那几份（58 号票搬的）。
// 跑法照 planguard 的 cases.ts（runRuntimeCase）：先按出处的审查用例审查修补，用修补后的计划建监控器，逐个调用检查——
// 判定（放行 / 当场确认 / 拦下）和查出的问题种类（off_plan 只在不放行时算）和用例写的一样；用例写了 commit 的按它、
// 没写的不是拦下就记进轨迹；最后没执行、也没报告跳过的步骤和用例写的一样。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Monitor } from "../../src/guard/planguard/monitor.ts";
import { type Goal, review } from "../../src/guard/planguard/reviewer.ts";
import { searchBackend } from "../../src/guard/planguard/search.ts";
import { type Plan, prepareScenario, type Scenario } from "../../src/guard/planguard/spec.ts";

const REVIEW_DIR = path.join(import.meta.dirname, "planguard-review");
const DIR = path.join(import.meta.dirname, "planguard-runtime");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));

const facts: Record<string, unknown> = readJson(path.join(REVIEW_DIR, "facts.json"));
const scenarios: Record<string, Scenario> = {};
for (const file of fs.readdirSync(REVIEW_DIR).filter((f) => f.endsWith(".planguard.json"))) {
  const doc = readJson(path.join(REVIEW_DIR, file));
  scenarios[doc.id] = prepareScenario({ ...doc, facts: facts[doc.id] ?? {} });
}

interface RuntimeCall {
  tool: string;
  args: Record<string, unknown>;
  commit?: boolean;
  expect: { verdict: string; kinds: string[] };
}

interface RuntimeCase {
  kind: "runtime";
  scenario: string;
  from_review: string;
  name: string;
  calls: RuntimeCall[];
  expect_end?: { skipped: string[] };
}

/** 出处的审查用例：先在 planguard-runtime/ 里找（travel/evening.json），没有就是 planguard-review/ 里的 */
function reviewCase(name: string): { plan: Plan; goals?: Goal[] } {
  const own = path.join(DIR, name);
  return readJson(fs.existsSync(own) ? own : path.join(REVIEW_DIR, name));
}

const cases: Array<{ file: string; c: RuntimeCase }> = [];
for (const dir of fs.readdirSync(DIR)) {
  for (const file of fs.readdirSync(path.join(DIR, dir)).filter((f) => f === "runtime.json")) cases.push({ file: `${dir}/${file}`, c: readJson(path.join(DIR, dir, file)) });
}

describe("planguard 的执行时监控：AgentSense 的 storage、office、travel 执行序列", () => {
  it("三个场景各一条执行序列", () => {
    expect(cases.map((x) => x.c.scenario).toSorted()).toEqual(["office", "storage", "travel"]);
  });

  for (const { file, c } of cases) {
    it(`${file}：${c.name}`, async () => {
      const scenario = scenarios[c.scenario]!;
      const source = reviewCase(c.from_review);
      const reviewed = (await review(scenario, source.plan, source.goals, searchBackend)) as { patched_plan: Plan };
      const monitor = new Monitor(scenario, reviewed.patched_plan);
      const got: Array<{ verdict: string; kinds: string[] }> = [];
      for (const call of c.calls) {
        const outcome = monitor.check(call.tool, call.args);
        got.push({ verdict: outcome.verdict, kinds: outcome.findings.filter((f) => f.verdict !== "allow" || f.kind !== "off_plan").map((f) => f.kind).toSorted() });
        if (call.commit ?? outcome.verdict !== "block") monitor.commit(call.tool, call.args, outcome.step);
      }
      expect(got).toEqual(c.calls.map((call) => ({ verdict: call.expect.verdict, kinds: call.expect.kinds.toSorted() })));
      expect(monitor.end().map((f) => f.step).toSorted()).toEqual(c.expect_end!.skipped.toSorted());
    });
  }

  it("report_step 说明跳过的步骤不再算漏做，依赖它的步骤也不算顺序错", async () => {
    const source = reviewCase("travel/evening.json");
    const reviewed = (await review(scenarios.travel!, source.plan, source.goals, searchBackend)) as { patched_plan: Plan & { steps: Array<{ id: string; tool: string; after?: string[] }> } };
    const monitor = new Monitor(scenarios.travel!, reviewed.patched_plan);
    const all = monitor.end().map((f) => f.step);
    expect(all.length).toBe(reviewed.patched_plan.steps.length);
    const first = all[0]!;
    monitor.skip(first);
    expect(monitor.end().map((f) => f.step)).toEqual(all.slice(1));
    expect(monitor.end()[0]).toMatchObject({ kind: "skipped", verdict: "confirm", message: expect.stringMatching(/^计划步骤 \S+「.+」没有执行$/) });
  });
});
