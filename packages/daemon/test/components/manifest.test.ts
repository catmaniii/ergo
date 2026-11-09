// 组件清单：随程序发布的那份读得进来、和代码里锁的版本一致；默认装不装写在数据里；清单写错了读的时候就报。
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { CODEX_COMPONENT, CODEX_MIN_VERSION, versionOlder } from "../../src/codex/install.ts";
import { fileSources, loadManifest, parseManifest, pendingParts, pickVariant, variantFiles } from "../../src/components/manifest.ts";
import { BGE_M3 } from "../../src/materials/embedding/bge-m3.ts";
import { AUDIOCPP_RECOGNIZER_MODEL } from "../../src/voice/recognizer-audiocpp.ts";
import { codexSchema } from "../helpers/codex-schema.ts";

const { manifest, signed } = loadManifest();
const byId = (id: string) => manifest.components.find((c) => c.id === id)!;

describe("随程序发布的清单", () => {
  test("读得进来；没签名（发布钥匙的签名发版时加）", () => {
    expect(manifest.components.map((c) => c.id)).toEqual(["bge-m3", "asr", "audiocpp", "tts", "claude-code", "codex"]);
    expect(signed).toBe(false);
  });

  test("默认写在数据里：向量模型默认装，语音问了再装，Claude Code、Codex 检测到才装", () => {
    expect(byId("bge-m3").default).toBe("install");
    expect(byId("asr").default).toBe("ask");
    expect(byId("audiocpp").default).toBe("ask");
    expect(byId("tts").default).toBe("ask");
    expect(byId("claude-code")).toMatchObject({ default: "detected", detect: "on-path:claude", provided: "node-package:@anthropic-ai/claude-agent-sdk" });
    expect(byId("codex")).toMatchObject({ default: "detected", detect: "on-path:codex", provided: "codex-cli", enables: ["runtime.codex"] });
  });

  test("向量模型和代码里锁的 bge-m3 一致：版本、装在模型区、文件的大小和 sha256", () => {
    const c = byId("bge-m3");
    expect(c.target).toBe(`models/${BGE_M3.repo}`);
    expect(c.version).toBe(BGE_M3.revision.slice(0, 8));
    const pinned = (c.sources ?? []).filter((source) => source.id !== "modelscope");
    expect(pinned.map((source) => source.url.includes(BGE_M3.revision))).toEqual([true, true]);
    expect(c.sources?.map((s) => s.title)).toEqual(["Hugging Face", "hf-mirror", "ModelScope"]);
    const files = variantFiles(c.variants[0]!).map(({ file }) => file);
    expect(files).toEqual(BGE_M3.files.map((f) => ({ path: f.path, size: f.size, ...(f.sha256 ? { sha256: f.sha256 } : {}) })));
  });

  test("语音合成：程序和模型分开，模型依赖程序；按 N 卡挑包；CUDA 版带运行库包；固定版本、大小、校验值", () => {
    const program = byId("audiocpp");
    const model = byId("tts");
    expect(model.dependsOn).toEqual(["audiocpp"]);
    expect(model.enables).toEqual(["voice.reply"]);
    expect(program.enables).toEqual([]);
    expect(program.provided).toBe("voice-speech");
    expect(model.provided).toBe("voice-speech");
    expect(program.service).toEqual({ name: "audiocpp", program: "audiocpp_server.exe", port: 8090, health: "/health" });

    const cuda = pickVariant(program, { platform: "win32", arch: "x64", gpu: "nvidia" })!;
    const cpu = pickVariant(program, { platform: "win32", arch: "x64", gpu: "none" })!;
    expect(cuda.id).toBe("cuda");
    expect(cpu.id).toBe("cpu");
    expect(pickVariant(program, { platform: "linux", arch: "x64", gpu: "nvidia" })).toBeUndefined();
    expect(variantFiles(cuda).map(({ file }) => [file.path, file.size, file.sha256])).toEqual([
      ["audio-v0.9.3-bin-windows-x64-cuda13.3.zip", 277_336_614, "0bd3988be10c31ec078c40df2bd0d4266e660804f6d5083aeb05d1309d091e43"],
      ["audio-v0.9.3-cudart-windows-x64-cuda13.3.zip", 575_457_454, "839eb20f684a8aab64895b1e466b32ce9b29dfc19dc1ce15b2ef35218512ac0a"],
    ]);
    // 运行库放到程序旁边，程序在包里第几层不写死（新版包的结构没实际核对过）
    expect(variantFiles(cuda).map(({ file }) => file.extract)).toMatchObject([{ format: "zip", to: "bin" }, { format: "zip", to: "bin", beside: "audiocpp_server.exe" }]);
    expect(cuda.expects).toEqual(["cudart64_*.dll", "cublas64_*.dll", "cublasLt64_*.dll", "cufft64_*.dll"]);
    expect(cpu.expects).toBeUndefined();
    // 程序只从上游 GitHub Release 下：不做镜像
    expect(program.sources?.map((s) => s.url)).toEqual(["https://github.com/0xShug0/audio.cpp/releases/download/v0.9.3/{path}"]);
    expect(variantFiles(cpu).map(({ file }) => [file.path, file.size, file.sha256])).toEqual([["audio-v0.9.3-bin-windows-x64-cpu.zip", 30_547_092, "3ac66f46395b4e92e4f3bb68b200f0032310bd9922f12d97f10ccdadb02dee4b"]]);
    expect(fileSources(program, cuda.parts[0]!, variantFiles(cuda)[0]!.file)[0]?.url).toBe("https://github.com/0xShug0/audio.cpp/releases/download/v0.9.3/audio-v0.9.3-bin-windows-x64-cuda13.3.zip");

    // 模型：不打包不镜像，只从上游（Hugging Face 和它的公共代理）拉，地址钉死到提交
    const [file] = variantFiles(model.variants[0]!);
    expect(file?.file).toEqual({ path: "Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf", size: 6_317_915_552, sha256: "4f051347079cfb61f9ef2996f67057229e486fefce31374721b5690940dfc34a" });
    expect(model.serve).toEqual({ host: "audiocpp", id: "tts", family: "fish_audio", task: "tts", mode: "offline", file: "Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf" });
    expect(model.sources?.map((s) => s.url)).toEqual([
      "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/{path}",
      "https://hf-mirror.com/audio-cpp/audio.cpp-gguf/resolve/874fcb41ececda20bcbc0782d6b4ea7f7d069ea8/{path}",
    ]);
    expect(model.version).toBe("874fcb41");
    expect(model.recommended).toBe(true);
    expect(model.slowWithoutGpu).toBe(true);
    expect(model.license).toMatchObject({ name: "Fish Audio Research License", confirm: true, attribution: "Built with Fish Audio", url: "https://huggingface.co/fishaudio/s2-pro/blob/main/LICENSE.md" });
    expect(program.license).toMatchObject({ name: "Apache-2.0", confirm: false });
  });

  test("Claude Code 接入的 SDK 和守护进程依赖的是同一个版本", () => {
    // SDK 在 optionalDependencies 里
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    const c = byId("claude-code");
    expect(c.version).toBe(pkg.optionalDependencies?.["@anthropic-ai/claude-agent-sdk"] ?? pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"]);
    const files = variantFiles(c.variants[0]!).map(({ file }) => file.path);
    expect(files.every((p) => p.endsWith(`-${c.version}.tgz`))).toBe(true);
    expect(fileSources(c, c.variants[0]!.parts[0]!, variantFiles(c.variants[0]!)[0]!.file)[0]?.url).toBe(`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-${c.version}.tgz`);
  });

  test("Codex 接入（454）：钉的版本就是 app-server 协议核对过的那一版；从 npm 官方下主包和 win32-x64 平台包，大小、sha512 是 registry 元数据的；装到 Codex 插件找的地方", () => {
    const c = byId("codex");
    // 版本：和生成协议 schema 的那一版（fixtures/codex-app-server.schema.json 的 codexVersion）一样，不低于运行时的最低版本
    expect(c.version).toBe(codexSchema.version);
    expect(versionOlder(c.version, CODEX_MIN_VERSION)).toBe(false);
    expect(c.target).toBe(`components/${CODEX_COMPONENT}`);
    expect(c.license).toEqual({ name: "Apache-2.0", summary: "Open source; free to use.", url: `https://github.com/openai/codex/blob/rust-v${c.version}/LICENSE`, confirm: false });
    expect(c.sources?.map((s) => s.url)).toEqual(["https://registry.npmjs.org/{path}"]);
    expect(c.variants.map((v) => v.id)).toEqual(["win32-x64"]);
    expect(pickVariant(c, { platform: "win32", arch: "x64", gpu: "none" })?.id).toBe("win32-x64");
    expect(pickVariant(c, { platform: "win32", arch: "arm64", gpu: "none" })).toBeUndefined();
    const variant = c.variants[0]!;
    // registry 元数据里的 dist.integrity（sha512 的 base64）原样抄在这里，清单里是它的十六进制；大小是对 tarball 发 HEAD 拿的（没下载）
    const integrity: Record<string, string> = {
      [`@openai/codex/-/codex-${c.version}.tgz`]: "sha512-2Szlp1l1cz5TX1ccpX4Zok3DZrot9xeZe0km+6/1v8JmqxADwyJxKBJah4dBymkwtS25j/u6dipJusTOI97Z8Q==",
      [`@openai/codex/-/codex-${c.version}-win32-x64.tgz`]: "sha512-NS8Ps5oG5r19pCrMCUXwUqOui6odnUIoBlQkrjCJ+h1k6KiwCzC/+mI9d3nSZCqFoVONPBTmqyq8NYq3YaFGyA==",
    };
    expect(variantFiles(variant).map(({ file }) => [file.path, file.size, file.sha256, file.extract])).toEqual([
      [`@openai/codex/-/codex-${c.version}.tgz`, 4_992, undefined, { format: "tgz", strip: 1, to: "node_modules/@openai/codex", unpackedSize: 13_570 }],
      [`@openai/codex/-/codex-${c.version}-win32-x64.tgz`, 180_706_795, undefined, { format: "tgz", strip: 1, to: "node_modules/@openai/codex-win32-x64", unpackedSize: 502_654_591 }],
    ]);
    for (const { file } of variantFiles(variant)) {
      expect(file.sha512).toBe(Buffer.from(integrity[file.path]!.replace(/^sha512-/, ""), "base64").toString("hex"));
    }
    // 平台包在 npm 上是同名包的另一个版本（optionalDependencies 里 npm:@openai/codex@<版本>-win32-x64 的别名），解到 bin/codex.js 找的 @openai/codex-win32-x64
    expect(fileSources(c, variant.parts[0]!, variantFiles(variant)[1]!.file)[0]?.url).toBe(`https://registry.npmjs.org/@openai/codex/-/codex-${c.version}-win32-x64.tgz`);
  });

  test("语音识别模型：Fun-ASR Nano，用 audio.cpp 那个程序；不打包不镜像，地址钉死到提交，校验值是 Hugging Face 的；要确认 v1.1 许可、标来源；默认不装", () => {
    const asr = byId("asr");
    expect(asr.default).toBe("ask");
    expect(asr.dependsOn).toEqual(["audiocpp"]);
    expect(asr.enables).toEqual(["voice.input"]);
    expect(asr.provided).toBe("voice-recognizer");
    expect(asr.recommended).toBe(true);
    // Python 那条路不再是"没接上"：能从这里装了
    for (const v of asr.variants) expect(pendingParts(v)).toEqual([]);
    expect(variantFiles(asr.variants[0]!)[0]?.file).toEqual({ path: "fun-asr-nano-2512-q8_0.gguf", size: 1_045_334_432, sha256: "4d727357574b079b7f43336b2930f39da086ca02f5d8d50872090b4c1c3d5e0a" });
    expect(asr.serve).toEqual({ host: "audiocpp", id: AUDIOCPP_RECOGNIZER_MODEL, family: "fun_asr_nano", task: "asr", mode: "offline", file: "fun-asr-nano-2512-q8_0.gguf" });
    expect(asr.version).toBe("ce72677f");
    expect(asr.sources?.map((s) => s.url)).toEqual([
      "https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512-GGUF/resolve/ce72677f84900f0dc57f498ace253bfb3c9155b6/{path}",
      "https://hf-mirror.com/FunAudioLLM/Fun-ASR-Nano-2512-GGUF/resolve/ce72677f84900f0dc57f498ace253bfb3c9155b6/{path}",
    ]);
    expect(asr.license).toMatchObject({ name: "FunASR Model License v1.1", url: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE", confirm: true, revision: "1.1", attribution: "Fun-ASR-Nano-2512 · FunAudioLLM / Alibaba Group" });
  });

  test("语音程序按有没有 N 卡挑 CUDA 版 / CPU 版；Claude Code 接入只有 Windows x64 的", () => {
    const program = byId("audiocpp");
    expect(pickVariant(program, { platform: "win32", arch: "x64", gpu: "nvidia" })?.id).toBe("cuda");
    expect(pickVariant(program, { platform: "win32", arch: "x64", gpu: "none" })?.id).toBe("cpu");
    expect(pickVariant(byId("claude-code"), { platform: "win32", arch: "x64", gpu: "none" })?.id).toBe("win32-x64");
    expect(pickVariant(byId("claude-code"), { platform: "linux", arch: "x64", gpu: "none" })).toBeUndefined();
  });

  test("设了 HF_ENDPOINT：Hugging Face 的地址换成它、排在最前，别的照旧", () => {
    const c = byId("bge-m3");
    const part = c.variants[0]!.parts[0]!;
    const file = part.files![3]!;
    const urls = fileSources(c, part, file, "https://mirror.example/");
    expect(urls.map((u) => u.url)).toEqual([
      `https://mirror.example/Xenova/bge-m3/resolve/${BGE_M3.revision}/onnx/model_quantized.onnx`,
      `https://huggingface.co/Xenova/bge-m3/resolve/${BGE_M3.revision}/onnx/model_quantized.onnx`,
      `https://hf-mirror.com/Xenova/bge-m3/resolve/${BGE_M3.revision}/onnx/model_quantized.onnx`,
      "https://www.modelscope.cn/models/Xenova/bge-m3/resolve/master/onnx/model_quantized.onnx",
    ]);
  });
});

const base = { id: "a", version: "1", default: "ask", enables: [], target: "components/a", variants: [{ id: "v", parts: [{ files: [] }] }] };
const parse = (components: unknown[]) => () => parseManifest({ format: 1, release: "x", components });

describe("清单写错了读的时候就报", () => {

  test("路径往外跳、写成绝对路径", () => {
    expect(parse([{ ...base, target: "../outside" }])).toThrow("不是安全的相对路径");
    expect(parse([{ ...base, target: "C:/Windows" }])).toThrow("不是安全的相对路径");
    expect(parse([{ ...base, variants: [{ id: "v", parts: [{ sources: [{ id: "s", title: "S", url: "http://x/{path}" }], files: [{ path: "a/../../b", size: 1 }] }] }] }])).toThrow("不是安全的相对路径");
  });

  test("sha512 要是 128 位十六进制（registry 给的 base64 要换过来）", () => {
    const withFile = (file: unknown) => [{ ...base, variants: [{ id: "v", parts: [{ sources: [{ id: "s", title: "S", url: "http://x/{path}" }], files: [file] }] }] }];
    expect(parse(withFile({ path: "a.tgz", size: 1, sha512: "a".repeat(128) }))).not.toThrow();
    expect(parse(withFile({ path: "a.tgz", size: 1, sha512: "sha512-2Szlp1l1cz5TX1ccpX4Zok3DZrot9xeZe0km+6/1v8JmqxADwyJxKBJah4dBymkwtS25j/u6dipJusTOI97Z8Q==" }))).toThrow("组件清单不对");
    expect(parse(withFile({ path: "a.tgz", size: 1, sha512: "a".repeat(64) }))).toThrow("组件清单不对");
  });

  test("id 重复、依赖不在、依赖绕圈、检测到才装却没写 detect、有文件没写下载地址、少了字段", () => {
    expect(parse([base, base])).toThrow("写了两次");
    expect(parse([{ ...base, dependsOn: ["nope"] }])).toThrow("不在清单里");
    expect(parse([{ ...base, dependsOn: ["b"] }, { ...base, id: "b", dependsOn: ["a"] }])).toThrow("绕成了圈");
    expect(parse([{ ...base, default: "detected" }])).toThrow("没写 detect");
    expect(parse([{ ...base, variants: [{ id: "v", parts: [{ files: [{ path: "x", size: 1 }] }] }] }])).toThrow("没写下载地址");
    expect(parse([{ ...base, version: undefined }])).toThrow("组件清单不对");
  });
});
