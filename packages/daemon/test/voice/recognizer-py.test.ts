// 识别进程的 Python 脚本（src/voice/recognizer.py，31 号票）：和守护进程这一侧说的 JSON 行对得上；显卡不可用、加载失败、
// 识别时显卡出错都退回 CPU 的模型并记下原因；库打到 stdout 上的东西不混进协议。
// 250 号票：同一份脚本的 --serve（LSM 托管的那条 HTTP 服务）也在这里真起起来验一遍：预热、状态、识别、错误。
// faster-whisper 和 ctranslate2 换成临时目录里的替身模块（PYTHONPATH 指过去，-s 不读用户目录的 site-packages）：
// 不加载真模型、不占显卡。本机没有 Python 时跳过。
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { createProcessRecognizer, RECOGNIZER_ENV, RECOGNIZER_SCRIPT, RecognizerUnavailable } from "../../src/voice/index.ts";
import { killIfRunning } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const PYTHON = process.env.ERGO_TEST_PYTHON ?? "python";
const hasPython = spawnSync(PYTHON, ["-s", "-c", "import json, sys; sys.exit(0)"], { stdio: "ignore", windowsHide: true }).status === 0;

const INIT = {
  primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" },
  fallback: { device: "cpu", model: "small", computeType: "int8" },
};

/**
 * 替身：ctranslate2 报几块显卡（文件 cuda_count 里写的数，默认 1）；faster_whisper 的 WhisperModel 在 cuda 上加载时按文件 cuda_load 的内容
 * 报错（没有这个文件就加载成功），cuda 上识别时按文件 cuda_transcribe 的内容报错；识别结果是录音文件里的文字按"。"切开。
 * 加载时往 stdout 打一行（模拟库的输出）
 */
const STUB_CT2 = `
import os
def get_cuda_device_count():
    f = os.path.join(os.path.dirname(__file__), "..", "cuda_count")
    return int(open(f).read()) if os.path.exists(f) else 1
`;
const STUB_FW = `
import os
ROOT = os.path.join(os.path.dirname(__file__), "..")
def flag(name):
    f = os.path.join(ROOT, name)
    return open(f, encoding="utf-8").read() if os.path.exists(f) else None

class Segment:
    def __init__(self, start, end, text):
        self.start, self.end, self.text = start, end, text

class Info:
    def __init__(self, language, duration):
        self.language, self.duration = language, duration

class WhisperModel:
    def __init__(self, model, device="auto", compute_type="default"):
        print("loading %s on %s" % (model, device))
        if device == "cuda" and flag("cuda_load"):
            raise RuntimeError(flag("cuda_load"))
        self.device = device
        with open(os.path.join(ROOT, "loads.txt"), "a", encoding="utf-8") as f:
            f.write("%s %s %s\\n" % (model, device, compute_type))

    def transcribe(self, path, **kwargs):
        if self.device == "cuda" and flag("cuda_transcribe"):
            raise RuntimeError(flag("cuda_transcribe"))
        with open(os.path.join(ROOT, "kwargs.txt"), "a", encoding="utf-8") as f:
            f.write(repr(sorted(kwargs.items())) + "\\n")
        text = open(path, encoding="utf-8").read()
        pieces = [p + "。" for p in text.split("。") if p]
        return (Segment(i * 1.5, (i + 1) * 1.5, " " + p) for i, p in enumerate(pieces)), Info("zh", 1.5 * len(pieces))
`;

/** 临时目录里放 faster_whisper / ctranslate2 的替身模块（见上），返回这个目录 */
function writeStubs(): string {
  const root = makeTempDir("ergo-pystub-");
  for (const [dir, body] of [
    ["faster_whisper", STUB_FW],
    ["ctranslate2", STUB_CT2],
  ] as const) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, "__init__.py"), body);
  }
  return root;
}

