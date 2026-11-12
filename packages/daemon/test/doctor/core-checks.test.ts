// 体检"二狗本身"的新检查（410）：造假的调用记录、假的上下文视图、假的入口清单、假的服务管家快照，一条一条判——
// - 模型近况：最近 5 轮全失败坏了（今天的样子：DeepSeek 报 500 / 503），15 分钟里出错占三成要注意，没有调用记录正常，用户停的不算；
// - 对话长度：93 万 token、压缩点 70 万是注意（带"现在压缩"），到窗口九成是坏了，上次自动压缩没压成是注意，Claude Code 跑的不查；
// - 外网入口：服务管家测好的 tailnet 入口打不通（reachable=false）不再是绿，全不通是坏了、有不通的是注意，连接停在等待是注意；
// - 托管的服务：8090 那个（语音合成）停着是坏了，名下的项目服务失败是坏了、开着开机自启却停着是注意，快照拿不到是没查出来；
// - 主对话掉线、插件没装上、网页文件不在；服务管家的连接断着、服务管家数据所在卷不够；
// - 内核这几项经登记表进"二狗本身"、排在原来八项后面；agent 管家的环形记录。
import fs from "node:fs";
import path from "node:path";
import {
  activeLocale,
  activeLocaleFrom,
  type AgentSettingsView,
  ASSISTANT_NAME_MARK,
  DOCTOR_CHECKS,
  DOCTOR_CORE_GROUP,
  type DoctorCheckDataById,
  type DoctorCheckId,
  doctorItemText,
  type DoctorView,
  type PluginInfo,
  setActiveLocale,
  t,
} from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createTurnLog, type TurnRecord } from "../../src/agent-manager/turn-log.ts";
import { createDoctorChecks, type DoctorFinding } from "../../src/doctor/checks.ts";
import { type ContextAgentView, judgeContext } from "../../src/doctor/context.ts";
import { type CoreDoctorSources, judgeAssistant, judgePlugins, judgeWeb, registerCoreDoctorChecks } from "../../src/doctor/core.ts";
import { createDoctor, type DoctorProbes, diskProbe, externalProbe, legacyLevel, supervisorProbe, supervisorStatus } from "../../src/doctor/doctor.ts";
import { judgeModelCalls, modelErrorGist } from "../../src/doctor/model-calls.ts";
import { judgeServices, parseSupervisorSnapshot } from "../../src/doctor/services.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const before = activeLocale();
afterEach(() => setActiveLocale(before));

/** 一项结果拼成句子（和 doctor.ts 一样） */
const said = (finding: DoctorFinding) => doctorItemText({ title: { key: "x" }, fact: finding.fact, ...(finding.fix ? { fix: finding.fix } : {}) });

const NOW = Date.parse("2026-11-07T08:00:00.000Z");
const MIN = 60_000;

/** 一轮记录：minutesAgo 分钟前 */
const turn = (minutesAgo: number, outcome: TurnRecord["outcome"], error?: string): TurnRecord => ({
  at: NOW - minutesAgo * MIN,
  agentId: "secretary",
  model: "deepseek/deepseek-chat",
  outcome,
  ...(error === undefined ? {} : { error }),
});

