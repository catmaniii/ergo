// 设置 · 服务（428，pages/more/ServicesPage.tsx + state/managed-services.ts）：用 React 在 Node 里渲染出来查——
// - 一个服务一块：名字、状态、id、端口、在跑多久、为什么和二狗有关、最近一次出错；
// - 受保护的（二狗自己、外网隧道、tailnet 网关、二狗离不开的）写原因、没有停止 / 重启 / 强制停止按钮、开着的开机自启关不掉；
// - 没在跑的给"启动"，有正常停止办法的在跑时多一个"强制停止"；强制停止、关开机自启要先确认，别的不用；
// - 操作的结果照实说（强制停了、服务管家拒的原因、超时）；
// - 取不到列表的几种（没接入、没连上、太老、服务管家没给）各一句；
// - 原型的假服务管家里混着和二狗无关的（短剧站、画图和它的隧道），挑出来的没有它们；
// - 英文、界面上不出现"秘书""待我处理"。
// 设置列表里的位置见 settings-groups.test.ts；页面打得开见 page-opens.test.ts。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ServiceLogsBlock, ServicesList, servicesStatusText } from "../../src/pages/more/ServicesPage.tsx";
import { FakeManagedServices } from "../../src/prototype/fake-managed-services.ts";
import {
  activeLocale,
  activeLocaleFrom,
  type ManagedServicesView,
  type ManagedServiceView,
  managedServiceActionNeedsConfirm,
  managedServiceActions,
  managedServiceAutostartLocked,
  managedServiceMeta,
  managedServiceName,
  managedServiceResultText,
  setActiveLocale,
} from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const NOW = Date.UTC(2026, 10, 7, 10, 0, 0);
const HOUR = 3_600_000;

function svc(id: string, extra: Partial<ManagedServiceView> = {}): ManagedServiceView {
  return {
    id,
    title: id,
    state: "RUNNING",
    up: true,
    port: null,
    autostart: false,
    since: NOW - HOUR,
    lastError: null,
    uses: ["owned"],
    canStop: true,
    canRestart: true,
    busy: false,
    busyReason: null,
    pendingStop: false,
    ...extra,
  };
}

const SERVICES: ManagedServiceView[] = [
  svc("ergo-daemon", { title: "二狗", port: 8810, autostart: true, since: NOW - 3 * HOUR - 12 * 60_000, uses: ["self"], protection: { kind: "self", why: ["调用方自己"] } }),
  svc("audiocpp", { title: "语音合成（audio.cpp）", port: 8090, state: "FAILED", up: false, since: null, autostart: true, canStop: false, canRestart: false, uses: ["speech", "dependency"], lastError: "进程启动 3 秒后退出" }),
  svc("ergo-tunnel", { title: "二狗的外网隧道", uses: ["tunnel"], autostart: true, protection: { kind: "tunnel", why: ["ergo-daemon 的公网隧道（exposure.via）"] } }),
  svc("ergo-asr", { title: "语音识别", port: 8091, uses: ["recognizer"], protection: { kind: "other", why: ["注册表里标了 lifeline: true"] } }),
  svc("ergo-daemon--p-ledger-web", { title: "记账本 · 网页", port: 18600, pendingStop: true, busy: true, busyReason: "有 2 个请求在处理" }),
  svc("notes-sync", { title: "笔记同步", state: "STOPPED", up: false, since: null, uses: ["marked"] }),
  svc("cpu-only", { title: "没有停机办法的", canStop: false, canRestart: false }),
];

const view = (services = SERVICES, extra: Partial<ManagedServicesView> = {}): ManagedServicesView => ({ support: "supported", services, at: NOW, ...extra });
const noop = () => {};
const render = (v: ManagedServicesView, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ServicesList, { view: v, now: NOW, results: {}, onAct: noop, onToggleLogs: noop, ...extra }));
/** 一个服务那一块的 HTML */
const card = (html: string, id: string) => {
  const start = html.indexOf(`data-service="${id}"`);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
};
const buttons = (html: string) => [...html.matchAll(/data-action="([a-z_]+)"/g)].map((m) => m[1]);

const before = activeLocale();
afterEach(() => setActiveLocale(before));