function setup(options: { fallback?: boolean } = {}) {
  const root = writeStubs();
  const recognizer = createProcessRecognizer({
    command: [PYTHON, "-s", RECOGNIZER_SCRIPT],
    env: buildChildEnv(process.env, { ...RECOGNIZER_ENV, PYTHONPATH: root }),
    cwd: root,
    init: {
      primary: { device: "cuda", model: "large-v3", computeType: "int8_float16" },
      fallback: options.fallback === false ? null : { device: "cpu", model: "small", computeType: "int8" },
    },
    idleMs: 60_000,
    timeout: { baseMs: 20_000, coldStartMs: 0, gpuPerAudioSecond: 1, cpuPerAudioSecond: 1 },
    log: () => {},
  });
  onTestFinished(() => recognizer.close());
  const audio = (text: string) => {
    const file = path.join(root, `audio-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(file, text, "utf8");
    return file;
  };
  const set = (name: string, value: string) => fs.writeFileSync(path.join(root, name), value, "utf8");
  // Python 在 Windows 上按文本写文件，行尾是 \r\n
  const lines = (name: string) => (fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), "utf8").trim().split(/\r?\n/) : []);
  const loads = () => lines("loads.txt");
  const kwargs = () => lines("kwargs.txt");
  return { recognizer, audio, set, loads, kwargs };
}

describe.runIf(hasPython)("识别进程的 Python 脚本", () => {
  it("显卡能用：在显卡上加载一次 large-v3，之后接着用；中文的分段拼起来不加空格；语言、提示、静音过滤交给 faster-whisper", async () => {
    const { recognizer, audio, loads, kwargs } = setup();
    const first = await recognizer.transcribe({ path: audio("今天天气怎么样。下午要不要带伞。"), language: "zh", initialPrompt: "以下是普通话的句子。" });
    expect(first).toEqual({
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
    await recognizer.transcribe({ path: audio("再来一句。") });
    expect(loads()).toEqual(["large-v3 cuda int8_float16"]);
    expect(kwargs()[0]).toBe("[('beam_size', 5), ('condition_on_previous_text', False), ('initial_prompt', '以下是普通话的句子。'), ('language', 'zh'), ('vad_filter', True)]");
  }, 30_000);

  it("没有可用的显卡：直接用 CPU 的 small，结果里记下原因", async () => {
    const { recognizer, audio, set, loads } = setup();
    set("cuda_count", "0");
    expect(await recognizer.transcribe({ path: audio("你好。") })).toMatchObject({ model: "small", device: "cpu", computeType: "int8", fallbackReason: "没有可用的显卡" });
    expect(loads()).toEqual(["small cpu int8"]);
  }, 30_000);

  it("显卡上加载失败（比如显存不够）：退回 CPU；识别时显卡出错：退回 CPU 再识别一次", async () => {
    const loadFails = setup();
    loadFails.set("cuda_load", "CUDA failed with error out of memory");
    expect(await loadFails.recognizer.transcribe({ path: loadFails.audio("一。") })).toMatchObject({
      device: "cpu",
      fallbackReason: "large-v3 加载失败：CUDA failed with error out of memory",
    });
    const runFails = setup();
    runFails.set("cuda_transcribe", "CUDA error: out of memory");
    expect(await runFails.recognizer.transcribe({ path: runFails.audio("二。") })).toMatchObject({ text: "二。", device: "cpu", fallbackReason: "用 cuda 识别时出错：CUDA error: out of memory" });
    expect(runFails.loads()).toEqual(["large-v3 cuda int8_float16", "small cpu int8"]);
  }, 30_000);

  it("加载（45 号票的预热）：拉起后马上在显卡上加载，回报模型、设备、计算精度、加载耗时；之后的识别不再加载", async () => {
    const { recognizer, audio, loads } = setup();
    const loaded = await recognizer.load();
    expect(loaded).toMatchObject({ model: "large-v3", device: "cuda", computeType: "int8_float16" });
    expect(loaded.loadMs).toBeGreaterThanOrEqual(0);
    expect(loaded).not.toHaveProperty("fallbackReason");
    expect(await recognizer.transcribe({ path: audio("你好。") })).toMatchObject({ text: "你好。", device: "cuda" });
    expect(loads()).toEqual(["large-v3 cuda int8_float16"]);
  }, 30_000);

  it("加载时显卡上加载失败：退回 CPU 的 small，回报里有原因；也没得退时加载以 RecognizerUnavailable 结束", async () => {
    const fallsBack = setup();
    fallsBack.set("cuda_load", "CUDA failed with error out of memory");
    expect(await fallsBack.recognizer.load()).toMatchObject({ model: "small", device: "cpu", computeType: "int8", fallbackReason: "large-v3 加载失败：CUDA failed with error out of memory" });
    const fails = setup({ fallback: false });
    fails.set("cuda_load", "no CUDA");
    const err = await fails.recognizer.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognizerUnavailable);
    expect((err as Error).message).toBe("模型加载失败：no CUDA");
  }, 30_000);

  it("不退回（fallback 是 null）时加载失败：以 RecognizerUnavailable 结束（致命）", async () => {
    const { recognizer, audio, set } = setup({ fallback: false });
    set("cuda_load", "no CUDA");
    const err = await recognizer.transcribe({ path: audio("嗯。") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognizerUnavailable);
    expect((err as Error).message).toBe("模型加载失败：no CUDA");
  }, 30_000);
});

// ───────────── --serve：LSM 托管的那条（250 号票） ─────────────

/** 服务回的模型状态（和 recognizer.py 的 status() 一样） */
interface ServeStatus {
  ok: boolean;
  loaded: boolean;
  model: string;
  device: string;
  computeType: string;
  loadMs?: number;
  fallbackReason?: string;
  error?: string;
}

interface ServeHandle {
  url: string;
  root: string;
  /** 写替身模块的指令文件（cuda_count、cuda_load、cuda_transcribe……） */
  set(name: string, value: string): void;
  loads(): string[];
  kwargs(): string[];
}

/**
 * 真起一个 `python -s recognizer.py --serve --port 0`（端口由系统挑，从 stderr 里那句启动日志读出来），
 * 替身模块在临时目录里，测试结束时结束进程。本机没有 Python 时整个 describe 跳过。
 */
async function startService(): Promise<ServeHandle> {
  const root = writeStubs();
  const child: ChildProcess = spawn(PYTHON, ["-s", RECOGNIZER_SCRIPT, "--serve", "--port", "0"], {
    env: buildChildEnv(process.env, { ...RECOGNIZER_ENV, PYTHONPATH: root }),
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  onTestFinished(async () => {
    killIfRunning(child);
    await exited;
  });
  let stderr = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`语音识别服务没起来：${stderr}`)), 20_000);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      const found = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
      if (found) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${found[1]}`);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`语音识别服务退出了（${code}）：${stderr}`));
    });
  });
  const set = (name: string, value: string) => fs.writeFileSync(path.join(root, name), value, "utf8");
  // Python 在 Windows 上按文本写文件，行尾是 \r\n
  const lines = (name: string) => (fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), "utf8").trim().split(/\r?\n/) : []);
  return { url, root, set, loads: () => lines("loads.txt"), kwargs: () => lines("kwargs.txt") };
}