describe("模型近况", () => {
  it("今天的样子：最近几轮都是服务商的 500 / 503 → 坏了，事实写出错的大意和模型，修法是等一会儿或换一个，跳设置 · 模型，从这一串失败的第一轮起", () => {
    const records = [
      turn(40, "ok"),
      turn(9, "error", '503 {"error":{"message":"Service Unavailable"}}'),
      turn(7, "error", "500 Internal Server Error"),
      turn(5, "error", "503 Server is busy, please try again later"),
      turn(3, "timeout", "模型 5 分钟没有回应，这一轮中止了"),
      turn(1, "error", "500 Internal Server Error"),
    ];
    const finding = judgeModelCalls(records, NOW);
    expect(finding.level).toBe("error");
    expect(finding.since).toBe(new Date(NOW - 9 * MIN).toISOString());
    expect(finding.action).toEqual({ kind: "open", route: "#/more/models" });
    const text = said(finding);
    expect(text.fact).toContain("最近 5 轮都失败了");
    expect(text.fact).toContain("服务商出错（500）");
    expect(text.fact).toContain("超时没回");
    expect(text.fact).toContain("deepseek/deepseek-chat");
    expect(text.fix).toBe("可能是服务商那边忙，等一会儿或在设置 · 模型里换一个");
  });

  it("最近 15 分钟出错占到三成 → 注意（事实写几轮里几轮出错、大意）；不到三成 → 正常，照样写出来", () => {
    const warn = judgeModelCalls([turn(10, "ok"), turn(6, "error", "503 Service Unavailable"), turn(2, "ok")], NOW);
    expect(warn.level).toBe("warn");
    expect(said(warn).fact).toBe("最近 15 分钟 3 轮里 1 轮出错：服务商说太忙");
    expect(warn.since).toBe(new Date(NOW - 6 * MIN).toISOString());
    const fine = judgeModelCalls([turn(10, "ok"), turn(8, "ok"), turn(6, "error", "503"), turn(4, "ok"), turn(2, "ok")], NOW);
    expect(fine.level).toBe("ok");
    expect(said(fine).fact).toContain("不到三成");
    // 20 分钟前的失败不算进 15 分钟
    expect(judgeModelCalls([turn(20, "error", "503"), turn(20, "error", "503"), turn(5, "ok")], NOW).level).toBe("ok");
  });

  it("没有调用记录 → 正常，写最近没调用过；15 分钟里没有的写上一轮的时间和结局", () => {
    expect(said(judgeModelCalls([], NOW)).fact).toBe("最近没调用过");
    expect(judgeModelCalls([], NOW).level).toBe("ok");
    const quiet = judgeModelCalls([turn(60, "error", "429 Too Many Requests")], NOW);
    expect(quiet.level).toBe("ok");
    expect(said(quiet).fact).toContain("最近 15 分钟没调用过");
    expect(said(quiet).fact).toContain("出错（调用太频繁被限流）");
  });

  it("用户停的那一轮不算成也不算败：4 轮失败夹着停下的不够 5 轮全失败", () => {
    const records = [turn(9, "error", "503"), turn(8, "stopped"), turn(7, "error", "503"), turn(6, "error", "503"), turn(5, "error", "503")];
    const finding = judgeModelCalls(records, NOW);
    expect(finding.level).toBe("warn");
    expect(said(finding).fact).toContain("4 轮里 4 轮出错");
  });

  it("出错的大意按原文认；Key、余额的问题修法换成核对 Key", () => {
    const gist = (error: string, outcome: TurnRecord["outcome"] = "error") => modelErrorGist({ outcome, error }).kind;
    expect(gist("503 Service Unavailable")).toBe("busy");
    expect(gist("Server overloaded")).toBe("busy");
    expect(gist("429 rate limit reached")).toBe("rate");
    expect(gist("401 Unauthorized: invalid api key")).toBe("auth");
    expect(gist("402 Insufficient Balance")).toBe("balance");
    expect(gist("502 Bad Gateway")).toBe("server");
    expect(gist("fetch failed: ECONNRESET")).toBe("network");
    expect(gist("This model's maximum context length is 131072 tokens")).toBe("overflow");
    expect(gist("x", "timeout")).toBe("timeout");
    expect(modelErrorGist({ outcome: "error", error: "something odd happened" }).message).toEqual({ key: "doctor.modelCalls.gist.other", params: { text: "something odd happened" } });
    const key = judgeModelCalls([1, 2, 3, 4, 5].map((n) => turn(n, "error", "401 Unauthorized")), NOW);
    expect(key.fix).toEqual({ key: "doctor.fix.modelCallsKey" });
  });

  it("环形记录：满了丢最老的，出错原文截短、压成一行", () => {
    const log = createTurnLog(3);
    for (let i = 0; i < 5; i += 1) log.record({ at: i, agentId: "a", model: "m", outcome: "error", error: `第 ${i} 次\n${"x".repeat(1000)}` });
    expect(log.recent().map((r) => r.at)).toEqual([2, 3, 4]);
    expect(log.recent()[0]!.error!.length).toBeLessThanOrEqual(300);
    expect(log.recent()[0]!.error).not.toContain("\n");
  });
});

