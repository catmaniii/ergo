// 服务商余额（440）的模块层测试：DeepSeek 查余额（本机的假接口回放官方文档的样例，不连真的 DeepSeek、只用假 Key）——
// - 正常：照文档的字段换成总余额、其中赠送 / 充值，带 Bearer Key 发到 /user/balance；多个币种、赠送和充值各自原样；
// - 余额不多了：用不了（is_available: false）、每个币种都低于提醒线；有一个币种够就不算；
// - 出错照实记：401（Key 不对）、429、500、别的状态码和看不懂的正文、超时、连不上；
// - 缓存和刷新：几分钟内不再打接口、一起来的请求只查一次、过了缓存期再查、没查成的一分钟后再查、刷新马上重查、10 秒内不重复查；
// - 没配 Key 不查；换了 Key 上一次的作废；Key 不进结果、日志（401 的正文里带着 Key 的末几位也不进）；
// - 用哪个 Key：DeepSeek 服务商的，接口地址是 api.deepseek.com 的自定义服务商的也算；
// - 秘书的 check_balance 写给模型的那段话、体检的"DeepSeek 余额"那一项（只读缓存）。
import { CUSTOM_PROVIDER_ID, type ProviderBalanceView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { judgeBalance } from "../src/doctor/balance.ts";
import {
  BALANCE_CACHE_MS,
  BALANCE_REFRESH_GAP_MS,
  BALANCE_RETRY_FAILED_MS,
  balanceLow,
  balanceReport,
  CHECK_BALANCE_TOOL,
  checkBalanceTool,
  createProviderBalances,
  deepseekBalanceKey,
  deepseekBalanceSource,
  isDeepSeekUrl,
  parseDeepSeekBalance,
} from "../src/model-settings/index.ts";
import { balanceError, DOC_SAMPLE_BALANCE, type FakeBalanceReply, startFakeDeepSeekBalance } from "./helpers/fake-deepseek-balance.ts";
import { fakeSecret } from "./helpers/fake-secrets.ts";
import { freePort } from "./helpers/ports.ts";

const KEY = fakeSecret("sk-", "unit-440-balance-not-real-Zx91");
const OTHER_KEY = fakeSecret("sk-", "unit-440-other-key-not-real-Pq55");
const T0 = Date.parse("2026-11-08T10:00:00+08:00");

/** 一套：假接口、手拨的时钟、日志、Key 现取（测试里能换） */
async function setup(script?: FakeBalanceReply | ((n: number) => FakeBalanceReply), opts: { key?: string | undefined; timeoutMs?: number } = {}) {
  const fake = await startFakeDeepSeekBalance(script);
  const clock = { now: T0 };
  const logs: string[] = [];
  const state = { key: "key" in opts ? opts.key : KEY };
  const balances = createProviderBalances({
    sources: [deepseekBalanceSource({ key: () => state.key, baseUrl: fake.baseUrl })],
    now: () => clock.now,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    log: (line) => logs.push(line),
  });
  return { fake, clock, logs, state, balances };
}

const deepseek = (view: ProviderBalanceView) => view.providers.find((p) => p.provider === "deepseek")!;

describe("DeepSeek 查余额：照官方文档的字段", () => {
  it("正常：文档的样例 → 能用、CNY 总余额 110.00，其中赠送 10.00、充值 100.00；Bearer Key 发到 GET /user/balance", async () => {
    const { fake, balances } = await setup();
    const view = await balances.view();
    expect(deepseek(view)).toEqual({
      provider: "deepseek",
      label: "DeepSeek",
      configured: true,
      result: { available: true, balances: [{ currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" }], checkedAt: expect.any(String), low: false },
      nextRefreshAt: expect.any(String),
    });
    expect(view.lowBelow).toEqual({ CNY: 10, USD: 1.5 });
    expect(fake.requests).toEqual([{ method: "GET", path: "/user/balance", authorization: `Bearer ${KEY}` }]);
  });

  it("赠送和充值：几个币种各自原样（数是字符串、不换算），币种大写", () => {
    const reading = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "3.50", granted_balance: "3.50", topped_up_balance: "0.00" },
        { currency: "usd", total_balance: "20.00", granted_balance: "0.00", topped_up_balance: "20.00" },
      ],
    });
    expect(reading).toEqual({
      available: true,
      balances: [
        { currency: "CNY", total: "3.50", granted: "3.50", toppedUp: "0.00" },
        { currency: "USD", total: "20.00", granted: "0.00", toppedUp: "20.00" },
      ],
    });
    // 有一个币种够就不算不多；都低于提醒线才算
    expect(balanceLow(reading!)).toBe(false);
    expect(balanceLow({ available: true, balances: [{ currency: "CNY", total: "9.99", granted: "0", toppedUp: "9.99" }] })).toBe(true);
    expect(balanceLow({ available: true, balances: [{ currency: "CNY", total: "10.00", granted: "0", toppedUp: "10.00" }] })).toBe(false);
    expect(balanceLow({ available: true, balances: [] })).toBe(false);
    // 不是文档里的样子：看不懂
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeUndefined();
    expect(parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: "CNY" }] })).toBeUndefined();
    expect(parseDeepSeekBalance("110")).toBeUndefined();
  });

  it("is_available: false：用不了了，算余额不多（low）", async () => {
    const { balances } = await setup({ status: 200, json: { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" }] } });
    const entry = deepseek(await balances.view());
    expect(entry.result).toMatchObject({ available: false, low: true, balances: [{ currency: "CNY", total: "0.00" }] });
    expect(entry.failure).toBeUndefined();
  });

  it("401：Key 不对，记状态码；DeepSeek 正文里带的 Key 末几位、Key 本身都不进结果和日志", async () => {
    const { balances, logs } = await setup({ status: 401, json: balanceError(`Authentication Fails, Your api key: ****${KEY.slice(-4)} is invalid`, "authentication_error") });
    const view = await balances.view();
    expect(deepseek(view)).toMatchObject({ configured: true, failure: { problem: "key_invalid", status: 401 } });
    expect(deepseek(view).result).toBeUndefined();
    const all = JSON.stringify(view) + logs.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(-4));
    expect(logs).toEqual([expect.stringContaining("key_invalid 401")]);
  });

  it("别的出错：429 限流、500 服务商出错、400 和看不懂的正文算看不懂、连不上", async () => {
    const cases: Array<[FakeBalanceReply, string, number | undefined]> = [
      [{ status: 429, json: balanceError("Rate Limit Reached") }, "rate_limited", 429],
      [{ status: 503, json: balanceError("Server Overloaded") }, "server", 503],
      [{ status: 400, json: balanceError("Invalid Format") }, "bad_response", 400],
      [{ status: 200, text: "<html>oops</html>" }, "bad_response", 200],
      [{ status: 200, json: { is_available: "yes" } }, "bad_response", 200],
      [{ drop: true }, "network", undefined],
    ];
    for (const [reply, problem, status] of cases) {
      const { balances } = await setup(reply);
      const failure = deepseek(await balances.view()).failure;
      expect(failure, problem).toMatchObject({ problem });
      expect(failure?.status, problem).toBe(status);
    }
    // 端口上没人听：连不上
    const port = await freePort();
    const nobody = createProviderBalances({ sources: [deepseekBalanceSource({ key: () => KEY, baseUrl: `http://127.0.0.1:${port}` })], log: () => {} });
    expect(deepseek(await nobody.view()).failure).toMatchObject({ problem: "network" });
  });

  it("超时：到点中止这次请求，记超时（没有状态码）", async () => {
    const { balances, logs } = await setup({ hang: true }, { timeoutMs: 150 });
    const started = Date.now();
    const entry = deepseek(await balances.view());
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(entry.failure).toEqual({ problem: "timeout", at: expect.any(String) });
    expect(logs.join("\n")).toContain("timeout");
  });
});

