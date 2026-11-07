// 设置 · 更多 · 体检（319b、409，pages/more/DoctorPage.tsx + app/doctor.ts）：用 React 在 Node 里渲染出来查——
// - 按块：二狗本身在最前、每个插件一块；块头是名字和最差的结果；每项一行：结果（data-level、小签）、守护进程拼好的名字和事实、
//   从什么时候起、怎么修、动作按钮（去看看 / 现在压缩）；不适用的淡显；停用的插件最底下一行；
// - 总状态：坏了几项、要注意几项、都正常；没查出来的另起一句；
// - 原型编的一份（prototype/fake-doctor.ts）：五种结果都有、有插件块、有过期的数据源、有没查出来的、两种动作；英文里一个中文字都没有；
//   停用了的插件不成块、列进"停用的插件"；
// - 八项的事实拼句（挪进了协议包 doctor-text.ts，守护进程和演示页共用）：端口号、版本号、剩多少 GB 按当前语言；查不了的写"这次没查出来"；
// - "再查一遍"每次重新取（loadDoctor 经 DaemonHttp）；页面右上的按钮；界面上不出现"秘书""待我处理"。
// 设置列表里的位置见 settings-groups.test.ts；页面打得开见 page-opens.test.ts。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { doctorActionText, doctorSinceText, doctorSummary, knownDoctorAction, loadDoctor } from "../../src/app/doctor.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { DoctorGroups, DoctorItemRow, DoctorPage } from "../../src/pages/more/DoctorPage.tsx";
import { hasChinese, localizedFake } from "../../src/prototype/fake-content.ts";
import { FakeConnection } from "../../src/prototype/fake-connection.ts";
import { fakeDoctorView } from "../../src/prototype/fake-doctor.ts";
import { FakeDaemonHttp } from "../../src/prototype/fake-http.ts";
import { FakePlugins } from "../../src/prototype/fake-plugins.ts";
import {
  activeLocale,
  activeLocaleFrom,
  coreDoctorItem,
  DOCTOR_CHECKS,
  DOCTOR_CORE_GROUP,
  DOCTOR_FIX_UNKNOWN,
  type DoctorCheckDataById,
  type DoctorCheckId,
  type DoctorCheckView,
  doctorFactText,
  doctorFixText,
  type DoctorItemView,
  type DoctorView,
  setActiveLocale,
} from "../../src/state/index.ts";
import { ToastProvider } from "../../src/ui/toast.tsx";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};

/** 八项都健康时各查出来的（和守护进程回的一个形状） */
const GOOD: { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
  node: { running: "22.23.4", expected: "22" },
  pi: { version: "1.0.4" },
  supervisor: { running: true, port: 7420 },
  model: { configured: true },
  components: { missing: [] },
  disk: { freeGb: 42.3, totalGb: 476.8, path: "C:\\Users\\demo\\.ergo" },
  external: { configured: true, kind: "tailscale" },
};

const check = (id: DoctorCheckId, data: DoctorCheckDataById[DoctorCheckId] = GOOD[id], ok = true, fix = `doctor.fix.${id}`): DoctorCheckView => ({ id, ok, data, ...(ok ? {} : { fix }) });

/** 一项（守护进程拼好的句子） */
function item(id: string, level: DoctorItemView["level"], title: string, fact: string, extra: Partial<Pick<DoctorItemView, "since" | "action">> & { fix?: string } = {}): DoctorItemView {
  return { id, level, title: { key: "k" }, fact: { key: "k" }, ...(extra.since ? { since: extra.since } : {}), ...(extra.action ? { action: extra.action } : {}), text: { title, fact, ...(extra.fix ? { fix: extra.fix } : {}) } };
}

/** 一份手写的结果：二狗本身（八项都好）、Looki 过期、记忆有一项没查出来、Codex 不适用、日历停用了 */
function sample(): DoctorView {
  return {
    checks: DOCTOR_CHECKS.map((id) => check(id)),
    groups: [
      { id: DOCTOR_CORE_GROUP, kind: "core", title: "二狗本身", level: "ok", items: DOCTOR_CHECKS.map((id) => coreDoctorItem(check(id), "ok")) },
      {
        id: "looki",
        kind: "plugin",
        title: "Looki",
        level: "warn",
        items: [
          item("plugin", "ok", "插件本身", "在跑"),
          item("source:looki", "warn", "数据源：Looki", "85 小时没同步成功了", { since: "2026-11-04T02:30:00+08:00", fix: "点立即同步", action: { kind: "open", route: "#/more/data-sources/looki" } }),
        ],
      },
      { id: "memory", kind: "plugin", title: "记忆", level: "ok", items: [item("plugin", "ok", "插件本身", "在跑"), item("brief", "unknown", "记忆简报", "这次没查出来")] },
      { id: "codex", kind: "plugin", title: "Codex", level: "na", items: [item("plugin", "na", "插件本身", "要的外部组件没装")] },
    ],
    off: [{ plugin: "calendar", title: "日历", state: "disabled" }],
    level: "warn",
    counts: { error: 0, warn: 1, unknown: 1 },
    at: "2026-11-07T07:30:00.000Z",
  };
}

