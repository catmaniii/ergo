// 336 号票：记忆的三个开关从"设置"搬进"记忆"页，这套记忆系统也有了名字（「会意」/ Subtext）。这里查四件事：
// - 设置列表最下面不再有记忆那一节（记忆插件不再登记 settingsSections，owns 里也没有）；
// - 记忆页标题下面一行写着「会意 · 从你说过的话里推断你真正想要的」，标题还是"记忆"（导航那一项不改）；
// - 记忆页最下面一块"会意 · 设置"（在四栏和数据源之后），默认收起；展开里三个开关都在，勾着跟着守护进程给的、还没取到时点不了、
//   取不到时写原因；
// - 拨一下发的是 PUT /api/memory/settings（只带拨的那一项，266 号票的规矩），话里说改了会怎样；英文也有。
// 记忆插件停用时整页（连同这块）都不出现，见下面最后一条；记忆页本身的地址、旧地址换新见 plugins/memory-page.test.ts。
import fs from "node:fs";
import path from "node:path";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import { type DaemonHttp, HttpDaemonClient } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { MEMORY_SWITCHES, MemorySwitchList, saveMemorySetting } from "../../src/plugins/memory/MemorySettingsSection.tsx";
import { MemorySection } from "../../src/plugins/memory/MemoryPage.tsx";
import { MEMORY_SYSTEM_NAME, memorySystemSettingsTitle, memorySystemTagline } from "../../src/plugins/memory/system.ts";
import { activeLocale, activeLocaleFrom, type MemorySettingsBody, type MemorySettingsView, replay, setActiveLocale, t, type UiInput } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};
const SETTINGS: MemorySettingsView = { memoryBrief: true, wovenQuestions: true, interviewInvites: true };

const load = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../state/recordings", `${name}.json`), "utf8")) as UiInput[];

/** 按真守护进程报的状况装好的网页插件宿主；不给录音是还没收到状况（全开） */
function assembled(recording?: string) {
  const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
  host.apply(recording === undefined ? undefined : replay(load(recording)).pluginStatus?.plugins);
  return host;
}

type Host = ReturnType<typeof assembled>;

/** 不连线的 StoreProvider（渲染时不跑副作用，连接、HTTP 都用不到） */
const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;
const inStore = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(StoreProvider, offline, child));
/** 记忆页（竖屏：首页整页） */
const memoryPage = () => inStore(createElement(MemorySection, { wide: false, navigate: noop }));
/** 三个开关那几行（纯渲染，view 没给是还没取到） */
const switchRows = (view: MemorySettingsView | undefined, failed?: string) =>
  renderToStaticMarkup(createElement(MemorySwitchList, { view, failed, saving: false, onChange: noop }));
/** 一行开关渲染出来的那一段（从它的 data-switch 到这行的 </label>） */
const rowOf = (html: string, key: string) => html.slice(html.indexOf(`data-switch="${key}"`)).split("</label>")[0]!;

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

describe("设置列表里不再有记忆那一节", () => {
  test("记忆插件不登记设置分节：设置列表最下面没有记忆的三个开关（也不再进 owns）", () => {
    const host = assembled();
    expect(host.list("settingsSections")).toEqual([]);
    expect(WEB_PLUGIN_MANIFEST.find((p) => p.name === "memory")?.owns?.settingsSections).toBeUndefined();
  });
});

describe("记忆页：标题下面一行写着这套记忆系统的名字", () => {
  test("「会意 · 从你说过的话里推断你真正想要的」；标题栏还是\"记忆\"（导航那一项不改）", () => {
    const html = memoryPage();
    expect(html).toContain('data-system="memory"');
    expect(html).toContain("会意 · 从你说过的话里推断你真正想要的");
    expect(html).toContain('<div class="title">记忆');
    // 名字从多语言里来（中文「会意」、英文 Subtext），不是写死的
    expect(t(MEMORY_SYSTEM_NAME)).toBe("会意");
    expect(memorySystemTagline()).toBe("会意 · 从你说过的话里推断你真正想要的");
  });

  test("英文：Subtext · Works out what you really want from what you've said", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(t(MEMORY_SYSTEM_NAME)).toBe("Subtext");
    expect(memorySystemTagline()).toBe("Subtext · Works out what you really want from what you've said");
    // 服务端渲染会把撇号写成 &apos; 一类的实体，比的时候照它写
    expect(memoryPage()).toContain("Subtext · Works out what you really want from what you&#x27;ve said");
    expect(memorySystemSettingsTitle()).toBe("Subtext · Settings");
  });
});

