// 351：语音程序挑哪一版（N 卡的驱动版本、显卡算力 → CUDA 13.3 / 12.4 / CPU）、nvidia-smi 的输出怎么读、
// 数据目录带中文时语音组件改放到哪、参考音色发什么路径。都是纯函数，不跑真的 nvidia-smi、不联网。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { audioCppWorkingDir, voiceFallbackRoot } from "../../src/components/audiocpp-host.ts";
import { atLeast, CUDA_BUILDS, cudaMiss, parseNvidiaSmi, summarizeGpus, variantReason } from "../../src/components/nvidia.ts";
import { queryNvidia } from "../../src/components/probes.ts";
import { createAudioCppSynthesizer, speechVoiceRef } from "../../src/voice/speech.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("驱动版本、算力比大小", () => {
  test("按段比数字", () => {
    expect(atLeast("610.88", "580")).toBe(true);
    expect(atLeast("580", "580")).toBe(true);
    expect(atLeast("579.99", "580")).toBe(false);
    expect(atLeast("551.78", "551.78")).toBe(true);
    expect(atLeast("551.61", "551.78")).toBe(false);
    expect(atLeast("12.0", "8.9")).toBe(true);
    expect(atLeast("6.1", "7.5")).toBe(false);
  });

  test("要求写的是上游 v0.9.3 的：CUDA 13.3 要 580、算力 7.5；CUDA 12.4 要 551.78、算力 6.1", () => {
    expect(CUDA_BUILDS).toEqual({
      cuda: { cuda: "13.3", minDriver: "580", minComputeCapability: "7.5" },
      cuda12: { cuda: "12.4", minDriver: "551.78", minComputeCapability: "6.1" },
    });
  });
});

describe("读 nvidia-smi 的输出", () => {
  test("一块卡：型号、驱动、算力", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4070 Ti, 610.88, 8.9\r\n", true)).toEqual([{ name: "NVIDIA GeForce RTX 4070 Ti", driver: "610.88", computeCapability: "8.9" }]);
  });

  test("[N/A]、不像版本号的算没有；没问算力时只有两格", () => {
    expect(parseNvidiaSmi("Tesla P4, 551.78, [N/A]\n", true)).toEqual([{ name: "Tesla P4", driver: "551.78" }]);
    expect(parseNvidiaSmi("NVIDIA GeForce GTX 1080, 472.12\n", false)).toEqual([{ name: "NVIDIA GeForce GTX 1080", driver: "472.12" }]);
    expect(parseNvidiaSmi("weird, abc, x.y\n", true)).toEqual([{ name: "weird" }]);
    expect(parseNvidiaSmi("\n\n", true)).toEqual([]);
  });

  test("几块卡：驱动是同一个，算力取最低的那块（最稳）", () => {
    const gpus = parseNvidiaSmi("NVIDIA GeForce RTX 3090, 566.36, 8.6\nNVIDIA GeForce GTX 1080 Ti, 566.36, 6.1\n", true);
    expect(summarizeGpus(gpus)).toEqual({ name: "NVIDIA GeForce RTX 3090", driver: "566.36", computeCapability: "6.1" });
    expect(summarizeGpus([])).toBeUndefined();
  });

  test("先连算力一起问；老驱动不认 compute_cap 时只问型号和驱动；再不行只看 -L；没有 nvidia-smi 是没有 N 卡", () => {
    const calls: string[] = [];
    const runner = (answers: Record<string, { status: number | null; stdout?: string; missing?: boolean }>) => (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      const answer = answers[args[0]!] ?? { status: 1 };
      return { status: answer.status, stdout: answer.stdout ?? "", missing: answer.missing === true };
    };
    const env = { ProgramFiles: "Z:\\nowhere" };
    expect(queryNvidia(env, runner({ "--query-gpu=name,driver_version,compute_cap": { status: 0, stdout: "NVIDIA GeForce RTX 4070 Ti, 610.88, 8.9\n" } }))).toEqual({ name: "NVIDIA GeForce RTX 4070 Ti", driver: "610.88", computeCapability: "8.9" });
    expect(queryNvidia(env, runner({ "--query-gpu=name,driver_version,compute_cap": { status: 2 }, "--query-gpu=name,driver_version": { status: 0, stdout: "NVIDIA GeForce GTX 970, 466.77\n" } }))).toEqual({ name: "NVIDIA GeForce GTX 970", driver: "466.77" });
    expect(queryNvidia(env, runner({ "-L": { status: 0, stdout: "GPU 0: NVIDIA GeForce GTX 1080 (UUID: GPU-1)\n" } }))).toEqual({});
    calls.length = 0;
    expect(queryNvidia(env, runner({ "--query-gpu=name,driver_version,compute_cap": { status: null, missing: true } }))).toBeUndefined();
    // 找不到程序就不再问别的
    expect(calls).toEqual(["--query-gpu=name,driver_version,compute_cap --format=csv,noheader"]);
    expect(queryNvidia(env, runner({}))).toBeUndefined();
  });
});

