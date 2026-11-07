// 语音插件自己的体检项（413，src/voice/doctor.ts）：五项各自的判法，现状都是假的——
// - 地址一律用测试自己挑的空端口（freePort），不碰本机真的 8090、8091；要"连得上"的起本机假服务，当场探用假的 probe 时它不许被叫到；
// - 今天的情形当样例：手工登记在服务管家里的 audio.cpp 停了（组件页认不出它），预热刚看过、状态是"连不上"→ 坏了，
//   从停的那一刻起，修法写"到服务管家把那一条开起来"，带"去看看"跳服务管家的网页；
// - 组件页装的那条（ergo-daemon--audiocpp）同样判得对：开着正常、停了坏了，修法写它；
// - 没开语音回复 / 语音输入的不适用；识别三种来源各按各的；参考音色、ffmpeg、N 卡。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { COMPONENT_FEATURES, DOCTOR_CHECKS, doctorItemText, type DoctorMessage, type VoiceModelState } from "@ergo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecognizeMode } from "../../src/config/config.ts";
import { createDoctor, type DoctorProbes } from "../../src/doctor/doctor.ts";
import { createDoctorChecks, type DoctorCheck, type DoctorFinding, runDoctorCheck } from "../../src/doctor/checks.ts";
import type { RegisteredService } from "../../src/lsm/registered.ts";
import type { VoiceSetup } from "../../src/plugins/kernel.ts";
import { findFfmpeg, type HealthProbe, probeHealth, RECOGNIZER_FRESH_MS, type VoiceDoctorFacts, voiceDoctorChecks, voiceReplyOn, VOICE_STARTUP_GRACE_MS } from "../../src/voice/doctor.ts";
import { createVoiceWarmup } from "../../src/voice/warmup.ts";
import { unavailableRecognizer } from "../../src/voice/recognizer.ts";
import { startedInRequest } from "../helpers/event-loop.ts";
import { freePort } from "../helpers/ports.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 体检的此刻：2026-11-07 15:50（+08:00） */
const NOW = Date.parse("2026-11-07T15:50:00+08:00");
/** 合成服务停的那一刻 */
const STOPPED_AT = "2026-11-07T15:42:00+08:00";
const MANAGER = "http://127.0.0.1:47999/";

const state = (status: VoiceModelState["status"], extra: Partial<VoiceModelState> = {}): VoiceModelState => ({ status, since: "2026-11-07T09:00:00+08:00", ...extra });

interface Fake {
  speechUrl: string;
  recognizerUrl: string;
  features?: string[];
  registered?: Record<number, RegisteredService>;
  gpu?: "nvidia" | "none";
  speech?: VoiceModelState;
  checkedAt?: number;
  mode?: RecognizeMode;
  recognizer?: VoiceModelState;
  references?: { count: number; current?: string };
  ffmpeg?: string;
  /** 当场探的结局；不给的话被叫到就算错（这一项不该探） */
  probe?: (url: string) => HealthProbe;
  /** 服务管家的网页（不给是本机的 MANAGER） */
  manager?: string;
  /** 语音插件（预热）起来的时刻（毫秒）；不给是早就起来了 */
  startedAt?: number;
}

/** 假的现状 + 记下当场探了哪些地址 */
function facts(fake: Fake): { facts: VoiceDoctorFacts; probed: string[] } {
  const probed: string[] = [];
  const setup: VoiceSetup = {
    featureReady: (feature) => (fake.features ?? []).includes(feature),
    registeredOn: (port) => fake.registered?.[port],
    managerUrl: () => fake.manager ?? MANAGER,
    gpu: () => fake.gpu ?? "nvidia",
  };
  return {
    probed,
    facts: {
      setup,
      speech: { url: fake.speechUrl, state: () => fake.speech ?? state("ready", { model: "fish_audio（audio.cpp/tts）" }), checkedAt: () => fake.checkedAt, freshMs: 120_000 },
      recognizer: { mode: () => fake.mode ?? "lsm", state: () => fake.recognizer ?? state("ready", { model: "large-v3", since: new Date(NOW - 10_000).toISOString() }), lsmUrl: fake.recognizerUrl },
      references: () => fake.references ?? { count: 1, current: "默认" },
      ffmpeg: () => ("ffmpeg" in fake ? fake.ffmpeg : "C:\\tools\\ffmpeg.exe"),
      now: () => NOW,
      startedAt: () => fake.startedAt,
      probe: async (url) => {
        probed.push(url);
        if (!fake.probe) throw new Error(`这一项不该当场探：${url}`);
        return fake.probe(url);
      },
    },
  };
}

