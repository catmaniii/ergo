// 组件清单（323 号票）：随程序发布的那份读得进来、和代码里锁的版本一致；默认装不装写在数据里；清单写错了读的时候就报。
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { fileSources, loadManifest, parseManifest, pickVariant, variantFiles } from "../../src/components/manifest.ts";
import { BGE_M3 } from "../../src/materials/embedding/bge-m3.ts";

const { manifest, signed } = loadManifest();
const byId = (id: string) => manifest.components.find((c) => c.id === id)!;

describe("随程序发布的清单", () => {
  test("读得进来；没签名（发布钥匙的签名由 318 号票发版时加）", () => {
    expect(manifest.components.map((c) => c.id)).toEqual(["bge-m3", "asr", "tts", "claude-code"]);
    expect(signed).toBe(false);
  });

  test("默认写在数据里：向量模型默认装，语音问了再装，Claude Code 检测到才装", () => {
    expect(byId("bge-m3").default).toBe("install");
    expect(byId("asr").default).toBe("ask");
    expect(byId("tts").default).toBe("ask");
    expect(byId("claude-code")).toMatchObject({ default: "detected", detect: "on-path:claude", provided: "node-package:@anthropic-ai/claude-agent-sdk" });
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

  test("Claude Code 接入的 SDK 和守护进程依赖的是同一个版本", () => {
    // 315 号票起 SDK 在 optionalDependencies 里
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    const c = byId("claude-code");
    expect(c.version).toBe(pkg.optionalDependencies?.["@anthropic-ai/claude-agent-sdk"] ?? pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"]);
    const files = variantFiles(c.variants[0]!).map(({ file }) => file.path);
    expect(files.every((p) => p.endsWith(`-${c.version}.tgz`))).toBe(true);
    expect(fileSources(c, c.variants[0]!.parts[0]!, variantFiles(c.variants[0]!)[0]!.file)[0]?.url).toBe(`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-${c.version}.tgz`);
  });

  test("语音识别按有没有 N 卡挑 CUDA 版 / CPU 版；Claude Code 接入只有 Windows x64 的", () => {
    const asr = byId("asr");
    expect(pickVariant(asr, { platform: "win32", arch: "x64", gpu: "nvidia" })?.id).toBe("cuda");
    expect(pickVariant(asr, { platform: "win32", arch: "x64", gpu: "none" })?.id).toBe("cpu");
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

  test("id 重复、依赖不在、依赖绕圈、检测到才装却没写 detect、有文件没写下载地址、少了字段", () => {
    expect(parse([base, base])).toThrow("写了两次");
    expect(parse([{ ...base, dependsOn: ["nope"] }])).toThrow("不在清单里");
    expect(parse([{ ...base, dependsOn: ["b"] }, { ...base, id: "b", dependsOn: ["a"] }])).toThrow("绕成了圈");
    expect(parse([{ ...base, default: "detected" }])).toThrow("没写 detect");
    expect(parse([{ ...base, variants: [{ id: "v", parts: [{ files: [{ path: "x", size: 1 }] }] }] }])).toThrow("没写下载地址");
    expect(parse([{ ...base, version: undefined }])).toThrow("组件清单不对");
  });
});