/** GET 一个 JSON 接口 */
async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** POST 一个 JSON 接口（body 不给就发空正文） */
async function postJson(url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 等 /health 说出想要的状态（模型是后台加载的，等它转过来） */
async function waitFor(url: string, done: (status: ServeStatus) => boolean, timeoutMs = 10_000): Promise<ServeStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await getJson(`${url}/health`);
    const status = body as unknown as ServeStatus;
    if (done(status)) return status;
    if (Date.now() > deadline) throw new Error(`等不到：${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 一段录音的 base64（替身模块把文件当 UTF-8 文本读，所以这里给纯文本；真的录音是 webm / ogg / wav，按内容认） */
const audioBody = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe.runIf(hasPython)("--serve 的 HTTP 服务（LSM 托管的那条）", () => {
  it("起服务：先说没加载好；warmup 带上设置（和 stdio 那行 init 一样）、异步加载；好了以后 /health 和 /v1/models 是同一份；识别按 base64 收录音、语言和提示照传", async () => {
    const service = await startService();
    const before = await getJson(`${service.url}/health`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ ok: false, loaded: false, model: "large-v3", device: "cuda", computeType: "int8_float16" });

    const warm = await postJson(`${service.url}/v1/warmup`, INIT);
    expect(warm.status).toBe(200);
    expect(warm.body).toMatchObject({ ok: false, loaded: false, model: "large-v3", device: "cuda" });
    expect(await waitFor(service.url, (s) => s.loaded)).toEqual({
      ok: true,
      loaded: true,
      model: "large-v3",
      device: "cuda",
      computeType: "int8_float16",
      loadMs: expect.any(Number),
    });
    expect((await getJson(`${service.url}/v1/models`)).body).toEqual((await getJson(`${service.url}/health`)).body);

    const text = "今天天气怎么样。下午要不要带伞。";
    const transcribed = await postJson(`${service.url}/v1/transcribe`, { audio: audioBody(text), language: "zh", initialPrompt: "以下是普通话的句子。" });
    expect(transcribed.status).toBe(200);
    expect(transcribed.body).toEqual({
      text,
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
    expect(service.loads()).toEqual(["large-v3 cuda int8_float16"]);
    expect(service.kwargs()[0]).toBe("[('beam_size', 5), ('condition_on_previous_text', False), ('initial_prompt', '以下是普通话的句子。'), ('language', 'zh'), ('vad_filter', True)]");
  }, 30_000);

  it("显卡上加载失败：退回 CPU，状态和识别结果里都是退回后的模型和原因", async () => {
    const service = await startService();
    service.set("cuda_load", "CUDA failed with error out of memory");
    await postJson(`${service.url}/v1/warmup`, INIT);
    expect(await waitFor(service.url, (s) => s.loaded)).toMatchObject({
      ok: true,
      model: "small",
      device: "cpu",
      computeType: "int8",
      fallbackReason: "large-v3 加载失败：CUDA failed with error out of memory",
    });
    const transcribed = await postJson(`${service.url}/v1/transcribe`, { audio: audioBody("一。") });
    expect(transcribed.body).toMatchObject({ text: "一。", model: "small", device: "cpu", fallbackReason: "large-v3 加载失败：CUDA failed with error out of memory" });
  }, 30_000);

  it("识别时显卡出错：退回 CPU 再识别一次，结果和之后的状态都是退回后的", async () => {
    const service = await startService();
    service.set("cuda_transcribe", "CUDA error: out of memory");
    await postJson(`${service.url}/v1/warmup`, INIT);
    await waitFor(service.url, (s) => s.loaded);
    const transcribed = await postJson(`${service.url}/v1/transcribe`, { audio: audioBody("二。") });
    expect(transcribed.body).toMatchObject({ text: "二。", model: "small", device: "cpu", fallbackReason: "用 cuda 识别时出错：CUDA error: out of memory" });
    expect((await getJson(`${service.url}/health`)).body).toMatchObject({ model: "small", device: "cpu" });
  }, 30_000);

  it("加载失败（fatal）：/health 里 ok、loaded 都是 false、error 写清（不是 5xx）；识别回 503 + fatal；原因撤掉后重新预热能好", async () => {
    const service = await startService();
    service.set("cuda_load", "no CUDA");
    await postJson(`${service.url}/v1/warmup`, { primary: INIT.primary, fallback: null });
    const failed = await waitFor(service.url, (s) => s.error !== undefined);
    expect(failed).toEqual({ ok: false, loaded: false, model: "large-v3", device: "cuda", computeType: "int8_float16", error: "模型加载失败：no CUDA" });
    expect((await getJson(`${service.url}/v1/models`)).body).toEqual(failed);

    const transcribed = await postJson(`${service.url}/v1/transcribe`, { audio: audioBody("嗯。") });
    expect(transcribed.status).toBe(503);
    expect(transcribed.body).toEqual({ error: "模型加载失败：no CUDA", fatal: true });

    // 显存腾出来了：撤掉失败的原因，再预热一次就好（LSM 里的服务是常驻的，不会一坏就永远坏）
    fs.rmSync(path.join(service.root, "cuda_load"));
    await postJson(`${service.url}/v1/warmup`);
    expect(await waitFor(service.url, (s) => s.loaded)).toMatchObject({ ok: true, device: "cuda" });
  }, 30_000);

  it("不认得的地址 404；没给 audio、正写坏了的正文 400（都不是 5xx）", async () => {
    const service = await startService();
    expect((await getJson(`${service.url}/nope`)).status).toBe(404);
    expect(await postJson(`${service.url}/v1/transcribe`, {})).toMatchObject({ status: 400, body: { error: expect.stringContaining("audio") } });
    const broken = await fetch(`${service.url}/v1/transcribe`, { method: "POST", headers: { "content-type": "application/json" }, body: "不是 JSON" });
    expect(broken.status).toBe(400);
    await broken.arrayBuffer();
  }, 30_000);
});
