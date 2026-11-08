// 消耗页顶上的 DeepSeek 余额（440，pages/more/BalanceCard.tsx + state/balance.ts）：用 React 在 Node 里渲染出来查——
// - 能用：名字、总余额（CNY 写 ¥）、其中赠送 / 充值、"能用"小签、几分钟前查的、提醒线、刷新按钮；
// - 余额不多了、余额不足（服务商说用不了了）：小签和底下那句；
// - 这次没查成：写原因，有上次查到的照旧显示；没有的只写原因；
// - 没配 Key：只一句"在 设置 · 模型 填了 DeepSeek 的 Key 才能看余额"，没有刷新按钮；
// - 刚刷过（nextRefreshAt 之前）按钮灰着；正在查写"正在查…"；
// - 打开页面先写"正在查余额…"（取数据在 effect 里）；
// - 原型编的余额（prototype/fake-balance.ts）：?demo-balance= 换样子，英文是美元；英文里没有中文，界面上不出现"秘书"。
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { BalanceCard, ProviderBalanceBlock } from "../../src/pages/more/BalanceCard.tsx";
import { hasChinese } from "../../src/prototype/fake-content.ts";
import { FakeBalance } from "../../src/prototype/fake-balance.ts";
import { activeLocaleFrom, balanceAgo, balanceLowLine, balanceRefreshWait, balanceStatus, balanceWhy, DEFAULT_LANGUAGE, type ProviderBalance, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const NOW = Date.parse("2026-11-08T10:00:00+08:00");
const LOW_BELOW = { CNY: 10, USD: 1.5 };
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const noop = () => {};

const inEnglish = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
afterEach(() => {
  setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
  vi.unstubAllGlobals();
});

function entry(extra: Partial<ProviderBalance> = {}): ProviderBalance {
  return {
    provider: "deepseek",
    label: "DeepSeek",
    configured: true,
    result: { available: true, balances: [{ currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" }], checkedAt: ago(3), low: false },
    ...extra,
  };
}

const render = (e: ProviderBalance, opts: { refreshing?: boolean; now?: number } = {}) =>
  renderToStaticMarkup(createElement(ProviderBalanceBlock, { entry: e, lowBelow: LOW_BELOW, now: opts.now ?? NOW, refreshing: opts.refreshing ?? false, onRefresh: noop }));

/** 去掉标签，只看字 */
const textOf = (html: string) => html.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");

describe("余额那一块的几种样子", () => {
  test("能用：名字、总余额（¥）、其中赠送 / 充值、能用、几分钟前查的、提醒线、刷新按钮", () => {
    const html = render(entry());
    const text = textOf(html);
    expect(html).toContain('class="balance-card balance-available"');
    expect(text).toContain("DeepSeek 余额");
    expect(text).toContain("¥110.00");
    expect(text).toContain("总余额");
    expect(text).toContain("其中赠送 ¥10.00 · 充值 ¥100.00");
    expect(html).toMatch(/class="chip balance-state chip-ok"[^>]*>能用</);
    expect(text).toContain("3 分钟前查的");
    expect(text).toContain("低于 ¥10 提醒");
    expect(html).toMatch(/<button[^>]*class="btn ghost small balance-refresh"[^>]*>刷新<\/button>/);
    expect(html).not.toMatch(/balance-refresh"[^>]*disabled/);
    expect(text).not.toContain("秘书");
  });

  test("余额不多了：小签是注意的颜色；余额不足：小签是坏了的颜色，底下一句说充值或换模型", () => {
    const low = render(entry({ result: { available: true, balances: [{ currency: "CNY", total: "7.35", granted: "0.00", toppedUp: "7.35" }], checkedAt: ago(1), low: true } }));
    expect(low).toContain("balance-card balance-low");
    expect(low).toMatch(/chip-op"[^>]*>余额不多了</);
    expect(textOf(low)).toContain("¥7.35");
    const out = render(entry({ result: { available: false, balances: [{ currency: "CNY", total: "0.00", granted: "0.00", toppedUp: "0.00" }], checkedAt: ago(0), low: true } }));
    expect(out).toContain("balance-card balance-unavailable");
    expect(out).toMatch(/chip-no"[^>]*>余额不足</);
    expect(textOf(out)).toContain("刚查的");
    expect(textOf(out)).toContain("DeepSeek 说余额不够调接口了");
  });

  test("这次没查成：写原因；有上次查到的照旧显示，没有的只写原因", () => {
    const kept = textOf(render(entry({ failure: { problem: "timeout", at: ago(0) } })));
    expect(kept).toContain("这次没查成：DeepSeek 超时没回，等一会儿再刷新。下面是上次查到的");
    expect(kept).toContain("¥110.00");
    const none = render({ provider: "deepseek", label: "DeepSeek", configured: true, failure: { problem: "key_invalid", status: 401, at: ago(0) } });
    expect(textOf(none)).toContain("这次没查成：Key 不对（DeepSeek 不认这个 Key），到 设置 · 模型 核对");
    expect(none).not.toContain("balance-total");
    expect(none).toContain("balance-refresh");
  });

  test("没配 Key：只一句话，没有刷新按钮", () => {
    const html = render({ provider: "deepseek", label: "DeepSeek", configured: false });
    expect(textOf(html).trim()).toBe("在 设置 · 模型 填了 DeepSeek 的 Key 才能看余额");
    expect(html).not.toContain("button");
  });

  test("刚刷过按钮灰着（悬停写还要几秒）；正在查写\"正在查…\"", () => {
    const wait = render(entry({ nextRefreshAt: new Date(NOW + 7_000).toISOString() }));
    expect(wait).toMatch(/<button[^>]*disabled=""[^>]*title="刚查过，7 秒后能再刷新"/);
    const busy = render(entry(), { refreshing: true });
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>正在查…<\/button>/);
  });

  test("打开页面先写\"正在查余额…\"（取数据在 effect 里）", () => {
    const store = { connection: {} as Connection, http: { balance: () => new Promise(noop) } as unknown as DaemonHttp } as ComponentProps<typeof StoreProvider>;
    expect(textOf(renderToStaticMarkup(createElement(StoreProvider, store, createElement(BalanceCard))))).toContain("正在查余额…");
  });

  test("英文：数和小签换成英文，单复数", () => {
    inEnglish();
    const text = textOf(render(entry({ result: { available: true, balances: [{ currency: "USD", total: "12.34", granted: "1.00", toppedUp: "11.34" }], checkedAt: ago(1), low: false } })));
    expect(text).toContain("DeepSeek balance");
    expect(text).toContain("$12.34");
    expect(text).toContain("Granted $1.00 · topped up $11.34");
    expect(text).toContain("Checked 1 minute ago");
    expect(text).toContain("Alert below $1.5");
    expect(hasChinese(text)).toBe(false);
  });
});

describe("余额的纯函数", () => {
  test("状态、几分钟前、原因、提醒线、还要等几秒", () => {
    expect(balanceStatus({ available: true, low: false })).toBe("available");
    expect(balanceStatus({ available: true, low: true })).toBe("low");
    expect(balanceStatus({ available: false, low: true })).toBe("unavailable");
    expect(balanceAgo(ago(0.5), NOW)).toBe("刚查的");
    expect(balanceAgo(ago(59), NOW)).toBe("59 分钟前查的");
    expect(balanceAgo(ago(125), NOW)).toBe("2 小时前查的");
    expect(balanceAgo(ago(60 * 30), NOW)).toMatch(/查的$/);
    expect(balanceWhy("rate_limited", "DeepSeek")).toBe("查得太频繁，被限流了，等一会儿再刷新");
    expect(balanceLowLine(entry(), LOW_BELOW)).toBe("¥10");
    expect(balanceLowLine({ result: { available: true, balances: [{ currency: "EUR", total: "1", granted: "0", toppedUp: "1" }], checkedAt: ago(0), low: false } }, LOW_BELOW)).toBe("");
    expect(balanceRefreshWait({}, NOW)).toBe(0);
    expect(balanceRefreshWait({ nextRefreshAt: new Date(NOW + 2_500).toISOString() }, NOW)).toBe(3);
    expect(balanceRefreshWait({ nextRefreshAt: new Date(NOW - 1).toISOString() }, NOW)).toBe(0);
  });
});

describe("原型编的余额", () => {
  test("平常能用；?demo-balance=low / out / none / failed 换样子；英文是美元、没有中文", async () => {
    const fake = new FakeBalance();
    const normal = fake.view().providers[0]!;
    expect(normal).toMatchObject({ configured: true, result: { available: true, low: false, balances: [{ currency: "CNY", total: "86.40" }] } });
    vi.stubGlobal("location", { search: "?demo-balance=low" });
    expect(fake.view().providers[0]!.result).toMatchObject({ available: true, low: true });
    vi.stubGlobal("location", { search: "?demo-balance=out" });
    expect(fake.view().providers[0]!.result).toMatchObject({ available: false, low: true });
    vi.stubGlobal("location", { search: "?demo-balance=none" });
    expect(fake.view().providers[0]).toEqual({ provider: "deepseek", label: "DeepSeek", configured: false });
    vi.stubGlobal("location", { search: "?demo-balance=failed" });
    expect(fake.view().providers[0]).toMatchObject({ failure: { problem: "timeout" }, result: { available: true } });
    vi.unstubAllGlobals();
    // 刷新：查的时刻换成现在、10 秒内不让再刷
    const refreshed = (await fake.refresh()).providers[0]!;
    expect(Date.now() - Date.parse(refreshed.result!.checkedAt)).toBeLessThan(5_000);
    expect(refreshed.nextRefreshAt).toBeDefined();
    inEnglish();
    const en = fake.view().providers[0]!;
    expect(en.result?.balances[0]).toMatchObject({ currency: "USD" });
    expect(hasChinese(JSON.stringify(en))).toBe(false);
  });
});