describe("记忆页最下面那块\"会意 · 设置\"", () => {
  test("在四栏和数据源之后，默认收起：小标题、下面一句写清里面是哪三个，▸、没有开关", () => {
    const html = memoryPage();
    expect(html).toContain('data-block="memory-settings"');
    expect(html).toContain("会意 · 设置");
    expect(html).toContain("每条消息带简报、顺口问「了解你」、每周约访谈");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("▸");
    expect(html).not.toContain('role="switch"');
    // 排在最下面：四栏、数据源之后
    expect(html.indexOf('data-block="memory-settings"')).toBeGreaterThan(html.indexOf("memory-layers"));
    expect(html.indexOf('data-block="memory-settings"')).toBeGreaterThan(html.indexOf('data-page="data-sources"'));
  });

  test("三个开关都在：每条消息带简报、顺口问、每周约访谈，勾着跟着守护进程给的", () => {
    const html = switchRows({ memoryBrief: true, wovenQuestions: false, interviewInvites: true });
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html.match(/ class="mem-setting-switch"/g)).toHaveLength(3);
    expect(html.match(/data-switch="[a-zA-Z]+"/g)).toEqual(['data-switch="memoryBrief"', 'data-switch="wovenQuestions"', 'data-switch="interviewInvites"']);
    expect(html).toContain("每条消息自动带上相关记忆");
    expect(html).toContain("在对话里顺口问");
    expect(html).toContain("每周约一次了解你访谈");
    expect(rowOf(html, "memoryBrief")).toContain('checked=""');
    expect(rowOf(html, "wovenQuestions")).not.toContain('checked=""');
    expect(rowOf(html, "interviewInvites")).toContain('checked=""');
  });

  test("还没取到：三个都点不了（但照默认勾着）；读不到时第一行下面写原因", () => {
    const loading = switchRows(undefined);
    expect(loading.match(/disabled=""/g)).toHaveLength(3);
    expect(loading.match(/checked=""/g)).toHaveLength(3);
    expect(switchRows(undefined, t("pages.memorySettings.loadFailed", { reason: "连不上" }))).toContain("读不到记忆的设置：连不上");
  });

  test("每个开关的标题、小字、读屏名字、拨开拨关的话都有英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    for (const s of MEMORY_SWITCHES) {
      for (const key of [s.title, s.sub, s.label, s.on, s.off]) expect(t(key)).not.toBe(key);
    }
    const html = switchRows(SETTINGS);
    expect(html).toContain("Bring related memories with each message");
    expect(html).toContain("Ask in passing during chats");
    expect(html).toContain("Weekly get-to-know interview");
  });
});

describe("拨一下：PUT /api/memory/settings，只带拨的那一项", () => {
  test("交给 http.saveMemorySettings 的只有拨的那一项；回什么就当什么（266 号票的规矩）", async () => {
    const sent: MemorySettingsBody[] = [];
    const http = {
      saveMemorySettings(body: MemorySettingsBody): Promise<MemorySettingsView> {
        sent.push(body);
        return Promise.resolve({ ...SETTINGS, memoryBrief: false });
      },
    };
    const next = await saveMemorySetting(http, "memoryBrief", false);
    expect(sent).toEqual([{ memoryBrief: false }]);
    expect(next.memoryBrief).toBe(false);
  });

  test("真的发出去的是 PUT /api/memory/settings，body 就是那一项", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const view: MemorySettingsView = { ...SETTINGS, interviewInvites: false };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      expect(await saveMemorySetting(new HttpDaemonClient(""), "interviewInvites", false)).toEqual(view);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/memory/settings");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect(calls[0]!.init?.body).toBe('{"interviewInvites":false}');
  });
});

describe("记忆插件停用时整页和设置块都不出现", () => {
  test("配置里停用记忆（录下的事件流）：页面插槽里没有记忆，设置分节也没有", () => {
    const host: Host = assembled("plugins-memory-off");
    expect(host.list("pages").map((p) => p.id)).not.toContain("memory");
    expect(host.list("settingsSections")).toEqual([]);
    // 停用时那块设置跟着整页一起没了：MemorySection 只由记忆插件登记的那一页画（见 App / MorePage 的插件页面）
    expect(host.unavailable("settingsSections", "memory")).toBeUndefined();
  });
});
