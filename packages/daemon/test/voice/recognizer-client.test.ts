// 语音识别的另一条接入（250 号票）：经 HTTP 调 LSM 托管的识别服务（voice/recognizer-client.ts）。
// 对上层是同一个接口（Recognizer），所以这里验的就是"预热 / 识别 / 超时 / check 在不在"这几件事和
// 自己拉起识别进程那条（recognizer.test.ts）一样：状态机、超时语义、串词过滤、错误都映射成同一套。
// 接的是假的识别服务进程（fixtures/fake-asr-service.mjs，真 HTTP、端口由系统挑），不加载真模型、不占显卡。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_VOICE_CONFIG, type RecognizeTimeoutConfig } from "../../src/config/config.ts";
import { createHttpRecognizer, type Recognizer, RecognizerUnavailable } from "../../src/voice/index.ts";
import { compileStripRules } from "../../src/voice/transcript-filter.ts";
import { type FakeAsrDirective, type FakeAsrService, asrLog, setFakeAsr, startFakeAsrService } from "../helpers/asr.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeRecording } from "../helpers/voice.ts";

const INIT = { primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" }, fallback: { device: "cpu", model: "small", computeType: "int8" } };
const TIMEOUT: RecognizeTimeoutConfig = { baseMs: 2000, coldStartMs: 0, gpuPerAudioSecond: 1, cpuPerAudioSecond: 1 };

async function setup(
  overrides: { directive?: FakeAsrDirective; timeout?: RecognizeTimeoutConfig; checkTimeoutMs?: number; stripRules?: boolean } = {},
): Promise<{ asr: FakeAsrService; recognizer: Recognizer; lines: string[]; recording(text: string): string }> {
  const asr = await startFakeAsrService(overrides.directive === undefined ? {} : { directive: overrides.directive });
  const lines: string[] = [];
  const recognizer = createHttpRecognizer({
    url: asr.url,
    init: INIT,
    timeout: overrides.timeout ?? TIMEOUT,
    checkTimeoutMs: overrides.checkTimeoutMs ?? 300,
    ...(overrides.stripRules ? { stripRules: compileStripRules(DEFAULT_VOICE_CONFIG.recognizer.stripPatterns, () => {}) } : {}),
    log: (line) => lines.push(line),
  });
  onTestFinished(() => recognizer.close());
  const dir = makeTempDir("ergo-asr-audio-");
  let n = 0;
  return {
    asr,
    recognizer,
    lines,
    recording(text) {
      const file = path.join(dir, `rec-${++n}`);
      fs.writeFileSync(file, fakeRecording({ text }));
      return file;
    },
  };
}

/** 假服务收到过几次什么（按到达顺序） */
const eventsOf = (log: string, event: string) => asrLog(log).filter((e) => e.event === event);

describe("调 LSM 托管的识别服务", () => {
  it("预热：让它加载模型（设置和 stdio 那行 init 一样）、等它加载好；状态是 等待 → 加载中 → 已就绪，报一次加载好了；已经好了直接回、不重复预热", async () => {
    const { asr, recognizer } = await setup();
    const states: string[] = [];
    recognizer.onState((s) => states.push(s.status));
    const events: string[] = [];
    recognizer.onLifecycle((e) => events.push(e.type === "loaded" ? `loaded:${e.info.model}` : `ended:${e.cause}`));
    expect(recognizer.state.status).toBe("waiting");
    expect(recognizer.running).toBe(false);

    const loaded = await recognizer.load();
    expect(loaded).toEqual({ model: "large-v3", device: "cuda", computeType: "int8_float16", loadMs: 0 });
    expect(recognizer.state).toMatchObject({ status: "ready", model: "large-v3", device: "cuda", computeType: "int8_float16", loadMs: 0 });
    expect(recognizer.running).toBe(true);
    expect(states).toEqual(["loading", "ready"]);
    expect(events).toEqual(["loaded:large-v3"]);

    // 设置交给了服务：两种接法用哪个模型还是这套配置说了算
    const warmups = eventsOf(asr.log, "warmup");
    expect(warmups).toHaveLength(1);
    expect(warmups[0]!.init).toEqual(INIT);
    // 已经加载好了：直接回，不再预热
    expect(await recognizer.load()).toEqual(loaded);
    expect(eventsOf(asr.log, "warmup")).toHaveLength(1);
  });

  it("模型是异步加载的：服务说还在加载时每 500 毫秒看一次 /health，等它好了才回；报的加载耗时照服务的", async () => {
    const { asr, recognizer } = await setup({ directive: { loadMs: 300 } });
    const started = Date.now();
    const loading = recognizer.load();
    await waitUntil(() => recognizer.state.status === "loading", { timeoutMs: 2000 });
    const loaded = await loading;
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(loaded.loadMs).toBe(300);
    expect(recognizer.state).toMatchObject({ status: "ready", loadMs: 300 });
    expect(eventsOf(asr.log, "health").length).toBeGreaterThanOrEqual(1);
  });

  it("识别：录音按 base64 发过去（字节数对得上），语言和给模型的提示照传；回来的文字、分段、时长、模型都对", async () => {
    const { asr, recognizer, recording } = await setup({ directive: { text: "今天天气怎么样。下午要不要带伞。", seconds: 3 } });
    await recognizer.load();
    const file = recording("今天天气怎么样。下午要不要带伞。");
    const result = await recognizer.transcribe({ path: file, language: "zh", initialPrompt: "以下是普通话的句子。" });
    expect(result).toEqual({
      text: "今天天气怎么样。下午要不要带伞。",
      language: "zh",
      segments: [
        { start: 0, end: 1.5, text: "今天天气怎么样。" },
        { start: 1.5, end: 3, text: "下午要不要带伞。" },
      ],
      duration: 3,
      model: "large-v3",
      device: "cuda",
      computeType: "int8_float16",
    });
    const [sent] = eventsOf(asr.log, "transcribe");
    expect(sent).toMatchObject({ language: "zh", initialPrompt: "以下是普通话的句子。", bytes: fs.statSync(file).size });
  });

  it("180 号票：串词照旧在交出结果之前剔掉，和守护进程自己拉起识别进程那条一样", async () => {
    const { recognizer, recording } = await setup({
      directive: { text: "下午三点开会。请不吝点赞 订阅 转发 打赏支持明镜与点点栏目。别忘了。", seconds: 3 },
      stripRules: true,
    });
    await recognizer.load();
    expect(await recognizer.transcribe({ path: recording("x") })).toMatchObject({ text: "下午三点开会。别忘了。", strippedChars: 21 });
  });

  it("加载失败：以 RecognizerUnavailable 结束，状态是出错（带原因），报一次没加载起来；服务是常驻的，撤掉失败的原因之后再预热就好了", async () => {
    const { asr, recognizer } = await setup({ directive: { loadFail: "no CUDA" } });
    const events: string[] = [];
    recognizer.onLifecycle((e) => events.push(e.type === "loaded" ? `loaded:${e.info.model}` : `ended:${e.cause}`));
    const err = await recognizer.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognizerUnavailable);
    expect((err as Error).message).toBe("模型加载失败：no CUDA");
    expect(recognizer.state).toMatchObject({ status: "error", reason: "模型加载失败：no CUDA" });
    expect(recognizer.running).toBe(false);
    expect(events).toEqual(["ended:load_failed"]);
    // 显存腾出来了（指令撤掉）：再预热一次就好了
    setFakeAsr(asr.log, {});
    expect(await recognizer.load()).toMatchObject({ model: "large-v3", device: "cuda" });
    expect(recognizer.state.status).toBe("ready");
  });

  it("识别超时：限时一到就作废（状态出错、报一次意外没了），这次以出错结束；下次调用重新预热、照常识别", async () => {
    const { asr, recognizer, recording } = await setup({
      directive: { hangTranscribe: true },
      // 冷启动给足：超时作废以后"下次调用重新预热"要把模型重新加载完才识别，机器忙时 0.3 秒不够（全量里偶发超时）；
      // 第一次是预热好了再卡住，不加冷启动这一段，限时照旧约 0.4 秒
      timeout: { baseMs: 300, coldStartMs: 10_000, gpuPerAudioSecond: 0.1, cpuPerAudioSecond: 0.1 },
    });
    const events: string[] = [];
    recognizer.onLifecycle((e) => events.push(e.type === "loaded" ? `loaded:${e.info.model}` : `ended:${e.cause}`));
    await recognizer.load();
    const started = Date.now();
    await expect(recognizer.transcribe({ path: recording("卡住") }, 1000)).rejects.toThrow(/识别超过 \d+ 秒没有结果/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(recognizer.state).toMatchObject({ status: "error" });
    expect(recognizer.running).toBe(false);
    expect(events).toEqual(["loaded:large-v3", "ended:exited"]);
    // 服务好了：下一次重新预热、识别照常
    setFakeAsr(asr.log, { text: "好了" });
    await expect(recognizer.transcribe({ path: recording("再来") })).resolves.toMatchObject({ text: "好了" });
  });

  it("识别出错（服务回 500，不是致命）：这次以出错结束、服务还在；fatal 的以 RecognizerUnavailable 结束，服务作废", async () => {
    const recoverable = await setup({ directive: { transcribeError: "听不清" } });
    await recoverable.recognizer.load();
    await expect(recoverable.recognizer.transcribe({ path: recoverable.recording("嗯") })).rejects.toThrow("识别出错：听不清");
    expect(recoverable.recognizer.running).toBe(true);
    expect(recoverable.recognizer.state.status).toBe("ready");
    setFakeAsr(recoverable.asr.log, { text: "这回好了" });
    await expect(recoverable.recognizer.transcribe({ path: recoverable.recording("再说") })).resolves.toMatchObject({ text: "这回好了" });

    const fatal = await setup({ directive: { transcribeFatal: "CUDA out of memory" } });
    await fatal.recognizer.load();
    const err = await fatal.recognizer.transcribe({ path: fatal.recording("嗯") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognizerUnavailable);
    expect((err as Error).message).toBe("模型加载失败：CUDA out of memory");
    expect(fatal.recognizer.state).toMatchObject({ status: "error", reason: "模型加载失败：CUDA out of memory" });
    expect(fatal.recognizer.running).toBe(false);
    setFakeAsr(fatal.asr.log, { text: "好了" });
    await expect(fatal.recognizer.load()).resolves.toMatchObject({ model: "large-v3" });
  });

  it("服务中途没了（LSM 还没来得及拉起）：识别以 RecognizerUnavailable 结束、说明里是连不上哪个地址；状态出错", async () => {
    const { asr, recognizer, recording } = await setup();
    await recognizer.load();
    await asr.down();
    const err = await recognizer.transcribe({ path: recording("嗯") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognizerUnavailable);
    expect((err as Error).message).toContain(`连不上语音识别服务（${asr.url}）：`);
    expect(recognizer.state).toMatchObject({ status: "error" });
    expect(recognizer.running).toBe(false);
  });

  it("208 号票 check()：加载好、空着的问一句 /health 就回（不重新预热、不另报加载好了）；正识别着的不另外问", async () => {
    const idle = await setup();
    await idle.recognizer.load();
    const warmups = eventsOf(idle.asr.log, "warmup").length;
    expect(await idle.recognizer.check()).toMatchObject({ model: "large-v3", device: "cuda" });
    expect(eventsOf(idle.asr.log, "health").length).toBeGreaterThanOrEqual(1);
    expect(eventsOf(idle.asr.log, "warmup")).toHaveLength(warmups);

    const busy = await setup({ directive: { hangTranscribe: true } });
    await busy.recognizer.load();
    const pending = busy.recognizer.transcribe({ path: busy.recording("正在识别") }).catch(() => {});
    await waitUntil(() => eventsOf(busy.asr.log, "transcribe").length > 0);
    const healths = eventsOf(busy.asr.log, "health").length;
    expect(await busy.recognizer.check()).toMatchObject({ model: "large-v3" });
    expect(eventsOf(busy.asr.log, "health")).toHaveLength(healths);
    await busy.recognizer.close();
    await pending;
  });

  it("208 号票 check()：服务卡住（/health 不应答）就判这一代不能用了，重新预热也不行才以 RecognizerUnavailable 结束", async () => {
    const { asr, recognizer, lines } = await setup({
      directive: {},
      timeout: { baseMs: 600, coldStartMs: 0, gpuPerAudioSecond: 1, cpuPerAudioSecond: 1 },
    });
    await recognizer.load();
    setFakeAsr(asr.log, { wedged: true });
    const started = Date.now();
    const err = await recognizer.check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognizerUnavailable);
    // 300 毫秒问不到 /health，接着等预热（这里最多 600 毫秒）
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await waitUntil(() => recognizer.state.status === "error", { timeoutMs: 2000 });
    expect(recognizer.running).toBe(false);
    expect(lines.filter((l) => l.startsWith("语音识别服务不正常"))).toEqual([expect.stringMatching(/^语音识别服务不正常（语音识别服务 1 秒没应答/)]);
  });

  it("close()：等着的识别以「语音识别已停止」结束，之后不再发请求", async () => {
    const { asr, recognizer, recording } = await setup({ directive: { hangTranscribe: true } });
    await recognizer.load();
    const pending = recognizer.transcribe({ path: recording("等着") }).catch((e: unknown) => e);
    await waitUntil(() => eventsOf(asr.log, "transcribe").length > 0);
    await recognizer.close();
    expect(await pending).toEqual(new Error("语音识别已停止"));
    await expect(recognizer.transcribe({ path: recording("之后") })).rejects.toThrow("语音识别已停止");
  });
});
