// 语音识别的第三条接入：调 audio.cpp 服务上的模型（voice/recognizer-audiocpp.ts）。
// 对上层是同一个接口（Recognizer），这里验的是"预热 / 识别 / 串词过滤 / 连不上 / 超时 / 模型没了"和另外两条语义一样，
// 再加上这个服务特有的：只收 WAV、语言提示只认几种、没有"加载了没有"的接口。
// 接的是假服务（helpers/fake-audiocpp-asr.ts，真 HTTP、端口由系统挑，错误照真服务试出来的写），不碰 8090、不加载真模型、不联网。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_VOICE_CONFIG, type RecognizeTimeoutConfig } from "../../src/config/config.ts";
import { AudioConvertError, type AudioConverter, createFfmpegConverter } from "../../src/voice/audio-convert.ts";
import { createAudioCppRecognizer, createSwitchableRecognizer, type Recognizer, RecognizerUnavailable, unavailableRecognizer } from "../../src/voice/index.ts";
import { AUDIOCPP_RECOGNIZER_MODEL, audiocppLanguage } from "../../src/voice/recognizer-audiocpp.ts";
import type { RecognizerLifecycleEvent } from "../../src/voice/recognizer.ts";
import { compileStripRules } from "../../src/voice/transcript-filter.ts";
import { fakeFfmpegCommand, fakeMp3 } from "../helpers/audio.ts";
import { type FakeAudioCppAsr, startFakeAudioCppAsr } from "../helpers/fake-audiocpp-asr.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeRecording, fakeWavRecording } from "../helpers/voice.ts";

const TIMEOUT: RecognizeTimeoutConfig = { baseMs: 2000, coldStartMs: 0, gpuPerAudioSecond: 1, cpuPerAudioSecond: 1 };

interface Setup {
  service: FakeAudioCppAsr;
  recognizer: Recognizer;
  lines: string[];
  events: RecognizerLifecycleEvent[];
  /** 一段 WAV 录音（假服务按里面的指令回） */
  wav(text: string): string;
}

async function setup(over: { service?: FakeAudioCppAsr; backend?: string; timeout?: RecognizeTimeoutConfig; stripRules?: boolean; convert?: AudioConverter; checkTimeoutMs?: number } = {}): Promise<Setup> {
  const service = over.service ?? (await startFakeAudioCppAsr(over.backend === undefined ? {} : { backend: over.backend }));
  const lines: string[] = [];
  const recognizer = createAudioCppRecognizer({
    url: service.url,
    timeout: over.timeout ?? TIMEOUT,
    checkTimeoutMs: over.checkTimeoutMs ?? 500,
    ...(over.convert ? { convert: over.convert } : {}),
    ...(over.stripRules ? { stripRules: compileStripRules(DEFAULT_VOICE_CONFIG.recognizer.stripPatterns, () => {}) } : {}),
    log: (line) => lines.push(line),
  });
  onTestFinished(() => recognizer.close());
  const events: RecognizerLifecycleEvent[] = [];
  recognizer.onLifecycle((event) => events.push(event));
  const dir = makeTempDir("ergo-asr-audiocpp-");
  let n = 0;
  return {
    service,
    recognizer,
    lines,
    events,
    wav(text) {
      const file = path.join(dir, `rec-${++n}.wav`);
      fs.writeFileSync(file, fakeWavRecording({ text }));
      return file;
    },
  };
}

