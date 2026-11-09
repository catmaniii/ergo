// 深度体检里插件那几项（415）：真的插件宿主（假内核，test/helpers/plugin-kernel.ts）装上 Looki、Claude Code、Codex，
// 体检照组合根那样接（登记表、插件清单、数据源的 doctorFacts 和 probe），深度体检（createDeepDoctor）点了才跑——
// - Looki：用存着的 Key 调本机的假 Looki 的 /me（从不连真的 Looki）：认得 → 正常（打码的账号）；Key 被撤 → 坏了；那边 500 → 注意；
//   没连 → 不测；平时体检不打 /me；"测一下"只读，不改数据源的连接状态；
// - Claude Code：跑假的 `claude auth status`（不起真的 claude）：JSON 说登录了 → 正常（写订阅）；没登录 → 坏了（修法）；看不懂 → 没查出来；
// - Codex：假的 `codex login status`（不跑真的 codex）：ChatGPT 登录 → 正常；Not logged in → 坏了；
// - 插件停用：它的深度体检项跟着撤了，深度体检里没有它那一块。
import { DOCTOR_CHECKS, type DoctorCheckDataById, type DoctorCheckId, type DoctorDeepView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { ClaudeCli, ClaudeCliResult } from "../../src/claude-code/cli.ts";
import { judgeClaudeLogin } from "../../src/claude-code/deep-doctor.ts";
import { createClaudeCodePlugin } from "../../src/claude-code/plugin.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { CodexCommandResult } from "../../src/codex/deep-doctor.ts";
import { judgeCodexLogin } from "../../src/codex/deep-doctor.ts";
import { createCodexPlugin } from "../../src/codex/plugin.ts";
import { createDeepDoctor, DEEP_DOCTOR_MIN_GAP_MS } from "../../src/doctor/deep.ts";
import { createDoctor, type DoctorProbes } from "../../src/doctor/doctor.ts";
import { LOOKI_SOURCE_ID } from "../../src/looki/api.ts";
import { createLookiPlugin } from "../../src/looki/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { type FakeLooki, LOOKI_TEST_KEY, startFakeLooki } from "../helpers/fake-looki.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import path from "node:path";

const GOOD: { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
  node: { running: "22.23.4", expected: "22" },
  pi: { version: "1.0.4" },
  supervisor: { running: true, port: 7420 },
  model: { configured: true },
  components: { missing: [] },
  disk: { freeGb: 120.5, totalGb: 476.8, path: "C:\\Users\\someone\\.ergo" },
  external: { configured: true, kind: "tailscale" },
};
const probes = Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, () => GOOD[id]])) as DoctorProbes;

/** 假的本机 claude：只认 auth status，交回 reply（记下跑过几次） */
class FakeAuthCli implements ClaudeCli {
  calls: string[][] = [];
  reply: ClaudeCliResult;
  constructor(reply: ClaudeCliResult) {
    this.reply = reply;
  }
  run(args: readonly string[]): Promise<ClaudeCliResult> {
    this.calls.push([...args]);
    return Promise.resolve(this.reply);
  }
}

const AT = new Date("2026-11-07T15:30:00+08:00");

async function setup(options: { claude: ClaudeCliResult; codex: CodexCommandResult }) {
  const fake = await startFakeLooki();
  const abroad = await startFakeLooki();
  const looki = createLookiPlugin({ endpoints: { cn: fake.base, global: abroad.base }, rateLimitWaitMs: 10, archive: { defaultFolder: path.join(makeTempDir("ergo-deep-looki-"), "Looki") } });
  const cli = new FakeAuthCli(options.claude);
  const claudeCode = createClaudeCodePlugin({ cli, sdkInstalled: () => true });
  const codexCalls: number[] = [];
  const codexReply = { current: options.codex };
  const codex = createCodexPlugin({
    missing: () => undefined,
    loginStatus: () => {
      codexCalls.push(1);
      return Promise.resolve(codexReply.current);
    },
  });
  const k = await startPluginKernel({
    plugins: [looki, claudeCode, codex],
    at: AT,
    services: [
      extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
      extraService(KERNEL.env, () => ({})),
      extraService(KERNEL.oneShot, () => () => Promise.reject(new Error("测试里不拉一次性子进程"))),
    ],
  });
  let now = AT.getTime();
  const doctor = createDoctor({
    probes,
    checks: k.doctorChecks,
    plugins: () => k.host.info(),
    dataSources: () => k.dataSources.doctorFacts(),
    runtimes: () => k.runtimes.view().runtimes,
    probeSource: (id, signal) => k.dataSources.probe(id, signal),
  });
  const deep = createDeepDoctor({ doctor, now: () => now });
  /** 跑一次深度体检、等它测完；每次先把时钟拨过防连点的那一分钟 */
  const run = async (): Promise<DoctorDeepView> => {
    now += DEEP_DOCTOR_MIN_GAP_MS + 1_000;
    deep.start();
    await deep.whenIdle();
    return deep.view();
  };
  return { fake, k, cli, codexCalls, codexReply, doctor, run };
}

