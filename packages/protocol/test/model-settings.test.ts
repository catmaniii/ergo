// 设置里的"模型"（73 号票）：agent 实际会用的（跟随默认的换成默认），设置接口的请求体（多出来的字段、写错的档位一律拒绝）；
// 120 号票：设置文件里单独配了模型的维护者、⚙ 里配模型的请求体；
// 自定义（OpenAI 兼容）服务商这一步：custom 那一块的校验（有 / 没有、地址不对、模型 id 空）、连通测试的请求体、列模型的请求体；
// 2026-10-30：在网页上填 key 的请求体可以点名服务商（设置 · 模型的 API key 一块按服务商逐条列出）。
import { describe, expect, it } from "vitest";
import {
  AgentModelBody,
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_ID,
  checkHttpBody,
  checkModelCustom,
  MAINTAINER_MODEL_AGENTS,
  effectiveModelChoice,
  MODEL_AGENTS,
  MODEL_AGENT_LABEL,
  MODEL_THINKING_LABEL,
  MODEL_THINKING_LEVELS,
  ModelKeyBody,
  modelKeyOf,
  ModelCustomModelsBody,
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

// ───────────── 自定义（OpenAI 兼容）服务商（provider id 固定是 custom） ─────────────

const custom = { baseUrl: "https://api.example.com/v1", modelId: "llama-3.1-70b" };
const customBody = { ...base, provider: CUSTOM_PROVIDER_ID, default: { modelId: "llama-3.1-70b", thinkingLevel: "high" as const }, custom };

describe("自定义（OpenAI 兼容）服务商", () => {
  it("有 custom：合规（接口风格不给就按 OpenAI 的 chat completions）；请求体和设置文件都收这一项", () => {
    expect(CUSTOM_PROVIDER_ID).toBe("custom");
    expect(CUSTOM_PROVIDER_APIS).toEqual(["openai-completions", "openai-responses"]);
    expect(checkHttpBody(ModelSettingsBody, customBody).ok).toBe(true);
    expect(checkHttpBody(ModelSettingsBody, { ...customBody, custom: { ...custom, api: "openai-responses" } }).ok).toBe(true);
    expect(checkHttpBody(ModelSettingsFile, { format: 1, ...customBody }).ok).toBe(true);
    // 不合规的类型检查函数合规时交回收拾过的那一份（末尾斜杠去掉）
    expect(checkModelCustom(customBody)).toEqual({ ok: true, custom });
    expect(checkModelCustom({ provider: CUSTOM_PROVIDER_ID, custom: { ...custom, baseUrl: "https://api.example.com/v1/" } })).toEqual({ ok: true, custom });
    // 不选自定义时允许没有 custom（连那块也没有的旧设置文件也合规）
    expect(checkModelCustom({ provider: "deepseek" })).toEqual({ ok: true });
    expect(checkHttpBody(ModelSettingsBody, base).ok).toBe(true);
  });

  it("没有 custom 却选了自定义：schema 管不了这条跨字段的规矩，由 checkModelCustom 挡住、说清楚", () => {
    const { custom: _custom, ...withoutCustom } = customBody;
    expect(checkHttpBody(ModelSettingsBody, withoutCustom).ok).toBe(true);
    expect(checkModelCustom(withoutCustom)).toEqual({ ok: false, error: "选了自定义（OpenAI 兼容）服务商，却没填接口地址和模型 id" });
    // 没选自定义的有、没给都行（给了照样查）
    expect(checkModelCustom({ provider: "deepseek", custom })).toEqual({ ok: true, custom });
  });

  it("地址不合规：不是 http(s)、没有协议、带空格的一律不收", () => {
    for (const baseUrl of ["api.example.com", "ftp://api.example.com", "https://api example.com", "https://"]) {
      expect(checkHttpBody(ModelSettingsBody, { ...customBody, custom: { ...custom, baseUrl } }).ok).toBe(false);
      expect(checkModelCustom({ provider: CUSTOM_PROVIDER_ID, custom: { ...custom, baseUrl } }).ok).toBe(false);
    }
    expect(checkModelCustom({ provider: CUSTOM_PROVIDER_ID, custom: { ...custom, baseUrl: "api.example.com" } })).toMatchObject({ ok: false, error: expect.stringContaining("http:// 或 https://") as unknown });
  });

  it("模型 id 是空的（空串、只有空白）不收", () => {
    expect(checkHttpBody(ModelSettingsBody, { ...customBody, custom: { ...custom, modelId: "" } }).ok).toBe(false);
    expect(checkHttpBody(ModelSettingsBody, { ...customBody, custom: { ...custom, modelId: "   " } }).ok).toBe(false);
    expect(checkModelCustom({ provider: CUSTOM_PROVIDER_ID, custom: { ...custom, modelId: "  " } })).toEqual({ ok: false, error: "自定义服务商的模型 id 不能是空的：填那家服务商那边的模型名（比如 llama-3.1-70b）" });
  });

  it("自定义服务商的模型 id 比 DeepSeek 的宽松（可以有斜杠），接口风格只认那两种，多出来的字段不收", () => {
    expect(checkHttpBody(ModelSettingsBody, { ...customBody, custom: { ...custom, modelId: "meta-llama/Llama-3-70B" } }).ok).toBe(true);
    expect(checkHttpBody(ModelSettingsBody, { ...customBody, custom: { ...custom, api: "anthropic-messages" } }).ok).toBe(false);
    expect(checkHttpBody(ModelSettingsBody, { ...customBody, custom: { ...custom, apiKey: "sk-x" } }).ok).toBe(false);
  });

  it("连通测试的请求体可以带一块 custom（还没存就想试一下），列模型的请求体只带接口地址", () => {
    expect(checkHttpBody(ModelTestBody, { custom }).ok).toBe(true);
    expect(checkHttpBody(ModelTestBody, { modelId: "llama-3.1-70b", custom }).ok).toBe(true);
    expect(checkHttpBody(ModelTestBody, { custom: { ...custom, baseUrl: "nope" } }).ok).toBe(false);
    // key 放不进连通测试、列模型的请求体：照旧只从密钥区来
    expect(checkHttpBody(ModelTestBody, { custom: { ...custom, apiKey: "sk-x" } }).ok).toBe(false);
    expect(checkHttpBody(ModelCustomModelsBody, {}).ok).toBe(true);
    expect(checkHttpBody(ModelCustomModelsBody, { baseUrl: "https://api.example.com/v1" }).ok).toBe(true);
    expect(checkHttpBody(ModelCustomModelsBody, { baseUrl: "https://api.example.com/v1", key: "sk-x" }).ok).toBe(false);
    expect(checkHttpBody(ModelCustomModelsBody, { baseUrl: "api.example.com" }).ok).toBe(false);
  });
});

describe("在网页上填 key 的请求体", () => {
  it("只有 key 时照旧（按设置里选的服务商）；带 provider 时收下——设置 · 模型的 API key 一块按服务商逐条列出", () => {
    expect(checkHttpBody(ModelKeyBody, { key: "sk-x-abcdef" }).ok).toBe(true);
    expect(checkHttpBody(ModelKeyBody, { key: "sk-x-abcdef", provider: "custom" }).ok).toBe(true);
    expect(checkHttpBody(ModelKeyBody, { key: "sk-x-abcdef", provider: "deepseek" }).ok).toBe(true);
    // 不认识的 id 交给守护进程挡住（回 400 并说清支持哪几个）；schema 只挡空串、非字符串和别的字段
    expect(checkHttpBody(ModelKeyBody, { key: "sk-x-abcdef", provider: "openrouter" }).ok).toBe(true);
    expect(checkHttpBody(ModelKeyBody, { key: "sk-x-abcdef", provider: "" }).ok).toBe(false);
    expect(checkHttpBody(ModelKeyBody, { key: "sk-x-abcdef", provider: 5 }).ok).toBe(false);
    expect(checkHttpBody(ModelKeyBody, { key: "sk-x-abcdef", providerId: "custom" }).ok).toBe(false);
    expect(checkHttpBody(ModelKeyBody, { key: "" }).ok).toBe(false);
    expect(checkHttpBody(ModelKeyBody, { provider: "custom" }).ok).toBe(false);
    expect(checkHttpBody(ModelKeyBody, {}).ok).toBe(false);
  });
});