describe("调 audio.cpp 服务上的语音识别模型", () => {
  it("预热：看服务配了模型，发一小段静音让它加载；状态 等待 → 加载中 → 已就绪，报一次加载好了；已经好了不再发", async () => {
    const { service, recognizer, events } = await setup({ backend: "cuda" });
    const states: string[] = [];
    recognizer.onState((s) => states.push(s.status));
    expect(recognizer.state.status).toBe("waiting");
    expect(recognizer.running).toBe(false);

    const loaded = await recognizer.load();
    expect(loaded).toMatchObject({ model: "fun_asr_nano（audio.cpp/asr）", device: "cuda", computeType: "" });
    expect(loaded.loadMs).toBeGreaterThanOrEqual(0);
    expect(recognizer.state).toMatchObject({ status: "ready", model: "fun_asr_nano（audio.cpp/asr）", device: "cuda" });
    expect(recognizer.running).toBe(true);
    expect(states).toEqual(["loading", "ready"]);
    expect(events.map((e) => e.type)).toEqual(["loaded"]);

    // 真的是一段静音、模型 id 是 asr，文件名是 .wav（服务按文件名认）；语言不传
    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({ filename: "audio.wav", silence: true, fields: { model: AUDIOCPP_RECOGNIZER_MODEL } });
    expect(service.requests[0]!.fields.language).toBeUndefined();

    await recognizer.load();
    expect(service.requests).toHaveLength(1);
  });

  it("CPU 版：设备照服务报的写；服务没报设备也能用", async () => {
    const { recognizer } = await setup({ backend: "cpu" });
    expect((await recognizer.load()).device).toBe("cpu");
  });

  it("识别：传 WAV、模型和语言，提示不传；一段算一个分段，时长是服务报的；冷的时候排在预热后面", async () => {
    const { service, recognizer, wav } = await setup();
    const file = wav("今天天气不错。");
    const result = await recognizer.transcribe({ path: file, language: "zh", initialPrompt: "以下是普通话的句子。" }, 3000);
    expect(result).toMatchObject({ text: "今天天气不错。", language: "zh", model: "fun_asr_nano（audio.cpp/asr）", device: "cuda" });
    expect(result.segments).toEqual([{ start: 0, end: result.duration, text: "今天天气不错。" }]);
    expect(result.duration).toBeGreaterThan(0);
    // 先预热、后识别
    expect(service.requests.map((r) => r.silence)).toEqual([true, false]);
    const sent = service.recognitions()[0]!;
    expect(sent.filename).toBe("audio.wav");
    expect(sent.fields).toEqual({ model: "asr", language: "zh" });
    expect(sent.file.equals(fs.readFileSync(file))).toBe(true);
    expect(recognizer.state.status).toBe("ready");
  });

  it("语言提示：模型只认 auto、zh、en、ja。zh-CN 算 zh，认不得的不传，让它自己判断（传了真服务回 500）", async () => {
    expect(["zh", "zh-CN", "ZH", "en-US", "ja", "auto", "yue", "", undefined].map(audiocppLanguage)).toEqual(["zh", "zh", "zh", "en", "ja", "auto", undefined, undefined, undefined]);
    const { service, recognizer, wav } = await setup();
    expect((await recognizer.transcribe({ path: wav("雷猴"), language: "yue" }, 1000)).text).toBe("雷猴");
    expect(service.recognitions()[0]!.fields.language).toBeUndefined();
  });

  it("串词过滤和另外两条一样：剔掉、记下字数；整条只有串词的文字是空的", async () => {
    const { recognizer, wav, lines } = await setup({ stripRules: true });
    const mixed = await recognizer.transcribe({ path: wav("今天开会。请不吝点赞 订阅 转发 打赏支持明镜与点点栏目") }, 1000);
    expect(mixed.text).toBe("今天开会。");
    expect(mixed.segments.map((s) => s.text)).toEqual(["今天开会。"]);
    expect(mixed.strippedChars).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("疑似串词") && !l.includes("点赞"))).toBe(true);
    const only = await recognizer.transcribe({ path: wav("请不吝点赞 订阅 转发 打赏支持明镜与点点栏目") }, 1000);
    expect(only.text).toBe("");
    expect(only.segments).toEqual([]);
  });

  it("识别出来是空的：没有分段，由上层当没识别出内容", async () => {
    const { service, recognizer, wav } = await setup();
    await recognizer.load();
    service.script({ text: "   " });
    expect(await recognizer.transcribe({ path: wav("x") }, 1000)).toMatchObject({ text: "", segments: [] });
  });

  it("连不上：预热、识别都是 RecognizerUnavailable，写明地址；状态记成出错，报一次没加载起来；服务起来了下一次就好了", async () => {
    const service = await startFakeAudioCppAsr({ down: true });
    const { recognizer, events, wav } = await setup({ service });
    await expect(recognizer.load()).rejects.toThrow(RecognizerUnavailable);
    expect(recognizer.state).toMatchObject({ status: "error", reason: expect.stringContaining(service.url) });
    expect(events).toMatchObject([{ type: "ended", cause: "load_failed" }]);
    await expect(recognizer.transcribe({ path: wav("x") }, 1000)).rejects.toThrow(RecognizerUnavailable);

    await service.up();
    expect((await recognizer.load()).device).toBe("cuda");
    expect(recognizer.state.status).toBe("ready");
    expect((await recognizer.transcribe({ path: wav("又好了") }, 1000)).text).toBe("又好了");
  });

  it("预热超时：服务不回话，到加载上限就是 RecognizerUnavailable", async () => {
    const service = await startFakeAudioCppAsr();
    service.behave("hang");
    const { recognizer } = await setup({ service, timeout: { ...TIMEOUT, baseMs: 200 } });
    await expect(recognizer.load()).rejects.toThrow(RecognizerUnavailable);
    expect(recognizer.state.status).toBe("error");
  });

  it("识别超时：这次以超时结束，这一代作废（状态出错、报一次它没了），下一次重新预热", async () => {
    const { service, recognizer, events, wav } = await setup({ timeout: { baseMs: 300, coldStartMs: 0, gpuPerAudioSecond: 0.1, cpuPerAudioSecond: 0.1 } });
    await recognizer.load();
    service.script("hang");
    await expect(recognizer.transcribe({ path: wav("卡住") }, 100)).rejects.toThrow(/秒/);
    expect(recognizer.state.status).toBe("error");
    expect(events.map((e) => (e.type === "ended" ? e.cause : e.type))).toEqual(["loaded", "exited"]);
    expect((await recognizer.transcribe({ path: wav("又好了") }, 100)).text).toBe("又好了");
    expect(service.requests.filter((r) => r.silence)).toHaveLength(2);
  });

  it("超时总是留着冷启动的时间：服务可能刚被服务管家重启过，模型要重新加载", async () => {
    const { service, recognizer, wav } = await setup({ timeout: { baseMs: 100, coldStartMs: 400, gpuPerAudioSecond: 0.01, cpuPerAudioSecond: 0.01 } });
    await recognizer.load();
    service.script("hang");
    const started = Date.now();
    await expect(recognizer.transcribe({ path: wav("x") }, 10)).rejects.toThrow(/秒/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  describe("模型没了", () => {
    it("服务上没配这个模型：不发静音，写明地址和模型 id", async () => {
      const service = await startFakeAudioCppAsr();
      service.models([{ id: "tts", family: "fish_audio" }]);
      const { recognizer } = await setup({ service });
      await expect(recognizer.load()).rejects.toThrow(RecognizerUnavailable);
      expect(recognizer.state.reason).toContain("id asr");
      expect(service.requests).toEqual([]);
    });

    it("模型文件不在（lazy_load：/health 照样通，到加载才回 500）：预热是 RecognizerUnavailable，带上服务的原话", async () => {
      const service = await startFakeAudioCppAsr();
      service.behave({ status: 500, message: "model path does not exist: D:/gone.gguf" });
      const { recognizer, events } = await setup({ service });
      await expect(recognizer.load()).rejects.toThrow(/model path does not exist/);
      expect(events).toMatchObject([{ type: "ended", cause: "load_failed" }]);
    });

    it("用着用着没了（服务重启后文件不在）：这一条 RecognizerUnavailable、这一代作废；模型 id 不对同样", async () => {
      const { service, recognizer, wav, events } = await setup();
      await recognizer.load();
      service.script({ status: 500, message: "model path does not exist: D:/gone.gguf" });
      await expect(recognizer.transcribe({ path: wav("x") }, 1000)).rejects.toThrow(RecognizerUnavailable);
      expect(recognizer.state.status).toBe("error");
      expect(events.at(-1)).toMatchObject({ type: "ended", cause: "exited" });
      await recognizer.load();
      service.script({ status: 404, message: "unknown model id: asr", type: "not_found" });
      await expect(recognizer.transcribe({ path: wav("x") }, 1000)).rejects.toThrow(/没有语音识别模型/);
      await recognizer.load();
      service.script({ status: 500, message: "unknown model id: asr" });
      await expect(recognizer.transcribe({ path: wav("x") }, 1000)).rejects.toThrow(/没有语音识别模型/);
    });
  });

  describe("这一次没做成、服务还在", () => {
    it("服务忙（503）：普通错误，不作废这一代；预热时碰上忙过一会儿再试", async () => {
      const { service, recognizer, wav } = await setup();
      service.script({ status: 503, message: "server busy", type: "server_busy" });
      expect((await recognizer.load()).device).toBe("cuda");
      expect(service.requests.filter((r) => r.silence)).toHaveLength(2);
      service.script({ status: 503, message: "server busy", type: "server_busy" });
      const err = await recognizer.transcribe({ path: wav("x") }, 1000).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RecognizerUnavailable);
      expect((err as Error).message).toContain("正忙");
      expect(recognizer.state.status).toBe("ready");
    });

    it("服务不收这段（400、坏的 WAV）：普通错误，带上服务的原话", async () => {
      const { service, recognizer, wav } = await setup();
      await recognizer.load();
      service.script({ status: 400, message: "bad request", type: "invalid_request_error" });
      await expect(recognizer.transcribe({ path: wav("x") }, 1000)).rejects.toThrow("bad request");
      service.script({ status: 500, message: "invalid WAV RIFF header" });
      const err = await recognizer.transcribe({ path: wav("x") }, 1000).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(RecognizerUnavailable);
      expect((err as Error).message).toContain("invalid WAV RIFF header");
      expect(recognizer.state.status).toBe("ready");
    });

    it("回的不是认得的：普通错误", async () => {
      const { service, recognizer, wav } = await setup();
      await recognizer.load();
      service.script({ text: 123 });
      await expect(recognizer.transcribe({ path: wav("x") }, 1000)).rejects.toThrow("认得");
      expect(recognizer.state.status).toBe("ready");
    });
  });

  describe("只收 WAV", () => {
    const webmFile = (body: Uint8Array) => {
      const file = path.join(makeTempDir("ergo-asr-webm-"), "rec.webm");
      fs.writeFileSync(file, body);
      return file;
    };

    it("不是 WAV 的先用 ffmpeg 转，传过去的是 WAV、文件名 .wav；转的临时目录删干净", async () => {
      const tmpDir = makeTempDir("ergo-asr-convert-");
      const log = path.join(makeTempDir("ergo-asr-ffmpeg-"), "ffmpeg.jsonl");
      const { service, recognizer } = await setup({ convert: createFfmpegConverter({ tmpDir, command: fakeFfmpegCommand(log), log: () => {} }) });
      const result = await recognizer.transcribe({ path: webmFile(fakeMp3({ seconds: 1, asr: { text: "转完的" } })), language: "zh" }, 1000);
      expect(result.text).toBe("转完的");
      const sent = service.recognitions()[0]!;
      expect(sent.filename).toBe("audio.wav");
      expect(sent.file.toString("latin1", 0, 4)).toBe("RIFF");
      expect(fs.readFileSync(log, "utf8")).toContain('"convert"');
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });

    it("本来就是 WAV 的不转", async () => {
      const convert: AudioConverter = { convert: () => Promise.reject(new Error("不该转")) };
      const { recognizer, wav } = await setup({ convert });
      expect((await recognizer.transcribe({ path: wav("原样") }, 1000)).text).toBe("原样");
    });

    it("这台电脑没有 ffmpeg：这一条失败、说清楚，服务没问题（状态还是已就绪，不算不可用）", async () => {
      const convert: AudioConverter = { convert: () => Promise.reject(new AudioConvertError("missing", "没有 ffmpeg")) };
      const { service, recognizer } = await setup({ convert });
      await recognizer.load();
      const err = await recognizer.transcribe({ path: webmFile(fakeRecording({ text: "x" })) }, 1000).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(RecognizerUnavailable);
      expect((err as Error).message).toContain("ffmpeg");
      expect(recognizer.state.status).toBe("ready");
      expect(service.recognitions()).toEqual([]);
    });

    it("转不了（坏文件）：这一条失败，带上原因；没给转换的也说清楚", async () => {
      const bad: AudioConverter = { convert: () => Promise.reject(new AudioConvertError("failed", "认不出的格式")) };
      const a = await setup({ convert: bad });
      await expect(a.recognizer.transcribe({ path: webmFile(fakeRecording({ text: "x" })) }, 1000)).rejects.toThrow("认不出的格式");
      const b = await setup();
      await expect(b.recognizer.transcribe({ path: webmFile(fakeRecording({ text: "x" })) }, 1000)).rejects.toThrow("不是 WAV");
    });
  });

  describe("check（重试之前看一眼）", () => {
    it("加载好、服务正常：问一句模型列表就回，不重新预热", async () => {
      const { service, recognizer } = await setup();
      await recognizer.load();
      const before = service.modelQueries;
      await recognizer.check();
      expect(service.modelQueries).toBe(before + 1);
      expect(service.requests.filter((r) => r.silence)).toHaveLength(1);
    });

    it("还没预热过：等于预热", async () => {
      const { service, recognizer } = await setup();
      await recognizer.check();
      expect(service.requests.filter((r) => r.silence)).toHaveLength(1);
    });

    it("服务没了：作废、重新预热，还不行就 RecognizerUnavailable；服务回来了重新预热、就绪", async () => {
      const { service, recognizer } = await setup();
      await recognizer.load();
      await service.down();
      await expect(recognizer.check()).rejects.toThrow(RecognizerUnavailable);
      expect(recognizer.state.status).toBe("error");
      await service.up();
      await recognizer.check();
      expect(recognizer.state.status).toBe("ready");
      expect(service.requests.filter((r) => r.silence)).toHaveLength(2);
    });

    it("模型从服务上撤了：RecognizerUnavailable", async () => {
      const { service, recognizer } = await setup();
      await recognizer.load();
      service.models([]);
      await expect(recognizer.check()).rejects.toThrow(/没有语音识别模型/);
    });
  });

  it("守护进程在停：手头的以语音识别已停止结束，之后的也一样", async () => {
    const { service, recognizer, wav } = await setup();
    await recognizer.load();
    service.script("hang");
    const pending = recognizer.transcribe({ path: wav("x") }, 1000);
    await waitUntil(() => service.recognitions().length === 1);
    await recognizer.close();
    await expect(pending).rejects.toThrow("已停止");
    await expect(recognizer.transcribe({ path: wav("x") }, 1000)).rejects.toThrow("已停止");
  });
});

