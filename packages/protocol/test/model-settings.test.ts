// 设置里的"模型"（73 号票）：agent 实际会用的（跟随默认的换成默认），设置接口的请求体（多出来的字段、写错的档位一律拒绝）；
// 120 号票：设置文件里单独配了模型的维护者、⚙ 里配模型的请求体。
import { describe, expect, it } from "vitest";
import {
  AgentModelBody,
  checkHttpBody,
  MAINTAINER_MODEL_AGENTS,
  effectiveModelChoice,
  MODEL_AGENTS,
  MODEL_AGENT_LABEL,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  modelKeyOf,
  ModelSettingsBody,
  ModelSettingsFile,
  ModelTestBody,
  splitModelKey,
} from "../src/index.ts";

const base = { provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" as const }, agents: {}, vision: {} };

describe("设置里的模型", () => {
  it("agent 实际会用的：没覆盖的跟随默认；只覆盖模型或只覆盖思考档位，另一项跟随默认", () => {
    const settings = { default: base.default, agents: { reviewer: { modelId: "deepseek-v4-pro" }, sub_agent: { thinkingLevel: "off" as const } } };
    expect(effectiveModelChoice(settings, "secretary")).toEqual({ modelId: "deepseek-flash", thinkingLevel: "high" });
    expect(effectiveModelChoice(settings, "reviewer")).toEqual({ modelId: "deepseek-v4-pro", thinkingLevel: "high" });
    expect(effectiveModelChoice(settings, "sub_agent")).toEqual({ modelId: "deepseek-flash", thinkingLevel: "off" });
  });

  it("「provider/模型 id」拼和拆都在一处：在第一个斜杠处拆，不是这个写法的（faux）拆不出来", () => {
    expect(modelKeyOf("deepseek", "deepseek-flash")).toBe("deepseek/deepseek-flash");
    expect(splitModelKey("deepseek/deepseek-flash")).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
    expect(splitModelKey("openrouter/vendor/model")).toEqual({ provider: "openrouter", modelId: "vendor/model" });
    for (const bad of ["faux", "/x", "deepseek/", ""]) expect(splitModelKey(bad)).toBeUndefined();
  });

  it("六个 agent、四档思考都有叫法", () => {
    expect(MODEL_AGENTS).toHaveLength(6);
    for (const agent of MODEL_AGENTS) expect(MODEL_AGENT_LABEL[agent]).toBeTruthy();
    expect(MODEL_THINKING_LEVELS.map((l) => MODEL_THINKING_LABEL[l])).toEqual(["关", "低", "中", "高"]);
  });

  it("请求体：合规的通过；多出来的字段（比如 key）、不认识的 agent、写错的档位、写错的看图能力的键都不通过", () => {
    expect(checkHttpBody(ModelSettingsBody, { ...base, agents: { secretary: { modelId: "deepseek-v4-pro" }, scope_review: { thinkingLevel: "low" } }, vision: { "deepseek/deepseek-v4-pro": true } }).ok).toBe(true);
    expect(checkHttpBody(ModelSettingsBody, { ...base, apiKey: "sk-x" }).ok).toBe(false);
    expect(checkHttpBody(ModelSettingsBody, { ...base, agents: { boss: {} } }).ok).toBe(false);
    expect(checkHttpBody(ModelSettingsBody, { ...base, agents: { secretary: { modelId: "deepseek-flash", key: "sk-x" } } }).ok).toBe(false);
    expect(checkHttpBody(ModelSettingsBody, { ...base, default: { modelId: "deepseek-flash", thinkingLevel: "max" } }).ok).toBe(false);
    expect(checkHttpBody(ModelSettingsBody, { ...base, default: { modelId: "../x", thinkingLevel: "high" } }).ok).toBe(false);
    expect(checkHttpBody(ModelSettingsBody, { ...base, vision: { "deepseek-flash": true } }).ok).toBe(false);
    expect(checkHttpBody(ModelTestBody, {}).ok).toBe(true);
    expect(checkHttpBody(ModelTestBody, { modelId: "deepseek-v4-pro" }).ok).toBe(true);
    expect(checkHttpBody(ModelTestBody, { modelId: "deepseek-v4-pro", apiKey: "sk-x" }).ok).toBe(false);
  });

  it("单独配了模型的维护者（120 号票）：只有项目维护者、任务维护者那两行能被盖过；设置文件里按 agent id 记选定的模型和思考档位（两项都要写），没有这一项的旧文件照样合规", () => {
    expect(MAINTAINER_MODEL_AGENTS).toEqual(["task_maintainer", "project_maintainer"]);
    const file = { format: 1, ...base };
    expect(checkHttpBody(ModelSettingsFile, file).ok).toBe(true);
    expect(checkHttpBody(ModelSettingsFile, { ...file, maintainers: { "pm-1": { modelId: "deepseek-v4-pro", thinkingLevel: "high" }, "tm-12": { modelId: "deepseek-flash", thinkingLevel: "off" } } }).ok).toBe(true);
    expect(checkHttpBody(ModelSettingsFile, { ...file, maintainers: { "pm-1": { modelId: "deepseek-v4-pro" } } }).ok).toBe(false);
    expect(checkHttpBody(ModelSettingsFile, { ...file, maintainers: { "../x": { modelId: "deepseek-v4-pro", thinkingLevel: "high" } } }).ok).toBe(false);
    // ⚙ 里配模型的请求体：模型和思考档位都要；多出来的字段不收
    expect(checkHttpBody(AgentModelBody, { modelId: "deepseek-v4-pro", thinkingLevel: "high" }).ok).toBe(true);
    expect(checkHttpBody(AgentModelBody, { modelId: "deepseek-v4-pro" }).ok).toBe(false);
    expect(checkHttpBody(AgentModelBody, { modelId: "deepseek-v4-pro", thinkingLevel: "high", apiKey: "sk-x" }).ok).toBe(false);
    // 设置页整份存的请求体里没有这一项（只经 ⚙ 改）
    expect(checkHttpBody(ModelSettingsBody, { ...base, maintainers: {} }).ok).toBe(false);
  });
});
