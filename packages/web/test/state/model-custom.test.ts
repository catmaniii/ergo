// 自定义（OpenAI 兼容）服务商在网页这一侧的状态层：设置里那份怎么填进表单、填的怎么收拾成设置里的样子、
// 存之前查什么（选的还是自定义时地址和模型 id 都得合规；存的是 DeepSeek 时不合规就不带这一块，原来那份留着——
// 切回 DeepSeek 不清空已经填好的自定义块）、拉到的模型怎么变成下拉的几项、拉列表的三种说法。
// 页面上的样子见 test/pages/model-provider.test.ts；守护进程那一侧见 packages/daemon/test/model-custom-provider.test.ts。
import { describe, expect, test } from "vitest";
import {
  CUSTOM_PROVIDER_ID,
  customDraftOf,
  customDraftUntouched,
  customModelLabel,
  customModelOptions,
  customModelsText,
  customOf,
  customSavePlan,
  DEFAULT_CUSTOM_PROVIDER_API,
  providerPickNeedsSave,
  settingsBody,
  withProvider,
  type ModelSettings,
} from "../../src/state/index.ts";

const CUSTOM = { baseUrl: "https://api.example.com/v1", modelId: "my-model", api: "openai-responses" } as const;

/** 存着自定义那一块、但现在选的是 DeepSeek（切走过一次） */
const SETTINGS: ModelSettings = {
  provider: "deepseek",
  default: { modelId: "deepseek-flash", thinkingLevel: "high" },
  agents: { reviewer: { thinkingLevel: "off" } },
  vision: {},
  custom: { ...CUSTOM },
};

/** 选了自定义、设置里那份也是它 */
const ON_CUSTOM: ModelSettings = { ...SETTINGS, provider: CUSTOM_PROVIDER_ID, default: { modelId: "my-model", thinkingLevel: "high" } };

describe("表单和设置之间", () => {
  test("没存过时是空的、接口类型按默认；存过的照着填（接口类型也带过来）", () => {
    expect(customDraftOf({})).toEqual({ baseUrl: "", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API });
    expect(customDraftOf({ custom: CUSTOM })).toEqual({ baseUrl: CUSTOM.baseUrl, modelId: CUSTOM.modelId, api: "openai-responses" });
    // 没写 api 的那份也按默认
    expect(customDraftOf({ custom: { baseUrl: CUSTOM.baseUrl, modelId: CUSTOM.modelId } })).toEqual({ baseUrl: CUSTOM.baseUrl, modelId: CUSTOM.modelId, api: DEFAULT_CUSTOM_PROVIDER_API });
  });

  test("填的收拾成设置里的样子：去掉首尾空白、地址末尾的斜杠", () => {
    expect(customOf({ baseUrl: "  https://api.example.com/v1// ", modelId: " my-model ", api: "openai-completions" })).toEqual({
      baseUrl: "https://api.example.com/v1",
      modelId: "my-model",
      api: "openai-completions",
    });
  });

  test("存整份时带着设置里原来那份自定义（切回 DeepSeek 不清空）；显式给了就换成新的", () => {
    expect(settingsBody(SETTINGS).custom).toEqual(CUSTOM);
    expect(withProvider(SETTINGS, "deepseek").custom).toEqual(CUSTOM);
    expect(withProvider(SETTINGS, "deepseek", { baseUrl: "https://other.example.com/v1", modelId: "other" }).custom).toEqual({ baseUrl: "https://other.example.com/v1", modelId: "other" });
    // 没有自定义那一块的不凭空多出来
    const bare: ModelSettings = { provider: "deepseek", default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents: {}, vision: {} };
    expect(settingsBody(bare).custom).toBeUndefined();
    expect(withProvider(bare, "deepseek").custom).toBeUndefined();
  });
});

