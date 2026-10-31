// 模型的 key 那一块（319 号票，设置 · 模型和首次设置向导共用；2026-10-30 起按服务商逐条列出）：用 React 在 Node 里渲染出来查——
// - 一个服务商一行（顺序按登记表）：它的名字、配没配（小签、来源和说明，没有 key 的内容）、一个密码框和"保存 key"；
// - 换 key 不用先把它选成当前服务商：每一行各自有输入框和保存按钮，某一行的按钮点不了不影响别的行；
// - 密码框（type=password、autocomplete 关掉）；草稿空 / 太短 / 太长时按钮点不了，下面一句说为什么；
// - 失败的原因、保存中（只有那一行在存）；
// - 存好之后显示"已配好"；effective 是 restart 时显示"重启二狗后生效"和怎么重启（安装版是 ergo restart）；
// - 填了 key 点保存发的是 POST（submitModelKey 交给 http.saveModelKey），送过去的是去掉 BOM、换行和首尾空白的那个 key，
//   以及这一行的服务商（给"另一个服务商"填 key 用）；
// - 英文也有；界面上不出现"秘书""待我处理"。
// 状态层的说法见 test/state/model-key.test.ts；两块页面里的位置见 page-opens.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { activeLocale, activeLocaleFrom, CUSTOM_PROVIDER_ID, type ModelApiKeyStatus, type ModelKeyWriteResult, type ModelProviderView, setActiveLocale, t } from "../../src/state/index.ts";
import { ModelKeyForm, ModelKeySaved, submitModelKey, type ModelKeyRow } from "../../src/ui/model-key.tsx";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};

/** 守护进程给的登记表（名字是守护进程换好的） */
const PROVIDERS: ModelProviderView[] = [
  { id: "deepseek", label: "DeepSeek" },
  { id: CUSTOM_PROVIDER_ID, label: t("modelSettings.provider.custom") },
];

const apiKey = (configured: boolean, provider = "deepseek"): ModelApiKeyStatus =>
  provider === CUSTOM_PROVIDER_ID
    ? { configured, envVar: "CUSTOM_MODEL_API_KEY", secretFile: "secrets/custom-model-api-key.txt", lsm: true }
    : { configured, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true };
const result = (effective: "now" | "restart"): ModelKeyWriteResult => ({ configured: true, effective, apiKey: apiKey(true) });

/** 按服务商逐条列出的纯渲染；rows 给哪几行就画哪几行 */
function render(rows: readonly ModelKeyRow[]): string {
  return renderToStaticMarkup(createElement(ModelKeyForm, { rows, onDraft: noop, onSave: noop }));
}

/** 两个服务商各一行（都还没配、草稿是空的）；要改哪一行给哪个服务商 */
const both = (over: Partial<Record<string, Partial<ModelKeyRow>>> = {}): string =>
  render(PROVIDERS.map((provider) => ({ provider, draft: "", saving: false, ...over[provider.id] })));

/** 只有一个服务商那一行（查它自己的密码框、按钮和状态，不被另一行干扰） */
const only = (provider: ModelProviderView, over: Partial<ModelKeyRow> = {}): string => render([{ provider, draft: "", saving: false, ...over }]);
const deepseek = PROVIDERS[0]!;
const custom = PROVIDERS[1]!;

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

describe("按服务商逐条列出", () => {
  test("每个服务商一行（顺序按登记表），各有一个密码框和一个保存按钮", () => {
    const html = both();
    expect(html.match(/class="model-key-setting"/g)).toHaveLength(2);
    expect(html).toContain('data-provider="deepseek"');
    expect(html).toContain('data-provider="custom"');
    expect(html.match(/name="model-api-key"/g)).toHaveLength(2);
    expect(html.match(/保存 key/g)).toHaveLength(2);
    // 名字各写各的（两行的标题不一样），deepseek 那一行排在前面
    expect(html).toContain("DeepSeek 的 API key");
    expect(html).toContain("自定义（OpenAI 兼容）的 API key");
    expect(html.indexOf("DeepSeek 的 API key")).toBeLessThan(html.indexOf("自定义（OpenAI 兼容）的 API key"));
  });

  test("给别的服务商填 key 不用先切过去：两行各自能填、能存", () => {
    const html = both({ custom: { apiKey: apiKey(false, CUSTOM_PROVIDER_ID), draft: "sk-custom-abcdef" } });
    expect(html).toMatch(/<input[^>]*data-provider="custom"[^>]*value="sk-custom-abcdef"/);
    expect(html).toMatch(/<input[^>]*data-provider="deepseek"[^>]*value=""/);
  });
});

describe("现在配没配", () => {
  test("没配：小签写没配置，说明里说去下面填一个（没有 key 的内容）", () => {
    const html = only(deepseek, { apiKey: apiKey(false) });
    expect(html).toMatch(/class="chip chip-no">没配置/);
    expect(html).toContain("还没有 key");
    expect(html).toContain("secrets/deepseek-api-key.txt");
  });

  test("配了：小签写已配置，说明里说可以换一个", () => {
    const html = only(deepseek, { apiKey: apiKey(true) });
    expect(html).toMatch(/class="chip chip-ok">已配置/);
    expect(html).toContain("想换一个就在下面填");
  });

  test("自定义那一行说它自己的环境变量和文件", () => {
    const html = only(custom, { apiKey: apiKey(true, CUSTOM_PROVIDER_ID) });
    expect(html).toContain("CUSTOM_MODEL_API_KEY");
    expect(html).toContain("secrets/custom-model-api-key.txt");
    expect(html).not.toContain("DEEPSEEK_API_KEY");
  });

  test("还不知道（还没取到状态）：小签写不知道配没配，照样能填", () => {
    const html = only(deepseek, { apiKey: undefined });
    expect(html).toContain("DeepSeek 的 API key");
    expect(html).toContain("不知道配没配");
    expect(html).toContain('type="password"');
  });
});

