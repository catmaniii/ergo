// 主切面：语音模型预热（规格第 22 节"模型预热"，45 号票）。守护进程启动后在后台先拉起识别进程加载识别模型，再用实际会用的模型和
// 参考音色给 audio.cpp 发一条极短的试合成，让它把合成模型加载好；不挡启动，失败只记录、显示。识别进程常驻（不因闲置退出），
// 意外退出后马上在后台重新拉起；audio.cpp 没开时记"没开"，后来开了（低频探活发现）补一次预热。两个模型的状态经本机接口
// GET /api/voice-models 取得到，变了经活动状态频道推一条临时事件 voice_models。
// 识别进程和合成服务一律是假的（fixtures/fake-recognizer.mjs、helpers/tts.ts）：不碰本机 8090、不拉真的 Python、不占显卡。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type VoiceModelsView } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { agentVoiceSettled, FAKE_SPEECH_BUSY, type FakeSpeechService, importReferenceVoice, SAMPLE_VOICE, startFakeSpeechService, voiceModelsApi } from "../helpers/tts.ts";
import { recognizerLog, sendVoice, setFakeLoad, voiceSettled } from "../helpers/voice.ts";

const SECRETARY = CHANNELS.secretary;
const ACTIVITY = CHANNELS.activity;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 本机接口上两个模型现在的状态 */
async function models(url: string): Promise<VoiceModelsView> {
  const res = await voiceModelsApi.get(url);
  expect(res.status).toBe(200);
  return res.body;
}

/** 等本机接口上的状态满足条件，返回那时的状态 */
async function modelsWhen(url: string, ok: (view: VoiceModelsView) => boolean, timeoutMs = 15_000): Promise<VoiceModelsView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await models(url);
    if (ok(view)) return view;
    if (Date.now() > deadline) throw new Error(`等待超时：识别 ${JSON.stringify(view.recognizer)}，合成 ${JSON.stringify(view.speech)}`);
    await sleep(50);
  }
}

/** 前端经活动状态频道收到的 voice_models（按到达顺序） */
function pushed(frontend: TestFrontend): VoiceModelsView[] {
  return frontend.events({ channel: ACTIVITY, type: EVENT_TYPES.voiceModels }).map((f) => f.payload as VoiceModelsView);
}

/** 识别进程的记录里某件事有几次 */
const count = (td: TestDaemon, event: string) => recognizerLog(td.recognizerLog).filter((e) => e.event === event).length;

/** 先在一个数据目录里导入参考音色（再起的守护进程启动时就有参考音色），返回数据目录和这个参考音色 */
async function dataDirWithReference(tts: FakeSpeechService) {
  const first = await startTestDaemon({ speechUrl: tts.url });
  const reference = await importReferenceVoice(first.url);
  // 导入后它也预热了一次：等它做完再停
  await modelsWhen(first.url, (v) => v.speech.status === "ready");
  await first.daemon.stop();
  return { reuse: { dataDir: first.dataDir, homeDir: first.homeDir }, reference };
}