describe("存之前查什么", () => {
  test("选的是自定义、地址和模型 id 都填了：整份带上它（地址末尾的斜杠去掉）", () => {
    const plan = customSavePlan(ON_CUSTOM, CUSTOM_PROVIDER_ID, { baseUrl: "https://api.example.com/v1/", modelId: " my-model ", api: "openai-completions" });
    expect(plan).toEqual({
      ok: true,
      body: expect.objectContaining({ provider: CUSTOM_PROVIDER_ID, custom: { baseUrl: "https://api.example.com/v1", modelId: "my-model", api: "openai-completions" } }),
    });
  });

  test("选的是自定义、什么都没填 / 地址不是 http(s) / 模型 id 是空白：不收，原样说原因（和守护进程同一句）", () => {
    const empty = customSavePlan(ON_CUSTOM, CUSTOM_PROVIDER_ID, { baseUrl: "", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API });
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.error).toBe("选了自定义（OpenAI 兼容）服务商，却没填接口地址和模型 id");

    const url = customSavePlan(ON_CUSTOM, CUSTOM_PROVIDER_ID, { baseUrl: "api.example.com", modelId: "my-model", api: DEFAULT_CUSTOM_PROVIDER_API });
    expect(url).toEqual({ ok: false, error: expect.stringMatching(/接口地址要以 http:\/\/ 或 https:\/\//) });

    const id = customSavePlan(ON_CUSTOM, CUSTOM_PROVIDER_ID, { baseUrl: "https://api.example.com/v1", modelId: "   ", api: DEFAULT_CUSTOM_PROVIDER_API });
    expect(id).toEqual({ ok: false, error: expect.stringMatching(/模型 id 不能是空的/) });
  });

  test("切回 DeepSeek：自定义那一块填好的照样存下去（不清空）；填坏了的不带，留着设置里原来那份", () => {
    const good = customSavePlan(SETTINGS, "deepseek", { baseUrl: "https://api2.example.com/v1", modelId: "model-2", api: "openai-responses" });
    expect(good.ok && good.body.provider).toBe("deepseek");
    expect(good.ok && good.body.custom).toEqual({ baseUrl: "https://api2.example.com/v1", modelId: "model-2", api: "openai-responses" });

    const broken = customSavePlan(SETTINGS, "deepseek", { baseUrl: "not-a-url", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API });
    expect(broken.ok && broken.body.custom).toEqual(CUSTOM);
    // 原来那份没被改
    expect(SETTINGS.custom).toEqual(CUSTOM);
  });

  test("刚切到自定义、还什么都没填时不必现在存；DeepSeek 总是存；填了一样就存", () => {
    expect(customDraftUntouched({ baseUrl: "  ", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API })).toBe(true);
    expect(customDraftUntouched({ baseUrl: "https://api.example.com/v1", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API })).toBe(false);
    expect(providerPickNeedsSave("deepseek", { baseUrl: "", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API })).toBe(true);
    expect(providerPickNeedsSave(CUSTOM_PROVIDER_ID, { baseUrl: "", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API })).toBe(false);
    expect(providerPickNeedsSave(CUSTOM_PROVIDER_ID, { baseUrl: "https://api.example.com/v1", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API })).toBe(true);
  });
});

describe("拉到的模型", () => {
  const MODELS = [
    { id: "model-a", name: "Model A", ownedBy: "fake" },
    { id: "model-b", ownedBy: "fake" },
  ] as const;

  test("下拉里一行一个：有名字的写名字和 id，没有的就写 id；现在填的不在列表里时补在第一项", () => {
    expect(customModelLabel(MODELS[0])).toBe("Model A（model-a）");
    expect(customModelLabel(MODELS[1])).toBe("model-b");
    expect(customModelOptions(MODELS, "model-a").map((o) => o.id)).toEqual(["model-a", "model-b"]);
    expect(customModelOptions(MODELS, "typed-model")).toEqual([
      { id: "typed-model", label: "typed-model" },
      { id: "model-a", label: "Model A（model-a）" },
      { id: "model-b", label: "model-b" },
    ]);
    expect(customModelOptions(MODELS, "  ").map((o) => o.id)).toEqual(["model-a", "model-b"]);
    expect(customModelOptions([], "")).toEqual([]);
  });

  test("拉到了、一个都没有、失败各一句（失败时是守护进程写的原因，原样显示）", () => {
    expect(customModelsText({ ok: true, models: [...MODELS] })).toEqual({ ok: true, text: "拉到 2 个模型：挑一个，或者接着手填" });
    expect(customModelsText({ ok: true, models: [] })).toEqual({ ok: true, text: "服务商那边一个模型都没列出来：模型 id 接着手填，或者再检查一下接口地址" });
    expect(customModelsText({ ok: false, models: [], error: "列不出这个服务商的模型：401 Unauthorized" })).toEqual({ ok: false, text: "列不出这个服务商的模型：401 Unauthorized" });
    // 没给原因时也得有话说
    expect(customModelsText({ ok: false, models: [] }).text).toBe("没说原因");
  });
});