describe("这一版用不用得了、为什么", () => {
  test("先看显卡（太老更新驱动也没用），再看驱动；查不到的说查不到；不在表里的显卡版不管", () => {
    expect(cudaMiss("cuda", { driver: "610.88", computeCapability: "8.9" })).toBeUndefined();
    expect(cudaMiss("cuda", { driver: "566.36", computeCapability: "8.6" })).toEqual({ why: "driver", driver: "566.36", need: "580" });
    expect(cudaMiss("cuda", { driver: "531.00", computeCapability: "6.1" })).toEqual({ why: "gpu", need: "7.5" });
    expect(cudaMiss("cuda12", { driver: "531.00", computeCapability: "6.1" })).toEqual({ why: "driver", driver: "531.00", need: "551.78" });
    expect(cudaMiss("cuda12", { driver: "610.88" })).toEqual({ why: "unknown" });
    expect(cudaMiss("cuda12", undefined)).toEqual({ why: "unknown" });
    expect(cudaMiss("vulkan", undefined)).toBeUndefined();
  });

  const variants = [
    { id: "cuda", when: { gpu: "nvidia" as const } },
    { id: "cuda12", when: { gpu: "nvidia" as const } },
    { id: "cpu" },
  ];
  const titleOf = (id: string) => ({ cuda: "CUDA 13.3 版", cuda12: "CUDA 12.4 版", cpu: "CPU 版" })[id] ?? id;
  const reason = (picked: string, gpu: "nvidia" | "none", nvidia?: { name?: string; driver?: string; computeCapability?: string }) =>
    variantReason({ variants, picked: variants.find((v) => v.id === picked)!, gpu, nvidia, titleOf });

  test("组件页那一行的话：没 N 卡、有 N 卡用最好的、次一些的为什么、只能 CPU 版为什么", () => {
    expect(reason("cpu", "none")).toBe("这台电脑没找到 N 卡");
    expect(reason("cuda", "nvidia", { driver: "610.88", computeCapability: "8.9" })).toBe("这台电脑有 N 卡，驱动 610.88");
    expect(reason("cuda12", "nvidia", { driver: "566.36", computeCapability: "8.6" })).toBe("显卡驱动是 566.36，CUDA 13.3 版要 580 或更新的驱动");
    expect(reason("cuda12", "nvidia", { name: "NVIDIA GeForce GTX 1060", driver: "582.28", computeCapability: "6.1" })).toBe("NVIDIA GeForce GTX 1060比较老，CUDA 13.3 版不支持它");
    expect(reason("cpu", "nvidia", { driver: "531.79", computeCapability: "7.5" })).toContain("显卡驱动 531.79 太旧，用显卡至少要 551.78");
    expect(reason("cpu", "nvidia", { driver: "582.28", computeCapability: "5.2" })).toBe("这块显卡太老，显卡版都不支持：只能用 CPU 版，会很慢");
    expect(reason("cpu", "nvidia", {})).toContain("查不到驱动版本或显卡型号");
    // 没有显卡版的组件（模型）不说
    expect(variantReason({ variants: [{ id: "q8" }], picked: { id: "q8" }, gpu: "nvidia", titleOf })).toBeUndefined();
  });
});