/** 只有功能门和登记的假 voiceSetup */
const setupOf = (features: string[], registered: Record<number, RegisteredService> = {}): VoiceSetup => ({
  featureReady: (f) => features.includes(f),
  registeredOn: (port) => registered[port],
  managerUrl: () => undefined,
  gpu: () => "none",
});

/** 查的时候抛错 */
const brokenPath = () => {
  throw new Error("PATH 读不了");
};

/** 跑某一项（经体检的跑法：超时、抛错都只算这一项没查出来） */
async function run(fake: Fake, id: string): Promise<DoctorFinding & { probed: string[] }> {
  const { facts: f, probed } = facts(fake);
  const check = voiceDoctorChecks(f).find((c) => c.id === id)!;
  return { ...(await runDoctorCheck(check)), probed };
}

/** 一句话按当前语言拼出来 */
const say = (message: DoctorMessage | undefined) => (message === undefined ? undefined : doctorItemText({ title: message, fact: message }).fact);

/** 两个空端口（没人在听）：合成服务、识别服务的地址 */
async function urls(): Promise<{ speechUrl: string; recognizerUrl: string; speechPort: number; recognizerPort: number }> {
  const speechPort = await freePort();
  let recognizerPort = await freePort();
  while (recognizerPort === speechPort) recognizerPort = await freePort();
  return { speechUrl: `http://127.0.0.1:${speechPort}`, recognizerUrl: `http://127.0.0.1:${recognizerPort}`, speechPort, recognizerPort };
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** 本机假服务：/health 按给的状态码和正文回 */
async function fakeService(status: number, body: string, delayMs = 0): Promise<string> {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(req.url === "/health" ? status : 404, { "content-type": "application/json" });
      res.end(body);
    }, delayMs);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("语音合成", () => {
  it("今天的情形：手工登记在服务管家里的 audio.cpp 停了（组件页认不出它）、预热刚看过是连不上 → 坏了，从停的那一刻起，修法写到服务管家把它开起来、带去看看", async () => {
    const { speechUrl, recognizerUrl, speechPort } = await urls();
    const fake: Fake = {
      speechUrl,
      recognizerUrl,
      // 组件页的"用语音回复"不能用（它停着，认不出是用户自己的）；服务管家里有一条登记在这个端口上
      features: [COMPONENT_FEATURES.voiceInput],
      registered: { [speechPort]: { id: "audiocpp", name: "audio.cpp 语音合成" } },
      speech: state("off", { reason: `语音合成服务没开（${speechUrl}）`, since: STOPPED_AT }),
      checkedAt: NOW - 30_000,
    };
    const finding = await run(fake, "speech");
    expect(finding.level).toBe("error");
    expect(finding.since).toBe(STOPPED_AT);
    expect(finding.probed).toEqual([]); // 预热 30 秒前刚看过：照它说的，不另探
    expect(say(finding.fact)).toBe(`语音合成服务没开（${speechUrl}）：你发语音时的回复都合成不了，退回只发文字`);
    expect(say(finding.fix)).toBe("到设置 · 服务把「audio.cpp 语音合成」（audiocpp）开起来，再查一遍");
    // 418 + 428：按钮是"开起来"登记在这个端口上的那条（和设置 · 服务一页同一个接口）
    expect(finding.action).toEqual({ kind: "start", service: "audiocpp" });
    // 服务管家只听在别的地址上：按钮照样给（开起来走二狗和服务管家的接入层，不用在浏览器里打开它的网页）
    const remote = await run({ ...fake, manager: "http://192.168.1.5:7420/" }, "speech");
    expect(remote).toMatchObject({ level: "error", action: { kind: "start", service: "audiocpp" } });
  });

  it("组件页装的那条（ergo-daemon--audiocpp）：开着正常（带模型名）；太久没看过就当场探，连不上是坏了，修法写它", async () => {
    const { speechUrl, recognizerUrl, speechPort } = await urls();
    const base: Fake = {
      speechUrl,
      recognizerUrl,
      features: [COMPONENT_FEATURES.voiceReply],
      registered: { [speechPort]: { id: "ergo-daemon--audiocpp", name: "语音合成服务（audio.cpp）" } },
    };
    const up = await run({ ...base, checkedAt: NOW - 5_000 }, "speech");
    expect(up.level).toBe("ok");
    expect(say(up.fact)).toBe(`127.0.0.1:${speechPort} 开着，模型加载好了（fish_audio（audio.cpp/tts））`);
    expect(up.probed).toEqual([]);

    // 三分钟没看过（超过两个探活间隔）：当场探一次
    const stale = await run({ ...base, checkedAt: NOW - 180_000, probe: () => ({ reachable: false, reason: "没有服务在听" }) }, "speech");
    expect(stale.probed).toEqual([speechUrl]);
    expect(stale.level).toBe("error");
    expect(stale.since).toBeUndefined(); // 预热上回看还是好的，不知道从什么时候起
    expect(say(stale.fact)).toBe(`连不上 127.0.0.1:${speechPort}（没有服务在听）：你发语音时的回复都合成不了，退回只发文字`);
    expect(say(stale.fix)).toContain("「语音合成服务（audio.cpp）」（ergo-daemon--audiocpp）");

    // 还没看过：也当场探；连得上就照状态说
    const never = await run({ ...base, speech: state("waiting"), probe: () => ({ reachable: true }) }, "speech");
    expect(never.probed).toEqual([speechUrl]);
    expect(never.level).toBe("ok");
    expect(say(never.fact)).toContain("还没加载模型");
  });

  it("没开语音回复（组件页的不能用、服务管家里也没登记在这个端口上）：不适用，不探", async () => {
    const { speechUrl, recognizerUrl } = await urls();
    const finding = await run({ speechUrl, recognizerUrl, features: [], speech: state("off", { since: STOPPED_AT }) }, "speech");
    expect(finding.level).toBe("na");
    expect(finding.probed).toEqual([]);
    expect(say(finding.fact)).toContain("没开语音回复");
  });

  it("忙 → 注意；试合成出错 → 坏了（修法写到服务管家重启那一条）；地址不在这台电脑上的不去连", async () => {
    const { speechUrl, recognizerUrl, speechPort } = await urls();
    const base: Fake = { speechUrl, recognizerUrl, features: [COMPONENT_FEATURES.voiceReply], registered: { [speechPort]: { id: "audiocpp" } }, checkedAt: NOW - 1_000 };
    const busy = await run({ ...base, speech: state("busy", { since: STOPPED_AT }) }, "speech");
    expect(busy).toMatchObject({ level: "warn", since: STOPPED_AT });
    expect(say(busy.fix)).toContain("占着显卡");
    const failed = await run({ ...base, speech: state("error", { reason: "模型 id 不对" }) }, "speech");
    expect(failed.level).toBe("error");
    expect(say(failed.fact)).toBe(`127.0.0.1:${speechPort} 开着，但试合成没成：模型 id 不对`);
    expect(say(failed.fix)).toContain("到设置 · 服务重启「audiocpp」");
    // 在跑却试合成出错：去看看跳设置 · 服务里它那一块（重启、看日志）
    expect(failed.action).toEqual({ kind: "open", route: "#/more/services/audiocpp" });

    // 别的机器上的合成服务：平时体检不联网，太久没看过也只照状态说
    const remote = await run({ speechUrl: "http://192.0.2.10:8090", recognizerUrl, features: [COMPONENT_FEATURES.voiceReply], checkedAt: NOW - 600_000 }, "speech");
    expect(remote.level).toBe("ok");
    expect(remote.probed).toEqual([]);
  });

  it("开没开语音回复：组件页的能用，或者服务管家里有登记在合成端口上的（只认本机地址）", () => {
    const setup = setupOf;
    expect(voiceReplyOn(setup([COMPONENT_FEATURES.voiceReply]), "http://127.0.0.1:1")).toBe(true);
    expect(voiceReplyOn(setup([], { 1: { id: "audiocpp" } }), "http://127.0.0.1:1")).toBe(true);
    expect(voiceReplyOn(setup([], { 1: { id: "audiocpp" } }), "http://127.0.0.1:2")).toBe(false);
    expect(voiceReplyOn(setup([], { 1: { id: "audiocpp" } }), "http://192.0.2.10:1")).toBe(false);
    expect(voiceReplyOn(setup([COMPONENT_FEATURES.voiceInput]), "http://127.0.0.1:1")).toBe(false);
  });
});