describe("启动后预热", () => {
  it("启动后在后台先加载识别模型、再用参考音色试合成一句；不挡启动；结果不进会话、不留文件；本机接口和活动状态频道都看得到状态", async () => {
    const tts = await startFakeSpeechService();
    const { reuse, reference } = await dataDirWithReference(tts);
    const before = tts.warmups.length;
    const hold = path.join(makeTempDir("ergou-hold-"), "go");
    const lines: string[] = [];
    const td = await startTestDaemon({ reuse, speechUrl: tts.url, recognizerLoad: { holdFile: hold, loadMs: 4200 }, secretary: [{ kind: "reply", text: "在的" }], log: (l) => lines.push(l) });

    // 启动没被挡住：识别模型还在加载，守护进程已经能回话
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [ACTIVITY]: 0 });
    await waitUntil(() => count(td, "load") === 1);
    expect(await models(td.url)).toMatchObject({ recognizerEngines: ["faster-whisper"], recognizerEngine: "faster-whisper", recognizer: { status: "loading" }, speech: { status: "waiting" } });
    await frontend.sendText("在吗");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length === 1, { timeoutMs: 20_000 });

    // 识别模型加载好之前不试合成（不同时往显卡里加载）
    await sleep(300);
    expect(tts.warmups).toHaveLength(before);
    fs.writeFileSync(hold, "");
    const view = await modelsWhen(td.url, (v) => v.speech.status === "ready");
    expect(view.recognizer).toMatchObject({ status: "ready", model: "large-v3", device: "cuda", computeType: "int8_float16", loadMs: 4200 });
    expect(view.recognizer).not.toHaveProperty("fallbackReason");
    expect(view.speech).toMatchObject({ status: "ready", model: "fish_audio（audio.cpp/tts）", alreadyLoaded: true });
    expect(view.speech.loadMs).toBeGreaterThanOrEqual(0);

    // 试合成：实际会用的模型和参考音色，极短的一句；不是语音回复
    expect(tts.warmups).toHaveLength(before + 1);
    const trial = tts.warmups.at(-1)!;
    expect(trial).toMatchObject({ model: "tts", input: "你好。", referenceText: SAMPLE_VOICE.referenceText });
    expect(trial.voiceRef).toBe(path.join(td.daemon.layout.voices, reference.id, "reference.wav"));
    expect(tts.requests).toEqual([]);
    // 按耗时判断模型之前是不是已经加载好，记进日志
    expect(lines.some((l) => /语音合成预热：试合成用了 [\d.]+ 秒，模型之前已经加载好了/.test(l))).toBe(true);
    expect(lines.some((l) => /语音识别模型加载好了：large-v3（cuda，int8_float16），加载用了 4\.2 秒/.test(l))).toBe(true);

    // 结果不进任何会话、不留文件
    expect(td.daemon.store.read(SECRETARY).filter((e) => e.type === EVENT_TYPES.agentVoice)).toEqual([]);
    expect(td.daemon.store.read(SECRETARY).filter((e) => e.type === EVENT_TYPES.message && JSON.stringify(e.payload).includes("tts_audio"))).toEqual([]);
    expect(fs.readdirSync(td.daemon.layout.tmp).filter((f) => f.endsWith(".wav"))).toEqual([]);

    // 状态的变化经活动状态频道推来（临时事件：不落盘）；推来的和本机接口的一样
    await waitUntil(() => pushed(frontend).some((v) => v.speech.status === "ready"));
    expect(pushed(frontend).map((v) => `${v.recognizer.status}/${v.speech.status}`)).toEqual(expect.arrayContaining(["ready/waiting", "ready/loading", "ready/ready"]));
    expect(pushed(frontend).at(-1)).toEqual(await models(td.url));
    expect(td.daemon.store.read(ACTIVITY).map((e) => e.type)).not.toContain(EVENT_TYPES.voiceModels);
  });

  it("守护进程要停时不等还在加载的模型", async () => {
    const td = await startTestDaemon({ recognizerLoad: { holdFile: path.join(makeTempDir("ergou-hold-"), "never") } });
    await waitUntil(() => count(td, "load") === 1);
    const pid = recognizerLog(td.recognizerLog).find((e) => e.event === "start")!.pid!;
    const started = Date.now();
    await td.daemon.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("还没有参考音色：合成那边等着；导入了再预热", async () => {
    const tts = await startFakeSpeechService();
    const td = await startTestDaemon({ speechUrl: tts.url });
    const waiting = await modelsWhen(td.url, (v) => v.recognizer.status === "ready" && v.speech.status === "waiting" && v.speech.reason !== undefined && v.speech.reason.includes("参考音色"));
    expect(waiting.speech.reason).toBe("还没有参考音色：导入一个之后再预热");
    expect(tts.warmups).toEqual([]);
    await importReferenceVoice(td.url);
    await modelsWhen(td.url, (v) => v.speech.status === "ready");
    expect(tts.warmups).toHaveLength(1);
  });
});