/** 一个 agent 的 ⚙ 上下文视图（只填用得到的） */
function agentView(agentId: string, label: string, context: Partial<AgentSettingsView["context"]>, runtime?: string): ContextAgentView {
  return { agentId, label, context: { running: true, busy: false, compaction: "idle", ...context }, ...(runtime ? { runtime: { id: runtime } } : {}) };
}

const WINDOW = 1_048_576;

describe("对话长度", () => {
  it("今天的样子：93 万 token、自动压缩点 70 万 → 注意；带\"现在压缩\"（压它）；名字用用户起的，不写秘书", () => {
    const secretary = agentView("secretary", ASSISTANT_NAME_MARK, { usedTokens: 935_000, window: WINDOW, autoCompactAt: 700_000 });
    const finding = judgeContext([secretary], "小助");
    expect(finding.level).toBe("warn");
    expect(finding.action).toEqual({ kind: "compact", agentId: "secretary" });
    const text = said(finding);
    expect(text.fact).toBe("小助：对话用了 93.5 万 token，过了自动压缩点 70 万还没压下去（模型窗口 104.9 万）");
    expect(text.fact).not.toContain("秘书");
    expect(text.fix).toContain("现在压缩");
  });

  it("用到模型窗口九成 → 坏了；几个都有问题时压最该压的那个、别的点名", () => {
    const secretary = agentView("secretary", ASSISTANT_NAME_MARK, { usedTokens: 935_000, window: WINDOW, autoCompactAt: 700_000 });
    const owner = agentView("tm-3", "长程任务 t-3「整理发票」的负责人", { usedTokens: 120_000, window: 128_000, autoCompactAt: 111_616 });
    const finding = judgeContext([secretary, owner], "小助");
    expect(finding.level).toBe("error");
    expect(finding.action).toEqual({ kind: "compact", agentId: "tm-3" });
    const fact = said(finding).fact;
    expect(fact).toContain("长程任务 t-3「整理发票」的负责人：对话用了 12 万 token，到了模型窗口 12.8 万的 94%");
    expect(fact).toContain("另外小助也要注意");
    expect(finding.fix).toEqual({ key: "doctor.fix.contextFull" });
  });

  it("上次自动压缩没压成（之后也没压成过）→ 注意，从那时起；之后压成了一次就不算", () => {
    // 420 记的上次自动压缩（autoCompact.last）
    const failed = { outcome: "failed" as const, by: "ergo" as const, at: "2026-11-07T07:30:00.000Z", message: "Summarization failed: 503" };
    const autoCompact = { source: "default" as const, defaultAt: 700_000, last: failed, failures: 1 };
    const stuck = judgeContext([agentView("secretary", ASSISTANT_NAME_MARK, { window: WINDOW, autoCompactAt: 700_000, autoCompact })], "小助");
    expect(stuck.level).toBe("warn");
    expect(stuck.since).toBe(failed.at);
    expect(said(stuck).fact).toContain("上次自动压缩");
    expect(said(stuck).fact).toContain("Summarization failed: 503");
    const later = judgeContext([agentView("secretary", ASSISTANT_NAME_MARK, { window: WINDOW, autoCompact, lastCompactedAt: "2026-11-07T07:40:00.000Z" })], "小助");
    expect(later.level).toBe("ok");
  });

  it("没过压缩点 → 正常（写用得最多的）；没有用量 → 正常（还没有用量）；Claude Code 跑的不查；压不了的不给按钮", () => {
    const fine = judgeContext([agentView("secretary", ASSISTANT_NAME_MARK, { usedTokens: 120_000, window: WINDOW, autoCompactAt: 700_000 })], "小助");
    expect(fine.level).toBe("ok");
    expect(said(fine).fact).toBe("用得最多的是小助：12 万 token（自动压缩点 70 万）");
    expect(said(judgeContext([agentView("secretary", ASSISTANT_NAME_MARK, {})], "小助")).fact).toBe("还没有对话的用量");
    const cc = agentView("tm-9", "任务的负责人", { usedTokens: 990_000, window: WINDOW, autoCompactAt: 700_000 }, "claude-code");
    expect(judgeContext([cc], "小助").level).toBe("ok");
    const pm = agentView("pm-1", "项目的负责人", { usedTokens: 800_000, window: WINDOW, autoCompactAt: 700_000, cannotCompact: "没有在进行的一段会话" });
    expect(judgeContext([pm], "小助").action).toBeUndefined();
  });

  it("英文：token 数按千写", () => {
    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    const finding = judgeContext([agentView("secretary", ASSISTANT_NAME_MARK, { usedTokens: 935_000, window: WINDOW, autoCompactAt: 700_000 })], "Buddy");
    expect(said(finding).fact).toBe("Buddy: the conversation is at 935K tokens, past its auto-compaction point of 700K, and hasn't been compacted (model window 1,048.6K)");
  });
});