const render = (view: DoctorView) => renderToStaticMarkup(createElement(DoctorGroups, { view, onAction: noop }));

const before = activeLocale();
afterEach(() => setActiveLocale(before));
const inEnglish = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));

describe("按块显示", () => {
  test("二狗本身在最前，插件一块一块（顺序照守护进程给的）；块头是名字和最差的结果", () => {
    const html = render(sample());
    expect([...html.matchAll(/data-group="([a-z-]+)"/g)].map((m) => m[1])).toEqual([DOCTOR_CORE_GROUP, "looki", "memory", "codex"]);
    expect(html).toContain('data-group="looki" data-level="warn"');
    expect(html).toContain('data-group="codex" data-level="na"');
    for (const title of ["二狗本身", "Looki", "记忆", "Codex"]) expect(html).toContain(`<span class="doctor-group-title">${title}</span>`);
    // 八项都在二狗本身那一块，句子按当前语言
    for (const id of DOCTOR_CHECKS) expect(html).toContain(`data-item="${id}"`);
    expect(html).toContain("本机端口 8810：在听，是二狗自己；外网端口 8811：在听，是二狗自己");
  });

  test("每项：结果（data-level，不正常的带小签）、名字、事实、从什么时候起、怎么修、动作按钮", () => {
    const html = render(sample());
    expect(html).toMatch(/data-item="source:looki" data-level="warn"/);
    expect(html).toContain('<span class="doctor-level">注意</span>');
    expect(html).toContain('<span class="doctor-level">没查出来</span>');
    expect(html).toContain('<span class="doctor-level">不适用</span>');
    expect(html).toContain("85 小时没同步成功了");
    expect(html).toContain(doctorSinceText("2026-11-04T02:30:00+08:00"));
    expect(html).toContain("点立即同步");
    expect(html).toContain('data-action="open"');
    expect(html).toContain("去看看");
    // 正常的项不带小签（八项 + 两个插件本身 = 10 项正常，块头的"正常"不算）
    expect(html.match(/<span class="doctor-level">正常<\/span>/g)).toHaveLength(2);
  });

  test("总状态：要注意几项；没查出来的另起一句；停用的插件最底下一行", () => {
    const html = render(sample());
    expect(html).toContain('<span class="doctor-summary-item doctor-warn">1 项要注意</span>');
    expect(html).toContain('<span class="doctor-summary-item doctor-unknown">另有 1 项这次没查出来</span>');
    expect(html).toContain("停用的插件不查：日历");
    expect(doctorSummary({ ...sample(), counts: { error: 2, warn: 0, unknown: 0 } })).toEqual([{ level: "error", text: "2 项坏了" }]);
    expect(doctorSummary({ ...sample(), counts: { error: 0, warn: 0, unknown: 0 } })).toEqual([{ level: "ok", text: "都正常" }]);
  });

  test("动作按钮：现在压缩（压着的时候点不了、写\"正在压缩…\"）；不认得的动作不画；没给处理函数时按钮灰着", () => {
    const compact = item("context", "warn", "对话长度", "过了自动压缩点", { action: { kind: "compact", agentId: "secretary" } });
    const idle = renderToStaticMarkup(createElement(DoctorItemRow, { item: compact, onAction: noop }));
    expect(idle).toContain('data-action="compact"');
    expect(idle).toContain("现在压缩");
    const busy = renderToStaticMarkup(createElement(DoctorItemRow, { item: compact, onAction: noop, busy: { kind: "compact", agentId: "secretary" } }));
    expect(busy).toContain("正在压缩…");
    expect(busy).toMatch(/disabled=""/);
    const strange = { ...compact, action: { kind: "restart", service: "x" } as unknown as DoctorItemView["action"] };
    expect(renderToStaticMarkup(createElement(DoctorItemRow, { item: strange, onAction: noop }))).not.toContain("data-action");
    expect(knownDoctorAction({ kind: "open", route: "#/more/plugins" })).toBe(true);
    expect(doctorActionText({ kind: "open", route: "#/more/plugins" })).toBe("去看看");
  });
});

