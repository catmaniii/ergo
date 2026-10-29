// 模型的 key 那一块（319 号票，设置 · 模型和首次设置向导共用）：用 React 在 Node 里渲染出来查——
// - 现在配没配（小签、来源和说明，没有 key 的内容）；
// - 密码框（type=password、autocomplete 关掉）、"保存 key"；草稿空 / 太短 / 太长时按钮点不了，下面一句说为什么；
// - 失败的原因、保存中；
// - 存好之后显示"已配好"；effective 是 restart 时显示"重启二狗后生效"和怎么重启（安装版是 ergo restart）；
// - 填了 key 点保存发的是 POST（submitModelKey 交给 http.saveModelKey），送过去的是去掉 BOM、换行和首尾空白的那个；
// - 英文也有；界面上不出现"秘书""待我处理"。
// 状态层的说法见 test/state/model-key.test.ts；两块页面里的位置见 pages/setup-wizard.test.ts 和页面打得开的检查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { activeLocale, activeLocaleFrom, type ModelApiKeyStatus, type ModelKeyWriteResult, setActiveLocale } from "../../src/state/index.ts";
import { ModelKeyForm, ModelKeySaved, submitModelKey } from "../../src/ui/model-key.tsx";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};

const apiKey = (configured: boolean): ModelApiKeyStatus => ({ configured, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true });
const result = (effective: "now" | "restart"): ModelKeyWriteResult => ({ configured: true, effective, apiKey: apiKey(true) });

/** 这一块的纯渲染；不加的用没配、空草稿 */
function form(over: Partial<Parameters<typeof ModelKeyForm>[0]> = {}): string {
  return renderToStaticMarkup(createElement(ModelKeyForm, { provider: "DeepSeek", apiKey: apiKey(false), draft: "", saving: false, onDraft: noop, onSave: noop, ...over }));
}

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

describe("现在配没配", () => {
  test("没配：小签写没配置，说明里说去下面填一个（没有 key 的内容）", () => {
    const html = form();
    expect(html).toContain("DeepSeek 的 API key");
    expect(html).toMatch(/class="chip chip-no">没配置/);
    expect(html).toContain("还没有 key");
    expect(html).toContain("secrets/deepseek-api-key.txt");
  });

  test("配了：小签写已配置，说明里说可以换一个", () => {
    const html = form({ apiKey: apiKey(true) });
    expect(html).toMatch(/class="chip chip-ok">已配置/);
    expect(html).toContain("想换一个就在下面填");
  });

  test("还不知道（还没取到状态）：小签写不知道配没配，照样能填", () => {
    const html = form({ apiKey: undefined, provider: undefined });
    expect(html).toContain("模型的 API key");
    expect(html).toContain("不知道配没配");
    expect(html).toContain('type="password"');
  });
});

describe("密码框和保存按钮", () => {
  test("密码框：type=password、autocomplete 关掉、placeholder 有话说", () => {
    const html = form();
    expect(html).toMatch(/<input[^>]*type="password"/);
    // React 19 在服务端渲染时大小写照 props（autoComplete）；HTML 属性名不分大小写，查的时候也不分
    expect(html).toMatch(/<input[^>]*autocomplete="off"/i);
    expect(html).toContain("在这里粘贴 key");
    expect(html).toContain("保存 key");
    expect(html).toContain('type="submit"');
  });

  test("草稿存不了（空、太短、太长）：按钮点不了，下面一句说为什么；保存中按钮也点不了", () => {
    const blocked = form({ blocked: true, note: "太短了：去掉首尾空白后至少要 8 个字符" });
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>保存 key/);
    expect(blocked).toContain("太短了");
    const saving = form({ draft: "sk-web-319-abcdef", saving: true });
    expect(saving).toMatch(/<button[^>]*disabled=""[^>]*>保存中/);
    expect(saving).toMatch(/<input[^>]*disabled=""/);
  });

  test("失败原因写在下面（role=alert），不出现 key 的内容", () => {
    const html = form({ draft: "sk-web-319-abcdef", failed: "太短了：去掉首尾空白后至少要 8 个字符" });
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
  test("发的是 POST（http.saveModelKey），送过去的是去掉 BOM、换行和首尾空白的那个；回什么就当什么", async () => {
    const sent: string[] = [];
    const http = {
      saveModelKey(key: string): Promise<ModelKeyWriteResult> {
        sent.push(key);
        return Promise.resolve(result("now"));
      },
    };
    const saved = await submitModelKey(http, "\uFEFF  sk-web-319-abcdef \r\n");
    expect(sent).toEqual(["sk-web-319-abcdef"]);
    expect(saved).toMatchObject({ configured: true, effective: "now", apiKey: { configured: true } });
  });
});

describe("英文也有，界面文字不出现秘书 / 待我处理", () => {
  test("英文：标题、密码框、按钮、已配好、重启的提示", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = form({ provider: "DeepSeek", draft: "sk-web-319-abcdef" });
    expect(html).toContain("DeepSeek API key");
    expect(html).toContain("Save key");
    expect(html).toContain("Paste the key here");
    expect(renderToStaticMarkup(createElement(ModelKeySaved, { result: result("now") }))).toContain("Configured");
    const restart = renderToStaticMarkup(createElement(ModelKeySaved, { result: result("restart") }));
    expect(restart).toContain("after restarting Ergo");
    expect(restart).toContain("ergo restart");
  });

  test("中文界面上不出现\"秘书\"\"待我处理\"", () => {
    const html = form({ apiKey: apiKey(true), draft: "sk-web-319-abcdef" });
    expect(html).not.toMatch(/秘书|待我处理/);
    expect(renderToStaticMarkup(createElement(ModelKeySaved, { result: result("restart") }))).not.toMatch(/秘书|待我处理/);
  });
});