describe("语音识别：三种来源各按各的", () => {
  const on = [COMPONENT_FEATURES.voiceInput];

  it("没开语音输入：不适用", async () => {
    const { speechUrl, recognizerUrl } = await urls();
    const finding = await run({ speechUrl, recognizerUrl, features: [COMPONENT_FEATURES.voiceReply] }, "recognizer");
    expect(finding.level).toBe("na");
    expect(say(finding.fact)).toContain("没开语音输入");
  });

  it("自己拉起的 Python：只看状态（没有端口）——出错是坏了，修法照识别的提示；别的状态正常", async () => {
    const { speechUrl, recognizerUrl } = await urls();
    const broken = await run({ speechUrl, recognizerUrl, features: on, mode: "spawn", recognizer: state("error", { reason: "数据目录配置里的 voice.recognizer.python 还是示例里的占位符" }) }, "recognizer");
    expect(broken.level).toBe("error");
    expect(broken.probed).toEqual([]);
    expect(say(broken.fact)).toBe("二狗自己拉起的识别进程（faster-whisper）用不了：数据目录配置里的 voice.recognizer.python 还是示例里的占位符。你发的语音识别不了");
    expect(broken.fix).toEqual({ key: "voice.recognizer.hint" });
    expect(broken.action).toEqual({ kind: "open", route: "#/more/voice" });
    // 加载好了三小时也不探（没有端口可探）
    const ready = await run({ speechUrl, recognizerUrl, features: on, mode: "spawn", recognizer: state("ready", { model: "large-v3" }) }, "recognizer");
    expect(ready.level).toBe("ok");
    expect(say(ready.fact)).toBe("二狗自己拉起的识别进程（faster-whisper）：模型加载好了（large-v3）");
  });

  it("服务管家托管的（recognizer.py --serve）：状态是刚变的照它；不新就当场探——连不上是坏了（修法写登记在那个端口上的服务），自己说加载出错也是坏了", async () => {
    const { speechUrl, recognizerUrl, recognizerPort } = await urls();
    const base: Fake = { speechUrl, recognizerUrl, features: on, mode: "lsm", registered: { [recognizerPort]: { id: "ergo-asr", name: "二狗语音识别" } } };
    // 十秒前刚加载好：不探
    const fresh = await run(base, "recognizer");
    expect(fresh).toMatchObject({ level: "ok", probed: [] });

    const stale: Fake = { ...base, recognizer: state("ready", { model: "large-v3", since: new Date(NOW - RECOGNIZER_FRESH_MS - 1_000).toISOString() }) };
    const down = await run({ ...stale, probe: () => ({ reachable: false, reason: "没有服务在听" }) }, "recognizer");
    expect(down.probed).toEqual([recognizerUrl]);
    expect(down.level).toBe("error");
    expect(say(down.fact)).toBe(`服务管家托管的识别服务（127.0.0.1:${recognizerPort}）连不上（没有服务在听）：你发的语音识别不了`);
    expect(say(down.fix)).toBe("到设置 · 服务把「二狗语音识别」（ergo-asr）开起来，再查一遍");
    expect(down.action).toEqual({ kind: "start", service: "ergo-asr" });

    const failed = await run({ ...stale, probe: () => ({ reachable: true, body: { ok: false, loaded: false, error: "模型加载失败：CUDA out of memory" } }) }, "recognizer");
    expect(failed.level).toBe("error");
    expect(say(failed.fact)).toContain("模型加载失败：CUDA out of memory");
    expect(failed.fix).toEqual({ key: "voice.recognizer.lsmHint" });

    // 服务被服务管家重启过、模型还没加载：能用（下一条语音再加载）
    const reloaded = await run({ ...stale, probe: () => ({ reachable: true, body: { ok: true, loaded: false } }) }, "recognizer");
    expect(reloaded.level).toBe("ok");
    expect(say(reloaded.fact)).toContain("模型还没加载");

    // 两分钟内刚出的错：照状态说坏了，不探
    const justFailed = await run({ ...base, recognizer: state("error", { reason: "连不上语音识别服务", since: new Date(NOW - 5_000).toISOString() }) }, "recognizer");
    expect(justFailed).toMatchObject({ level: "error", probed: [] });
  });

  it("audio.cpp 上的 Fun-ASR：探的是合成那个地址；连得上但上次没用成 → 注意（下一条语音会再试）", async () => {
    const { speechUrl, recognizerUrl, speechPort } = await urls();
    const base: Fake = { speechUrl, recognizerUrl, features: on, mode: "audiocpp", recognizer: state("error", { reason: "服务回了 HTTP 500", since: STOPPED_AT }) };
    const stale = await run({ ...base, probe: () => ({ reachable: true }) }, "recognizer");
    expect(stale.probed).toEqual([speechUrl]);
    expect(stale).toMatchObject({ level: "warn", since: STOPPED_AT });
    expect(say(stale.fact)).toBe(`audio.cpp 上的 Fun-ASR（127.0.0.1:${speechPort}）连得上，但上次没用成：服务回了 HTTP 500`);
    const down = await run({ ...base, probe: () => ({ reachable: false, reason: "没有服务在听" }) }, "recognizer");
    expect(down).toMatchObject({ level: "error", since: STOPPED_AT });
  });
});