const byId = (view: DoctorDeepView) => Object.fromEntries(view.items.map((entry) => [`${entry.group}:${entry.id}`, entry]));
const connect = (k: Awaited<ReturnType<typeof setup>>["k"]) => k.dataSources.act(LOOKI_SOURCE_ID, { action: "configure", values: { region: "cn", key: LOOKI_TEST_KEY }, idempotencyKey: `c-${Math.random()}` });
const meCalls = (fake: FakeLooki) => fake.keyed().filter((r) => r.path === "/api/v1/me").length;

const LOGGED_IN: ClaudeCliResult = { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }), stderr: "" };
const CODEX_IN: CodexCommandResult = { code: 0, stdout: "", stderr: "Logged in using ChatGPT\n" };

describe("深度体检里的插件项", () => {
  it("Looki 没连不测；连上后用存着的 Key 调 /me：认得正常、Key 被撤坏了、那边 500 注意；平时体检不打 /me，测一下不改连接状态", async () => {
    const { fake, k, run, doctor } = await setup({ claude: LOGGED_IN, codex: CODEX_IN });
    let view = await run();
    expect(byId(view)["looki:probe:looki"]).toMatchObject({ groupTitle: "数据源-Looki穿戴式相机", title: "连一下：Looki", item: { level: "na", text: { fact: "没连，不测" } } });
    expect(meCalls(fake)).toBe(0);

    await connect(k);
    const afterConnect = meCalls(fake);
    // 平时体检：数据源那一项照读现成的状态，不打 /me
    await doctor.view();
    expect(meCalls(fake)).toBe(afterConnect);

    view = await run();
    expect(meCalls(fake)).toBe(afterConnect + 1);
    expect(byId(view)["looki:probe:looki"]!.item).toMatchObject({ level: "ok", fact: { key: "doctor.sourceProbe.okAccount" } });
    expect(byId(view)["looki:probe:looki"]!.item!.text.fact).toMatch(/^连上了，账号认得：.+\*\*\*.+（\d+(\.\d)? 秒）$/);

    fake.mode = "revoked";
    view = await run();
    expect(byId(view)["looki:probe:looki"]!.item).toMatchObject({ level: "error", fix: { key: "doctor.fix.sourceProbe.auth" }, action: { kind: "open", route: "#/more/data-sources/looki" } });
    // 只读：数据源页上照旧是连着的（同步、按需查碰到了才标出错）
    expect(k.dataSources.view().sources.find((s) => s.id === LOOKI_SOURCE_ID)!.connection).toBe("connected");

    fake.mode = "down";
    view = await run();
    expect(byId(view)["looki:probe:looki"]!.item).toMatchObject({ level: "warn", fact: { key: "doctor.sourceProbe.server" } });
    // 出错原因里没有 Key
    expect(JSON.stringify(view)).not.toContain(LOOKI_TEST_KEY);
  });

  it("Claude Code：跑假的 claude auth status——登录了正常（写订阅），没登录坏了（修法），看不懂没查出来；平时体检不跑", async () => {
    const { cli, run, doctor } = await setup({ claude: LOGGED_IN, codex: CODEX_IN });
    await doctor.view();
    expect(cli.calls).toEqual([]);

    let view = await run();
    expect(cli.calls).toEqual([["auth", "status"]]);
    expect(byId(view)["claude-code:login"]).toMatchObject({ groupTitle: "Claude Code", title: "登录", item: { level: "ok", text: { fact: "登录了（Claude Max 订阅）" } } });

    cli.reply = { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
    view = await run();
    expect(byId(view)["claude-code:login"]!.item).toMatchObject({ level: "error", text: { fact: "没登录：用 Claude Code 跑的任务、项目起不来" } });
    expect(byId(view)["claude-code:login"]!.item!.text.fix).toContain("claude");

    cli.reply = { code: null, stdout: "", stderr: "" };
    view = await run();
    expect(byId(view)["claude-code:login"]!.item!.level).toBe("unknown");
  });

  it("Codex：假的 codex login status——ChatGPT 登录正常、没登录坏了；插件停用后深度体检里没有它那一块", async () => {
    const { k, codexCalls, codexReply, run, doctor } = await setup({ claude: LOGGED_IN, codex: CODEX_IN });
    await doctor.view();
    expect(codexCalls).toEqual([]);

    let view = await run();
    expect(byId(view)["codex:login"]).toMatchObject({ groupTitle: "Codex", item: { level: "ok", text: { fact: "用 ChatGPT 账号登录了" } } });

    codexReply.current = { code: 1, stdout: "", stderr: "Not logged in\n" };
    view = await run();
    expect(byId(view)["codex:login"]!.item).toMatchObject({ level: "error", fix: { key: "codex.doctor.login.fix" }, text: { fix: "在这台电脑的 PowerShell 里运行 codex login，按提示登录；二狗不碰你的登录" } });

    await k.host.disable("codex");
    view = await run();
    expect(view.items.map((entry) => entry.group)).not.toContain("codex");
    expect(view.items.map((entry) => `${entry.group}:${entry.id}`)).toEqual(["looki:probe:looki", "claude-code:login"]);
  });
});

describe("登录输出的认法", () => {
  it("claude auth status：JSON、文字两种；退出码兜底", () => {
    expect(judgeClaudeLogin(LOGGED_IN)).toEqual({ level: "ok", fact: { key: "claudeCode.doctor.login.okMethod", params: { method: "Claude Max 订阅" } } });
    expect(judgeClaudeLogin({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }), stderr: "" }).fact).toEqual({ key: "claudeCode.doctor.login.okMethod", params: { method: "API Key" } });
    expect(judgeClaudeLogin({ code: 0, stdout: "Login method: Claude Max account\n", stderr: "" }).fact).toEqual({ key: "claudeCode.doctor.login.okMethod", params: { method: "Claude Max account" } });
    expect(judgeClaudeLogin({ code: 1, stdout: "", stderr: "Not logged in. Run claude to log in.\n" }).level).toBe("error");
    expect(judgeClaudeLogin({ code: 1, stdout: "something else", stderr: "" }).level).toBe("error");
    expect(judgeClaudeLogin({ code: 0, stdout: "", stderr: "" }).level).toBe("unknown");
  });

  it("codex login status：ChatGPT、API Key（不回显 Key）、没登录、看不懂", () => {
    expect(judgeCodexLogin({ code: 0, stdout: "", stderr: "Logged in using an API key - sk-proj-***ABCDE\n" })).toEqual({ level: "ok", fact: { key: "codex.doctor.login.apiKey" } });
    expect(JSON.stringify(judgeCodexLogin({ code: 0, stdout: "", stderr: "Logged in using an API key - sk-proj-***ABCDE\n" }))).not.toContain("ABCDE");
    expect(judgeCodexLogin({ code: 1, stdout: "", stderr: "Not logged in\n" }).level).toBe("error");
    expect(judgeCodexLogin({ code: 0, stdout: "???", stderr: "" }).level).toBe("unknown");
  });

  it("codex login status 没登录：修法写在终端运行哪条命令——PATH 上的是 codex login，设置 · 组件装的写完整的（454）", () => {
    expect(judgeCodexLogin({ code: 1, stdout: "", stderr: "Not logged in\n" }).fix).toEqual({ key: "codex.doctor.login.fix", params: { command: "codex login" } });
    const command = "& 'C:\\ergo\\node.exe' 'C:\\Users\\me\\.ergo\\components\\codex\\node_modules\\@openai\\codex\\bin\\codex.js' login";
    expect(judgeCodexLogin({ code: 1, stdout: "", stderr: "Not logged in\n", loginCommand: command }).fix).toEqual({ key: "codex.doctor.login.fix", params: { command } });
    expect(judgeCodexLogin({ code: 2, stdout: "", stderr: "", loginCommand: command }).fix).toEqual({ key: "codex.doctor.login.fix", params: { command } });
  });
});