/** 原型的插件清单（off 里的停用了） */
const plugins = (off: string[] = []) => new FakePlugins(new Set(off), new Set()).view();

describe("原型编的一份", () => {
  test("五种结果都有：二狗本身在最前（组件、外网入口是注意，带\"现在压缩\"的一项），有插件块、Looki 存一份到本地停下了（注意）、Google 一个日历地址失效了（坏了）、没查出来的、不适用的", () => {
    const view = fakeDoctorView(plugins());
    expect(view.groups[0]!.id).toBe(DOCTOR_CORE_GROUP);
    const levels = new Set(view.groups.flatMap((g) => g.items.map((i) => i.level)));
    expect([...levels].toSorted()).toEqual(["error", "na", "ok", "unknown", "warn"]);
    const core = view.groups[0]!.items;
    expect(core.filter((i) => i.level === "warn").map((i) => i.id)).toEqual(["components", "external", "context"]);
    expect(core.find((i) => i.id === "context")!.action).toEqual({ kind: "compact", agentId: "secretary" });
    // 414：Looki 一块一项黄（存一份到本地停下了，跳到数据源详情），Google 一块一项红（每个日历地址，从什么时候起）
    const looki = view.groups.find((g) => g.id === "looki")!;
    expect(looki.level).toBe("warn");
    expect(looki.items.filter((i) => i.level === "warn").map((i) => i.id)).toEqual(["archive"]);
    expect(looki.items.find((i) => i.id === "archive")).toMatchObject({ action: { kind: "open", route: "#/more/data-sources/looki" }, text: { title: "存一份到本地", fact: expect.stringContaining("Looki 换了接口") } });
    const google = view.groups.find((g) => g.id === "google")!;
    expect(google.level).toBe("error");
    expect(google.items.filter((i) => i.level === "error").map((i) => i.id)).toEqual(["calendar-feeds"]);
    expect(google.items.find((i) => i.id === "calendar-feeds")).toMatchObject({ since: "2026-11-07T14:30:00+08:00", text: { title: "每个日历地址", fact: expect.stringContaining("「工作」连着 2 次没拉到") } });
    expect(view.groups.find((g) => g.id === "memory")!.items.find((i) => i.id === "brief")!.text.fact).toBe("这次没查出来：1.5 秒内没查完");
    // 坏了的插件块排在前面（语音、Google），然后是要注意的（Looki），总状态是坏了
    expect(view.groups.slice(1, 4).map((g) => g.id)).toEqual(["voice", "google", "looki"]);
    expect(view.level).toBe("error");
    expect(view.counts).toEqual({ error: 2, warn: 5, unknown: 1 });
    expect(view.off).toEqual([]);
  });

  test("停用、移除了的插件不成块，列进\"停用的插件\"", () => {
    const view = fakeDoctorView(plugins(["looki", "calendar"]));
    expect(view.groups.map((g) => g.id)).not.toContain("looki");
    expect(view.off.map((p) => p.plugin)).toEqual(["calendar", "looki"]);
    expect(render(view)).toContain("停用的插件不查：日历和Looki");
  });

  test("英文：假 HTTP 照表换过之后一个中文字都没有", async () => {
    inEnglish();
    const view = await localizedFake(new FakeDaemonHttp(new FakeConnection())).doctor();
    const texts = view.groups.flatMap((g) => [g.title, ...g.items.flatMap((i) => [i.text.title, i.text.fact, i.text.fix ?? ""])]);
    expect(texts.filter(hasChinese)).toEqual([]);
    const html = render(view);
    expect(html).toContain("ergo itself");
    expect(html).toContain("Stopped: Vlogs not saved: Looki changed its API");
    expect(html).toContain("&quot;Work&quot; failed 2 times in a row");
    expect(html).toContain("Compact now");
    expect(html).toContain("Take a look");
    expect(hasChinese(html)).toBe(false);
  });
});

/** 八项里一项的事实（不给 data 用好的那份） */
const fact = (id: DoctorCheckId, data?: DoctorCheckDataById[DoctorCheckId]) => doctorFactText(check(id, data));