/** 八项的假探测器：不给的都好 */
const GOOD: { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
  node: { running: "22.23.4", expected: "22" },
  pi: { version: "1.0.4" },
  supervisor: { running: true, port: 7420, link: "connected" },
  model: { configured: true },
  components: { missing: [] },
  disk: { freeGb: 120.5, totalGb: 476.8, path: "C:\\Users\\someone\\.ergo" },
  external: { configured: true, kind: "tailscale" },
};
const probes = (overrides: Partial<Record<DoctorCheckId, () => unknown>> = {}): DoctorProbes =>
  Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, overrides[id] ?? (() => GOOD[id])])) as DoctorProbes;
const legacyOf = async (overrides: Partial<Record<DoctorCheckId, () => unknown>>, id: DoctorCheckId) => {
  const view = await createDoctor({ probes: probes(overrides) }).view();
  const check = view.checks.find((c) => c.id === id)!;
  const item = view.groups[0]!.items.find((i) => i.id === id)!;
  return { check, item, level: legacyLevel(check) };
};

describe("外网入口：读服务管家测好的通不通", () => {
  const tailnet = { kind: "tailnet" as const, url: "https://ergo.tail1234.ts.net/", reachable: false, why: "tailnet 节点离线" };
  const publicOk = { kind: "public" as const, url: "https://ergo.example.test/", reachable: true };

  it("今天的样子：tailnet 入口 reachable=false（唯一的入口）→ 不是绿：坏了，事实写哪个入口、为什么，修法是专门的那条", async () => {
    const { check, item } = await legacyOf({ external: () => ({ configured: true, kind: "tailscale", entries: [tailnet] }) }, "external");
    expect(check.ok).toBe(false);
    expect(check.fix).toBe("doctor.fix.externalUnreachable");
    expect(item.level).toBe("error");
    expect(item.text.fact).toBe("配了：Tailscale。入口从外面都打不通：https://ergo.tail1234.ts.net/（tailnet 节点离线）");
  });

  it("部分不通 → 注意；没测过的（null）不算不通；连接停在等待 → 注意", async () => {
    const some = await legacyOf({ external: () => ({ configured: true, kind: "tailscale", entries: [tailnet, publicOk] }) }, "external");
    expect(some.item.level).toBe("warn");
    expect(some.item.text.fact).toContain("2 个入口里有 1 个从外面打不通");
    const untested = await legacyOf({ external: () => ({ configured: true, kind: "tailscale", entries: [{ ...tailnet, reachable: null }] }) }, "external");
    expect(untested.check.ok).toBe(true);
    const waiting = await legacyOf({ external: () => ({ configured: true, kind: "tailscale", entries: [publicOk], link: "waiting" }) }, "external");
    expect(waiting.item.level).toBe("warn");
    expect(waiting.check.fix).toBe("doctor.fix.supervisorLink");
    expect(waiting.item.text.fact).toContain("二狗和服务管家的连接断着");
  });

  it("正式的探测器：入口清单原样带上，有入口也算依据；等待时带 link", () => {
    const dir = makeTempDir("ergo-doctor-410-ext-");
    const probe = externalProbe({ svcDataDir: dir, pairedDevices: () => 0, reachability: () => ({ entries: [tailnet], waiting: true }) });
    expect(probe()).toEqual({ configured: true, kind: "tailscale", entries: [tailnet], link: "waiting" });
    // 没有入口、没在等待：和原来一样（不多字段）
    expect(externalProbe({ svcDataDir: dir, pairedDevices: () => 0, reachability: () => ({ entries: [], waiting: false }) })()).toEqual({ configured: false });
  });
});

