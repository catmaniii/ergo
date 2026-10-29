// Google 插件的网页这一半（297 号票）：设置 · 数据源里 Google · 日历下面那一块（dataSources 插槽），用 React 在 Node 里渲染出来查——
// - 订阅的几个日历：名字、打了码的地址和几个事件、拉不到的原因，每个能删；
// - 加一个日历：私密地址是密码框（不回显）、名字可以不填、没填地址时按钮不能点；做完说一句、没做成写原因；
// - 怎么拿私密地址（Google 日历网页版的设置里），写明地址相当于密码；
// - 298 号票 Google · Gmail 下面那一块：Gmail 地址、应用专用密码（密码框、不回显）、连上并测试；连上以后能换密码、重新测试；
//   怎么开两步验证、生成应用专用密码（没连时展开），写明只读、密码存在哪、改 Google 密码会失效、什么情况没有这一项；
// - 301 号票：Google · 联系人下面那一块——进候选的是谁、一张卡几个人、怎么从 Google 联系人导出 vCard；
// - 插件定义：拥有 google-calendar、google-gmail、google-contacts 这三块、登记的就是它们。
// 界面上不出现"秘书""待我处理"。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { GoogleCalendarFields, type GoogleCalendarFieldsProps } from "../../src/plugins/google/GoogleCalendarPanel.tsx";
import { GoogleContactsPanel } from "../../src/plugins/google/GoogleContactsPanel.tsx";
import { GoogleGmailFields, type GoogleGmailFieldsProps } from "../../src/plugins/google/GoogleGmailPanel.tsx";
import { googleWebPlugin } from "../../src/plugins/google/plugin.tsx";
import type { DataSourceView } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};

function calendar(extra: Partial<DataSourceView> = {}): DataSourceView {
  return {
    id: "google-calendar",
    title: "Google · 日历",
    summary: "",
    plugin: "google",
    pluginTitle: "Google",
    available: true,
    connection: "connected",
    usages: [],
    sensitive: [],
    count: 57,
    syncing: false,
    canSync: true,
    files: [],
    configurable: true,
    items: [
      { id: "g3f2a9c01de", title: "工作", detail: "calendar.google.com · y***@gmail.com · 48 个事件" },
      { id: "g7b11e40c2a", title: "家里", detail: "calendar.google.com · f***@group.calendar.google.com · 9 个事件", problem: "地址失效了（Google 回了 404）" },
    ],
    ...extra,
  };
}

const render = (props: Partial<GoogleCalendarFieldsProps> = {}) =>
  renderToStaticMarkup(
    createElement(GoogleCalendarFields, { source: calendar(), address: "", name: "", busy: false, done: undefined, failed: undefined, onAddress: noop, onName: noop, onAdd: noop, onRemove: noop, ...props }),
  );