describe("换接入方式（组件页装好、删掉语音识别模型时）", () => {
  it("换过去以后识别走新的，老的关掉；状态、一生里的事只看现在这条；关了以后再换把新的也关掉", async () => {
    const a = await setup();
    const b = await setup();
    const lines: string[] = [];
    const recognizer = createSwitchableRecognizer(a.recognizer, (l) => lines.push(l));
    onTestFinished(() => recognizer.close());
    const states: string[] = [];
    const events: string[] = [];
    recognizer.onState((s) => states.push(s.status));
    recognizer.onLifecycle((e) => events.push(e.type));

    await recognizer.load();
    expect(states).toEqual(["loading", "ready"]);
    expect((await recognizer.transcribe({ path: a.wav("走老的") }, 1000)).text).toBe("走老的");
    expect(a.service.recognitions()).toHaveLength(1);

    recognizer.use(b.recognizer);
    // 换的时候报一次新那条的状态（还没预热）
    expect(states.at(-1)).toBe("waiting");
    expect(recognizer.state.status).toBe("waiting");
    expect(recognizer.running).toBe(false);
    await recognizer.load();
    expect(recognizer.state.status).toBe("ready");
    expect(recognizer.running).toBe(true);
    expect((await recognizer.transcribe({ path: b.wav("走新的") }, 1000)).text).toBe("走新的");
    expect(a.service.recognitions()).toHaveLength(1);
    expect(b.service.recognitions()).toHaveLength(1);
    expect(events).toEqual(["loaded", "loaded"]);
    // 老的关了
    await expect(a.recognizer.transcribe({ path: a.wav("x") }, 1000)).rejects.toThrow("已停止");

    await recognizer.close();
    await expect(recognizer.transcribe({ path: b.wav("x") }, 1000)).rejects.toThrow("已停止");
    const c = await setup();
    recognizer.use(c.recognizer);
    await expect(c.recognizer.transcribe({ path: c.wav("x") }, 1000)).rejects.toThrow("已停止");
  });

  it("换成不可用的（配置里的 Python 还是占位符）：状态是出错、原因照写", async () => {
    const a = await setup();
    const recognizer = createSwitchableRecognizer(a.recognizer, () => {});
    onTestFinished(() => recognizer.close());
    recognizer.use(unavailableRecognizer("Python 没配"));
    expect(recognizer.state).toMatchObject({ status: "error", reason: "Python 没配" });
    await expect(recognizer.load()).rejects.toThrow(RecognizerUnavailable);
  });
});
