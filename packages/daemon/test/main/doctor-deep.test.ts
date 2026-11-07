// 主切面：深度体检（415）接在真的守护进程上——临时数据目录、系统挑的端口；测模型的请求打到本机的假 DeepSeek（catalogBaseUrl，
// 绝不连真的），Looki 接本机的假 Looki，Claude Code / Codex 的登录换成假的命令（不跑真的 claude、codex），完整性检查只对这个测试
// 自己的临时 ergo.db 跑——
// - 打开体检页（GET /api/doctor、GET /api/doctor/deep）不跑这几项：假 DeepSeek 没收到请求、假 Looki 没被打 /me、登录命令没跑，
//   深度体检是"还没做过"，平时体检里没有这几项；
// - 点了（POST /api/doctor/deep）才跑：先交回还在测的，测完：模型回了（假 DeepSeek 收到一条输出封顶的请求、记了耗时）、
//   ergo.db 完整、Looki 认得 Key、两个登录都正常；
// - 马上再点回 429（防连点），取的时候还是上一次的；拨过一分钟、假 DeepSeek 回 503 → 模型那一项是"服务商忙"（坏了）；
// - 假 DeepSeek 收下不回：子进程到点中止这次请求、标超时 → "超时"（注意）。
import { DOCTOR_CORE_GROUP, type DoctorDeepView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { ClaudeCli, ClaudeCliResult } from "../../src/claude-code/cli.ts";
import { createClaudeCodePlugin } from "../../src/claude-code/plugin.ts";
import { createCodexPlugin } from "../../src/codex/plugin.ts";
import { DEEP_DOCTOR_MIN_GAP_MS } from "../../src/doctor/deep.ts";
import { judgeModelProbe } from "../../src/doctor/deep-checks.ts";
import { LOOKI_SOURCE_ID } from "../../src/looki/api.ts";
import { createLookiPlugin } from "../../src/looki/plugin.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { startFakeDeepSeek } from "../helpers/fake-deepseek.ts";
import { LOOKI_TEST_KEY, startFakeLooki } from "../helpers/fake-looki.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";
import { dataSourcesApi, doctorApi } from "../helpers/http.ts";

/** 假的模型 key（守护进程环境里的 DEEPSEEK_API_KEY） */
const KEY = fakeSecret("sk-", "main-415-deep-doctor-Qw7");
const START = new Date("2026-11-07T15:30:00+08:00");

/** 假的本机 claude：只认 auth status */
class LoggedInClaude implements ClaudeCli {
  calls: string[][] = [];
  run(args: readonly string[]): Promise<ClaudeCliResult> {
    this.calls.push([...args]);
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }), stderr: "" });
  }
}

const entry = (view: DoctorDeepView, group: string, id: string) => view.items.find((item) => item.group === group && item.id === id);