describe("服务管家：连接断着要注意；磁盘：服务管家的数据和日志所在卷也看", () => {
  it("命令行有回应、连接断着 → 注意，事实和修法都说连接", async () => {
    const { check, item } = await legacyOf({ supervisor: () => ({ running: true, port: 7420, link: "waiting" }) }, "supervisor");
    expect(check.ok).toBe(false);
    expect(check.fix).toBe("doctor.fix.supervisorLink");
    expect(item.level).toBe("warn");
    expect(item.text.fact).toBe("有回应（端口 7420）；但二狗和它的连接断着，在重连");
  });

  it("探测器：快照只跑一次给两项用；link 照组合根给的报", async () => {
    const dir = makeTempDir("ergo-doctor-410-svc-");
    const counter = path.join(dir, "runs.txt");
    // 假的 lsm.mjs：每跑一次记一笔，打印一份快照
    const snapshot = JSON.stringify({ services: [{ id: "audiocpp", name: "audiocpp", port: 8090, state: "STOPPED", autostart: true }] });
    fs.writeFileSync(path.join(dir, "lsm.mjs"), `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(counter)}, "x");\nconsole.log(${JSON.stringify(snapshot)});\n`);
    const command = { node: process.execPath, script: path.join(dir, "lsm.mjs"), dataDir: dir, timeoutMs: 10_000 };
    const status = supervisorStatus(command);
    const probe = supervisorProbe(command, { status, link: () => "waiting" });
    const [data, reading] = await Promise.all([probe(), status.read()]);
    expect(data).toEqual({ running: true, link: "waiting" });
    expect(reading.snapshot?.services.map((s) => [s.id, s.port, s.state])).toEqual([["audiocpp", 8090, "STOPPED"]]);
    expect(fs.readFileSync(counter, "utf8")).toBe("x");
  });

  it("服务管家的数据在同一个卷上不另报；另一个卷剩不到 1 GB → 磁盘那项不健康，事实一并写", async () => {
    const dir = makeTempDir("ergo-doctor-410-disk-");
    expect(diskProbe(dir, { supervisorDir: dir })()).not.toHaveProperty("supervisor");
    expect(diskProbe(dir, { supervisorDir: path.join(dir, "nope") })()).not.toHaveProperty("supervisor");
    const { check, item } = await legacyOf({ disk: () => ({ ...GOOD.disk, supervisor: { freeGb: 0.4, totalGb: 64, path: "D:\\lsm" } }) }, "disk");
    expect(check.ok).toBe(false);
    expect(item.level).toBe("error");
    expect(item.text.fact).toContain("服务管家的数据和日志 D:\\lsm 所在卷还剩 0.4 GB");
  });
});

/** 一份假的服务管家快照（lsm status --json 的样子，只写用得到的字段） */
function snapshotJson(services: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): unknown {
  return { manager: {}, services, ...extra };
}

