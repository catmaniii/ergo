// 语音识别进程的宿主（voice/recognizer.ts，31 号票）：按需拉起、放进自己的 Job 对象、JSON 行一问一答、闲置退出、超时和出错；
// 45 号票：拉起后马上加载模型（load）、模型的状态（state / onState）、闲置时间为 0 时常驻。
// 接的是假的识别进程（fixtures/fake-recognizer.mjs），不加载真模型。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { createJobObject, type JobObject } from "../../src/process/job-object.ts";
import { createProcessRecognizer, type Recognizer, RecognizerUnavailable } from "../../src/voice/index.ts";
import { type ProcessRecognizerOptions, recognizeTimeoutMs } from "../../src/voice/recognizer.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { type FakeAsr, fakeRecognizerCommand, fakeRecording, recognizerLog, setFakeLoad } from "../helpers/voice.ts";

const INIT = { primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" }, fallback: { device: "cpu", model: "small", computeType: "int8" } };

function setup(overrides: Partial<ProcessRecognizerOptions> = {}): { recognizer: Recognizer; log: string; dir: string; recording(asr: FakeAsr): string } {
  const dir = makeTempDir("ergou-asr-");
  const log = path.join(dir, "recognizer.jsonl");
  const recognizer = createProcessRecognizer({
    command: fakeRecognizerCommand(log),
    env: buildChildEnv(process.env),
    cwd: dir,
    init: INIT,
    idleMs: 60_000,
    timeout: { baseMs: 10_000, coldStartMs: 0, gpuPerAudioSecond: 1, cpuPerAudioSecond: 1 },
    log: () => {},
    ...overrides,
  });
  onTestFinished(() => recognizer.close());
  let n = 0;
  return {
    recognizer,
    log,
    dir,
    recording(asr) {
      const file = path.join(dir, `rec-${++n}`);
      fs.writeFileSync(file, fakeRecording(asr));
      return file;
    },
  };
}

const pidOf = (log: string) => recognizerLog(log).find((e) => e.event === "start")?.pid;

describe("识别进程", () => {
  it("第一次要用时才拉起，先交给它设置、紧接着让它加载模型；识别排在加载后面，一次一条，结果按请求对上；之后接着用同一个进程", async () => {
    const { recognizer, log, recording } = setup();
    expect(recognizer.running).toBe(false);
    expect(recognizerLog(log)).toEqual([]);
    const [a, b] = await Promise.all([recognizer.transcribe({ path: recording({ text: "第一句。" }), language: "zh" }), recognizer.transcribe({ path: recording({ text: "第二句。", fallback: "没有可用的显卡" }) })]);
    expect(a).toMatchObject({ text: "第一句。", language: "zh", model: "large-v3", device: "cuda", computeType: "int8_float16" });
    expect(b).toMatchObject({ text: "第二句。", model: "small", device: "cpu", fallbackReason: "没有可用的显卡" });
    expect(recognizer.running).toBe(true);
    expect(recognizerLog(log).map((e) => e.event)).toEqual(["start", "init", "load", "transcribe", "transcribe"]);
    expect(recognizerLog(log)[1]).toMatchObject(INIT);
  });

  it("load()（预热）：拉起并加载模型，回报用的模型、设备、加载耗时；已经加载好了直接回报，不另起进程；状态：等待加载 → 加载中 → 已就绪", async () => {
    const { recognizer, log } = setup();
    setFakeLoad(log, { loadMs: 3500 });
    const states: string[] = [];
    recognizer.onState((s) => states.push(s.status));
    expect(recognizer.state.status).toBe("waiting");
    const loaded = await recognizer.load();
    expect(loaded).toEqual({ model: "large-v3", device: "cuda", computeType: "int8_float16", loadMs: 3500 });
    expect(recognizer.state).toMatchObject({ status: "ready", model: "large-v3", device: "cuda", computeType: "int8_float16", loadMs: 3500 });
    expect(await recognizer.load()).toEqual(loaded);
    expect(states).toEqual(["loading", "ready"]);
    expect(recognizerLog(log).map((e) => e.event)).toEqual(["start", "init", "load"]);
  });

  it("显卡上加载不了、退回了 CPU：回报和状态里是退回后的模型和原因；之后的识别也是它", async () => {
    const { recognizer, log, recording } = setup();
    setFakeLoad(log, { fallback: "large-v3 加载失败：out of memory" });
    expect(await recognizer.load()).toMatchObject({ model: "small", device: "cpu", computeType: "int8", fallbackReason: "large-v3 加载失败：out of memory" });
    expect(recognizer.state).toMatchObject({ status: "ready", model: "small", device: "cpu", fallbackReason: "large-v3 加载失败：out of memory" });
    expect(await recognizer.transcribe({ path: recording({ text: "嗯。" }) })).toMatchObject({ model: "small", device: "cpu" });
  });

  it("加载失败（致命）：load 以 RecognizerUnavailable 结束，排在后面的识别一起失败，进程作废，状态是出错（带原因）；下次要用时重新拉起", async () => {
    const { recognizer, log, recording } = setup();
    setFakeLoad(log, { fatal: "no CUDA" });
    const pending = recognizer.transcribe({ path: recording({ text: "排在后面" }) }).catch((e: unknown) => e);
    const err = await recognizer.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognizerUnavailable);
    expect((err as Error).message).toBe("模型加载失败：no CUDA");
    expect(await pending).toBeInstanceOf(RecognizerUnavailable);
    expect(recognizer.running).toBe(false);
    expect(recognizer.state).toMatchObject({ status: "error", reason: "模型加载失败：no CUDA" });
    setFakeLoad(log, undefined);
    await expect(recognizer.load()).resolves.toMatchObject({ model: "large-v3" });
    expect(recognizerLog(log).filter((e) => e.event === "start")).toHaveLength(2);
  });

  it("进程的一生明确报出来：加载好了；没了的话报为什么——没加载起来、加载好之后意外没了、闲置退出", async () => {
    const { recognizer, log, recording } = setup({ idleMs: 300 });
    const events: string[] = [];
    recognizer.onLifecycle((e) => events.push(e.type === "loaded" ? `loaded:${e.info.model}` : `ended:${e.cause}`));
    // 没加载起来
    setFakeLoad(log, { fatal: "no CUDA" });
    await recognizer.load().catch(() => {});
    expect(events).toEqual(["ended:load_failed"]);
    // 加载好了，之后闲置退出
    setFakeLoad(log, undefined);
    await recognizer.load();
    await waitUntil(() => events.length === 3, { timeoutMs: 10_000 });
    expect(events).toEqual(["ended:load_failed", "loaded:large-v3", "ended:idle"]);
    // 加载好了，识别时进程崩了：加载好之后意外没了
    await recognizer.transcribe({ path: recording({ crash: "Segmentation fault" }) }).catch(() => {});
    await waitUntil(() => events.length === 5, { timeoutMs: 10_000 });
    expect(events.slice(3)).toEqual(["loaded:large-v3", "ended:exited"]);
    // 自己停的不报
    await recognizer.load();
    await recognizer.close();
    expect(events.slice(5)).toEqual(["loaded:large-v3"]);
  });

  it("闲置时间为 0：常驻，不因闲置退出；被杀了状态是出错（意外退出）", async () => {
    const { recognizer, log, recording } = setup({ idleMs: 0 });
    await recognizer.transcribe({ path: recording({ text: "一" }) });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(recognizer.running).toBe(true);
    expect(recognizerLog(log).map((e) => e.event)).not.toContain("exit");
    process.kill(pidOf(log)!);
    await waitUntil(() => recognizer.state.status === "error", { timeoutMs: 10_000 });
    expect(recognizer.state.reason).toMatch(/^识别进程退出了/);
    expect(recognizer.running).toBe(false);
  });

  it("stdout 上不是协议的行（库打出来的东西）不当应答，照常等真正的结果", async () => {
    const { recognizer, recording } = setup();
    await expect(recognizer.transcribe({ path: recording({ text: "照常", noise: "Downloading model..." }) })).resolves.toMatchObject({ text: "照常" });
  });

  it("闲置超过配置的时间：让它退出、释放模型；再识别时重新拉起", async () => {
    const { recognizer, log, recording } = setup({ idleMs: 300 });
    await recognizer.transcribe({ path: recording({ text: "一" }) });
    const first = pidOf(log)!;
    await waitUntil(() => !recognizer.running && !isProcessAlive(first), { timeoutMs: 10_000 });
    expect(recognizerLog(log).map((e) => e.event)).toContain("exit");
    // 闲置退出：模型已卸载（不算出错）
    expect(recognizer.state.status).toBe("unloaded");
    await recognizer.transcribe({ path: recording({ text: "二" }) });
    const starts = recognizerLog(log).filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.pid).not.toBe(first);
  });

  it("识别出错（不致命）：这次以出错结束，进程接着用；模型加载失败（致命）：以 RecognizerUnavailable 结束，进程作废，下次重新拉起", async () => {
    const { recognizer, log, recording } = setup();
    await expect(recognizer.transcribe({ path: recording({ error: "解码失败" }) })).rejects.toThrow("识别出错：解码失败");
    expect(recognizer.running).toBe(true);
    const failed = recognizer.transcribe({ path: recording({ fatal: "CUDA out of memory" }) });
    await expect(failed).rejects.toBeInstanceOf(RecognizerUnavailable);
    await expect(failed).rejects.toThrow("模型加载失败：CUDA out of memory");
    expect(recognizer.running).toBe(false);
    await expect(recognizer.transcribe({ path: recording({ text: "好了" }) })).resolves.toMatchObject({ text: "好了" });
    expect(recognizerLog(log).filter((e) => e.event === "start")).toHaveLength(2);
  });

  it("起不来（程序不存在）、识别到一半退出：以 RecognizerUnavailable 结束，说明里带上 stderr 的结尾", async () => {
    const missing = setup({ command: [path.join(makeTempDir("ergou-nopy-"), "python.exe"), "recognizer.py"] });
    await expect(missing.recognizer.transcribe({ path: missing.recording({ text: "嗯" }) })).rejects.toThrow(/识别进程起不来/);
    const crash = setup();
    const err = await crash.recognizer.transcribe({ path: crash.recording({ crash: "ImportError: No module named faster_whisper" }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognizerUnavailable);
    expect((err as Error).message).toMatch(/识别进程退出了（退出码 3）：ImportError: No module named faster_whisper/);
  });

  it("超时（按语音时长算）：结束这个进程（可能卡住了），这次以出错结束；下次重新拉起", async () => {
    const { recognizer, log, recording, dir } = setup({ timeout: { baseMs: 300, coldStartMs: 10_000, gpuPerAudioSecond: 0.1, cpuPerAudioSecond: 0.1 } });
    // 先加载好（热的：不算冷启动的时间）
    await recognizer.load();
    const started = Date.now();
    await expect(recognizer.transcribe({ path: recording({ text: "卡住", holdFile: path.join(dir, "never") }) }, 2000)).rejects.toThrow(/识别超过 \d+ 秒没有结果/);
    // 300 毫秒余量 + 2 秒语音 × 0.1
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    const pid = pidOf(log)!;
    await waitUntil(() => !isProcessAlive(pid), { timeoutMs: 10_000 });
    await expect(recognizer.transcribe({ path: recording({ text: "又来" }) })).resolves.toMatchObject({ text: "又来" });
  });

  it("close()：等着的请求以出错结束，进程结束", async () => {
    const { recognizer, log, recording, dir } = setup();
    const pending = recognizer.transcribe({ path: recording({ text: "等着", holdFile: path.join(dir, "never") }) }).catch((err: unknown) => err);
    await waitUntil(() => recognizerLog(log).some((e) => e.event === "transcribe"));
    const pid = pidOf(log)!;
    await recognizer.close();
    expect(await pending).toEqual(new Error("语音识别已停止"));
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("识别进程的 Job 对象", () => {
  it("识别进程放进它自己的 Job 对象；闲置退出、close 时 Job 关掉", async () => {
    const jobs: JobObject[] = [];
    const { recognizer, log, recording } = setup({
      newJob: () => {
        const job = createJobObject();
        jobs.push(job);
        return job;
      },
    });
    await recognizer.transcribe({ path: recording({ text: "在 Job 里" }) });
    const pid = pidOf(log)!;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.contains(pid)).toBe(true);
    expect(jobs[0]!.limits()).toEqual({ killOnClose: true, breakawayAllowed: false });
    await recognizer.close();
    expect(isProcessAlive(pid)).toBe(false);
    expect(() => jobs[0]!.processIds()).toThrow(/已关闭/);
  });
});

describe("一次识别最多等多久", () => {
  const timeout = { baseMs: 30_000, coldStartMs: 60_000, gpuPerAudioSecond: 1, cpuPerAudioSecond: 3 };
  it("按语音时长和设备算：显卡上热着的最紧，CPU 上宽；还没加载模型（刚拉起）时多留冷启动，按 primary 和退回的里宽的算", () => {
    // 显卡上已经加载好：30 秒余量 + 15 秒语音 × 1
    expect(recognizeTimeoutMs(timeout, INIT, 15_000, "cuda")).toBe(45_000);
    // CPU 上（已经退回过）：30 + 15 × 3
    expect(recognizeTimeoutMs(timeout, INIT, 15_000, "cpu")).toBe(75_000);
    // 冷的：多 60 秒，可能退回 CPU，按 CPU 的算
    expect(recognizeTimeoutMs(timeout, INIT, 15_000, undefined)).toBe(135_000);
    // 冷的、不退回（只用显卡）：按显卡的算
    expect(recognizeTimeoutMs(timeout, { primary: INIT.primary, fallback: null }, 15_000, undefined)).toBe(105_000);
    // 最坏的：最长的 60 秒语音、冷的、退回 CPU，4.5 分钟
    expect(recognizeTimeoutMs(timeout, INIT, 60_000, undefined)).toBe(270_000);
  });
});