describe("Google · 日历下面那一块", () => {
  test("订阅的几个日历：名字、打了码的地址和几个事件、拉不到的原因，每个能删", () => {
    const html = render();
    expect(html).toContain("<b>工作</b>");
    expect(html).toContain("calendar.google.com · y***@gmail.com · 48 个事件");
    expect(html).toContain('<span class="field-error">地址失效了（Google 回了 404）</span>');
    expect(html.match(/>删掉</g)).toHaveLength(2);
    expect(html).toContain('aria-label="删掉日历「家里」"');
    expect(html).toContain("再加一个日历（iCal 格式的私密地址）");
  });

  test("还没有日历：只有加一个的表单；地址是密码框、没填时按钮不能点；怎么拿私密地址写在下面", () => {
    const html = render({ source: calendar({ connection: "not_connected", items: undefined, count: 0 }) });
    expect(html).not.toContain(">删掉<");
    expect(html).toContain("<span>iCal 格式的私密地址</span>");
    expect(html).toMatch(/<input class="input" type="password" autoComplete="off"/);
    expect(html).toMatch(/<button type="submit" class="btn primary small" disabled="">添加并测试连接<\/button>/);
    expect(html).toContain("怎么拿私密地址");
    expect(html).toContain("复制「iCal 格式的私密地址」，贴到上面");
    expect(html).toContain("这个地址相当于密码");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("填了地址才能点；正在测试连接时按钮写明；做完说一句、没做成写原因", () => {
    expect(render({ address: "https://calendar.google.com/x/basic.ics" })).toMatch(/<button type="submit" class="btn primary small">添加并测试连接<\/button>/);
    expect(render({ address: "x", busy: true })).toContain("正在测试连接……");
    expect(render({ done: "加好了，同步进来 6 条" })).toContain('<div class="hint">加好了，同步进来 6 条</div>');
    expect(render({ failed: "没做成：连不上" })).toContain('<div class="field-error" role="alert">没做成：连不上</div>');
  });
});

describe("Google · 联系人下面那一块", () => {
  test("进候选的是谁、一张卡最多 10 个人、怎么从 Google 联系人导出 vCard", () => {
    const html = renderToStaticMarkup(createElement(GoogleContactsPanel));
    expect(html).toContain("进候选的是有生日、纪念日、关系的人，和档案里已经有的人");
    expect(html).toContain("一张核对卡最多 10 个人，处理完接着上下一批；同一份再放一次不会重复问。");
    expect(html).toContain("怎么导出 Google 联系人");
    expect(html).toContain("格式选「vCard（适用于 iOS 通讯录）」");
    expect(html).toContain("contacts.vcf 放进下面的导入文件夹");
    expect(html).not.toMatch(/秘书|待我处理/);
  });
});

describe("插件定义", () => {
  test("名字和守护进程的一样（google）；拥有、登记的都是 google-calendar、google-gmail、google-contacts 这三块", () => {
    expect(googleWebPlugin.name).toBe("google");
    expect(googleWebPlugin.owns).toEqual({ dataSources: ["google-calendar", "google-gmail", "google-contacts"] });
    const host = createWebPluginHost({ plugins: [googleWebPlugin], log: () => {} });
    host.apply([{ name: "google", title: "Google", state: "running" }]);
    expect(host.list("dataSources").map((e) => e.id)).toEqual(["google-calendar", "google-gmail", "google-contacts"]);
    host.apply([{ name: "google", title: "Google", state: "disabled" }]);
    expect(host.list("dataSources")).toEqual([]);
    expect(host.unavailable("dataSources", "google-calendar")).toBe("Google");
    expect(host.unavailable("dataSources", "google-gmail")).toBe("Google");
  });
});

function gmail(extra: Partial<DataSourceView> = {}): DataSourceView {
  return {
    id: "google-gmail",
    title: "Google · Gmail",
    summary: "",
    plugin: "google",
    pluginTitle: "Google",
    available: true,
    connection: "not_connected",
    usages: [],
    sensitive: [],
    count: 0,
    syncing: false,
    canSync: false,
    files: [],
    configurable: true,
    ...extra,
  };
}

const renderGmail = (props: Partial<GoogleGmailFieldsProps> = {}) =>
  renderToStaticMarkup(
    createElement(GoogleGmailFields, { source: gmail(), address: "", password: "", busy: false, done: undefined, failed: undefined, onAddress: noop, onPassword: noop, onSave: noop, onRetest: noop, ...props }),
  );

describe("Google · Gmail 下面那一块", () => {
  test("没连：Gmail 地址、应用专用密码（密码框）、连上并测试（都填了才能点）；怎么生成应用专用密码展开着，写明两步验证、只读、密码存在哪、失效、没有这一项", () => {
    const html = renderGmail();
    expect(html).toContain("<span>Gmail 地址</span>");
    expect(html).toMatch(/<input class="input" type="email" autoComplete="off"/);
    expect(html).toContain("<span>应用专用密码</span>");
    expect(html).toMatch(/<input class="input" type="password" autoComplete="new-password"/);
    expect(html).toMatch(/<button type="submit" class="btn primary small" disabled="">连上并测试<\/button>/);
    expect(html).not.toContain("重新测试连接");
    expect(html).toContain('<details class="gcal-howto" open="">');
    expect(html).toContain("怎么生成应用专用密码");
    expect(html).toContain("先把「两步验证」打开");
    expect(html).toContain("myaccount.google.com/apppasswords");
    expect(html).toContain("不发信、不删信、不改已读未读");
    expect(html).toContain("只把它存在这台电脑的密钥区");
    expect(html).toContain("改了 Google 账号密码，所有应用专用密码都会失效");
    expect(html).toContain("开了高级保护时，Google 不给这一项");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("地址和密码都填了才能点；正在测试时按钮写明；做完说一句、没做成写原因；密码框不回显填的", () => {
    expect(renderGmail({ address: "test.user@example.com" })).toMatch(/disabled="">连上并测试</);
    expect(renderGmail({ address: "test.user@example.com", password: "abcd efgh ijkl mnop" })).toMatch(/<button type="submit" class="btn primary small">连上并测试<\/button>/);
    expect(renderGmail({ address: "x@example.com", password: "p", busy: true })).toContain("正在测试连接……");
    expect(renderGmail({ done: "连上了" })).toContain('<div class="hint">连上了</div>');
    expect(renderGmail({ failed: "没做成：连不上" })).toContain('<div class="field-error" role="alert">没做成：连不上</div>');
  });

  test("连上了：换一个地址（可以空着）、换密码并测试（只填密码就能点）、重新测试连接；说明收起来", () => {
    const connected = gmail({ connection: "connected", account: "t***@example.com" });
    const html = renderGmail({ source: connected });
    expect(html).toContain("换一个 Gmail 地址（不换就空着）");
    expect(html).toMatch(/disabled="">换密码并测试</);
    expect(html).toContain('<button type="button" class="btn ghost small">重新测试连接</button>');
    expect(html).toContain('<details class="gcal-howto">');
    expect(renderGmail({ source: connected, password: "newpasswordabcd" })).toMatch(/<button type="submit" class="btn primary small">换密码并测试<\/button>/);
    // 登录没通过（密码失效）时也按"已经填过"画
    expect(renderGmail({ source: gmail({ connection: "error", account: "t***@example.com", problem: "登录 Gmail 没通过" }) })).toContain("重新测试连接");
  });
});