describe("托管的服务", () => {
  const daemon = { id: "ergo-daemon", name: "ergo-daemon", port: 8810, state: "RUNNING", autostart: true, exposure: { via: "ergo-tunnel" }, tailnet: { name: "ergo" } };
  const audiocpp = { id: "audiocpp", name: "audiocpp", port: 8090, state: "STOPPED", autostart: true, lastError: "进程退出（代码 1）" };
  const asr = { id: "ergo-asr", name: "ergo-asr", port: 8091, state: "RUNNING", autostart: true };
  const tunnel = { id: "ergo-tunnel", name: "ergo-tunnel", port: 0, state: "RUNNING", autostart: true, role: "tunnel" };
  /** 接入了服务管家 */
  const LINKED = true;

  it("今天的样子：8090 那个（语音合成）停着 → 坏了，事实写服务名、状态、最后一次出错；动作是\"开起来\"它（418 + 428）", () => {
    const snapshot = parseSupervisorSnapshot(snapshotJson([daemon, audiocpp, asr, tunnel]))!;
    const finding = judgeServices(snapshot, { speechPort: 8090, recognizerPort: 8091 }, LINKED);
    expect(finding.level).toBe("error");
    expect(finding.action).toEqual({ kind: "start", service: "audiocpp" });
    const text = said(finding);
    expect(text.fact).toBe("有问题：语音合成 audiocpp（停着；服务管家记的最后一次出错：进程退出（代码 1））；另有 2 个正常");
    expect(text.fix).toBe("到设置 · 服务把它开起来；开不起来就在那里看它记的出错和日志");
  });

  it("都在跑 → 正常，列出来；tailnet 网关在 ergo-daemon 开了 tailnet 时算进来（网关是服务管家里登记的一个服务）", () => {
    const gateway = { id: "tailnet-gw", name: "tailnet-gw", port: 8443, state: "RUNNING", autostart: true };
    const snapshot = parseSupervisorSnapshot(snapshotJson([daemon, { ...audiocpp, state: "RUNNING" }, tunnel, gateway], { tailnet: { gateway: { id: "tailnet-gw", state: "RUNNING", autostart: true } } }))!;
    const finding = judgeServices(snapshot, { speechPort: 8090, recognizerPort: 8090 }, LINKED);
    expect(finding.level).toBe("ok");
    expect(said(finding).fact).toBe("都正常：语音合成和语音识别 audiocpp（在跑）、外网隧道 ergo-tunnel（在跑）和tailnet 网关 tailnet-gw（在跑）");
  });

  it("名下的项目服务：失败 → 坏了；开着开机自启却停着 → 注意；关着（没开机自启）停着 → 正常；隧道停了 → 坏了", () => {
    const owned = (state: string, autostart: boolean, lastError?: string) => ({ id: "ergo-daemon--ledger-web", name: "ledger-web", port: 9100, state, autostart, ...(lastError ? { lastError } : {}) });
    const judge = (services: Array<Record<string, unknown>>) => judgeServices(parseSupervisorSnapshot(snapshotJson(services))!, {}, LINKED);
    expect(judge([owned("FAILED", true, "健康检查不过")]).level).toBe("error");
    const autostart = judge([owned("STOPPED", true)]);
    expect(autostart.level).toBe("warn");
    expect(said(autostart).fact).toBe("有问题：项目服务 ledger-web（停着，可开着开机自启）");
    expect(judge([owned("STOPPED", false)]).level).toBe("ok");
    expect(judge([daemon, { ...tunnel, state: "FAILED" }]).level).toBe("error");
  });

  it("语音没在用（端口不给）就不管 8090；一个相关的都没有 → 不适用；快照拿不到 → 没查出来；没接入服务管家不给动作；不太健康的跳设置 · 服务里它那一块", () => {
    const snapshot = parseSupervisorSnapshot(snapshotJson([{ ...daemon, exposure: {}, tailnet: null }, audiocpp]))!;
    expect(judgeServices(snapshot, {}, LINKED).level).toBe("na");
    expect(judgeServices(undefined, { speechPort: 8090 }, LINKED).level).toBe("unknown");
    const noLink = judgeServices(parseSupervisorSnapshot(snapshotJson([audiocpp]))!, { speechPort: 8090 }, false);
    expect(noLink.action).toBeUndefined();
    expect(noLink.fix).toEqual({ key: "doctor.fix.servicesNoLink" });
    // 不太健康、端口被占着：开起来没用，去看看跳设置 · 服务里它那一块（#/more/services/<id>，id 编码过）
    const degraded = judgeServices(parseSupervisorSnapshot(snapshotJson([{ ...audiocpp, state: "DEGRADED" }]))!, { speechPort: 8090 }, LINKED);
    expect(degraded).toMatchObject({ level: "warn", action: { kind: "open", route: "#/more/services/audiocpp" } });
    // 坏了的排在注意的前面，按钮给坏了的那个
    const both = judgeServices(parseSupervisorSnapshot(snapshotJson([daemon, { ...asr, state: "ORPHAN" }, audiocpp, tunnel]))!, { speechPort: 8090, recognizerPort: 8091 }, LINKED);
    expect(both.action).toEqual({ kind: "start", service: "audiocpp" });
  });

  it("和设置 · 服务一页同一份判定（ergoRelated，428）：二狗登记的依赖连同它们硬依赖的停了是坏了；标了 ergo: true 的按名下的判；二狗自己不列；无关的不列", () => {
    const withDeps = { ...daemon, exposure: {}, tailnet: null, dependsOn: [{ id: "db", type: "hard" }] };
    const db = { id: "db", name: "db", port: 5432, state: "RUNNING", autostart: true, dependsOn: [{ id: "disk-mount", type: "hard" }] };
    const mount = { id: "disk-mount", name: "disk-mount", port: 0, state: "STOPPED", autostart: false };
    const marked = { id: "comfyui", name: "comfyui", port: 8188, state: "STOPPED", autostart: true, ergo: true };
    const drama = { id: "drama-server", name: "drama-server", port: 3000, state: "FAILED", autostart: true };
    const finding = judgeServices(parseSupervisorSnapshot(snapshotJson([withDeps, db, mount, marked, drama]))!, {}, LINKED);
    expect(finding.level).toBe("error");
    const fact = said(finding).fact;
    expect(fact).toContain("二狗要靠的服务 disk-mount（停着）");
    expect(fact).toContain("标了和二狗有关的服务 comfyui（停着，可开着开机自启）");
    expect(fact).toContain("另有 1 个正常");
    expect(fact).not.toContain("drama-server");
    expect(fact).not.toContain("ergo-daemon");
  });

  it("快照解析：形状不对的服务丢掉，不像快照是 undefined；依赖、ergo 标记照读", () => {
    expect(parseSupervisorSnapshot({ nope: 1 })).toBeUndefined();
    expect(parseSupervisorSnapshot(snapshotJson([{ name: "no id" }, audiocpp]))!.services.map((s) => s.id)).toEqual(["audiocpp"]);
    const parsed = parseSupervisorSnapshot(snapshotJson([{ ...audiocpp, dependsOn: [{ id: "gpu", type: "soft" }, { nope: 1 }], ergo: true }]))!;
    expect(parsed.services[0]).toMatchObject({ dependsOn: [{ id: "gpu", type: "soft" }], ergo: true });
  });
});

