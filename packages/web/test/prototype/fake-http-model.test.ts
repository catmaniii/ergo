// 原型假数据里模型那一块（73 号票的演示页；自定义 OpenAI 兼容服务商这一步）：演示页不联网——
// 两个服务商都在（名字按登记表，和守护进程给的一样）、自定义那一块存得住（切回 DeepSeek 不清空）、
// 连通测试照假延迟说通了、拉列表回几个编的模型 id，模型目录和"实际会用的"跟着自定义服务商换成它那个模型。
import { describe, expect, test, vi } from "vitest";
import { FakeDaemonHttp } from "../../src/prototype/fake-http.ts";
import { CUSTOM_PROVIDER_ID, type ModelSettingsBody } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const CUSTOM = { baseUrl: "https://api.example.com/v1", modelId: "my-model", api: "openai-completions" } as const;

/** 存一份设置（服务商 + 自定义那一块），回存好之后的视图 */
function save(http: FakeDaemonHttp, body: Partial<ModelSettingsBody> & Pick<ModelSettingsBody, "provider">): Promise<Awaited<ReturnType<FakeDaemonHttp["saveModelSettings"]>>> {
  return http.saveModelSettings({ default: { modelId: "deepseek-flash", thinkingLevel: "high" }, agents: {}, vision: {}, ...body });
}

describe("原型里的服务商和自定义那一块", () => {
  test("两个服务商都在（DeepSeek、自定义（OpenAI 兼容）），默认是 DeepSeek", async () => {
    const view = await new FakeDaemonHttp().modelSettings();
    expect(view.providers.map((p) => p.id)).toEqual(["deepseek", CUSTOM_PROVIDER_ID]);
    expect(view.providers.map((p) => p.label)).toEqual(["DeepSeek", "自定义（OpenAI 兼容）"]);
    expect(view.settings.provider).toBe("deepseek");
    expect(view.settings.custom).toBeUndefined();
  });

  test("存成自定义：设置里存住、可选的模型只剩它那个、实际会用的也是它；key 那一块跟着换成自定义的", async () => {
    const http = new FakeDaemonHttp();
    const view = await save(http, { provider: CUSTOM_PROVIDER_ID, default: { modelId: "my-model", thinkingLevel: "medium" }, custom: { ...CUSTOM } });
    expect(view.settings.custom).toEqual(CUSTOM);
    expect(view.models.map((m) => m.modelId)).toEqual(["my-model"]);
    expect(view.effective.secretary).toEqual({ modelId: "my-model", thinkingLevel: "medium" });
    expect(view.secretarySession).toMatchObject({ modelId: "my-model" });
    expect(view.apiKey.envVar).toBe("CUSTOM_MODEL_API_KEY");
    expect(view.apiKey.secretFile).toBe("secrets/custom-model-api-key.txt");
    expect((await http.modelKey()).provider.label).toBe("自定义（OpenAI 兼容）");
  });

  test("切回 DeepSeek：自定义那一块留着（以后再选不用重填），模型目录回到 DeepSeek 那两个", async () => {
    const http = new FakeDaemonHttp();
    await save(http, { provider: CUSTOM_PROVIDER_ID, custom: { ...CUSTOM } });
    const back = await save(http, { provider: "deepseek" });
    expect(back.settings.provider).toBe("deepseek");
    expect(back.settings.custom).toEqual(CUSTOM);
    expect(back.models.map((m) => m.modelId)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(back.apiKey.envVar).toBe("DEEPSEEK_API_KEY");
  });

  test("API key 按服务商逐条列出：两个服务商各有自己的状态，存哪个都回那个的", async () => {
    const http = new FakeDaemonHttp();
    const view = await http.modelSettings();
    // 顺序按登记表，各说自己的环境变量和密钥文件
    expect(Object.keys(view.apiKeys)).toEqual(["deepseek", CUSTOM_PROVIDER_ID]);
    expect(view.apiKeys[CUSTOM_PROVIDER_ID]).toMatchObject({ configured: true, envVar: "CUSTOM_MODEL_API_KEY", secretFile: "secrets/custom-model-api-key.txt" });
    expect(view.apiKey).toEqual(view.apiKeys.deepseek);
    // 给"不是当前服务商"的那个填 key 也照样收下（演示页不联网、不真写文件）
    expect((await http.saveModelKey("sk-demo-custom-abcdef", CUSTOM_PROVIDER_ID)).apiKey.envVar).toBe("CUSTOM_MODEL_API_KEY");
    expect((await http.saveModelKey("sk-demo-deepseek-abcdef")).apiKey.envVar).toBe("DEEPSEEK_API_KEY");
  });
});

describe("原型里的连通测试和拉列表", () => {
  test("连通测试：不联网，照假延迟说通了，测的是传进来的那个模型 id", async () => {
    const http = new FakeDaemonHttp();
    const result = await http.testModel({ custom: { ...CUSTOM } });
    expect(result).toMatchObject({ ok: true, modelId: "my-model" });
    expect(result.firstTokenMs).toBe(640);
    expect((await http.testModel({ modelId: "deepseek-v4-pro" })).modelId).toBe("deepseek-v4-pro");
  });

  test("拉列表：回几个编的模型 id（和谁家的都不对应）；没填地址时说一句", async () => {
    const http = new FakeDaemonHttp();
    const result = await http.customModels(CUSTOM.baseUrl);
    expect(result.ok).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(["fake-chat-pro", "fake-chat-mini", "fake-reasoner"]);
    expect(result.models[0]?.name).toBe("Fake Chat Pro");
    const empty = await http.customModels("");
    expect(empty.ok).toBe(false);
    expect(empty.models).toEqual([]);
    expect(empty.error).toContain("还没填接口地址");
  });
});