describe("参考音色、ffmpeg、N 卡", () => {
  it("参考音色：一条都没有 → 注意（跳设置 · 语音）；有就说用的哪一条；没开语音回复不适用", async () => {
    const { speechUrl, recognizerUrl } = await urls();
    const on = [COMPONENT_FEATURES.voiceReply];
    const none = await run({ speechUrl, recognizerUrl, features: on, references: { count: 0 } }, "references");
    expect(none.level).toBe("warn");
    expect(say(none.fact)).toBe("一条参考音色都没有：语音回复合成不了，退回只发文字");
    expect(none.action).toEqual({ kind: "open", route: "#/more/voice" });
    const some = await run({ speechUrl, recognizerUrl, features: on, references: { count: 2, current: "小张" } }, "references");
    expect(some.level).toBe("ok");
    expect(say(some.fact)).toBe("有 2 条，语音回复用「小张」");
    expect((await run({ speechUrl, recognizerUrl, features: [], references: { count: 0 } }, "references")).level).toBe("na");
  });

  it("ffmpeg：找不到 → 注意；找到写在哪；语音都没开不适用", async () => {
    const { speechUrl, recognizerUrl } = await urls();
    const missing = await run({ speechUrl, recognizerUrl, features: [COMPONENT_FEATURES.voiceInput], ffmpeg: undefined }, "ffmpeg");
    expect(missing.level).toBe("warn");
    expect(say(missing.fix)).toContain("winget install ffmpeg");
    const found = await run({ speechUrl, recognizerUrl, features: [COMPONENT_FEATURES.voiceReply] }, "ffmpeg");
    expect(found.level).toBe("ok");
    expect(say(found.fact)).toBe("找到了：C:\\tools\\ffmpeg.exe");
    expect((await run({ speechUrl, recognizerUrl, features: [], ffmpeg: undefined }, "ffmpeg")).level).toBe("na");
  });

  it("找 ffmpeg：配了命令看它的程序在不在；没配找 PATH 上的", () => {
    const dir = makeTempDir("ergo-ffmpeg-");
    const exe = path.join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    expect(findFfmpeg(undefined, { PATH: dir, PATHEXT: ".EXE" })).toBeUndefined();
    fs.writeFileSync(exe, "");
    expect(findFfmpeg(undefined, { PATH: dir, PATHEXT: ".EXE" })?.toLowerCase()).toBe(exe.toLowerCase());
    expect(findFfmpeg([exe, "--fake"], { PATH: "" })).toBe(exe);
    expect(findFfmpeg([path.join(dir, "nope.exe")], { PATH: dir })).toBeUndefined();
  });

  it("N 卡：有是正常；没有是提示（不适用，写会很慢）；语音都没开不适用", async () => {
    const { speechUrl, recognizerUrl } = await urls();
    const on = [COMPONENT_FEATURES.voiceReply];
    expect((await run({ speechUrl, recognizerUrl, features: on, gpu: "nvidia" }, "gpu")).level).toBe("ok");
    const none = await run({ speechUrl, recognizerUrl, features: on, gpu: "none" }, "gpu");
    expect(none.level).toBe("na");
    expect(say(none.fact)).toBe("没有 N 卡：语音合成、识别只能跑在 CPU 上，会很慢");
    const off = await run({ speechUrl, recognizerUrl, features: [], gpu: "none" }, "gpu");
    expect(say(off.fact)).toBe("语音回复、语音输入都没开，不查");
  });
});