describe("八项的事实拼句（协议包，守护进程和演示页共用）", () => {
  test("端口号、版本号、端口、缺哪个功能、剩多少 GB、外网是哪一种", () => {
    expect(fact("ports")).toBe("本机端口 8810：在听，是二狗自己；外网端口 8811：在听，是二狗自己");
    expect(fact("node")).toBe("运行的是 Node 22.23.4；pi 那条线是 22");
    expect(fact("pi")).toBe("读到的版本是 1.0.4");
    expect(fact("supervisor")).toBe("有回应（端口 7420）");
    expect(fact("model")).toBe("Key 配好了");
    expect(fact("components", { missing: ["memory.semantic", "voice.input"] })).toBe("还缺：按意思检索素材和按住说话");
    expect(fact("disk")).toBe("数据目录 C:\\Users\\demo\\.ergo 所在卷还剩 42.3 GB（一共 476.8 GB）");
    expect(fact("external")).toBe("配了：Tailscale");
    expect(fact("external", { configured: true, kind: "paired", devices: 2 })).toBe("有 2 台已配对的设备");
    expect(fact("external", { configured: false })).toBe("服务管家里没登记外网入口；手机已经能连的话可以忽略这条");
    expect(fact("external", { configured: true, kind: "tunnel", rejected: [{ url: "https://x.example", reason: "wrong_port", port: 8810 }] } as DoctorCheckDataById["external"])).toBe(
      "配了：VPS 隧道。有 1 个入口手机用不了：https://x.example（接到了端口 8810）",
    );
  });

  test("坏的那项的修法是整句（不是键名）；查不了的写\"这次没查出来\"，不拿空值（0 GB）拼句子", () => {
    expect(doctorFixText(check("ports", { ...GOOD.ports, externalUp: false }, false))).toContain("看看这两个端口被谁占着");
    const unknown = check("disk", { freeGb: 0, totalGb: 0, path: "" }, false, DOCTOR_FIX_UNKNOWN);
    expect(doctorFactText(unknown)).toBe("这次没查出来");
    expect(doctorFixText(unknown)).toContain("点「再查一遍」");
    const row = coreDoctorItem(unknown, "unknown");
    expect(row).toMatchObject({ id: "disk", level: "unknown", fact: { key: "doctor.fact.unknown" }, fix: { key: DOCTOR_FIX_UNKNOWN } });
    expect(row.text.fact).not.toContain("0 GB");
  });

  test("英文：名字、事实、修法都是英文；配对设备分单复数", () => {
    inEnglish();
    expect(coreDoctorItem(check("ports"), "ok").text).toEqual({ title: "Ports", fact: "Local port 8810: listening, and it's ergo itself; external port 8811: listening, and it's ergo itself" });
    expect(coreDoctorItem(check("model", { configured: false }, false), "error").text).toEqual({ title: "Model key", fact: "No key yet", fix: expect.stringContaining("Put a model key in Settings · Models") });
    expect(doctorFactText(check("external", { configured: true, kind: "paired", devices: 1 }))).toBe("1 paired device");
    expect(doctorFactText(check("external", { configured: true, kind: "paired", devices: 3 }))).toBe("3 paired devices");
  });
});

describe("再查一遍、页面", () => {
  test("loadDoctor 每次都经 DaemonHttp 取一遍，拿回来的是新的一份", async () => {
    let calls = 0;
    const http = { doctor: () => Promise.resolve({ ...sample(), at: `2026-11-07T07:3${(calls += 1)}:00.000Z` }) };
    expect((await loadDoctor(http)).at).toBe("2026-11-07T07:31:00.000Z");
    expect((await loadDoctor(http)).at).toBe("2026-11-07T07:32:00.000Z");
    expect(calls).toBe(2);
  });

  test("标题栏右上是\"再查一遍\"，说明写平时体检只读本机、会连本机服务的端口；还没取到时写\"正在体检…\"", () => {
    const store = { connection: {} as Connection, http: { doctor: () => Promise.resolve(sample()) } as unknown as DaemonHttp } as ComponentProps<typeof StoreProvider>;
    const html = renderToStaticMarkup(createElement(StoreProvider, store, createElement(ToastProvider, null, createElement(DoctorPage, { title: "体检", onBack: noop, navigate: noop }))));
    expect(html).toContain('data-action="recheck"');
    expect(html).toContain("平时体检只查本机");
    expect(html).toContain("二狗在用的服务的端口");
    expect(html).toContain("正在体检…");
  });

  test("界面上不出现\"秘书\"\"待我处理\"", () => {
    const html = render(fakeDoctorView(plugins())) + render(sample());
    expect(html).not.toMatch(/秘书|待我处理/);
  });
});