function plugin(name: string, title: string, state: PluginInfo["state"], extra: Partial<PluginInfo> = {}): PluginInfo {
  return { name, title, summary: "", state, brings: { tools: [], cards: [], jobs: [] }, needs: [], neededBy: [], stopsWith: [], startsWith: [], ...extra };
}

describe("主对话、插件、网页文件", () => {
  it("主对话：在线正常（名字是用户起的）；掉线超过阈值坏了，写掉线多久、为什么；停了坏了", () => {
    expect(said(judgeAssistant({ ok: true, status: "idle" }, "小助")).fact).toBe("小助在线，闲着");
    const down = judgeAssistant({ ok: false, status: "restarting", downMs: 95_000 }, "小助");
    expect(down.level).toBe("error");
    expect(said(down).fact).toBe("小助掉线 2 分钟了：意外退出后等着重新拉起");
    expect(judgeAssistant({ ok: false, status: "stopped" }, "小助").level).toBe("error");
  });

  it("插件：启用着没装上的汇一句（注意，跳设置 · 插件）；外部组件没装的不算", () => {
    const fine = judgePlugins([plugin("memory", "记忆", "running"), plugin("codex", "Codex", "skipped", { missing: true, problem: "没装" })]);
    expect(fine.level).toBe("ok");
    const warn = judgePlugins([plugin("memory", "记忆", "running"), plugin("voice", "语音", "skipped", { problem: "识别进程起不来" })]);
    expect(warn.level).toBe("warn");
    expect(said(warn).fact).toBe("语音没装上（原因在下面它那一块）");
    expect(warn.action).toEqual({ kind: "open", route: "#/more/plugins" });
  });

  it("网页文件：index.html 在正常，不在坏了（写路径）", () => {
    const dir = makeTempDir("ergo-doctor-410-web-");
    const index = path.join(dir, "index.html");
    expect(judgeWeb(index).level).toBe("error");
    expect(said(judgeWeb(index)).fact).toBe(`网页文件不在：${index}`);
    fs.writeFileSync(index, "<html></html>");
    expect(judgeWeb(index).level).toBe("ok");
  });
});