describe("识别模型", () => {
  it("显卡上加载不了：退回 CPU 的 small，状态里记下用的模型、设备和原因；识别照常用它", async () => {
    const td = await startTestDaemon({ recognizerLoad: { fallback: "large-v3 加载失败：CUDA failed with error out of memory" }, secretary: [{ kind: "reply", text: "收到" }] });
    const view = await modelsWhen(td.url, (v) => v.recognizer.status === "ready");
    expect(view.recognizer).toMatchObject({ status: "ready", model: "small", device: "cpu", computeType: "int8", fallbackReason: "large-v3 加载失败：CUDA failed with error out of memory" });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, td.url, { text: "用 CPU 识别" });
    expect((await voiceSettled(frontend, "done")).recognition).toMatchObject({ model: "small", device: "cpu", fallbackReason: "large-v3 加载失败：CUDA failed with error out of memory" });
    // 预热时已经拉起、加载好：识别没有另起进程
    expect(count(td, "start")).toBe(1);
  });

  it("加载失败（也没得退）：状态是出错（带原因），过一会儿再试；不影响别的功能，修好之后来了语音照常拉起识别", async () => {
    const lines: string[] = [];
    const td = await startTestDaemon({ recognizerLoad: { fatal: "no CUDA" }, secretary: [{ kind: "reply", text: "在的" }, { kind: "reply", text: "收到" }], log: (l) => lines.push(l) });
    const failed = await modelsWhen(td.url, (v) => v.recognizer.status === "error");
    expect(failed.recognizer.reason).toBe("模型加载失败：no CUDA");
    await waitUntil(() => lines.some((l) => l.includes("语音识别模型没加载起来（模型加载失败：no CUDA）：5 秒后再试")));
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("在吗");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length === 1, { timeoutMs: 20_000 });

    setFakeLoad(td.recognizerLog, undefined);
    await sendVoice(frontend, td.url, { text: "这回好了" });
    await voiceSettled(frontend, "done");
    expect((await models(td.url)).recognizer).toMatchObject({ status: "ready", model: "large-v3" });
  });

  it("识别进程常驻；加载好、稳定下来之后被杀：马上在后台重新拉起并加载，不等下一条语音", async () => {
    const lines: string[] = [];
    // 加载好之后 0.3 秒没崩就算稳定；退避第一次要等 10 秒（马上重拉的不该等它）
    const td = await startTestDaemon({ recognizerStableMs: 300, recognizerRetryMs: [10_000], log: (l) => lines.push(l) });
    expect(td.daemon.config.voice.recognizer.idleMs).toBe(0);
    await modelsWhen(td.url, (v) => v.recognizer.status === "ready");
    await sleep(600);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [ACTIVITY]: 0 });
    const pid = recognizerLog(td.recognizerLog).find((e) => e.event === "start")!.pid!;
    process.kill(pid);
    await waitUntil(() => !isProcessAlive(pid) && count(td, "load") === 2, { timeoutMs: 8_000 });
    await modelsWhen(td.url, (v) => v.recognizer.status === "ready");
    expect(count(td, "start")).toBe(2);
    expect(lines.filter((l) => l.includes("马上重新拉起"))).toEqual([expect.stringMatching(/^语音识别进程意外退出（识别进程退出了.*）：马上重新拉起、加载模型$/)]);
    // 前端看到：出错（意外退出）→ 加载中 → 已就绪
    await waitUntil(() => pushed(frontend).some((v) => v.recognizer.status === "ready"));
    const steps = pushed(frontend).map((v) => v.recognizer.status);
    expect(steps.slice(steps.indexOf("error"))).toEqual(expect.arrayContaining(["error", "loading", "ready"]));
    expect(pushed(frontend).find((v) => v.recognizer.status === "error")!.recognizer.reason).toMatch(/识别进程退出了/);
  });
});

describe("识别进程加载好就崩", () => {
  it("加载好之后很快又退出、连着几次：算连续失败，按退避再试（越隔越久），每次一行日志；好了之后不再重拉", async () => {
    const lines: string[] = [];
    const td = await startTestDaemon({ recognizerLoad: { exitAfterMs: 50 }, recognizerRetryMs: [200, 400, 800], log: (l) => lines.push(l) });
    await waitUntil(() => count(td, "start") >= 4, { timeoutMs: 20_000 });
    const retries = () => lines.filter((l) => l.includes("加载好后很快又退出了"));
    expect(retries()[0]).toMatch(/^语音识别进程加载好后很快又退出了（识别进程退出了（退出码 3）.*）：0\.2 秒后再试$/);
    // 越隔越久
    expect(retries().slice(0, 3).map((l) => /：([\d.]+) 秒后再试$/.exec(l)?.[1])).toEqual(["0.2", "0.4", "0.8"]);
    // 不算"没加载起来"，也不马上重拉；一次退出只记一行
    expect(lines.filter((l) => l.includes("没加载起来") || l.includes("马上重新拉起"))).toEqual([]);
    expect(retries().length).toBeLessThanOrEqual(count(td, "start"));

    // 好了：加载好之后不再退出，也就不再重拉
    setFakeLoad(td.recognizerLog, undefined);
    await sleep(2_000);
    const view = await modelsWhen(td.url, (v) => v.recognizer.status === "ready");
    expect(view.recognizer.model).toBe("large-v3");
    const starts = count(td, "start");
    await sleep(1_500);
    expect(count(td, "start")).toBe(starts);
    expect((await models(td.url)).recognizer.status).toBe("ready");
  });
});