describe("当场探一次本机端口（probeHealth）", () => {
  it("2xx 连得上（带回 JSON）；没人在听、别的状态码、超时都写原因", async () => {
    const ok = await fakeService(200, JSON.stringify({ ok: true, loaded: true }));
    expect(await probeHealth(ok, new AbortController().signal)).toEqual({ reachable: true, body: { ok: true, loaded: true } });
    const closed = `http://127.0.0.1:${await freePort()}`;
    expect(await probeHealth(closed, new AbortController().signal)).toEqual({ reachable: false, reason: "没有服务在听" });
    const sick = await fakeService(503, "{}");
    expect(await probeHealth(sick, new AbortController().signal)).toEqual({ reachable: false, reason: "/health 回了 HTTP 503" });
    const slow = await fakeService(200, "{}", 1_000);
    expect(await probeHealth(slow, new AbortController().signal, 200)).toEqual({ reachable: false, reason: "0.2 秒没回应" });
  });

  it("限时只数事件循环给了的时间（437）：在请求里起头、马上被卡住 800 毫秒，/health 早回来了也不报\"没回应\"", async () => {
    const ok = await fakeService(200, JSON.stringify({ ok: true }));
    expect(await startedInRequest(() => probeHealth(ok, new AbortController().signal, 300), 800)).toEqual({ reachable: true, body: { ok: true } });
  });
});