describe("一个服务一块", () => {
  test("名字、状态、id、端口、在跑多久、用途；没在跑的写最近一次出错", () => {
    const html = render(view());
    const daemon = card(html, "ergo-daemon");
    expect(daemon).toContain("二狗");
    expect(daemon).toContain("在跑");
    expect(daemon).toContain("ergo-daemon · 端口 8810 · 已运行 3 小时 12 分钟");
    expect(daemon).toContain("二狗自己");
    const audio = card(html, "audiocpp");
    expect(audio).toContain("出错了");
    expect(audio).toContain("语音合成</span>");
    expect(audio).toContain("二狗要靠它");
    expect(audio).toContain("最近一次出错：进程启动 3 秒后退出");
    expect(card(html, "notes-sync")).toContain("登记里标了和二狗有关");
    expect(card(html, "ergo-daemon--p-ledger-web")).toContain("正忙：有 2 个请求在处理");
    expect(card(html, "ergo-daemon--p-ledger-web")).toContain("等它空闲了就停");
  });

  test("受保护的写原因，没有停止、重启、强制停止；开着的开机自启关不掉（开关灰着）", () => {
    const html = render(view());
    const daemon = card(html, "ergo-daemon");
    expect(daemon).toContain("受保护");
    expect(daemon).toContain("这是二狗自己");
    expect(buttons(daemon)).toEqual(["logs", "autostart"]);
    expect(daemon).toMatch(/data-action="autostart"[^>]*disabled/);
    expect(card(html, "ergo-tunnel")).toContain("这是二狗的外网隧道，停了手机就连不上二狗");
    expect(card(html, "ergo-asr")).toContain("二狗离不开它（服务管家说：注册表里标了 lifeline: true）");
    // 受保护的、开机自启关着的：可以开
    expect(managedServiceAutostartLocked(SERVICES[3]!)).toBe(false);
    expect(buttons(card(html, "ergo-asr"))).toEqual(["logs", "autostart"]);
  });

  test("能点的：没在跑的启动；在跑的停止、重启，有正常停止办法的多一个强制停止；挂着等空闲再停的能取消", () => {
    const html = render(view());
    expect(buttons(card(html, "audiocpp"))).toEqual(["start", "logs", "autostart"]);
    expect(buttons(card(html, "notes-sync"))).toEqual(["start", "logs", "autostart"]);
    expect(buttons(card(html, "ergo-daemon--p-ledger-web"))).toEqual(["stop", "restart", "force_stop", "cancel_stop", "logs", "autostart"]);
    // 没有正常停止办法的：停止、重启会直接强制，不另给强制停止，写一句提醒
    const cpu = card(html, "cpu-only");
    expect(buttons(cpu)).toEqual(["stop", "restart", "logs", "autostart"]);
    expect(cpu).toContain("没有正常的停止办法");
    // 正在起：等它；正在停、卡着的：强制停
    expect(managedServiceActions(svc("x", { state: "STARTING", up: false }))).toEqual([]);
    expect(managedServiceActions(svc("x", { state: "STOPPING", up: false }))).toEqual(["force_stop"]);
    expect(managedServiceActions(svc("x", { state: "STOPPING", up: false, protection: { kind: "self", why: [] } }))).toEqual([]);
  });

  test("强制停止、关开机自启先确认；启动、停止、重启、开开机自启、取消不用", () => {
    expect(["force_stop", "autostart_off"].map((a) => managedServiceActionNeedsConfirm(a as never))).toEqual([true, true]);
    expect(["start", "stop", "restart", "autostart_on", "cancel_stop"].map((a) => managedServiceActionNeedsConfirm(a as never))).toEqual([false, false, false, false, false]);
  });

  test("体检里点过来的那一块描一圈；展开的日志在那一块里", () => {
    const html = render(view(), { focus: "audiocpp", logsOpen: "audiocpp", renderLogs: (id: string) => createElement("div", { className: "probe" }, id) });
    expect(html).toContain(`class="service-row service-focus" data-service="audiocpp"`);
    expect(card(html, "audiocpp")).toContain('class="probe">audiocpp');
    expect(card(html, "notes-sync")).not.toContain("probe");
  });

  test("没在跑、不知道从什么时候起的不写在跑多久；没有端口的不写端口", () => {
    expect(managedServiceMeta(svc("x", { up: false, since: null }), NOW)).toEqual([]);
    expect(managedServiceMeta(svc("x", { port: 1, since: NOW - 30_000 }), NOW)).toEqual(["端口 1", "已运行 不到 1 分钟"]);
  });
});

describe("结果照实说", () => {
  const name = managedServiceName(SERVICES[1]!);
  test("做成了：强制停了写明、正忙排上、本来就是、服务管家交代的跟在后面", () => {
    expect(name).toBe("「语音合成（audio.cpp）」（audiocpp）");
    expect(managedServiceResultText({ ok: true, action: "stop", forced: true }, name).text).toBe("「语音合成（audio.cpp）」（audiocpp）没有正常的停止办法，已经强制停下（它手上正在做的断了）。");
    expect(managedServiceResultText({ ok: true, action: "restart", forced: true }, name).text).toContain("已经强制重启");
    expect(managedServiceResultText({ ok: true, action: "stop", pending: true, note: "服务正忙，停机已排队" }, name).text).toBe("「语音合成（audio.cpp）」（audiocpp）正忙，等它空闲了再停。 服务管家说：服务正忙，停机已排队");
    expect(managedServiceResultText({ ok: true, action: "start", already: true }, name).text).toContain("本来就在跑");
    expect(managedServiceResultText({ ok: true, action: "autostart_off" }, name)).toEqual({ ok: true, text: "「语音合成（audio.cpp）」（audiocpp）以后不再开机自启，现在在跑的不受影响。" });
  });

  test("没做成：受保护的写原因，服务管家拒的、超时、断线、不是和二狗有关的各一句", () => {
    expect(managedServiceResultText({ ok: false, action: "stop", code: "protected", message: "调用方自己" }, "二狗", { kind: "self", why: ["调用方自己"] })).toEqual({
      ok: false,
      text: "没做：这是二狗自己，不能在这里停止、重启或关掉开机自启。",
    });
    expect(managedServiceResultText({ ok: false, action: "stop", code: "protected", message: "它是命脉" }, "x").text).toContain("服务管家说：它是命脉");
    expect(managedServiceResultText({ ok: false, action: "start", code: "failed", message: "端口 8090 被占着" }, "x").text).toBe("没做成：端口 8090 被占着");
    expect(managedServiceResultText({ ok: false, action: "start", code: "timeout", message: "" }, "x").text).toContain("可能做了也可能没做");
    expect(managedServiceResultText({ ok: false, action: "start", code: "not-related", message: "" }, "drama-server").text).toContain("不是和二狗有关的服务");
  });
});

