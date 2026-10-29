// 模型文件（规格第 15、21 节）：bge-m3 的文件放在数据目录的模型区；不在时提示在设置 · 组件里装、或者运行下载命令。
// 下载本身（断点续传、几个地址、校验）323 号票起在组件的下载器里，测试在 test/components/。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BGE_M3, bgeM3Dir, createBgeM3Embedder } from "../../src/materials/embedding/bge-m3.ts";
import { modelFilesPresent } from "../../src/materials/embedding/model-files.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("模型文件在不在", () => {
  test("大小不对的文件不算\"在\"（比如被截断了）", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "config.json"), "短");
    expect(modelFilesPresent(dir, [{ path: "config.json", size: 9 }])).toBe(false);
  });
});

describe("bge-m3", () => {
  test("模型区里没有文件时不可用，提示里写明放在哪、去设置 · 组件装或者运行哪条下载命令", () => {
    const root = makeTempDir();
    const embedder = createBgeM3Embedder(root);
    expect(embedder.available()).toBe(false);
    expect(bgeM3Dir(root)).toBe(path.join(root, "models", "Xenova", "bge-m3"));
    expect(embedder.unavailableHint()).toContain(bgeM3Dir(root));
    expect(embedder.unavailableHint()).toContain(`npm run download-model -- --data-dir "${root}"`);
    expect(embedder.unavailableHint()).toContain("设置 · 组件");
    expect(embedder.model).toBe(`Xenova/bge-m3:q8@${BGE_M3.revision.slice(0, 8)}`);
  });

  test("下载清单是 transformers.js 加载 q8 模型要的那几个文件", () => {
    expect(BGE_M3.files.map((f) => f.path)).toEqual(["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quantized.onnx"]);
  });
});
