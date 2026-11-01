// 设置向导"能力"那一步和组件页的"检查更新"：页面上纯渲染的几块，用 React 在 Node 里渲染出来查——
// - 每项一句它能做什么、要下多大；勾选、进度、失败原因、重试和跳过、跳过后写之后去哪重做；
// - 现在装了什么（版本）；开机自启的开关（不能改的灰着写原因，写明自动拉起哪些服务在服务管家里改）；
// - 组件页查更新那几句：没查过、都是最新的、有新版本（点了才换）、没查成（不是报错），写明查的是哪里、只取版本清单；
// - 英文也有；界面上不出现"秘书""待我处理"。走一遍真页面见 page-opens.test.ts，真守护进程见 daemon 的 setup-capabilities.browser.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { capabilityRows } from "../../src/app/setup-capabilities.ts";
import { AutostartBlock, CapabilityList, type CapabilityListProps, downloadText, InstalledNow } from "../../src/pages/more/CapabilitiesStep.tsx";
import { ComponentUpdates } from "../../src/pages/more/ComponentsPage.tsx";
import { activeLocale, activeLocaleFrom, type AutostartView, type ComponentsView, type ComponentView, type PluginInfo, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));
const noop = () => {};

function component(id: string, extra: Partial<ComponentView> = {}): ComponentView {
  return { id, title: `组件${id}`, summary: `${id} 能做什么`, version: "1.0", state: "missing", default: "ask", defaultText: "问了再装", wanted: false, size: 1024 * 1024 * 570, enables: [], dependsOn: [], sources: [], location: "x", ...extra };
}

function components(over: Record<string, Partial<ComponentView>> = {}): ComponentsView {
  return {
    components: [
      component("bge-m3", { wanted: true, enables: [{ id: "memory.semantic", title: "按意思检索" }], ...over["bge-m3"] }),
      component("audiocpp", { title: "语音程序 audio.cpp", size: 1024 * 1024 * 850, ...over.audiocpp }),
      component("tts", { title: "语音合成模型", size: 1024 * 1024 * 6000, dependsOn: ["audiocpp"], enables: [{ id: "voice.reply", title: "语音回复" }], ...over.tts }),
    ],
    features: [],
    manifest: { release: "0.1.0", signed: false },
    defaultsMissing: [],
  };
}

