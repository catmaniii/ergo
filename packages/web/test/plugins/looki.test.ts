// Looki 插件的网页这一半（296 号票）：设置 · 数据源里 Looki 下面的设置那一块（dataSources 插槽）。
// - 按真守护进程报的状况装（录下的事件流里 Looki 在运行）：插槽里有 looki；停用了插槽里没有，位置交回"Looki"；
// - 那一块渲染出来（Node 里直接渲染纯组件）：没连时默认中国区、Key 是密码框、按钮"测试连接并保存"；连着时区域不预选（沿用）、
//   Key 框写"已存好"、没填 Key 时按钮是"再测一次"；说明里写 Key 在哪建、只存在这台电脑上、导入到昨天为止、照片视频不导入；
// - 测试连接回来说一句：连着且没有问题是"连上了"，否则写原因；界面文字里没有"秘书""待我处理"；
// - 307 号票"存一份到本地"那一块：开关、位置（默认位置的小签、打开文件夹、改位置）、存哪几类、已存多少、正在存 / 限速在等、停下的原因和
//   现在接着存、补存的日期和进度（开始 / 停下 / 接着补）、说明（不进记忆和备份、断开不删、改位置不搬）；补存默认最近 30 天到昨天。
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { archiveOf, backfillLine, defaultRange, LookiArchiveBlock, type LookiArchiveBlockProps, savedLine, workingLine } from "../../src/plugins/looki/LookiArchive.tsx";
import { LookiPanelView, type LookiPanelViewProps, resultOf } from "../../src/plugins/looki/LookiPanel.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { type DataSourcesView, type DataSourceView, type LookiArchiveView, replay, type UiInput } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const load = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../state/recordings", `${name}.json`), "utf8")) as UiInput[];
const noop = () => {};

function looki(extra: Partial<DataSourceView> = {}): DataSourceView {
  return {
    id: "looki",
    title: "Looki",
    summary: "挂脖相机每天的时刻",
    plugin: "looki",
    pluginTitle: "Looki",
    available: true,
    connection: "not_connected",
    usages: [
      { usage: "query", on: true },
      { usage: "import", on: true },
    ],
    sensitive: [],
    count: 0,
    syncing: false,
    canSync: false,
    files: [],
    configurable: true,
    ...extra,
  };
}

/** 只有这一个数据源的整页 */
const view = (s: DataSourceView): DataSourcesView => ({ sources: [s], folder: { path: "x", importedPath: "x/imported", pending: [], recent: [] } });

const render = (props: Partial<LookiPanelViewProps> = {}) =>
  renderToStaticMarkup(createElement(LookiPanelView, { source: looki(), region: "cn", keyText: "", busy: false, result: undefined, onRegion: noop, onKey: noop, onSubmit: noop, ...props }));

describe("按真守护进程报的状况装", () => {
  test("录下的事件流里 Looki 在运行：设置 · 数据源的插槽里有 looki（归 Looki 插件）", () => {
    const state = replay(load("plugins-memory-off"));
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    host.apply(state.pluginStatus?.plugins);
    expect(host.running("looki")).toBe(true);
    expect(host.list("dataSources").map((e) => e.id)).toEqual(["phone-contacts", "phone-calendar", "phone-photos", "phone-location", "google-calendar", "google-gmail", "google-contacts", "looki"]);
    expect(host.ownerOf("dataSources", "looki")?.name).toBe("looki");
  });

  test("Looki 停用了：插槽里没有，位置交回\"Looki\"（数据源页那一行写没启用、不画这一块）", () => {
    const state = replay(load("plugins-memory-off"));
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    host.apply(state.pluginStatus!.plugins.map((p) => (p.name === "looki" ? { ...p, state: "disabled" as const } : p)));
    expect(host.get("dataSources", "looki")).toBeUndefined();
    expect(host.unavailable("dataSources", "looki")).toBe("Looki");
    expect(host.running("memory")).toBe(false);
    expect(host.running("reminders")).toBe(true);
  });
});