describe("数据目录带中文时语音组件改放到哪", () => {
  test("Windows：ProgramData 下 ergo\\<数据目录的指纹>，英文的；同一个数据目录（不分大小写）同一个，不同的不一样", () => {
    const env = { ProgramData: "C:\\ProgramData" };
    const a = voiceFallbackRoot(env, "C:\\Users\\张三\\.ergo", "win32")!;
    expect(a).toMatch(/^C:\\ProgramData\\ergo\\[0-9a-f]{8}$/);
    expect(voiceFallbackRoot(env, "c:\\users\\张三\\.ergo\\", "win32")).toBe(a);
    expect(voiceFallbackRoot(env, "C:\\Users\\李四\\.ergo", "win32")).not.toBe(a);
    expect(voiceFallbackRoot({ ALLUSERSPROFILE: "C:\\ProgramData" }, "C:\\Users\\张三\\.ergo", "win32")).toBe(a);
  });

  test("没有 ProgramData、不是 Windows：没有（照旧不让装）", () => {
    expect(voiceFallbackRoot({}, "C:\\Users\\张三\\.ergo", "win32")).toBeUndefined();
    expect(voiceFallbackRoot({ ProgramData: "/x" }, "/home/张三/.ergo", "linux")).toBeUndefined();
  });
});

describe("参考音色发给 audio.cpp 的路径", () => {
  const work = path.join(path.sep === "\\" ? "C:\\" : "/", "Users", "张三", ".ergo", "components", "audiocpp-service");
  const voice = path.join(path.dirname(path.dirname(work)), "voices", "v-1", "reference.wav");

  test("读得了的原样发", () => {
    const plain = path.join(path.sep === "\\" ? "D:\\" : "/", "ergo", "voices", "v-1", "reference.wav");
    expect(speechVoiceRef(plain, undefined)).toBe(plain);
    expect(speechVoiceRef(plain, work)).toBe(plain);
  });

  test("带中文：知道工作目录就发相对它的路径；不知道是 undefined（报清楚，不发）", () => {
    expect(speechVoiceRef(voice, work)).toBe(path.join("..", "..", "voices", "v-1", "reference.wav"));
    expect(speechVoiceRef(voice, undefined)).toBeUndefined();
  });

  test("相对的那段也带中文：undefined", () => {
    expect(speechVoiceRef(path.join(path.dirname(voice), "参考.wav"), work)).toBeUndefined();
  });

  test.runIf(process.platform === "win32")("不在同一个盘（相对不过去）：undefined", () => {
    expect(speechVoiceRef("E:\\张三\\voices\\v-1\\reference.wav", work)).toBeUndefined();
  });
});

describe("我们接上的语音服务的工作目录（只看组件区的文件，守护进程刚起来时也问得到）", () => {
  test("有我们生成的 server.json、端口对得上才是", () => {
    const components = makeTempDir();
    expect(audioCppWorkingDir(components, "http://127.0.0.1:8090")).toBeUndefined();
    const dir = path.join(components, "audiocpp-service");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({ host: "127.0.0.1", port: 8090 }));
    expect(audioCppWorkingDir(components, "http://127.0.0.1:8090")).toBe(dir);
    expect(audioCppWorkingDir(components, "http://localhost:8090/")).toBe(dir);
    expect(audioCppWorkingDir(components, "http://127.0.0.1:8091")).toBeUndefined();
    expect(audioCppWorkingDir(components, "http://192.168.1.2:8090")).toBeUndefined();
    fs.writeFileSync(path.join(dir, "server.json"), "坏了");
    expect(audioCppWorkingDir(components, "http://127.0.0.1:8090")).toBeUndefined();
  });

  test("参考音色的路径读得了时不问工作目录（问的时候可能还没接上）", async () => {
    let asked = 0;
    const synth = createAudioCppSynthesizer({
      url: "http://127.0.0.1:1",
      model: "tts",
      timeout: { baseMs: 1000, coldStartMs: 0, perSpeechSecond: 1 },
      workingDir: () => {
        asked += 1;
        throw new Error("还没接上");
      },
      log: () => {},
    });
    await expect(synth.synthesize({ text: "你好", voiceId: "v-1", voiceRef: path.join(path.parse(process.cwd()).root, "ergo", "voices", "v-1", "reference.wav"), referenceText: "参考" }, { estimatedSeconds: 1 })).rejects.toBeInstanceOf(Error);
    expect(asked).toBe(0);
  });
});
