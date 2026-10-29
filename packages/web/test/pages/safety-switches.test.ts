// 设置 · 关注类别最上面的两个开关（315 号票，pages/more/SafetySwitches.tsx）：有风险的事先问我、任务超预算就停下。
// 每个开关一行：标题、下面一句开着 / 关掉各会怎样（写明改了马上生效），勾着跟着守护进程给的；还没取到时点不了。
// 界面上不出现"秘书""待我处理"（43 号票的规矩）；英文也有。用 React 在 Node 里渲染出来查。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SAFETY_SWITCHES, SafetySwitchList } from "../../src/pages/more/SafetySwitches.tsx";
import { activeLocale, activeLocaleFrom, setActiveLocale, type SafetySettingsView, t } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const render = (view: SafetySettingsView | undefined, failed?: string) => renderToStaticMarkup(createElement(SafetySwitchList, { view, failed, saving: false, onChange: () => {} }));
const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

describe("安全和预算的两个开关", () => {
  test("两行：标题、开着 / 关掉各会怎样、改了马上生效；勾着跟着守护进程给的", () => {
    const html = render({ conversationApprovals: true, budgetControl: false });
    expect(html).toContain("安全和预算");
    expect(html).toContain("有风险的事先问我");
    expect(html).toContain("开着：对话里要做有风险的事");
    expect(html).toContain("关掉：这些大多直接做");
    expect(html).toContain("任务超预算就停下");
    expect(html).toContain("超过两倍就停下等你");
    expect(html.match(/改了马上生效/g)).toHaveLength(2);
    expect(html).toMatch(/data-switch="conversationApprovals".*?checked=""/s);
    expect(html).not.toMatch(/data-switch="budgetControl"[^>]*>.*?checked=""/s);
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("还没取到：两个都点不了；取不到时写原因", () => {
    const html = render(undefined, t("pages.safety.loadFailed", { reason: "连不上" }));
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("读不到这两个开关：连不上");
  });

  test("英文也有", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = render({ conversationApprovals: false, budgetControl: true });
    expect(html).toContain("Ask me before risky things");
    expect(html).toContain("Stop tasks that go over budget");
    for (const s of SAFETY_SWITCHES) expect(t(s.on)).not.toBe(s.on);
  });
});