describe("刚启动的头一分钟（437）", () => {
  it("今天的情形：重启后 20 秒，预热还没看过合成服务，当场探 1.5 秒没回应 → 没查出来（不是坏了），说刚启动、过一会儿再查，不给\"开起来\"", async () => {
    const { speechUrl, recognizerUrl, speechPort } = await urls();
    const fake: Fake = {
      speechUrl,
      recognizerUrl,
      features: [COMPONENT_FEATURES.voiceInput],
      registered: { [speechPort]: { id: "audiocpp", name: "audio.cpp 语音合成" } },
      speech: state("waiting"),
      startedAt: NOW - 20_000,
      probe: () => ({ reachable: false, reason: "1.5 秒没回应" }),
    };
    const starting = await run(fake, "speech");
    expect(starting.probed).toEqual([speechUrl]);
    expect(starting.level).toBe("unknown");
    expect(say(starting.fact)).toBe(`二狗刚启动，语音合成这次没探通：127.0.0.1:${speechPort} 1.5 秒没回应。刚启动时忙，这一眼先不算坏了`);
    expect(say(starting.fix)).toContain("再查一遍");
    expect(starting.action).toBeUndefined();

    // 起来过了一分钟还探不通：照常坏了，修法写开起来
    const later = await run({ ...fake, startedAt: NOW - VOICE_STARTUP_GRACE_MS - 1_000 }, "speech");
    expect(later).toMatchObject({ level: "error", action: { kind: "start", service: "audiocpp" } });
    expect(say(later.fact)).toBe(`连不上 127.0.0.1:${speechPort}（1.5 秒没回应）：你发语音时的回复都合成不了，退回只发文字`);

    // 刚启动、探通了：照常说
    expect((await run({ ...fake, probe: () => ({ reachable: true }) }, "speech")).level).toBe("ok");
  });

  it("刚启动时预热记下的\"没开\"也先不算坏了（写预热记的原因）；试合成出错、忙照常报", async () => {
    const { speechUrl, recognizerUrl, speechPort } = await urls();
    const base: Fake = { speechUrl, recognizerUrl, features: [COMPONENT_FEATURES.voiceReply], registered: { [speechPort]: { id: "audiocpp" } }, checkedAt: NOW - 5_000, startedAt: NOW - 30_000 };
    const off = await run({ ...base, speech: state("off", { reason: `语音合成服务 3 秒没回应（${speechUrl}）`, since: new Date(NOW - 10_000).toISOString() }) }, "speech");
    expect(off.level).toBe("unknown");
    expect(say(off.fact)).toBe(`二狗刚启动，语音合成这次没探通：语音合成服务 3 秒没回应（${speechUrl}）。刚启动时忙，这一眼先不算坏了`);
    expect((await run({ ...base, speech: state("error", { reason: "模型 id 不对" }) }, "speech")).level).toBe("error");
    expect((await run({ ...base, speech: state("busy") }, "speech")).level).toBe("warn");
  });

  it("识别（服务管家托管的、audio.cpp 的）刚启动时当场探不通也算没查出来；过了一分钟照常坏了", async () => {
    const { speechUrl, recognizerUrl, recognizerPort } = await urls();
    const fake: Fake = {
      speechUrl,
      recognizerUrl,
      features: [COMPONENT_FEATURES.voiceInput],
      mode: "lsm",
      registered: { [recognizerPort]: { id: "ergo-asr", name: "二狗语音识别" } },
      recognizer: state("ready", { model: "large-v3", since: new Date(NOW - RECOGNIZER_FRESH_MS - 1_000).toISOString() }),
      startedAt: NOW - 10_000,
      probe: () => ({ reachable: false, reason: "1.5 秒没回应" }),
    };
    const starting = await run(fake, "recognizer");
    expect(starting.level).toBe("unknown");
    expect(say(starting.fact)).toBe(`二狗刚启动，服务管家托管的识别服务（127.0.0.1:${recognizerPort}）这次没探通（1.5 秒没回应）。刚启动时忙，这一眼先不算坏了`);
    expect((await run({ ...fake, startedAt: NOW - VOICE_STARTUP_GRACE_MS }, "recognizer")).level).toBe("error");
  });

  it("没查出来不拉低总状态：刚启动时语音那一块整块不是坏了", async () => {
    const { speechUrl, recognizerUrl, speechPort } = await urls();
    const { facts: f } = facts({ speechUrl, recognizerUrl, features: [COMPONENT_FEATURES.voiceReply], registered: { [speechPort]: { id: "audiocpp" } }, speech: state("waiting"), startedAt: NOW - 20_000, probe: () => ({ reachable: false, reason: "1.5 秒没回应" }) });
    const registry = createDoctorChecks();
    for (const check of voiceDoctorChecks(f)) registry.register({ ...check, plugin: "voice" });
    const probes = Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, brokenPath])) as unknown as DoctorProbes;
    const view = await createDoctor({ probes, checks: registry, now: () => NOW }).view({ include: (check) => check.group === "voice" });
    const voice = view.groups.find((group) => group.id === "voice")!;
    expect(voice.items.find((item) => item.id === "speech")!.level).toBe("unknown");
    expect(voice.level).not.toBe("error");
    expect(view.level).not.toBe("error");
  });
});

