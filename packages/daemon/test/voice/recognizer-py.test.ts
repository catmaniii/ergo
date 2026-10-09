// 识别进程的 Python 脚本（src/voice/recognizer.py，31 号票）：和守护进程这一侧说的 JSON 行对得上；显卡不可用、加载失败、
// 识别时显卡出错都退回 CPU 的模型并记下原因；库打到 stdout 上的东西不混进协议。
// faster-whisper 和 ctranslate2 换成临时目录里的替身模块（PYTHONPATH 指过去，-s 不读用户目录的 site-packages）：
// 不加载真模型、不占显卡。本机没有 Python 时跳过。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { createProcessRecognizer, RECOGNIZER_ENV, RECOGNIZER_SCRIPT, RecognizerUnavailable } from "../../src/voice/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const PYTHON = process.env.ERGOU_TEST_PYTHON ?? "python";
const hasPython = spawnSync(PYTHON, ["-s", "-c", "import json, sys; sys.exit(0)"], { stdio: "ignore", windowsHide: true }).status === 0;

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

function setup(options: { fallback?: boolean } = {}) {
  const root = makeTempDir("ergou-pystub-");
  for (const [dir, body] of [
    ["faster_whisper", STUB_FW],
    ["ctranslate2", STUB_CT2],
  ] as const) {
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, "__init__.py"), body);
  }
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
