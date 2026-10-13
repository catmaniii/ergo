// 每个 agent 单独的提示词怎么查（114 号票，agent-settings.ts）：守护进程存之前、设置页边改边查用同一个函数，
// 占位符照这个角色的通用模板查（和设置 · 系统提示一致），整份自己写的不能是空的，追加的空着等于不追加。
import { describe, expect, it } from "vitest";
import { agentPromptProblem } from "../src/agent-settings.ts";
import type { PromptTemplateSpec } from "../src/system-prompts.ts";

const SPEC: PromptTemplateSpec = { values: ["名字"], common: ["view_board"], flags: ["对话审批开着"], partials: [] };

describe("单独的提示词的检查", () => {
  it("两种写法都按通用模板的占位符查：认得的值、公用的工具名、条件都能用，写错的报第几行", () => {
    for (const mode of ["append", "replace"] as const) {
      expect(agentPromptProblem(mode, "你叫{{名字}}。\n{{#对话审批开着}}\n先问。\n{{/对话审批开着}}\n看板用 {{view_board}}。", SPEC, false)).toBeUndefined();
      expect(agentPromptProblem(mode, "第一行\n叫我{{老板}}", SPEC, false)).toBe("第 2 行：不认得的占位符 {{老板}}（这里能填的值：名字，另有每份都能用的工具名和标记）");
      expect(agentPromptProblem(mode, "{{#对话审批开着}}\n没结束", SPEC, false)).toMatch(/^第 1 行：第 1 行的 \{\{#对话审批开着\}\} 没有结束/);
    }
  });

  it("整份自己写的不能是空的（通用模板能是空的除外）；追加的空着可以（等于不追加）", () => {
    expect(agentPromptProblem("replace", "  \n\n", SPEC, false)).toBe("不能是空的（要用通用模板请点“恢复用通用模板”）");
    expect(agentPromptProblem("replace", "", SPEC, true)).toBeUndefined();
    expect(agentPromptProblem("append", "\r\n", SPEC, false)).toBeUndefined();
  });
});
