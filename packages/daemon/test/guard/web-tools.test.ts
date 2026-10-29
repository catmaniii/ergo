// 守卫切面：联网搜索、读网页（70 号票，来源 web）。守卫看得懂参数（查询词、网址），性质算"只看"：
// 只读或幂等、只往下拉、不落入任何类别；要联网，联网开关关着时硬拒绝；对外内容里有密钥照样永不；流程的步骤里能写。
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_REGISTRY,
  findTool,
  identityArgsOf,
  isBuiltinDescriptor,
  isReadOnlyOrIdempotentCall,
  isUnknownArg,
  judgeToolCall,
  normalizeArgs,
  stepToolAllowed,
  TOOL,
  usesNetwork,
  workflowToolkit,
} from "../../src/guard/index.ts";
import { ruleStep } from "../../src/guard/rule-steps.ts";
import { call, inChat, inTask, maintainer, P, secretary, subAgent } from "./helpers/guard-input.ts";

const SEARCH = call(TOOL.web_search, { query: "二狗 天气", n: 3, time: "w" });
const FETCH = call(TOOL.web_fetch, { url: "https://example.com/a?b=1", max: 2000 });

describe("登记", () => {
  it("两个都在框架自带的注册表里：来源 web，只读或幂等，要联网、只往下拉，不落入任何类别", () => {
    for (const name of [TOOL.web_search, TOOL.web_fetch]) {
      const tool = findTool(BUILTIN_TOOL_REGISTRY, name)!;
      expect(tool.source).toBe("web");
      expect(tool.readOnlyOrIdempotent).toBe(true);
      expect([tool.network, tool.pullOnly, tool.outbound]).toEqual([true, true, undefined]);
      expect(tool.categories).toEqual([]);
      expect(usesNetwork(tool)).toBe(true);
      expect(isBuiltinDescriptor(tool)).toBe(true);
      expect(isBuiltinDescriptor({ ...tool })).toBe(false);
    }
    expect(findTool(BUILTIN_TOOL_REGISTRY, TOOL.web_search)!.title).toBe("联网搜索");
    expect(findTool(BUILTIN_TOOL_REGISTRY, TOOL.web_fetch)!.title).toBe("读网页");
  });

  it("守卫看得懂参数：读网页的网址是对象（收件人、网址），查询词是发出去的内容；规范化照注册表", () => {
    const env = { cwd: P.scratch, homeDir: P.home };
    const fetchStep = ruleStep({ tools: BUILTIN_TOOL_REGISTRY, env, agent: secretary(), facts: {} }, { id: "x", tool: TOOL.web_fetch, args: FETCH.args as Record<string, unknown> });
    expect(fetchStep.recipients).toEqual(["https://example.com/a?b=1"]);
    expect([fetchStep.sends, fetchStep.outward]).toEqual([true, false]);
    const searchStep = ruleStep({ tools: BUILTIN_TOOL_REGISTRY, env, agent: secretary(), facts: {} }, { id: "y", tool: TOOL.web_search, args: SEARCH.args as Record<string, unknown> });
    expect(searchStep.content).toBe("二狗 天气");
    expect([searchStep.sends, searchStep.outward]).toEqual([true, false]);
    // 不是 http(s) 的网址不合登记的 pattern：规范化成"未知"
    expect(isUnknownArg(normalizeArgs(TOOL.web_fetch, { url: "file:///etc/passwd" }, BUILTIN_TOOL_REGISTRY, env).url)).toBe(true);
    expect(normalizeArgs(TOOL.web_fetch, { url: "https://example.com" }, BUILTIN_TOOL_REGISTRY, env).url).toBe("https://example.com");
    // 流程的自动纠偏不改认对象的参数：网址、查询词
    expect(identityArgsOf(BUILTIN_TOOL_REGISTRY, TOOL.web_fetch)).toEqual(["url"]);
    expect(identityArgsOf(BUILTIN_TOOL_REGISTRY, TOOL.web_search)).toEqual(["query"]);
  });

  it("性质算只看：只读或幂等（被杀后能直接重做，流程里计划外的只记下）", () => {
    for (const c of [SEARCH, FETCH]) {
      const j = judgeToolCall(inChat(secretary({ toolkit: { bash: true, network: true } }), c));
      expect(isReadOnlyOrIdempotentCall(BUILTIN_TOOL_REGISTRY, c.toolName, j)).toBe(true);
    }
  });

  it("流程的步骤里能写，用到它们的流程开联网、不开 bash", () => {
    expect(stepToolAllowed(BUILTIN_TOOL_REGISTRY, TOOL.web_fetch)).toBe(true);
    expect(stepToolAllowed(BUILTIN_TOOL_REGISTRY, TOOL.web_search)).toBe(true);
    expect(workflowToolkit([{ tool: TOOL.web_fetch, args: { url: "https://example.com" } }], BUILTIN_TOOL_REGISTRY, { cwd: P.workDir, homeDir: P.home })).toEqual({ skills: [], mcp: [], bash: false, network: true });
  });
});

describe("判定", () => {
  it("联网开着：对话里、任务里都直接做，不落入任何类别", () => {
    for (const agent of [secretary({ toolkit: { bash: true, network: true } }), maintainer(), subAgent()]) {
      for (const scene of [inChat, inTask]) {
        for (const c of [SEARCH, FETCH]) {
          const j = judgeToolCall(scene(agent, c));
          expect({ tool: c.toolName, agent: agent.kind, d: j.disposition, cats: j.categories, refusal: j.hardRefusal }).toEqual({
            tool: c.toolName,
            agent: agent.kind,
            d: "log_only",
            cats: [],
            refusal: null,
          });
        }
      }
    }
  });

  it("联网开关关着：硬拒绝", () => {
    for (const agent of [secretary(), maintainer({ toolkit: { bash: false, network: false } })]) {
      for (const c of [SEARCH, FETCH]) expect(judgeToolCall(inChat(agent, c)).hardRefusal).toEqual(["network_off"]);
    }
  });

  it("工具包的白名单里没有：硬拒绝（评审子 agent 不配）", () => {
    const reviewer = subAgent({ toolkit: { bash: false, network: true, tools: ["read", "ls", "submit_review"] } });
    expect(judgeToolCall(inTask(reviewer, FETCH)).hardRefusal).toContain("not_in_toolkit");
  });

  it("模型直接调用伪工具名 http_request 仍按没登记处理（读网页不是伪工具）", () => {
    const j = judgeToolCall(inChat(maintainer(), call("http_request", { method: "GET", url: "https://example.com" })));
    expect(j.categories).toEqual(["unknown_write"]);
  });
});