describe("登记进体检：语音那一块", () => {
  it("五项都在、先后照登记；今天的情形整块是坏了，句子拼好了（带服务管家）；一项抛错只算它没查出来", async () => {
    const { speechUrl, recognizerUrl, speechPort } = await urls();
    const { facts: f } = facts({
      speechUrl,
      recognizerUrl,
      features: [COMPONENT_FEATURES.voiceInput],
      registered: { [speechPort]: { id: "audiocpp" } },
      speech: state("off", { reason: "语音合成服务没开", since: STOPPED_AT }),
      checkedAt: NOW - 10_000,
    });
    const registry = createDoctorChecks();
    // ffmpeg 那一项查的时候抛错：只算它没查出来
    const checks: DoctorCheck[] = voiceDoctorChecks({ ...f, ffmpeg: brokenPath });
    for (const check of checks) registry.register({ ...check, plugin: "voice" });
    // 二狗本身那八项这里不看：都当查不了
    const probes = Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, brokenPath])) as unknown as DoctorProbes;
    const view = await createDoctor({ probes, checks: registry, now: () => NOW }).view();
    const voice = view.groups.find((g) => g.id === "voice")!;
    // 合成登记在服务管家里，算开了语音回复：参考音色也查
    expect(voice.items.map((i) => [i.id, i.level])).toEqual([
      ["speech", "error"],
      ["recognizer", "ok"],
      ["references", "ok"],
      ["ffmpeg", "unknown"],
      ["gpu", "ok"],
    ]);
    expect(voice.level).toBe("error");
    expect(voice.items[0]!.text).toEqual({
      title: "语音合成",
      fact: "语音合成服务没开：你发语音时的回复都合成不了，退回只发文字",
      fix: "到设置 · 服务把「audiocpp」开起来，再查一遍",
    });
    expect(voice.items[0]!.action).toEqual({ kind: "start", service: "audiocpp" });
  });
});

describe("预热记下合成服务上次是什么样子的时刻", () => {
  it("探了 /health 就记下（体检据此判新不新）；还没看过是 undefined", async () => {
    const health = vi.fn<() => Promise<{ up: false; reason: string }>>(async () => ({ up: false, reason: "没开" }));
    const warmup = createVoiceWarmup({
      recognizer: unavailableRecognizer("测试里不识别"),
      speech: { model: "audio.cpp/tts", health, synthesize: () => Promise.reject(new Error("不合成")) },
      references: { current: () => undefined, onChange: () => () => {} } as never,
      probeMs: 60_000,
      log: () => {},
    });
    expect(warmup.speechCheckedAt()).toBeUndefined();
    const before = Date.now();
    warmup.start();
    await vi.waitFor(() => expect(warmup.speechCheckedAt()).toBeDefined());
    expect(health).toHaveBeenCalled();
    expect(warmup.speechCheckedAt()!).toBeGreaterThanOrEqual(before);
    expect(warmup.view().speech.status).toBe("off");
    await warmup.stop();
  });
});
