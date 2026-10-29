// 首次设置向导（319 号票）页面上纯渲染的几块，用 React 在 Node 里渲染出来查——
// - 步骤那一排：五步都列出来（再加上"外网访问"那一屏），做完的打勾、当前的突出，点了交给外面；
// - 一屏底下那一排："以后再说"（skip: true）和"这一步就这样"（安全默认值那一步是"看过了"），打标记的时候点不了；
// - 全部做完那一屏："设置完了，去用它吧"和回到会话页的按钮（按钮上写的是用户给助手起的名字）；
// - 外网访问那一屏：三种方式的地址和"只接 8811、8810 别接出去"那句；
// - 英文也有；界面上不出现"秘书""待我处理"（43 号票的规矩）。
// 现在该显示哪一屏、演示页的假状态、请求体的写法见 test/app/setup.test.ts；页面打得开见 page-opens.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { pageSetupBanner, setupPrototypePage } from "../../src/app/page-setup.ts";
import { demoSetupView, setupMarkBody, setupScreenOf } from "../../src/app/setup.ts";
import { SetupActions, SetupDone, SetupExternal, SetupRail } from "../../src/pages/SetupWizard.tsx";
import { activeLocale, activeLocaleFrom, SETUP_STEPS, type SetupStepId, type SetupStepView, type SetupView, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};

/** 一份五步的状态：done 写哪几步做完了 */
function view(done: readonly SetupStepId[] = [], ready: readonly SetupStepId[] = []): SetupView {
  const steps = SETUP_STEPS.map((id) => ({ id, done: done.includes(id), ready: ready.includes(id), optional: true }));
  return { steps, complete: steps.every((step) => step.done) };
}

const stepOf = (done: SetupStepId = "model"): SetupStepView => ({ id: done, done: false, ready: false, optional: true });

const rail = (state: SetupView, at: SetupStepId | "external" | undefined) => renderToStaticMarkup(createElement(SetupRail, { view: state, screen: setupScreenOf(state, at), onPick: noop }));
const actions = (step: SetupStepView, busy = false) => renderToStaticMarkup(createElement(SetupActions, { step, busy, onMark: noop }));
const done = (name: string) => renderToStaticMarkup(createElement(SetupDone, { name, onFinish: noop, onExternal: noop }));

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

describe("步骤那一排", () => {
  test("五步都渲染出来（做完的打勾、当前的突出），最后是外网访问那一屏", () => {
    const html = rail(view(["language"]), undefined);
    // 假 view 下五步的名字都在
    for (const title of ["语言、称呼、助手名", "模型 Key", "组件（记忆的向量模型）", "手机配对", "安全默认值"]) expect(html).toContain(title);
    expect(html).toContain("外网访问");
    // 五步 + 外网访问，一项一个按钮
    expect(html.match(/data-step=/g)).toHaveLength(6);
    for (const id of [...SETUP_STEPS, "external"]) expect(html).toContain(`data-step="${id}"`);
    // 做完的打勾，没做完的写序号
    expect(html).toMatch(/<button[^>]*class="setup-rail-item done"[^>]*data-step="language"/);
    expect(html).toContain("✓");
    expect(html).toMatch(/data-step="model"[^>]*><span class="setup-rail-mark" aria-hidden="true">2</);
  });

  test("当前那一项突出、标 aria-current；点了某一步就是那一项", () => {
    const first = rail(view(), undefined);
    expect(first).toMatch(/data-step="language"[^>]*aria-current="step"/);
    const picked = rail(view(["language"]), "phone");
    expect(picked).toMatch(/data-step="phone"[^>]*aria-current="step"/);
    // 外网访问也点得进去
    expect(rail(view(), "external")).toMatch(/data-step="external"[^>]*aria-current="step"/);
    // 只剩一个 current（做完了的那一步不算）
    expect(first.match(/aria-current="step"/g)).toHaveLength(1);
    // 做完了的打勾，也就不再是 current
    expect(picked).toMatch(/<button[^>]*class="setup-rail-item done"[^>]*data-step="language"/);
  });

  test("还认得演示页的假状态（五步都没做完）", () => {
    const html = rail(demoSetupView(), "external");
    expect(html.match(/data-step=/g)).toHaveLength(6);
    expect(html).not.toContain("✓");
  });
});

describe("一屏底下那一排", () => {
  test("\"以后再说\"和\"这一步就这样\"：两个按钮，一个 skip 一个不 skip", () => {
    const html = actions(stepOf("model"));
    expect(html).toContain("以后再说");
    expect(html).toContain("这一步就这样");
    expect(html.match(/<button/g)).toHaveLength(2);
    // 点哪一个是 skip、哪一个不是（请求体由 test/app/setup.test.ts 的 setupMarkBody 定）
    expect(setupMarkBody("model", true)).toEqual({ step: "model", skip: true });
    expect(setupMarkBody("model", false)).toEqual({ step: "model", skip: false });
  });

  test("安全默认值那一步是\"看过了\"（点它才算做完）", () => {
    expect(actions(stepOf("safety"))).toContain("看过了");
    expect(actions(stepOf("safety"))).not.toContain("这一步就这样");
  });

  test("打标记的时候两个都点不了", () => {
    expect(actions(stepOf("model"), true).match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("全部做完那一屏", () => {
  test("全部做完（含点过以后再说）时那一屏是\"设置完了\"，写着那一句和回到会话页的按钮", () => {
    const all = view([...SETUP_STEPS]);
    expect(setupScreenOf(all, undefined)).toEqual({ kind: "done" });

    const html = done("二狗");
    expect(html).toContain("设置完了，去用它吧");
    // 按钮上是用户给助手起的名字（不是"秘书"）
    expect(html).toContain("回到");
    expect(html).toContain("二狗");
    // 还留一个去外网访问那一屏的入口，一个"设置完了"的回到会话页的按钮
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toMatch(/秘书|待我处理/);
  });
});

describe("外网访问那一屏", () => {
  test("三种方式各写一句和地址（Tailscale 推荐、自建 Headscale、VPS 隧道）", () => {
    const html = renderToStaticMarkup(createElement(SetupExternal, {}));
    expect(html).toContain("Tailscale");
    expect(html).toContain("Headscale");
    expect(html).toContain("nginx");
    expect(html.match(/class="setup-address"/g)).toHaveLength(3);
    expect(html).toContain("ts.net");
    expect(html).toContain("sslip.io");
    // 只接外网端口，本机端口不能接出去
    expect(html).toContain("8811");
    expect(html).toContain("8810");
    // 这一版不自动配置：没有按钮
    expect(html).not.toContain("<button");
  });
});

describe("英文也有", () => {
  test("步骤、按钮、设置完了、外网访问都有英文，不是键名", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const english = rail(view(["language"]), undefined);
    expect(english).toContain("Language, how to call you, assistant name");
    expect(english).toContain("Access from outside");
    expect(actions(stepOf("model"))).toContain("Later");
    expect(actions(stepOf("model"))).toContain("This is fine");
    expect(done("Ergo")).toContain("Setup is done");
    expect(renderToStaticMarkup(createElement(SetupExternal, {}))).toContain("Way one: Tailscale");
  });
});

describe("首页那条引导条在这台设备上的记号", () => {
  test("Node 里不算演示页；存储用不了（Node 里没有 window）时按没关过，页面上那一份只有一个", () => {
    expect(setupPrototypePage()).toBe(false);
    expect(pageSetupBanner()).toBe(pageSetupBanner());
    expect(pageSetupBanner().dismissed()).toBe(false);
    expect(() => pageSetupBanner().dismiss()).not.toThrow();
  });
});