function plugin(name: string, extra: Partial<PluginInfo> = {}): PluginInfo {
  return { name, title: `插件${name}`, summary: `${name} 的一句话`, state: "running", brings: { tools: [], cards: [], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [], ...extra };
}

function list(view: ComponentsView, plugins: PluginInfo[], over: Partial<CapabilityListProps> = {}) {
  return renderToStaticMarkup(
    createElement(CapabilityList, { rows: capabilityRows(view, plugins), all: view.components, ticked: new Set<string>(), skipped: new Set<string>(), failures: new Map<string, string>(), busy: false, onToggle: noop, onRetry: noop, onSkip: noop, ...over }),
  );
}

describe("能力那一步的列表", () => {
  test("每项一句它能做什么、要下多大；没装的能勾，默认勾的勾着", () => {
    const html = list(components(), [plugin("memory")], { ticked: new Set(["component:bge-m3"]) });
    expect(html).toContain("bge-m3 能做什么");
    expect(html).toContain("要下载 570");
    // 语音合成连程序一起算，写明连同什么
    expect(html).toContain("连同语音程序 audio.cpp");
    expect(html).toMatch(/data-capability="component:bge-m3"[\s\S]*?checked=""/);
    // 没勾的语音合成不是勾着的
    expect(html).not.toMatch(/data-capability="component:tts"><label class="capability-head"><input type="checkbox" aria-label="语音合成模型" checked=""/);
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("运行中的插件、装好的组件：写现在的样子和版本，勾着但点不了，不写要下多大", () => {
    const html = list(components({ "bge-m3": { state: "installed", installedVersion: "4de13258" } }), [plugin("memory")]);
    expect(html).toContain("运行中");
    expect(html).toContain("版本 4de13258");
    expect(html).toMatch(/aria-label="插件memory" disabled="" checked=""/);
    expect(html).toMatch(/aria-label="组件bge-m3" disabled="" checked=""/);
    expect(downloadText(capabilityRows(components(), [plugin("calendar")])[0]!)).toBe("不用下载");
  });

  test("正在下：进度条和已下多少；模型排着队时写先下程序", () => {
    const html = list(
      components({
        "bge-m3": { state: "downloading", progress: { phase: "downloading", done: 100, total: 200, speed: 1024 * 1024, source: "hf-mirror" } },
        tts: { state: "queued" },
        audiocpp: { state: "downloading", progress: { phase: "downloading", done: 50, total: 200 } },
      }),
      [],
    );
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("从 hf-mirror");
    expect(html).toContain("先下语音程序 audio.cpp");
    expect(html).toContain('aria-valuenow="25"');
    // 已经开始了的：勾着、点不了，不再写"要下载"
    expect(html).toMatch(/aria-label="组件bge-m3" disabled="" checked=""/);
    expect(html).not.toContain("要下载");
  });

  test("失败：写原因，有重试和跳过；依赖下不下来的把依赖的原因带上", () => {
    const html = list(components({ tts: { state: "failed", error: "要先装好语音程序" }, audiocpp: { state: "failed", error: "GitHub 连不上" } }), []);
    expect(html).toContain("要先装好语音程序");
    expect(html).toContain("语音程序 audio.cpp：GitHub 连不上");
    expect(html).toContain("重试");
    expect(html).toContain("跳过");
    expect(html).not.toContain("跳过了");
  });

  test("跳过了：不再有按钮，写之后去哪重做", () => {
    const html = list(components({ "bge-m3": { state: "failed", error: "下不下来" } }), [], { skipped: new Set(["component:bge-m3"]) });
    expect(html).toContain("跳过了，之后在设置 · 组件里重做");
    expect(html).not.toContain("重试");
  });

  test("接口拒绝的（没接上服务管家这些）：那一行写原因，能重试能跳过", () => {
    const html = list(components(), [], { failures: new Map([["component:bge-m3", "没接上服务管家"]]) });
    expect(html).toContain("没成：没接上服务管家");
    expect(html).toContain("跳过");
  });

  test("语音模型下好了，服务没起来：写服务的原因；要标注的那句照写", () => {
    const html = list(
      components({
        tts: { state: "installed", installedVersion: "874f", license: { name: "Fish", summary: "s", url: "https://x", confirm: true, accepted: true, attribution: "Built with Fish Audio" } },
        audiocpp: { state: "installed", service: { state: "failed", port: 8090, autostart: false, error: "端口被占着" } },
      }),
      [],
    );
    expect(html).toContain("端口被占着");
    expect(html).toContain("Built with Fish Audio");
  });

  test("没有 N 卡时写明会很慢（语音合成没装时）；已有自己配的写谁提供的", () => {
    expect(list(components({ tts: { note: "没有显卡会很慢" } }), [])).toContain("没有显卡会很慢");
    expect(list(components({ tts: { state: "provided", providedBy: "已有自己配的语音合成，在用它" } }), [])).toContain("已有自己配的语音合成，在用它");
  });
});

describe("现在装了什么", () => {
  test("组件带版本，别处已有的写已有；运行中的插件都列；什么都没有写还没有", () => {
    const html = renderToStaticMarkup(createElement(InstalledNow, { components: components({ "bge-m3": { state: "installed", installedVersion: "4de1" }, tts: { state: "provided" } }), plugins: [plugin("reminders"), plugin("voice", { state: "disabled" })] }));
    expect(html).toContain("组件bge-m3（4de1）");
    expect(html).toContain("语音合成模型（已有，不是从这里装的）");
    expect(html).toContain("插件reminders");
    expect(html).not.toContain("插件voice");
    expect(renderToStaticMarkup(createElement(InstalledNow, { components: components(), plugins: [] }))).toContain("还没有");
  });
});

const block = (view: AutostartView | undefined, over: { failed?: string; saving?: boolean } = {}) => renderToStaticMarkup(createElement(AutostartBlock, { view, failed: over.failed, saving: over.saving ?? false, onChange: noop }));

describe("开机自启的开关", () => {
  const managerUrl = "http://127.0.0.1:7420";

  test("开着、关着：开关能拨，写明自动拉起哪些服务在服务管家里改", () => {
    const on = block({ state: "on", managerUrl });
    expect(on).toContain("开着");
    expect(on).toMatch(/role="switch"[^>]*checked=""/);
    expect(on).not.toMatch(/role="switch"[^>]*disabled=""/);
    expect(on).toContain("http://127.0.0.1:7420");
    expect(on).toContain("ergo svc autostart");
    const off = block({ state: "off", managerUrl });
    expect(off).toContain("关着");
    expect(off).not.toMatch(/role="switch"[^>]*checked=""/);
  });

  test("不能从这里改的（指着别处、源码跑的）：开关灰着，写原因", () => {
    const html = block({ state: "elsewhere", cannotChange: "任务指着别处，这里不动它", managerUrl });
    expect(html).toContain("指着别处的服务管家");
    expect(html).toContain("任务指着别处，这里不动它");
    expect(html).toMatch(/role="switch"[^>]*disabled=""[^>]*checked=""/);
  });

  test("还没取到、正在改：点不了；没改成写原因", () => {
    expect(block(undefined)).toMatch(/role="switch"[^>]*disabled=""/);
    expect(block({ state: "on", managerUrl }, { saving: true })).toMatch(/role="switch"[^>]*disabled=""/);
    expect(block({ state: "on", managerUrl }, { failed: "没改成：拒绝访问" })).toContain("没改成：拒绝访问");
  });
});

describe("组件页的检查更新", () => {
  const where = "https://github.com/catmaniii/ergo/releases/latest/download/components-manifest.json";
  const updates = (over: Partial<NonNullable<ComponentsView["updates"]>>, view = components()) => renderToStaticMarkup(createElement(ComponentUpdates, { view: { ...view, updates: { where, available: [], ...over } } }));

  test("写明查的是哪里、只取版本清单", () => {
    const html = updates({});
    expect(html).toContain(where);
    expect(html).toContain("只取这一份版本清单");
    expect(html).toContain("每晚会自己查一次");
  });

  test("都是最新的、有新版本（写点了才换）", () => {
    expect(updates({ checkedAt: "2026-11-01T04:20:00.000+08:00" })).toContain("都是最新的（11-01 04:20 查的）");
    const html = updates({ checkedAt: "2026-11-01T04:20:00.000+08:00", available: ["bge-m3"] });
    expect(html).toContain("组件bge-m3 有新版本");
    expect(html).toContain("点了「更新」才换");
  });

  test("没查成：只是一句话，不是红字", () => {
    const html = updates({ checkedAt: "2026-11-01T04:20:00.000+08:00", error: "连不上 github.com" });
    expect(html).toContain("这次没查成");
    expect(html).toContain("连不上 github.com");
    expect(html).not.toContain("field-error");
    expect(html).not.toContain('role="alert"');
  });

  test("发布页上还没有这份清单：不写没查成、不写 404，就说这个版本还没有组件更新信息", () => {
    const html = updates({ checkedAt: "2026-11-01T04:20:00.000+08:00", notPublished: true });
    expect(html).toContain("这个版本还没有组件更新信息");
    expect(html).not.toContain("没查成");
    expect(html).not.toContain("404");
    expect(html).not.toContain("field-error");
    // 地址照写
    expect(html).toContain(where);
  });

  test("没接查更新的不显示", () => {
    expect(renderToStaticMarkup(createElement(ComponentUpdates, { view: components() }))).toBe("");
  });
});

describe("英文也有", () => {
  test("列表、现在装了什么、开关、查更新都有英文，不是键名", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = list(components({ tts: { state: "failed", error: "x" } }), [plugin("memory")]);
    expect(html).toContain("Plugins");
    expect(html).toContain("Components");
    expect(html).toContain("to download");
    expect(html).toContain("Skip");
    expect(html).not.toContain("setup.steps");
    expect(renderToStaticMarkup(createElement(InstalledNow, { components: components(), plugins: [] }))).toContain("What&#x27;s installed now");
    const autostart = renderToStaticMarkup(createElement(AutostartBlock, { view: { state: "on", managerUrl: "http://127.0.0.1:7420" }, failed: undefined, saving: false, onChange: noop }));
    expect(autostart).toContain("Start at boot");
    expect(autostart).not.toContain("setup.autostart");
    const check = renderToStaticMarkup(createElement(ComponentUpdates, { view: { ...components(), updates: { where: "https://x", available: [] } } }));
    expect(check).toContain("only fetches this one version list");
  });
});