describe("缓存和刷新", () => {
  it("几分钟内不再打接口；一起来的只查一次；过了缓存期再查", async () => {
    const { fake, clock, balances } = await setup();
    await Promise.all([balances.view(), balances.view(), balances.view()]);
    expect(fake.requests).toHaveLength(1);
    clock.now += BALANCE_CACHE_MS - 1;
    await balances.view();
    expect(fake.requests).toHaveLength(1);
    clock.now += 1;
    await balances.view();
    expect(fake.requests).toHaveLength(2);
  });

  it("没查成的过一分钟再查；查成了清掉没查成", async () => {
    const { fake, clock, balances } = await setup((n) => (n === 1 ? { status: 500, json: balanceError("Server Error") } : { status: 200, json: DOC_SAMPLE_BALANCE }));
    expect(deepseek(await balances.view()).failure).toMatchObject({ problem: "server" });
    clock.now += BALANCE_RETRY_FAILED_MS - 1;
    await balances.view();
    expect(fake.requests).toHaveLength(1);
    clock.now += 1;
    const entry = deepseek(await balances.view());
    expect(fake.requests).toHaveLength(2);
    expect(entry.failure).toBeUndefined();
    expect(entry.result?.balances[0]?.total).toBe("110.00");
  });

  it("刷新马上重查；离上一次开始查不到 10 秒的不重复查（防连点），回的带 nextRefreshAt；过了能再刷", async () => {
    const { fake, clock, balances } = await setup((n) => ({ status: 200, json: { ...DOC_SAMPLE_BALANCE, balance_infos: [{ ...DOC_SAMPLE_BALANCE.balance_infos[0]!, total_balance: `${100 + n}.00` }] } }));
    await balances.view();
    expect(fake.requests).toHaveLength(1);
    // 刚查过：刷新不重查
    clock.now += 3_000;
    const tooSoon = deepseek(await balances.refresh());
    expect(fake.requests).toHaveLength(1);
    expect(tooSoon.result?.balances[0]?.total).toBe("101.00");
    expect(Date.parse(tooSoon.nextRefreshAt!)).toBe(T0 + BALANCE_REFRESH_GAP_MS);
    // 过了防连点：马上重查（缓存期还没过也查）
    clock.now = T0 + BALANCE_REFRESH_GAP_MS;
    const fresh = deepseek(await balances.refresh());
    expect(fake.requests).toHaveLength(2);
    expect(fresh.result?.balances[0]?.total).toBe("102.00");
    // 刚刷过，再点一次不查
    await balances.refresh();
    expect(fake.requests).toHaveLength(2);
    // 只读缓存的不查
    expect(deepseek(balances.cached()).result?.balances[0]?.total).toBe("102.00");
    expect(fake.requests).toHaveLength(2);
  });

  it("没配 Key：不查，configured 是 false；换了 Key 上一次的作废、用新 Key 重查", async () => {
    const { fake, state, balances } = await setup(undefined, { key: undefined });
    expect(deepseek(await balances.view())).toEqual({ provider: "deepseek", label: "DeepSeek", configured: false });
    expect(await balances.refresh()).toEqual(await balances.view());
    expect(fake.requests).toHaveLength(0);

    state.key = KEY;
    await balances.view();
    expect(fake.requests.map((r) => r.authorization)).toEqual([`Bearer ${KEY}`]);
    state.key = OTHER_KEY;
    // 换了 Key：缓存里那份不算，只读缓存的也看不到上一个 Key 的结果
    expect(deepseek(balances.cached()).result).toBeUndefined();
    await balances.view();
    expect(fake.requests.map((r) => r.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${OTHER_KEY}`]);
    // 去掉 Key：又不查了
    state.key = "  ";
    expect(deepseek(await balances.view()).configured).toBe(false);
  });
});

describe("用哪个 Key", () => {
  const credentials = { deepseek: KEY, [CUSTOM_PROVIDER_ID]: OTHER_KEY };
  it("DeepSeek 服务商的；选着接口地址是 api.deepseek.com 的自定义服务商时先用它的；别家的自定义服务商不算", () => {
    expect(deepseekBalanceKey({ provider: "deepseek" }, credentials)).toBe(KEY);
    expect(deepseekBalanceKey({ provider: CUSTOM_PROVIDER_ID, custom: { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat", api: "openai-completions" } }, credentials)).toBe(OTHER_KEY);
    expect(deepseekBalanceKey({ provider: CUSTOM_PROVIDER_ID, custom: { baseUrl: "https://api.example.com/v1", modelId: "m", api: "openai-completions" } }, credentials)).toBe(KEY);
    // 只配了自定义的（地址是 DeepSeek 的）：也能查
    expect(deepseekBalanceKey({ provider: "deepseek", custom: { baseUrl: "https://API.DeepSeek.com", modelId: "deepseek-chat", api: "openai-completions" } }, { [CUSTOM_PROVIDER_ID]: OTHER_KEY })).toBe(OTHER_KEY);
    expect(deepseekBalanceKey({ provider: CUSTOM_PROVIDER_ID, custom: { baseUrl: "https://api.example.com/v1", modelId: "m", api: "openai-completions" } }, { [CUSTOM_PROVIDER_ID]: OTHER_KEY })).toBeUndefined();
    expect(deepseekBalanceKey({ provider: "deepseek" }, {})).toBeUndefined();
    expect(isDeepSeekUrl("not a url")).toBe(false);
    expect(isDeepSeekUrl("https://api.deepseek.com.evil.example/v1")).toBe(false);
  });
});

describe("秘书的 check_balance", () => {
  it("名字、只读、落在\"看\"、要联网只往下拉；默认用缓存，refresh 马上重查；交回总余额、赠送 / 充值、能不能用，没有 Key", async () => {
    const { fake, clock, balances } = await setup();
    const tool = checkBalanceTool(balances, () => clock.now);
    expect(tool.spec.name).toBe(CHECK_BALANCE_TOOL);
    expect(tool.descriptor).toMatchObject({ name: "check_balance", readOnlyOrIdempotent: true, nature: "look", network: true, pullOnly: true });
    const first = await tool.run({}, { toolCallId: "t-1" } as never);
    expect(first.text).toContain("DeepSeek 余额（刚查的）：¥110.00（其中赠送 ¥10.00、充值 ¥100.00）。能用。");
    expect(first.text).not.toContain(KEY);
    clock.now += 4 * 60_000;
    expect((await tool.run({}, { toolCallId: "t-2" } as never)).text).toContain("4 分钟前查的");
    expect(fake.requests).toHaveLength(1);
    await tool.run({ refresh: true }, { toolCallId: "t-3" } as never);
    expect(fake.requests).toHaveLength(2);
  });

  it("那段话：余额不多了、用不了了、这次没查成（留着上次的）、没配 Key", () => {
    const at = "2026-11-08T09:50:00.000+08:00";
    const base = { provider: "deepseek", label: "DeepSeek", configured: true };
    const lowBelow = { CNY: 10, USD: 1.5 };
    const amounts = [{ currency: "CNY", total: "7.35", granted: "0.00", toppedUp: "7.35" }];
    expect(balanceReport({ providers: [{ ...base, result: { available: true, balances: amounts, checkedAt: at, low: true } }], lowBelow }, T0)).toContain("能用，但余额不多了（低于 ¥10 算不多）");
    expect(balanceReport({ providers: [{ ...base, result: { available: false, balances: amounts, checkedAt: at, low: true } }], lowBelow }, T0)).toContain("接口已经用不了了");
    const failed = balanceReport({ providers: [{ ...base, result: { available: true, balances: amounts, checkedAt: at, low: true }, failure: { problem: "timeout", at } }], lowBelow }, T0);
    expect(failed).toContain("这次没查成——超时没回。下面是上一次查成的：");
    expect(failed).toContain("10 分钟前查的");
    expect(balanceReport({ providers: [{ provider: "deepseek", label: "DeepSeek", configured: false }], lowBelow }, T0)).toBe(
      "没配 DeepSeek 的 Key，查不了余额。告诉用户：在设置 · 模型里填了 DeepSeek 的 Key，消耗页顶上就能看余额。",
    );
  });
});

describe("体检：DeepSeek 余额（只读缓存）", () => {
  const at = "2026-11-08T09:50:00.000+08:00";
  const base = { provider: "deepseek", label: "DeepSeek", configured: true };
  const lowBelow = { CNY: 10, USD: 1.5 };
  const result = (total: string, available = true, low = false) => ({ available, balances: [{ currency: "CNY", total, granted: "0.00", toppedUp: total }], checkedAt: at, low });

  it("没配 Key、还没查过：不适用；够用：正常，写总余额", () => {
    expect(judgeBalance({ providers: [{ ...base, configured: false }], lowBelow })).toMatchObject({ level: "na", fact: { key: "doctor.balance.noKey" } });
    expect(judgeBalance({ providers: [base], lowBelow })).toMatchObject({ level: "na", fact: { key: "doctor.balance.notYet" } });
    expect(judgeBalance({ providers: [{ ...base, result: result("110.00") }], lowBelow })).toMatchObject({ level: "ok", fact: { key: "doctor.balance.fine", params: { name: "DeepSeek", amount: "¥110.00" } } });
  });

  it("余额不多了、用不了了：注意，带\"去看看\"跳消耗页", () => {
    const low = judgeBalance({ providers: [{ ...base, result: result("7.35", true, true) }], lowBelow });
    expect(low).toMatchObject({ level: "warn", fact: { key: "doctor.balance.low", params: { amount: "¥7.35", threshold: "¥10" } }, action: { kind: "open", route: "#/more/usage" } });
    const out = judgeBalance({ providers: [{ ...base, result: result("0.00", false, true) }], lowBelow });
    expect(out).toMatchObject({ level: "warn", fact: { key: "doctor.balance.unavailable" }, fix: { key: "doctor.fix.balanceLow" }, action: { kind: "open", route: "#/more/usage" } });
  });

  it("上一次没查成：Key 不对是注意（去设置 · 模型），超时这类是没查出来", () => {
    expect(judgeBalance({ providers: [{ ...base, failure: { problem: "key_invalid", status: 401, at } }], lowBelow })).toMatchObject({ level: "warn", fix: { key: "doctor.fix.balanceKey" }, action: { route: "#/more/models" } });
    expect(judgeBalance({ providers: [{ ...base, failure: { problem: "timeout", at } }], lowBelow })).toMatchObject({ level: "unknown", fact: { key: "doctor.balance.failed", params: { why: "超时没回" } } });
  });
});