describe("密码框和保存按钮", () => {
  test("密码框：type=password、autocomplete 关掉、placeholder 有话说", () => {
    const html = both();
    expect(html).toMatch(/<input[^>]*type="password"/);
    // React 19 在服务端渲染时大小写照 props（autoComplete）；HTML 属性名不分大小写，查的时候也不分
    expect(html).toMatch(/<input[^>]*autocomplete="off"/i);
    expect(html).toContain("在这里粘贴 key");
    expect(html).toContain('type="submit"');
  });

  test("草稿太短：那一行的按钮点不了、下面一句说为什么；填好了的另一行照样点得了（空草稿的也点不了）", () => {
    const short = both({ deepseek: { draft: "sk-短" }, custom: { draft: "sk-custom-abcdef" } });
    expect(short).toContain("太短了");
    // 两行都有一个保存按钮，只有填好那一行的能点
    expect(short.match(/>保存 key</g)).toHaveLength(2);
    expect(short.match(/<button[^>]*disabled=""[^>]*>保存 key/g)).toHaveLength(1);
  });

  test("只有正在存的那一行点不了、写保存中；另一行不受影响", () => {
    const html = both({ deepseek: { draft: "sk-web-319-abcdef", saving: true } });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存中/);
    expect(html).toMatch(/<input[^>]*data-provider="deepseek"[^>]*disabled=""/);
    expect(html).toMatch(/<input[^>]*data-provider="custom"[^>]*value=""/);
    expect(html).not.toMatch(/<input[^>]*data-provider="custom"[^>]*disabled=""/);
  });

  test("失败原因写在那一行下面（role=alert），不出现 key 的内容", () => {
    const html = both({ custom: { draft: "sk-web-319-abcdef", failed: "太短了：去掉首尾空白后至少要 8 个字符" } });
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain("没存成：太短了");
  });
});

describe("存好之后", () => {
  test("显示已配好、不用重启；不出现 key 的内容", () => {
    const html = renderToStaticMarkup(createElement(ModelKeySaved, { result: result("now") }));
    expect(html).toContain("已配好");
    expect(html).toContain("下一个新会话");
    expect(html).toMatch(/role="status"/);
    expect(html).not.toContain("sk-");
  });

  test("effective 是 restart：显示重启二狗后生效，另外一句写怎么重启（安装版是 ergo restart）", () => {
    const html = renderToStaticMarkup(createElement(ModelKeySaved, { result: result("restart") }));
    expect(html).toContain("重启二狗后生效");
    expect(html).toContain("ergo restart");
  });
});

describe("填了 key 点保存", () => {
  test("发的是 POST（http.saveModelKey），送过去的是去掉 BOM、换行和首尾空白的 key 和这一行的服务商", async () => {
    const sent: Array<[string, string | undefined]> = [];
    const http = {
      saveModelKey(key: string, provider?: string): Promise<ModelKeyWriteResult> {
        sent.push([key, provider]);
        return Promise.resolve(result("now"));
      },
    };
    const saved = await submitModelKey(http, "\uFEFF  sk-web-319-abcdef \r\n", CUSTOM_PROVIDER_ID);
    expect(sent).toEqual([["sk-web-319-abcdef", CUSTOM_PROVIDER_ID]]);
    expect(saved).toMatchObject({ configured: true, effective: "now", apiKey: { configured: true } });
    // 不给服务商时请求里就没有这一项（守护进程照选中的那个写）
    await submitModelKey(http, "sk-web-319-abcdef");
    expect(sent[1]).toEqual(["sk-web-319-abcdef", undefined]);
  });
});

describe("英文也有，界面文字不出现秘书 / 待我处理", () => {
  test("英文：两行的标题、密码框、按钮、已配好、重启的提示", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    // 登记表的名字是守护进程换好的：英文下自定义那一项也换成英文的
    const providers: ModelProviderView[] = [
      { id: "deepseek", label: "DeepSeek" },
      { id: CUSTOM_PROVIDER_ID, label: t("modelSettings.provider.custom") },
    ];
    const html = render(providers.map((provider) => ({ provider, apiKey: apiKey(false, provider.id), draft: "sk-web-319-abcdef", saving: false })));
    expect(html).toContain("DeepSeek API key");
    expect(html).toContain("Save key");
    expect(html).toContain("Paste the key here");
    expect(html).not.toMatch(/[　-〿一-鿿！-｠]/);
    expect(renderToStaticMarkup(createElement(ModelKeySaved, { result: result("now") }))).toContain("Configured");
    const restart = renderToStaticMarkup(createElement(ModelKeySaved, { result: result("restart") }));
    expect(restart).toContain("after restarting Ergo");
    expect(restart).toContain("ergo restart");
  });

  test("中文界面上不出现\"秘书\"\"待我处理\"", () => {
    const html = both({ deepseek: { apiKey: apiKey(true), draft: "sk-web-319-abcdef" } });
    expect(html).not.toMatch(/秘书|待我处理/);
    expect(renderToStaticMarkup(createElement(ModelKeySaved, { result: result("restart") }))).not.toMatch(/秘书|待我处理/);
  });
});
