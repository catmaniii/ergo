// 设置 · 更多 · 体检（319b、409，pages/more/DoctorPage.tsx + app/doctor.ts）：用 React 在 Node 里渲染出来查——
// - 按块：二狗本身在最前、每个插件一块；块头是名字和最差的结果；每项一行：结果（data-level、小签）、守护进程拼好的名字和事实、
//   从什么时候起、怎么修、动作按钮（去看看 / 现在压缩）；不适用的淡显；停用的插件最底下一行；
// - 总状态：坏了几项、要注意几项、都正常；没查出来的另起一句；
// - 原型编的一份（prototype/fake-doctor.ts）：五种结果都有、有插件块、有过期的数据源、有没查出来的、两种动作；英文里一个中文字都没有；
//   停用了的插件不成块、列进"停用的插件"；
// - 八项的事实拼句（挪进了协议包 doctor-text.ts，守护进程和演示页共用）：端口号、版本号、剩多少 GB 按当前语言；查不了的写"这次没查出来"；
// - "再查一遍"每次重新取（loadDoctor 经 DaemonHttp）；页面右上的按钮；界面上不出现"秘书""待我处理"；
// - 415 深度体检那一块：还没做过、正在测（逐项出结果、还在测的写"正在测…"）、测完了（"几分钟前测的"、总状态、按块）、
//   刚测过（按钮倒数）；"几分钟前"按守护进程的时钟走；原型编的一份和点了以后的样子；英文里没有中文。
// - 后台盯着（416）那一段：多久看一眼、看哪几件；点过"不再提醒这件事"的一项一行带"恢复提醒"（正在恢复时灰着）；原型的假 HTTP 能恢复；中英。
// 设置列表里的位置见 settings-groups.test.ts；页面打得开见 page-opens.test.ts。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { doctorActionText, doctorDeepAgoText, doctorDeepButtonText, doctorDeepNow, doctorDeepWaitSeconds, doctorSinceText, doctorSummary, knownDoctorAction, loadDoctor } from "../../src/app/doctor.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { DoctorDeepBlock, DoctorGroups, DoctorItemRow, DoctorPage, DoctorWatchSection } from "../../src/pages/more/DoctorPage.tsx";
import { hasChinese, localizedFake } from "../../src/prototype/fake-content.ts";
import { FakeConnection } from "../../src/prototype/fake-connection.ts";
import { fakeDoctorView, FakeDoctorWatch } from "../../src/prototype/fake-doctor.ts";
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
  type DoctorDeepItemView,
  type DoctorDeepView,
  doctorFactText,
  doctorFixText,
  type DoctorItemView,
  type DoctorView,
  type DoctorWatchView,
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
    // 410：本机的网址（服务管家的网页）是"打开服务管家"
    expect(doctorActionText({ kind: "open", route: "http://127.0.0.1:7420/" })).toBe("打开服务管家");
    const manager = item("services", "error", "托管的服务", "语音合成停着", { action: { kind: "open", route: "http://127.0.0.1:7420/" } });
    expect(renderToStaticMarkup(createElement(DoctorItemRow, { item: manager, onAction: noop }))).toContain("打开服务管家");
  });

  test("跳本机的网页（服务管家，410、413）：画成新开一页的链接，写\"打开服务管家\"，不经页面的跳转", () => {
    const speech = item("speech", "error", "语音合成", "连不上", { action: { kind: "open", route: "http://127.0.0.1:7420/" } });
    let clicked = 0;
    const html = renderToStaticMarkup(createElement(DoctorItemRow, { item: speech, onAction: () => (clicked += 1) }));
    expect(html).toContain('<a class="btn ghost small" data-action="open" href="http://127.0.0.1:7420/" target="_blank" rel="noreferrer">打开服务管家</a>');
    expect(html).not.toContain("<button");
    expect(clicked).toBe(0);
    // 二狗自己的地址照旧是按钮
    const inside = renderToStaticMarkup(createElement(DoctorItemRow, { item: { ...speech, action: { kind: "open", route: "#/more/voice" } }, onAction: noop }));
    expect(inside).toContain('<button type="button" class="btn ghost small" data-action="open"');
  });
});

