// 模型服务商那一块（设置 · 模型和首次设置向导共用）的样子，用 React 在 Node 里渲染出来查——
// - 两个单选按登记表列（DeepSeek、自定义（OpenAI 兼容）），选中的是设置里存的那个或者刚点的那个；
// - 选的是 DeepSeek 时没有自定义那几项；选了自定义才出现接口地址（占位 https://api.openai.com/v1、说明要填到 /v1 这一层）、
//   模型 id（能手填，旁边"拉取列表"）、接口类型（两种，默认 openai-completions）；
// - 诚实的那句提示在自定义块里：换成自定义只换"跑对话的模型"，记忆整理、联网搜索、读网页仍然要 DeepSeek 的 key；
// - 拉到了就变成下拉（现在填的不在列表里时补在第一项），失败 / 存不了的原因原样写出来（role=alert），照样能手填；
// - 2026-10-30 起连通测试不在这一块里了（在 API key 那一块的底部，见 ModelTestBlock）：按钮写"测一下当前服务商"，
//   测的是设置里选中的那个服务商，结果写通不通；这里查它的按钮、结果和"还存着 / 还拉着时不点"；
// - 还没存进设置时那一句；英文也有；界面上不出现"秘书""待我处理"。
// 存之前查什么、下拉里是哪几项见 test/state/model-custom.test.ts；点着走的交互见 page-opens.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { activeLocale, activeLocaleFrom, CUSTOM_PROVIDER_ID, DEFAULT_CUSTOM_PROVIDER_API, type ModelCustomModelsResult, type ModelProviderView, setActiveLocale, t } from "../../src/state/index.ts";
import { ModelProviderForm, ModelTestBlock, submitCustomModels } from "../../src/ui/model-provider.tsx";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};
const DRAFT = { baseUrl: "", modelId: "", api: DEFAULT_CUSTOM_PROVIDER_API } as const;

/** 守护进程给的登记表（名字是守护进程换好的，这里照原样给） */
const providers = (): ModelProviderView[] => [
  { id: "deepseek", label: "DeepSeek" },
  { id: CUSTOM_PROVIDER_ID, label: t("modelSettings.provider.custom") },
];

/** 这一块的纯渲染；不加的用"选着 DeepSeek、自定义还没填" */
function form(over: Partial<Parameters<typeof ModelProviderForm>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ModelProviderForm, {
      providers: providers(),
      provider: "deepseek",
      savedProvider: "deepseek",
      custom: DRAFT,
      listing: false,
      saving: false,
      onPick: noop,
      onCustom: noop,
      onCommit: noop,
      onModelPick: noop,
      onApi: noop,
      onManual: noop,
      onList: noop,
      ...over,
    }),
  );
}

/** 选着自定义、地址填好了的样子 */
const filled = (over: Partial<Parameters<typeof ModelProviderForm>[0]> = {}) =>
  form({ provider: CUSTOM_PROVIDER_ID, savedProvider: CUSTOM_PROVIDER_ID, custom: { baseUrl: "https://api.example.com/v1", modelId: "my-model", api: DEFAULT_CUSTOM_PROVIDER_API }, ...over });

/** 连通测试那一段的纯渲染（设置 · 模型放在 API key 那一块的底部） */
const testBlock = (over: Partial<Parameters<typeof ModelTestBlock>[0]> = {}) => renderToStaticMarkup(createElement(ModelTestBlock, { testing: false, busy: false, onTest: noop, ...over }));

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

describe("服务商那两个单选", () => {
  test("按登记表列两项（DeepSeek、自定义（OpenAI 兼容）），各写一句在服务端调用；选中的是那个", () => {
    const html = form();
    expect(html).toContain("DeepSeek");
    expect(html).toContain("自定义（OpenAI 兼容）");
    expect(html.match(/name="model-provider"/g)).toHaveLength(2);
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="deepseek"/);
    expect(html).toContain("在服务端调用");
    expect(html).toContain("也可以换成自定义（OpenAI 兼容）的服务商");
  });

  test("选着 DeepSeek：没有自定义那几项，也没有连通测试（它在 API key 那一块）", () => {
    const html = form();
    expect(html).not.toContain('name="model-custom-base-url"');
    expect(html).not.toContain('name="model-custom-model-id"');
    expect(html).not.toContain("拉取列表");
    expect(html).not.toContain("测一下当前服务商");
    expect(html).not.toContain("model-test");
  });
});

describe("选了自定义才出现的几项", () => {
  test("接口地址：占位是 https://api.openai.com/v1，说明要填到 /v1 这一层", () => {
    const html = filled();
    expect(html).toMatch(/<input[^>]*name="model-custom-base-url"/);
    expect(html).toContain('placeholder="https://api.openai.com/v1"');
    expect(html).toContain("要填到 /v1 这一层");
    expect(html).toContain('value="https://api.example.com/v1"');
  });

  test("模型 id：能手填，旁边一个\"拉取列表\"；还没拉到时是输入框", () => {
    const html = filled();
    expect(html).toMatch(/<input[^>]*name="model-custom-model-id"/);
    expect(html).toContain("模型 id");
    expect(html).toContain("拉取列表");
    expect(html).not.toMatch(/<select[^>]*aria-label="模型 id"/);
  });

  test("接口类型：两种，默认 openai-completions，能切 openai-responses", () => {
    const html = filled();
    expect(html).toContain("接口类型");
    expect(html).toContain("OpenAI chat completions（/chat/completions）");
    expect(html).toContain("OpenAI responses（/responses）");
    expect(html).toMatch(/<option value="openai-completions"[^>]*selected=""/);
    // 换了一种就选那个
    expect(filled({ custom: { baseUrl: "https://api.example.com/v1", modelId: "my-model", api: "openai-responses" } })).toMatch(/<option value="openai-responses"[^>]*selected=""/);
  });

  test("诚实的提示：换成自定义只换跑对话的模型，记忆整理、联网搜索、读网页仍然要 DeepSeek 的 key", () => {
    const html = filled();
    expect(html).toContain("记忆整理、联网搜索和读网页仍然要用 DeepSeek 的 key");
    // DeepSeek 时不说这句（还没有自定义服务商）
    expect(form()).not.toContain("记忆整理");
  });

  test("还没存进设置（选着自定义、存着 DeepSeek）时写一句；存好了就不写", () => {
    expect(form({ provider: CUSTOM_PROVIDER_ID, savedProvider: "deepseek" })).toContain("自定义这一块还没存进设置");
    expect(filled()).not.toContain("自定义这一块还没存进设置");
  });
});