describe("内核这几项进\"二狗本身\"", () => {
  const sources = (overrides: Partial<CoreDoctorSources> = {}): CoreDoctorSources => ({
    assistantName: () => "小助",
    secretary: () => ({ ok: true, status: "idle" }),
    turns: () => [turn(9, "error", "503"), turn(7, "error", "500"), turn(5, "error", "503"), turn(3, "error", "503"), turn(1, "error", "500")],
    contextAgents: () => [agentView("secretary", ASSISTANT_NAME_MARK, { usedTokens: 935_000, window: WINDOW, autoCompactAt: 700_000 })],
    supervisor: { read: async () => ({ responded: true, snapshot: parseSupervisorSnapshot(snapshotJson([{ id: "audiocpp", name: "audiocpp", port: 8090, state: "STOPPED", autostart: true }]))! }) },
    servicesInUse: () => ({ speechPort: 8090 }),
    managerUrl: () => "http://127.0.0.1:7420/",
    plugins: () => [plugin("memory", "记忆", "running")],
    webIndex: path.join(makeTempDir("ergo-doctor-410-core-"), "index.html"),
    now: () => NOW,
    ...overrides,
  });

  it("今天的样子拼在一起：模型近况坏了、对话长度注意、托管的服务坏了，排在原来八项后面；总状态坏了；撤销后没了", async () => {
    const registry = createDoctorChecks();
    fs.writeFileSync(sources().webIndex, "");
    const src = sources();
    fs.writeFileSync(src.webIndex, "<html></html>");
    const off = registerCoreDoctorChecks(registry, src);
    const view: DoctorView = await createDoctor({ probes: probes(), checks: registry, now: () => NOW }).view();
    const core = view.groups.find((g) => g.id === DOCTOR_CORE_GROUP)!;
    expect(core.items.map((i) => i.id)).toEqual([...DOCTOR_CHECKS, "assistant", "model-calls", "context", "services", "plugins", "web"]);
    const level = (id: string) => core.items.find((i) => i.id === id)!.level;
    expect([level("assistant"), level("model-calls"), level("context"), level("services"), level("plugins"), level("web")]).toEqual(["ok", "error", "warn", "error", "ok", "ok"]);
    expect(core.items.find((i) => i.id === "context")!.action).toEqual({ kind: "compact", agentId: "secretary" });
    expect(core.items.find((i) => i.id === "model-calls")!.text.title).toBe(t("doctor.check.modelCalls.title"));
    expect(view.level).toBe("error");
    // 整页上不出现"秘书"
    expect(JSON.stringify(view.groups)).not.toContain("秘书");
    off();
    expect(registry.list()).toEqual([]);
  });

  it("二狗占的内存（439）：给了 memory 才有这一项，排在网页文件后面；占到 8.7 GB 是注意", async () => {
    const GB = 1024 ** 3;
    const registry = createDoctorChecks();
    registerCoreDoctorChecks(registry, sources({ memory: () => ({ used: 8.7 * GB, peak: 8.7 * GB, heapUsed: 0.1 * GB, children: [] }) }));
    const src = sources();
    expect(registry.list().find((c) => c.id === "memory-use")!.cost).toBe("passive");
    const core = (await createDoctor({ probes: probes(), checks: registry, now: () => NOW }).view()).groups.find((g) => g.id === DOCTOR_CORE_GROUP)!;
    expect(core.items.map((i) => i.id)).toEqual([...DOCTOR_CHECKS, "assistant", "model-calls", "context", "services", "plugins", "web", "memory-use"]);
    const item = core.items.find((i) => i.id === "memory-use")!;
    expect(item.level).toBe("warn");
    expect(item.text.title).toBe("二狗占的内存");
    // 不给 memory 就没有这一项
    const without = createDoctorChecks();
    registerCoreDoctorChecks(without, src);
    expect(without.list().map((c) => c.id)).not.toContain("memory-use");
  });

  it("托管的服务等服务管家的命令行：超时比默认的 1.5 秒长；快照没回应算没查出来", async () => {
    const registry = createDoctorChecks();
    registerCoreDoctorChecks(registry, sources({ supervisor: { read: async () => ({ responded: false }) } }));
    expect(registry.list().find((c) => c.id === "services")!.timeoutMs).toBeGreaterThan(1_500);
    expect(registry.list().find((c) => c.id === "services")!.cost).toBe("local");
    const view = await createDoctor({ probes: probes(), checks: registry, now: () => NOW }).view();
    expect(view.groups[0]!.items.find((i) => i.id === "services")!.level).toBe("unknown");
  });
});