describe("深度体检（415）", () => {
  it("打开体检页不跑；点了才逐项跑；测完缓存、马上再点回 429；拨过一分钟、假模型回 503 归服务商忙", { timeout: 120_000 }, async () => {
    const deepseek = await startFakeDeepSeek();
    const looki = await startFakeLooki();
    const claude = new LoggedInClaude();
    let codexRuns = 0;
    const clock = new ManualClock(START);
    const td = await startTestDaemon({
      env: { DEEPSEEK_API_KEY: KEY },
      catalogBaseUrl: deepseek.baseUrl,
      clock,
      plugins: ["looki", "claude-code", "codex"],
      extraPlugins: [
        createLookiPlugin({ endpoints: { cn: looki.base, global: looki.base }, rateLimitWaitMs: 20 }),
        createClaudeCodePlugin({ cli: claude, sdkInstalled: () => true }),
        createCodexPlugin({
          missing: () => undefined,
          loginStatus: () => {
            codexRuns += 1;
            return Promise.resolve({ code: 0, stdout: "", stderr: "Logged in using ChatGPT\n" });
          },
        }),
      ],
    });
    const configured = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "configure", values: { region: "cn", key: LOOKI_TEST_KEY }, idempotencyKey: "deep-looki-1" });
    expect(configured.status).toBe(200);
    const meAfterConnect = looki.keyed().filter((r) => r.path === "/api/v1/me").length;

    // 打开体检页：平时体检和"上一次的深度体检"都不跑这几项
    const plain = (await doctorApi.view(td.url)).body;
    const plainIds = plain.groups.flatMap((g) => g.items.map((i) => `${g.id}:${i.id}`));
    expect(plainIds).not.toContain(`${DOCTOR_CORE_GROUP}:model-probe`);
    expect(plainIds).not.toContain(`${DOCTOR_CORE_GROUP}:database`);
    expect(plainIds).not.toContain("codex:login");
    const never = await doctorApi.deep(td.url);
    expect(never.status).toBe(200);
    expect(never.body).toMatchObject({ state: "never", items: [] });
    expect(deepseek.requests).toEqual([]);
    expect(looki.keyed().filter((r) => r.path === "/api/v1/me").length).toBe(meAfterConnect);
    expect(claude.calls).toEqual([]);
    expect(codexRuns).toBe(0);

    // 点了：先交回还在测的（二狗本身在前，插件的按插件清单的先后）
    const started = await doctorApi.deepStart(td.url);
    expect(started.status).toBe(200);
    expect(started.body.state).toBe("running");
    expect(started.body.items.map((i) => `${i.group}:${i.id}`)).toEqual([`${DOCTOR_CORE_GROUP}:model-probe`, `${DOCTOR_CORE_GROUP}:database`, "claude-code:login", "looki:probe:looki", "codex:login"]);
    await td.daemon.doctorDeep.whenIdle();

    const done = (await doctorApi.deep(td.url)).body;
    expect(done.state).toBe("done");
    expect(done.counts).toEqual({ error: 0, warn: 0, unknown: 0 });
    expect(entry(done, DOCTOR_CORE_GROUP, "model-probe")!.item).toMatchObject({ level: "ok", fact: { key: "doctor.modelProbe.ok", params: { model: "deepseek-flash" } } });
    expect(entry(done, DOCTOR_CORE_GROUP, "model-probe")!.item!.text.fact).toMatch(/^deepseek-flash 回了：首字 [\d.]+ 秒，整次 [\d.]+ 秒$/);
    // 真发了一句：输出封顶几十个 token，带着 key
    expect(deepseek.requests).toHaveLength(1);
    expect(deepseek.requests[0]!.body.max_tokens).toBeLessThanOrEqual(64);
    expect(deepseek.requests[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(entry(done, DOCTOR_CORE_GROUP, "database")!.item).toMatchObject({ level: "ok", fact: { key: "doctor.database.ok" } });
    expect(entry(done, "looki", "probe:looki")!.item).toMatchObject({ level: "ok", fact: { key: "doctor.sourceProbe.okAccount" } });
    expect(entry(done, "claude-code", "login")!.item!.text.fact).toBe("登录了（Claude Max 订阅）");
    expect(entry(done, "codex", "login")!.item!.text.fact).toBe("用 ChatGPT 账号登录了");
    expect(claude.calls).toEqual([["auth", "status"]]);
    expect(codexRuns).toBe(1);
    expect(JSON.stringify(done)).not.toContain(KEY);
    expect(JSON.stringify(done)).not.toContain(LOOKI_TEST_KEY);

    // 马上再点：防连点，回 429；取的还是上一次的
    const tooSoon = await doctorApi.deepStart(td.url);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.message).toMatch(/^刚测过，\d+ 秒后再测$/);
    expect((await doctorApi.deep(td.url)).body.finishedAt).toBe(done.finishedAt);
    expect(deepseek.requests).toHaveLength(1);

    // 拨过一分钟，假模型这次回 503：归"服务商忙"（坏了）
    clock.advance(DEEP_DOCTOR_MIN_GAP_MS + 1_000);
    deepseek.failNext("Service Unavailable: the server is overloaded, please try again later", 503);
    expect((await doctorApi.deepStart(td.url)).status).toBe(200);
    await td.daemon.doctorDeep.whenIdle();
    const busy = (await doctorApi.deep(td.url)).body;
    // 不重试：503 原样报出来，只发了一次
    expect(deepseek.requests).toHaveLength(2);
    expect(entry(busy, DOCTOR_CORE_GROUP, "model-probe")!.item).toMatchObject({ level: "error", fix: { key: "doctor.fix.modelProbe.busy" }, action: { kind: "open", route: "#/more/models" } });
    expect(entry(busy, DOCTOR_CORE_GROUP, "model-probe")!.item!.text.fact).toMatch(/^deepseek-flash 没回成：服务商忙（503）（用了 [\d.]+ 秒）$/);
    expect(busy.counts.error).toBe(1);
  });

  it("测模型到点没回完：子进程里中止这次请求、结果标超时，判成「超时」那一种（注意）", { timeout: 120_000 }, async () => {
    const deepseek = await startFakeDeepSeek();
    const td = await startTestDaemon({ env: { DEEPSEEK_API_KEY: KEY }, catalogBaseUrl: deepseek.baseUrl, plugins: [] });
    // 假 DeepSeek 收下请求但不回：时限调短到 1.5 秒（正式是 8 秒）
    deepseek.hold();
    const result = await td.daemon.modelSettings.probeDefault({ timeoutMs: 1_500 });
    deepseek.release();
    expect(result).toMatchObject({ ok: false, timedOut: true, modelId: "deepseek-flash" });
    expect(result.totalMs).toBeGreaterThanOrEqual(1_400);
    expect(deepseek.requests).toHaveLength(1);
    expect(judgeModelProbe(result)).toMatchObject({ level: "warn", fact: { key: "doctor.modelProbe.timeout" }, fix: { key: "doctor.fix.modelProbe.timeout" } });
  });
});