describe("拉列表和连通测试", () => {
  test("拉到了：模型 id 变成下拉（现在填的不在列表里时补在第一项），并说拉到几个", () => {
    const html = filled({
      models: [
        { id: "model-a", name: "Model A", ownedBy: "fake" },
        { id: "model-b" },
      ],
      listText: "拉到 2 个模型：挑一个，或者接着手填",
    });
    expect(html).toMatch(/<select[^>]*aria-label="模型 id"/);
    expect(html).toContain('<option value="my-model" selected="">my-model</option>');
    expect(html).toContain("Model A（model-a）");
    expect(html).toContain("拉到 2 个模型");
    // 不想挑列表里的，能改回手填
    expect(html).toContain("还是手填");
    expect(html).not.toContain('name="model-custom-model-id"');
  });

  test("列表失败、存不了：原因原样写在 role=alert 里（不另加话）", () => {
    const html = filled({ problem: "列不出这个服务商的模型：401 Unauthorized" });
    expect(html).toMatch(/role="alert"[^>]*>列不出这个服务商的模型：401 Unauthorized</);
    expect(html).not.toMatch(/role="alert"[^>]*>没存成/);
  });

  test("拉取中按钮点不了", () => {
    expect(filled({ listing: true })).toContain("拉取中…");
    expect(filled({ listing: true })).toMatch(/<button[^>]*disabled=""[^>]*>拉取中…/);
  });

  test("连通测试：按钮写\"测一下当前服务商\"，结果写在下面（通不通、首 token）", () => {
    const idle = testBlock();
    expect(idle).toContain("测一下当前服务商");
    expect(idle).not.toContain('role="status"');
    expect(testBlock({ test: { ok: true, modelId: "deepseek-flash", firstTokenMs: 820, totalMs: 1340 } })).toContain("通了：deepseek-flash 首 token 820 毫秒");
    expect(testBlock({ test: { ok: false, modelId: "my-model", totalMs: 0, error: "401 Unauthorized" } })).toContain("不通：my-model：401 Unauthorized");
  });

  test("测着、或者还存着 / 还拉着的时候按钮点不了", () => {
    expect(testBlock({ testing: true })).toContain("测试中…");
    expect(testBlock({ testing: true })).toMatch(/<button[^>]*disabled=""[^>]*>测试中…/);
    expect(testBlock({ busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>测一下当前服务商/);
    expect(testBlock()).not.toMatch(/<button[^>]*disabled=""/);
  });

  test("点\"拉取列表\"发的是接口地址（key 不在请求体里）", async () => {
    const sent: (string | undefined)[] = [];
    const http = {
      customModels(baseUrl?: string): Promise<ModelCustomModelsResult> {
        sent.push(baseUrl);
        return Promise.resolve({ ok: true, models: [{ id: "model-a" }] });
      },
    };
    // 地址末尾的斜杠、首尾空白先收拾掉，和存进设置的是同一个
    const result = await submitCustomModels(http, { baseUrl: "  https://api.example.com/v1/  ", modelId: "my-model", api: DEFAULT_CUSTOM_PROVIDER_API });
    expect(sent).toEqual(["https://api.example.com/v1"]);
    expect(result.models.map((m) => m.id)).toEqual(["model-a"]);
  });
});

describe("英文也有，界面文字不出现秘书 / 待我处理", () => {
  test("英文：服务商、接口地址、模型 id、拉取列表、接口类型、诚实的那句、连通测试", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = filled({ providers: providers() });
    expect(html).toContain("Model provider");
    expect(html).toContain("Called from the server");
    expect(html).toContain("Endpoint URL");
    expect(html).toContain("Include the /v1 part");
    expect(html).toContain("Model id");
    expect(html).toContain("Fetch list");
    expect(html).toContain("API style");
    expect(html).toContain("OpenAI chat completions");
    expect(html).toContain("still need a DeepSeek key");
    expect(testBlock()).toContain("Test the current provider");
    // 这个块里没有中文（服务商名字是登记表给的，也已经是英文）
    expect(html).not.toMatch(/[　-〿一-鿿！-｠]/);
    expect(testBlock()).not.toMatch(/[　-〿一-鿿！-｠]/);
  });

  test("中文界面上不出现\"秘书\"\"待我处理\"", () => {
    expect(filled()).not.toMatch(/秘书|待我处理/);
    expect(form()).not.toMatch(/秘书|待我处理/);
    expect(testBlock()).not.toMatch(/秘书|待我处理/);
  });
});