describe("设置那一块", () => {
  test("没连：默认中国区，Key 是密码框（不回显），按钮\"测试连接并保存\"，没填 Key 时按不了；说明写清楚", () => {
    const html = render();
    expect(html).toContain("连接 Looki");
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*class="on"[^>]*>中国区（looki.tech）<\/button>/);
    expect(html).toContain("海外（looki.ai）");
    expect(html).toMatch(/<input type="password" autoComplete="off"[^>]*placeholder="lk- 开头"/);
    expect(html).toMatch(/<button type="button" class="btn primary small" disabled="">测试连接并保存<\/button>/);
    expect(html).toContain("web.looki.tech");
    expect(html).toContain("只存在这台电脑上");
    expect(html).toContain("导入到昨天为止");
    expect(html).toContain("照片、视频不进记忆");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("填了 Key：按钮能按", () => {
    expect(render({ keyText: "lk-abc" })).toMatch(/<button type="button" class="btn primary small">测试连接并保存<\/button>/);
  });

  test("连着：区域不预选（写明沿用）、Key 框写已存好、没填 Key 时按钮是\"再测一次\"", () => {
    const html = render({ source: looki({ connection: "connected", account: "d***@example.com（中国区）" }), region: undefined });
    expect(html).toContain("换 Key、换区域、再测一次");
    expect(html).not.toContain('aria-checked="true"');
    expect(html).toContain("不选就沿用现在的区域");
    expect(html).toContain('placeholder="已存好，不显示；要换就填新的"');
    expect(html).toMatch(/<button type="button" class="btn primary small">再测一次<\/button>/);
  });

  test("没存过 Key、测试没过（出错、没有账号那一行）：照没连画，不说\"已存好\"", () => {
    const html = render({ source: looki({ connection: "error", problem: "Looki 不认这个 Key" }) });
    expect(html).toContain("连接 Looki");
    expect(html).toContain('placeholder="lk- 开头"');
    expect(html).not.toContain("再测一次");
  });

  test("正在测试：都按不了；回来以后说一句", () => {
    expect(render({ keyText: "lk-abc", busy: true })).toContain("正在测试……");
    expect(render({ result: { ok: false, text: "没连上：Looki 不认这个 Key" } })).toContain('<div class="field-error" role="status">没连上：Looki 不认这个 Key</div>');
  });

  test("测试连接的结果：连着且没有问题是连上了（带账号），出错、新 Key 没通过都写原因", () => {
    expect(resultOf(view(looki({ connection: "connected", account: "d***@example.com（中国区）" })), "looki")).toEqual({ ok: true, text: "连上了：d***@example.com（中国区）" });
    expect(resultOf(view(looki({ connection: "error", problem: "Looki 不认这个 Key" })), "looki")).toEqual({ ok: false, text: "没连上：Looki 不认这个 Key" });
    expect(resultOf(view(looki({ connection: "connected", problem: "新填的没通过（…），还在用原来的 Key" })), "looki").ok).toBe(false);
    expect(resultOf(view(looki()), "nobody")).toEqual({ ok: false, text: "没连上：原因不明" });
  });
});

describe("存一份到本地那一块（307 号票）", () => {
  const HOME = "C:\\Users\\me\\Documents\\Looki";
  const archive = (extra: Partial<LookiArchiveView> = {}): LookiArchiveView => ({
    on: true,
    folder: HOME,
    defaultFolder: HOME,
    kinds: { photos: true, journals: true, vlogs: true, clips: false },
    saved: { photos: 0, clips: 0, journals: 0, vlogs: 0, bytes: 0, days: 0 },
    pending: 0,
    failed: 0,
    ...extra,
  });
  const block = (props: Partial<LookiArchiveBlockProps> = {}) =>
    renderToStaticMarkup(
      createElement(LookiArchiveBlock, {
        archive: archive(),
        busy: false,
        folderText: undefined,
        range: { from: "2026-09-25", to: "2026-10-24" },
        result: undefined,
        onSettings: noop,
        onFolderText: noop,
        onRange: noop,
        onOpen: noop,
        onBackfill: noop,
        onStop: noop,
        onResume: noop,
        onRetry: noop,
        ...props,
      }),
    );

  test("默认：开着、默认位置、照片 / 日记 / vlog 勾着、原始视频没勾；还没存过；补存的日期；说明写清不进记忆、断开不删", () => {
    const html = block();
    expect(html).toContain("存一份到本地");
    expect(html).toMatch(/role="switch"[^>]*checked=""/);
    expect(html).toContain(HOME);
    expect(html).toContain(">默认位置<");
    expect(html).toContain(">打开文件夹<");
    expect(html).toContain(">改位置<");
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span>照片/);
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span>AI 日记/);
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span>vlog/);
    expect(html).toMatch(/<input type="checkbox"\/><span>原始视频片段/);
    expect(html).toContain("还没存过");
    expect(html).toContain('value="2026-09-25"');
    expect(html).toContain('value="2026-10-24"');
    expect(html).toContain(">开始补存<");
    expect(html).toContain("不进记忆、不进备份");
    expect(html).toContain("不删这些文件");
    expect(html).toContain("已经存的不搬");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("关着：几类、补存按不了", () => {
    const html = block({ archive: archive({ on: false }) });
    expect(html).toContain('data-on="false"');
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""\/><span>照片/);
    expect(html).toMatch(/<button type="button" class="btn primary small" disabled="">开始补存<\/button>/);
  });

  test("改位置：输入框（空着是默认位置）、保存、取消", () => {
    const html = block({ folderText: "D:\\Looki" });
    expect(html).toContain("新的位置（完整路径，空着就是默认位置）");
    expect(html).toContain('value="D:\\Looki"');
    expect(html).toContain(">保存位置<");
    expect(html).not.toContain(">打开文件夹<");
  });

  test("已存多少、上次存的时间；正在存、限速在等；停下的原因、没存齐的、现在接着存；没做成的原因", () => {
    const saved = archive({ saved: { photos: 1286, clips: 0, journals: 9, vlogs: 9, bytes: 3_412_000_000, days: 9 }, lastSavedAt: "2026-10-25T02:41:00.000+08:00" });
    expect(savedLine(saved)).toBe("已存：照片 1286 张、日记 9 篇、vlog 9 个，共 3.18 GB（9 天） · 上次存：10-25 02:41");
    expect(workingLine(archive({ working: { kind: "sync", day: "2026-10-24" } }))).toBe("正在存 10-24 的");
    expect(workingLine(archive({ working: { kind: "backfill", day: "2026-10-03", waiting: true } }))).toBe("正在补存 10-03 的 · Looki 限速了，等一会儿接着存");
    const stopped = block({ archive: archive({ problem: "磁盘满了：D: 没地方了", pending: 2, failed: 1 }) });
    expect(stopped).toContain("停下了：磁盘满了：D: 没地方了");
    expect(stopped).toContain("还有 2 个时刻没存齐，下次同步接着补");
    expect(stopped).toContain("1 个时刻试了几次都没存下来");
    expect(stopped).toContain(">现在接着存<");
    expect(block({ archive: archive({ pending: 2, working: { kind: "sync" } }) })).not.toContain(">现在接着存<");
    expect(block({ archive: archive({ refused: "位置要写完整的路径，比如 D:\\Looki" }) })).toContain('<div class="field-error">位置要写完整的路径');
    expect(block({ result: { ok: false, text: "打不开：拒绝访问" } })).toContain("打不开：拒绝访问");
  });

  test("补存的进度：正在补（停下）、停下了 / 暂停了（接着补）、补完了", () => {
    const base = { from: "2026-09-25", to: "2026-10-24", doneDays: 5, totalDays: 30, files: 85 };
    const running = archive({ backfill: { ...base, next: "2026-10-19", state: "running" } });
    expect(backfillLine(running)).toBe("正在往回补：补到 10-19（已补 5 / 30 天，存下 85 个文件）");
    expect(block({ archive: running })).toContain(">停下<");
    expect(block({ archive: running })).not.toContain(">开始补存<");
    const stopped = archive({ backfill: { ...base, next: "2026-10-19", state: "stopped" } });
    expect(backfillLine(stopped)).toBe("补到 10-19 停下了（已补 5 / 30 天）");
    expect(block({ archive: stopped })).toContain(">接着补<");
    expect(backfillLine(archive({ backfill: { ...base, next: "2026-10-19", state: "paused" } }))).toContain("暂停了");
    const done = archive({ backfill: { ...base, doneDays: 30, state: "done" } });
    expect(backfillLine(done)).toBe("2026-09-25 到 2026-10-24 补完了，存下 85 个文件");
    expect(block({ archive: done })).not.toContain(">接着补<");
  });

  test("补存默认最近 30 天到昨天；认得数据源报的那一块（认不出不画）", () => {
    expect(defaultRange("2026-10-25")).toEqual({ from: "2026-09-25", to: "2026-10-24" });
    expect(defaultRange("2026-03-01")).toEqual({ from: "2026-01-30", to: "2026-02-28" });
    expect(archiveOf(looki({ panel: archive() }))?.folder).toBe(HOME);
    expect(archiveOf(looki({ panel: { something: 1 } }))).toBeUndefined();
    expect(archiveOf(looki())).toBeUndefined();
  });
});
