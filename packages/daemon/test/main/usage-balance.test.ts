// 主切面：消耗页顶上的 DeepSeek 余额（440）接在真的守护进程上——临时数据目录、系统挑的端口、faux 模型；查余额打到本机的
// 假 DeepSeek 余额接口（deepseekBalanceBaseUrl，回放官方文档的样例），绝不连真的 DeepSeek，Key 是假的：
// - GET /api/usage/balance：拿守护进程环境里的 DeepSeek Key 去查，回总余额、其中赠送 / 充值、能用；几分钟内再取不再打接口；
//   POST 刷新马上重查（刚查过的不重复查）；接口回的、日志里都没有 Key；
// - 体检"二狗本身"里的"DeepSeek 余额"：只读查过的结果，打开体检页不打接口；余额不足（is_available: false）是注意、带"去看看"；
// - 秘书问"DeepSeek 还剩多少钱"：调 check_balance，结果里有总余额，没有 Key；
// - 没配 Key：configured 是 false，假接口一次都没被打；体检里这一项不适用。
import { CHANNELS, DOCTOR_CORE_GROUP, type DoctorView, EVENT_TYPES } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { BALANCE_REFRESH_GAP_MS } from "../../src/model-settings/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { balanceError, DOC_SAMPLE_BALANCE, startFakeDeepSeekBalance } from "../helpers/fake-deepseek-balance.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { doctorApi, usageApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { call, say } from "../helpers/task-flow.ts";

const KEY = fakeSecret("sk-", "main-440-balance-not-real-Kd38");
const START = new Date("2026-11-08T10:00:00+08:00");
const SECRETARY = CHANNELS.secretary;

const coreItem = (view: DoctorView, id: string) => view.groups.find((group) => group.id === DOCTOR_CORE_GROUP)?.items.find((item) => item.id === id);

describe("消耗页顶上的 DeepSeek 余额（440）", () => {
  it("取、缓存、刷新；体检只读查过的；Key 不进接口和日志", { timeout: 60_000 }, async () => {
    const fake = await startFakeDeepSeekBalance();
    const logs: string[] = [];
    const clock = new ManualClock(START);
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: KEY }, deepseekBalanceBaseUrl: fake.baseUrl, clock, log: (line) => logs.push(line) });

    // 打开体检页：还没查过（不适用），不打接口
    const before = coreItem((await doctorApi.view(td.url)).body, "balance");
    expect(before).toMatchObject({ level: "na", text: { title: "DeepSeek 余额" } });
    expect(fake.requests).toHaveLength(0);

    const first = await usageApi.balance(td.url);
    expect(first.status).toBe(200);
    expect(first.body.providers).toEqual([
      {
        provider: "deepseek",
        label: "DeepSeek",
        configured: true,
        result: { available: true, balances: [{ currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" }], checkedAt: expect.any(String), low: false },
        nextRefreshAt: expect.any(String),
        topUpUrl: "https://platform.deepseek.com/top_up",
      },
    ]);
    expect(fake.requests).toEqual([{ method: "GET", path: "/user/balance", authorization: `Bearer ${KEY}` }]);

    // 再取：用缓存；刷新：刚查过，不重复查
    await usageApi.balance(td.url);
    const tooSoon = await usageApi.refreshBalance(td.url);
    expect(tooSoon.status).toBe(200);
    expect(fake.requests).toHaveLength(1);

    // 体检：读查过的那一次，正常，事实写总余额；这一项紧跟"模型近况"（不适用的挪到最后，所以不看它们）
    const doctor = (await doctorApi.view(td.url)).body;
    const fine = coreItem(doctor, "balance");
    expect(fine).toMatchObject({ level: "ok" });
    const ids = doctor.groups.find((group) => group.id === DOCTOR_CORE_GROUP)!.items.filter((item) => item.level !== "na").map((item) => item.id);
    expect(ids.indexOf("balance")).toBe(ids.indexOf("model-calls") + 1);
    expect(fine?.text.fact).toContain("¥110.00");
    expect(fake.requests).toHaveLength(1);

    // 余额不足：拨过防连点再刷新，马上重查；体检里变注意、带去看看
    fake.reply({ status: 200, json: { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" }] } });
    clock.advance(BALANCE_REFRESH_GAP_MS);
    const refreshed = await usageApi.refreshBalance(td.url);
    expect(fake.requests).toHaveLength(2);
    expect(refreshed.body.providers[0]).toMatchObject({ result: { available: false, low: true } });
    const out = coreItem((await doctorApi.view(td.url)).body, "balance");
    expect(out).toMatchObject({ level: "warn", action: { kind: "open", route: "#/more/usage" } });
    expect(out?.text.fact).toContain("余额不足");

    // Key 不对：照实记，Key 不进接口、日志
    fake.reply({ status: 401, json: balanceError(`Authentication Fails, Your api key: ****${KEY.slice(-4)} is invalid`, "authentication_error") });
    clock.advance(BALANCE_REFRESH_GAP_MS);
    await usageApi.refreshBalance(td.url);
    const failed = await usageApi.balance(td.url);
    expect(failed.body.providers[0]).toMatchObject({ failure: { problem: "key_invalid", status: 401 }, result: { available: false } });
    const all = JSON.stringify(failed.body) + JSON.stringify((await doctorApi.view(td.url)).body) + logs.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(-4));
  });

  it("秘书问余额：调 check_balance，结果里有总余额、没有 Key", { timeout: 60_000 }, async () => {
    const fake = await startFakeDeepSeekBalance({ status: 200, json: DOC_SAMPLE_BALANCE });
    const td = await startTestDaemon({
      env: { DEEPSEEK_API_KEY: KEY },
      deepseekBalanceBaseUrl: fake.baseUrl,
      secretary: [call("check_balance", {}), say("DeepSeek 还剩 110 元。")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("DeepSeek 还剩多少钱？");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 30_000, describe: () => "等秘书答完" });
    const result = JSON.stringify(frontend.events({ channel: SECRETARY }));
    expect(result).toContain("¥110.00");
    expect(result).not.toContain(KEY);
    expect(fake.requests).toHaveLength(1);
  });

  it("没配 Key：不查（configured 是 false，假接口没被打），体检里这一项不适用", { timeout: 60_000 }, async () => {
    const fake = await startFakeDeepSeekBalance();
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: undefined, CUSTOM_MODEL_API_KEY: undefined }, deepseekBalanceBaseUrl: fake.baseUrl });
    const view = await usageApi.balance(td.url);
    expect(view.body.providers).toEqual([{ provider: "deepseek", label: "DeepSeek", configured: false, topUpUrl: "https://platform.deepseek.com/top_up" }]);
    expect((await usageApi.refreshBalance(td.url)).body.providers[0]?.configured).toBe(false);
    expect(fake.requests).toHaveLength(0);
    expect(coreItem((await doctorApi.view(td.url)).body, "balance")).toMatchObject({ level: "na" });
  });
});