describe("取不到列表", () => {
  test("没接入、没连上、太老、服务管家没给、一个都没有：各一句", () => {
    expect(servicesStatusText(view([], { support: "disabled" }))).toContain("不是由服务管家拉起来的");
    expect(servicesStatusText(view([], { support: "waiting" }))).toContain("还没连上服务管家");
    expect(servicesStatusText(view([], { support: "unsupported" }))).toContain("版本太旧");
    expect(servicesStatusText(view([], { error: { code: "timeout", message: "服务管家 30 秒没回话" } }))).toBe("服务管家没给列表：服务管家 30 秒没回话");
    expect(servicesStatusText(view([]))).toBe("服务管家里没有和二狗有关的服务。");
    expect(servicesStatusText(view())).toBeUndefined();
    expect(render(view([], { support: "waiting" }))).toContain('data-support="waiting"');
  });
});

describe("日志", () => {
  test("一份的写名字，几份的能换；截掉了写一句；取不到写原因", () => {
    const one = renderToStaticMarkup(createElement(ServiceLogsBlock, { logs: { ok: true, id: "a", source: 0, label: "命令行输出", lines: ["ready", "hf_token=***"], cut: true, sources: [{ source: 0, label: "命令行输出" }] }, loading: false, onSource: noop }));
    expect(one).toContain("命令行输出");
    expect(one).toContain("ready\nhf_token=***");
    expect(one).toContain("太长了，只留最后 2 行");
    const two = renderToStaticMarkup(createElement(ServiceLogsBlock, { logs: { ok: true, id: "a", source: 1, label: "server", lines: [], cut: false, sources: [{ source: 0, label: "命令行输出" }, { source: 1, label: "server" }] }, loading: true, onSource: noop }));
    expect(two).toContain('<button type="button" class="chip">命令行输出</button>');
    expect(two).toContain('class="chip chip-op">server');
    expect(two).toContain("还没有日志");
    expect(two).toContain("data-loading");
    expect(renderToStaticMarkup(createElement(ServiceLogsBlock, { logs: { ok: false, id: "a", code: "not-found", message: "没有第 3 份日志" }, loading: false, onSource: noop }))).toContain("没取到日志：没有第 3 份日志");
  });
});

describe("原型的假服务管家", () => {
  test("混着和二狗无关的（短剧站、画图和它的隧道）：挑出来的没有它们，二狗自己在最前", async () => {
    const fake = new FakeManagedServices();
    const v = await fake.view();
    const ids = v.services.map((s) => s.id);
    expect(ids[0]).toBe("ergo-daemon");
    for (const id of ["drama-server", "comfyui", "comfy-tunnel"]) expect(ids.includes(id) ? id : undefined).toBeUndefined();
    expect(ids).toEqual(["ergo-daemon", "audiocpp", "ergo-asr", "ergo-tunnel", "tail-gw", "ergo-daemon--p-ledger-web", "notes-sync"]);
    const html = render(v);
    expect(html).not.toContain("短剧站");
    expect(html).not.toContain("画图");
    // 受保护的本地拒；没有正常停止办法的强制停；无关的不认
    expect(await fake.act("ergo-daemon", "stop")).toMatchObject({ ok: false, code: "protected" });
    expect(await fake.act("drama-server", "stop")).toMatchObject({ ok: false, code: "not-related" });
    expect(await fake.act("audiocpp", "start")).toMatchObject({ ok: true, service: { state: "RUNNING" } });
    expect(await fake.act("audiocpp", "stop")).toMatchObject({ ok: true, forced: true });
  }, 10_000);
});

describe("英文", () => {
  test("整块都是英文，没有\"秘书\"\"待我处理\"", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    // 服务管家写的原因、名字是数据（原型里有英文表），这里换成英文的
    const english = SERVICES.map(({ protection, ...s }) => ({ ...s, title: s.id, lastError: s.lastError ? "exited" : null, busyReason: null, ...(protection ? { protection: { ...protection, why: ["lifeline"] } } : {}) }));
    const html = render(view(english));
    expect(html).toContain("Running");
    expect(html).toContain("This is ergo itself");
    expect(html).toContain("Up ");
    expect(html).not.toMatch(/[一-鿿]/);
    setActiveLocale(before);
    const zh = render(view());
    expect(zh).not.toContain("秘书");
    expect(zh).not.toContain("待我处理");
  });
});