describe("合成服务后来才开", () => {
  it("audio.cpp 先没开：记'没开'、不报错；开了（探活发现连得上）补一次预热；只在连不上和连得上之间变了的时候动作", async () => {
    const tts = await startFakeSpeechService();
    await tts.down();
    const td = await startTestDaemon({ speechUrl: tts.url, config: { voice: { speech: { probeSeconds: 0.1 } } } });
    const off = await modelsWhen(td.url, (v) => v.speech.status === "off");
    expect(off.speech.reason).toBe(`语音合成服务没开（${tts.url}）`);
    await importReferenceVoice(td.url);

    await tts.up();
    await modelsWhen(td.url, (v) => v.speech.status === "ready");
    expect(tts.warmups).toHaveLength(1);
    // 一直开着：之后的探活不再动作
    await sleep(600);
    expect(tts.warmups).toHaveLength(1);

    // 又关了：没开；再开：再预热一次
    await tts.down();
    await modelsWhen(td.url, (v) => v.speech.status === "off");
    await tts.up();
    await modelsWhen(td.url, (v) => v.speech.status === "ready");
    expect(tts.warmups).toHaveLength(2);
  });
});

describe("合成服务忙", () => {
  it("试合成碰上服务忙（503，显卡在给别的任务用）：记'忙，稍后再试'，按探活的间隔再试，日志只记一次；不忙了就是已就绪", async () => {
    const tts = await startFakeSpeechService();
    tts.behaveWarmup(FAKE_SPEECH_BUSY);
    const lines: string[] = [];
    const td = await startTestDaemon({ speechUrl: tts.url, config: { voice: { speech: { probeSeconds: 0.2 } } }, log: (l) => lines.push(l) });
    await importReferenceVoice(td.url);
    const busy = await modelsWhen(td.url, (v) => v.speech.status === "busy");
    expect(busy.speech.reason).toBe("语音合成服务正忙（显卡在给别的任务用），稍后再试");
    await waitUntil(() => tts.warmups.length >= 3, { timeoutMs: 10_000 });
    expect(lines.filter((l) => l.includes("正忙"))).toHaveLength(1);
    tts.behaveWarmup("ok");
    await modelsWhen(td.url, (v) => v.speech.status === "ready");
  });
});

describe("预热期间来了真请求", () => {
  it("识别：识别模型还在加载时来了一条语音——排在加载后面，加载好就识别，不另起进程", async () => {
    const hold = path.join(makeTempDir("ergou-hold-"), "go");
    const td = await startTestDaemon({ recognizerLoad: { holdFile: hold }, secretary: [{ kind: "reply", text: "收到" }] });
    await waitUntil(() => count(td, "load") === 1);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, td.url, { text: "加载时说的" });
    await voiceSettled(frontend, "recognizing");
    await sleep(300);
    expect((await models(td.url)).recognizer.status).toBe("loading");
    fs.writeFileSync(hold, "");
    expect((await voiceSettled(frontend, "done")).recognition).toMatchObject({ text: "加载时说的", model: "large-v3" });
    expect(recognizerLog(td.recognizerLog).map((e) => e.event)).toEqual(["start", "init", "load", "transcribe"]);
  });

  it("合成：试合成还在做时要合成语音回复——等试合成做完再发，不同时打到 audio.cpp；之后照常合成", async () => {
    const tts = await startFakeSpeechService();
    const { reuse } = await dataDirWithReference(tts);
    const before = tts.warmups.length;
    tts.behaveWarmup("hold");
    const td = await startTestDaemon({ reuse, speechUrl: tts.url, secretary: [{ kind: "reply", text: "好的，记下了。" }] });
    await waitUntil(() => tts.heldWarmups === 1);
    expect((await models(td.url)).speech.status).toBe("loading");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await sendVoice(frontend, td.url, { text: "记一下" });
    await agentVoiceSettled(frontend, "synthesizing");
    await sleep(300);
    expect(tts.requests).toEqual([]);

    tts.releaseWarmups();
    const done = await agentVoiceSettled(frontend, "done");
    expect(done.text).toBe("好的，记下了。");
    expect(tts.requests.map((r) => r.input)).toEqual(["好的，记下了。"]);
    expect(tts.warmups).toHaveLength(before + 1);
    expect((await models(td.url)).speech.status).toBe("ready");
  });
});
