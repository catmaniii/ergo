// 守卫切面：场景文件。每个 `scenarios/*.guard.json` 是一串调用，逐步判定、逐步核对（格式见 helpers/scenario.ts）。
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenarios, runScenario } from "./helpers/scenario.ts";

const scenarios = loadScenarios(path.join(import.meta.dirname, "scenarios"));

describe("守卫场景文件", () => {
  it("至少有一个场景文件", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const { file, scenario } of scenarios) {
    it(`${file}：${scenario.name}`, () => {
      expect(runScenario(scenario)).toEqual([]);
    });
  }
});