/** 原型的插件清单（off 里的停用了） */
const plugins = (off: string[] = []) => new FakePlugins(new Set(off), new Set()).view();

describe("原型编的一份", () => {
  test("五种结果都有：二狗本身在最前（照 11-07 那天：外网入口打不通、模型近况、托管的服务坏了，组件、对话长度要注意，带\"现在压缩\"和\"打开服务管家\"），有插件块、Looki 存一份到本地出了问题（注意，414）、Google 一个日历地址失效了（坏了，414）、没查出来的、不适用的、坏了的", () => {
    const view = fakeDoctorView(plugins());
    expect(view.groups[0]!.id).toBe(DOCTOR_CORE_GROUP);
    const levels = new Set(view.groups.flatMap((g) => g.items.map((i) => i.level)));
    expect([...levels].toSorted()).toEqual(["error", "na", "ok", "unknown", "warn"]);
    const core = view.groups[0]!.items;
    expect(core.map((i) => i.id)).toEqual([...DOCTOR_CHECKS, "assistant", "model-calls", "context", "services", "plugins", "web", "backup", "triggers", "internal-jobs", "stuck-agents", "log-size", "config-files", "missing-skills", "pending", "app-version", "db-wal"]);
    expect(core.filter((i) => i.level === "warn").map((i) => i.id)).toEqual(["components", "context", "backup", "log-size", "missing-skills"]);
    expect(core.filter((i) => i.level === "error").map((i) => i.id)).toEqual(["external", "model-calls", "services"]);
    expect(core.find((i) => i.id === "context")!.action).toEqual({ kind: "compact", agentId: "secretary" });
    expect(core.find((i) => i.id === "context")!.text.fact).toBe("二狗：对话用了 93.5 万 token，过了自动压缩点 70 万还没压下去（模型窗口 104.9 万）");
    expect(core.find((i) => i.id === "model-calls")!.text.fact).toContain("最近 5 轮都失败了：服务商说太忙和服务商出错（500）");
    expect(core.find((i) => i.id === "services")!.action).toEqual({ kind: "open", route: "http://127.0.0.1:7420/" });
    expect(core.find((i) => i.id === "external")!.text.fact).toBe("配了：Tailscale。入口从外面都打不通：https://ergo.demo-tailnet.ts.net/（tailnet 节点离线）");
    // 411 的十项照今天的样子：备份 EBUSY、日志 265 MB、合集缺两个 skill；待办、旧手机是提示（正常，带事实和去看看）
    const text = (id: string) => core.find((i) => i.id === id)!.text;
    expect(text("backup").fact).toContain("EBUSY: resource busy or locked");
    expect(text("backup").fix).toContain("立即备份");
    expect(text("log-size").fact).toContain("ergo-daemon.out.log（服务管家的日志，265 MB）");
    expect(text("missing-skills").fact).toBe("合集「matt-pocock」的清单里有、库里没有：handoff和to-questionnaire");
    expect(core.find((i) => i.id === "pending")).toMatchObject({ level: "ok", action: { kind: "open", route: "#/inbox" } });
    expect(text("pending").fact).toBe("待办 6 条，其中待审批 2 条");
    expect(text("app-version").fact).toBe("1 台手机的 App 比要求的 0.4.1 旧：家里的平板（0.3.9）");
    // 414：Looki 一块一项黄（存一份到本地出了问题，跳到数据源详情），Google 一块一项红（每个日历地址，从什么时候起）
    const looki = view.groups.find((g) => g.id === "looki")!;
    expect(looki.level).toBe("warn");
    expect(looki.items.filter((i) => i.level === "warn").map((i) => i.id)).toEqual(["archive"]);
    expect(looki.items.find((i) => i.id === "archive")).toMatchObject({ action: { kind: "open", route: "#/more/data-sources/looki" }, text: { title: "存一份到本地", fact: expect.stringContaining("Looki 换了接口") } });
    const google = view.groups.find((g) => g.id === "google")!;
    expect(google.level).toBe("error");
    expect(google.items.filter((i) => i.level === "error").map((i) => i.id)).toEqual(["calendar-feeds"]);
    expect(google.items.find((i) => i.id === "calendar-feeds")).toMatchObject({ since: "2026-11-07T14:30:00+08:00", text: { title: "每个日历地址", fact: expect.stringContaining("「工作」连着 2 次没拉到") } });
    // 没查出来的示例（412 挪到语音那一块；413 之后是 N 卡：第一次问要跑 nvidia-smi）
    expect(view.groups.find((g) => g.id === "voice")!.items.find((i) => i.id === "gpu")!.text.fact).toBe("这次没查出来：1.5 秒内没查完");
    // 记忆那一块（412 的六项）：记忆简报注意、每晚整理坏了（从上次跑成起，跳记忆管理员），别的正常
    const memory = view.groups.find((g) => g.id === "memory")!;
    expect(memory.items.map((i) => [i.id, i.level])).toEqual([
      ["plugin", "ok"],
      ["index", "ok"],
      ["graph", "ok"],
      ["system", "ok"],
      ["brief", "warn"],
      ["nightly", "error"],
      ["presync", "ok"],
    ]);
    expect(memory.items.find((i) => i.id === "nightly")).toMatchObject({ since: "2026-11-05T03:14:00+08:00", action: { kind: "open", route: "#/more/memory/curator" } });
    // 坏了的插件块排在前面（记忆、语音、Google，照插件清单的先后），然后是要注意的（Looki），总状态是坏了
    expect(view.groups.slice(1, 5).map((g) => g.id)).toEqual(["memory", "voice", "google", "looki"]);
    // 语音那一块是 413 的五项：合成服务坏了（从 15:42 起，打开服务管家），N 卡这次没查出来，别的正常
    const voice = view.groups.find((g) => g.id === "voice")!.items;
    expect(voice.map((i) => [i.id, i.level])).toEqual([
      ["plugin", "ok"],
      ["speech", "error"],
      ["recognizer", "ok"],
      ["references", "ok"],
      ["ffmpeg", "ok"],
      ["gpu", "unknown"],
    ]);
    expect(voice[1]).toMatchObject({ since: "2026-11-07T15:42:00+08:00", action: { kind: "open", route: "http://127.0.0.1:7420/" } });
    expect(voice[1]!.text.fix).toContain("服务管家");
    // 和二狗本身的"托管的服务"说的是同一个停着的服务（audiocpp），一个从服务管家看、一个从语音看
    expect(voice[1]!.text.fix).toContain("audiocpp");
    expect(view.groups[0]!.items.find((i) => i.id === "services")!.text.fact).toContain("audiocpp");
    expect(view.level).toBe("error");
    expect(view.counts).toEqual({ error: 6, warn: 8, unknown: 1 });
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
    expect(html).toContain("Ran into a problem: Vlogs not saved: Looki changed its API");
    expect(html).toContain("&quot;Work&quot; failed 2 times in a row");
    expect(html).toContain("Compact now");
    expect(html).toContain("Take a look");
    expect(html).toContain("Open service manager");
    expect(html).toContain("ergo: the conversation is at 935K tokens");
    expect(html).toContain("In the list of the &quot;matt-pocock&quot; collection but not in the library: handoff and to-questionnaire");
    expect(html).toContain("The app on 1 phone is older than the required 0.4.1: Home tablet (0.3.9)");
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

  test("410 补的几处：服务管家的连接断着、服务管家的数据在另一个卷、外网入口从外面打不通（哪个、为什么）、连接停在等待", () => {
    expect(fact("supervisor", { running: true, port: 7420, link: "waiting" })).toBe("有回应（端口 7420）；但二狗和它的连接断着，在重连");
    expect(fact("supervisor", { running: true, port: 7420, link: "connected" })).toBe("有回应（端口 7420）");
    expect(fact("disk", { ...GOOD.disk, supervisor: { freeGb: 0.6, totalGb: 64, path: "D:\\lsm" } })).toBe(
      "数据目录 C:\\Users\\demo\\.ergo 所在卷还剩 42.3 GB（一共 476.8 GB）；服务管家的数据和日志 D:\\lsm 所在卷还剩 0.6 GB（一共 64 GB）",
    );
    const entries = [
      { kind: "tailnet" as const, url: "https://ergo.tail.example/", reachable: false, why: "节点离线" },
      { kind: "public" as const, url: "https://ergo.example/", reachable: true },
    ];
    expect(fact("external", { configured: true, kind: "tailscale", entries })).toBe("配了：Tailscale。2 个入口里有 1 个从外面打不通：https://ergo.tail.example/（节点离线）");
    expect(fact("external", { configured: true, kind: "tailscale", entries: [entries[1]!], link: "waiting" })).toBe("配了：Tailscale。二狗和服务管家的连接断着，入口通不通是断之前的结果");
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

// ───────── 深度体检（415）：点了才跑、逐项出结果、"几分钟前测的"、防连点 ─────────

/** 深度体检测完的一项 */
function deepDone(group: string, groupTitle: string, id: string, level: DoctorItemView["level"], title: string, factText: string): DoctorDeepItemView {
  return { group, groupTitle, id, title, state: "done", item: item(id, level, title, factText), ms: 600 };
}

const DEEP_AT = Date.parse("2026-11-07T07:30:00.000Z");

/** 一份测完的：模型那项坏了（服务商忙），别的正常 */
function deepSample(extra: Partial<DoctorDeepView> = {}): DoctorDeepView {
  return {
    state: "done",
    startedAt: "2026-11-07T07:29:56.000Z",
    finishedAt: "2026-11-07T07:30:00.000Z",
    items: [
      deepDone(DOCTOR_CORE_GROUP, "二狗本身", "model-probe", "error", "模型（真发一句）", "deepseek-flash 没回成：服务商忙（503）（用了 0.6 秒）"),
      deepDone(DOCTOR_CORE_GROUP, "二狗本身", "database", "ok", "数据库完整性", "ergo.db 完整（312 MB，查了 2.4 秒）"),
      deepDone("looki", "Looki", "probe:looki", "ok", "连一下：Looki", "连上了，账号认得：d***@example.com（0.7 秒）"),
    ],
    counts: { error: 1, warn: 0, unknown: 0 },
    now: "2026-11-07T07:33:00.000Z",
    ...extra,
  };
}

const renderDeep = (view: DoctorDeepView | undefined, now: number, extra: { starting?: boolean; error?: string } = {}) =>
  renderToStaticMarkup(createElement(DoctorDeepBlock, { view, now, onStart: noop, onAction: noop, ...extra }));

describe("深度体检（415）", () => {
  test("还没做过：按钮写「深度体检」、旁边一句会真发请求测模型、会连外网、要一点时间；状态写还没做过", () => {
    const html = renderDeep({ state: "never", items: [], counts: { error: 0, warn: 0, unknown: 0 }, now: "2026-11-07T07:30:00.000Z" }, DEEP_AT);
    expect(html).toContain('data-action="deep"');
    expect(html).toContain(">深度体检</button>");
    expect(html).toContain("会真发一个很短的请求测模型（花不到一分钱）、会连外网、要一点时间");
    expect(html).toContain("还没做过深度体检");
    expect(html).not.toContain("disabled");
  });

  test("正在测：按钮灰着写「正在测…」，测完的照常一行、还在测的写「正在测…」，状态写几项里测完了几项", () => {
    const { finishedAt: _done, ...base } = deepSample();
    const running: DoctorDeepView = {
      ...base,
      state: "running",
      counts: { error: 0, warn: 0, unknown: 0 },
      items: [base.items[1]!, { group: "looki", groupTitle: "Looki", id: "probe:looki", title: "连一下：Looki", state: "pending" }],
    };
    const html = renderDeep(running, DEEP_AT);
    expect(html).toMatch(/<button[^>]*data-action="deep"[^>]*disabled=""[^>]*>正在测…<\/button>/);
    expect(html).toContain("正在测：2 项里测完了 1 项");
    expect(html).toContain('data-item="probe:looki" data-level="pending"');
    expect(html).toContain("ergo.db 完整（312 MB，查了 2.4 秒）");
  });

  test("测完了：写「几分钟前测的」、总状态、按块（二狗本身在前）各项一行；按钮写「再测一遍」", () => {
    const html = renderDeep(deepSample(), DEEP_AT + 3 * 60_000);
    expect(html).toContain("3 分钟前测的");
    expect(html).toContain("1 项坏了");
    expect(html.indexOf("二狗本身")).toBeLessThan(html.indexOf("Looki"));
    expect(html).toContain('data-group="ergo" data-level="error"');
    expect(html).toContain("deepseek-flash 没回成：服务商忙（503）（用了 0.6 秒）");
    expect(html).toContain(">再测一遍</button>");
  });

  test("刚测过：按钮灰着倒数「刚测过，N 秒后能再测」；开测没开成写原因", () => {
    const view = deepSample({ nextAt: "2026-11-07T07:31:00.000Z" });
    const html = renderDeep(view, DEEP_AT + 15_000);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>刚测过，45 秒后能再测<\/button>/);
    expect(html).toContain("刚测的");
    expect(renderDeep(view, DEEP_AT + 15_000, { error: "刚测过，45 秒后再测" })).toContain("没开始测：刚测过，45 秒后再测");
  });

  test("「几分钟前」按守护进程的时钟走（取到时它报的 now 加上本机走过的时间）；一小时以上写小时、一天以上写日期；英文分单复数", () => {
    expect(doctorDeepNow({ now: "2026-11-07T07:33:00.000Z" }, 1_000, 31_000)).toBe(Date.parse("2026-11-07T07:33:30.000Z"));
    expect(doctorDeepAgoText("2026-11-07T07:30:00.000Z", DEEP_AT + 30_000)).toBe("刚测的");
    expect(doctorDeepAgoText("2026-11-07T07:30:00.000Z", DEEP_AT + 2 * 3_600_000 + 60_000)).toBe("2 小时前测的");
    expect(doctorDeepAgoText("2026-11-07T07:30:00.000Z", DEEP_AT + 2 * 86_400_000)).toMatch(/测的$/);
    expect(doctorDeepWaitSeconds({ nextAt: "2026-11-07T07:31:00.000Z" }, DEEP_AT + 61_000)).toBe(0);
    inEnglish();
    expect(doctorDeepAgoText("2026-11-07T07:30:00.000Z", DEEP_AT + 60_000)).toBe("Tested 1 minute ago");
    expect(doctorDeepAgoText("2026-11-07T07:30:00.000Z", DEEP_AT + 5 * 60_000)).toBe("Tested 5 minutes ago");
    expect(doctorDeepButtonText(undefined, DEEP_AT)).toBe("Run deep checkup");
  });

  test("原型：打开是 3 分钟前测完的一份（模型那项服务商忙、数据库完整、Claude Code 登录着、Looki 认得），点了逐项出结果；英文里一个中文字都没有", async () => {
    const http = new FakeDaemonHttp(new FakeConnection());
    const first = await http.doctorDeep();
    expect(first.state).toBe("done");
    const ago = Date.parse(first.now) - Date.parse(first.finishedAt!);
    expect(ago).toBeGreaterThanOrEqual(3 * 60_000 - 1_000);
    expect(ago).toBeLessThan(4 * 60_000);
    expect(first.items.map((entry) => `${entry.group}:${entry.id}:${entry.item?.level}`)).toEqual(["ergo:model-probe:error", "ergo:database:ok", "claude-code:login:ok", "looki:probe:looki:ok"]);
    expect(first.items[0]!.item!.text.fact).toBe("deepseek-flash 没回成：服务商忙（503）（用了 0.6 秒）");
    const started = await http.startDoctorDeep();
    expect(started.state).toBe("running");
    expect(started.items.every((entry) => entry.state === "pending")).toBe(true);
    await expect(http.startDoctorDeep()).resolves.toMatchObject({ state: "running" });

    inEnglish();
    const en = await localizedFake(new FakeDaemonHttp(new FakeConnection())).doctorDeep();
    const texts = en.items.flatMap((entry) => [entry.groupTitle, entry.title, entry.item?.text.fact ?? "", entry.item?.text.fix ?? ""]);
    expect(texts.filter(hasChinese)).toEqual([]);
    const html = renderDeep(en, Date.parse(en.now));
    expect(html).toContain("Deep checkup");
    expect(html).toContain("Tested 3 minutes ago");
    expect(html).toContain("the provider is busy (503)");
    expect(hasChinese(html)).toBe(false);
  });

  test("界面上不出现「秘书」「待我处理」", () => {
    expect(renderDeep(deepSample(), DEEP_AT)).not.toMatch(/秘书|待我处理/);
  });
});

describe("后台盯着（416）", () => {
  const watch: DoctorWatchView = {
    everyMinutes: 5,
    muted: [
      { group: DOCTOR_CORE_GROUP, id: "context", title: "对话长度", at: "2026-11-06T13:40:00.000Z" },
      { group: "voice", id: "speech", title: "语音合成", at: "2026-11-07T07:42:00.000Z" },
    ],
  };
  const section = (props: Partial<ComponentProps<typeof DoctorWatchSection>> = {}) => renderToStaticMarkup(createElement(DoctorWatchSection, { watch, onUnmute: noop, ...props }));

  test("一句说明：每 5 分钟看哪几件、坏了放进待办；点过不再提醒的一项一行：名字、从什么时候起、恢复提醒", () => {
    const html = section();
    expect(html).toContain("后台盯着：每 5 分钟看一眼备份、夜里整理记忆、语音合成和识别（开了的才看）、模型近况、对话长度");
    expect(html).toContain("放进待办");
    expect(html).toContain("这几件点了「不再提醒这件事」");
    expect(html).toContain('data-muted="ergo/context"');
    expect(html).toContain("对话长度");
    expect(html).toContain("11/6 21:40 起不再提醒");
    expect(html).toContain('data-muted="voice/speech"');
    expect(html.match(/data-action="unmute"/g)).toHaveLength(2);
    expect(html).toContain("恢复提醒");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("正在恢复的那一项按钮灰着、写\"正在恢复…\"；没有不再提醒的就只有那句说明；没给处理函数时按钮灰着", () => {
    const busy = section({ busy: "voice/speech" });
    expect(busy).toMatch(/data-muted="voice\/speech"[^]*?<button[^>]*disabled=""[^>]*>正在恢复…<\/button>/);
    const empty = section({ watch: { everyMinutes: 5, muted: [] } });
    expect(empty).toContain("后台盯着");
    expect(empty).not.toContain("data-action=\"unmute\"");
    expect(section({ onUnmute: undefined })).toMatch(/<button[^>]*disabled=""[^>]*>恢复提醒<\/button>/);
  });

  test("原型：假 HTTP 的体检带上后台盯着（编了一项对话长度不再提醒），恢复提醒了就拿掉", async () => {
    const http = new FakeDaemonHttp(new FakeConnection());
    const view = await http.doctor();
    expect(view.watch).toEqual({ everyMinutes: 5, muted: [{ group: DOCTOR_CORE_GROUP, id: "context", title: "对话长度", at: "2026-11-06T13:40:00.000Z" }] });
    expect(await http.doctorUnmute({ group: DOCTOR_CORE_GROUP, id: "context" })).toEqual({ everyMinutes: 5, muted: [] });
    expect((await http.doctor()).watch?.muted).toEqual([]);
    expect(new FakeDoctorWatch().view().muted).toHaveLength(1);
  });

  test("英文：说明、不再提醒的那几行都是英文", () => {
    inEnglish();
    const html = renderToStaticMarkup(createElement(DoctorWatchSection, { watch: new FakeDoctorWatch().view(), onUnmute: noop }));
    expect(html).toContain("every 5 minutes");
    expect(html).toContain("Conversation length");
    expect(html).toContain("Remind me again");
    expect(hasChinese(html)).toBe(false);
  });
});
