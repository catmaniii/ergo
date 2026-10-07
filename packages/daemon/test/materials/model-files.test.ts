// 模型文件（规格第 15、21 节）：bge-m3 的文件放在数据目录的模型区；不在时提示用户运行下载命令。
// 下载命令本身不在测试里联网：这里注入一个假的 fetch，测下载的落盘和核对；也不下载真模型。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BGE_M3, bgeM3Dir, createBgeM3Embedder } from "../../src/materials/embedding/bge-m3.ts";
import { downloadModelFiles, type ModelFile, modelFilesPresent } from "../../src/materials/embedding/model-files.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

function fakeRemote(files: Record<string, string>) {
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    const name = url.replace("https://hf.example/repo/resolve/rev/", "");
    const body = files[name];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
  };
  return { fetch, requested };
}

describe("下载模型文件", () => {
  const manifest: ModelFile[] = [
    { path: "config.json", size: 9 },
    { path: "onnx/model_quantized.onnx", size: 12, sha256: sha256("模型权重") },
  ];

  test("按清单下载到模型目录（保持子目录），大小和哈希核对过才算数；下好之后算是\"在\"", async () => {
    const dir = path.join(makeTempDir(), "models", "Xenova", "bge-m3");
    const remote = fakeRemote({ "config.json": '{"a": 1}\n', "onnx/model_quantized.onnx": "模型权重" });
    expect(modelFilesPresent(dir, manifest)).toBe(false);

    const logs: string[] = [];
    await downloadModelFiles({ baseUrl: "https://hf.example/repo/resolve/rev", files: manifest, dir, log: (l) => logs.push(l), fetch: remote.fetch });
    expect(fs.readFileSync(path.join(dir, "onnx", "model_quantized.onnx"), "utf8")).toBe("模型权重");
    expect(modelFilesPresent(dir, manifest)).toBe(true);
    expect(fs.readdirSync(path.join(dir, "onnx"))).toEqual(["model_quantized.onnx"]);

    // 再跑一次：已经在的跳过
    await downloadModelFiles({ baseUrl: "https://hf.example/repo/resolve/rev", files: manifest, dir, log: (l) => logs.push(l), fetch: remote.fetch });
    expect(remote.requested).toHaveLength(2);
    expect(logs.join("\n")).toContain("已经在了");
  });

  test("下载的内容和清单的哈希对不上：报错，模型目录里不留文件", async () => {
    const dir = makeTempDir();
    const remote = fakeRemote({ "config.json": '{"a": 1}\n', "onnx/model_quantized.onnx": "被篡改的权重" });
    const bad: ModelFile[] = [{ path: "onnx/model_quantized.onnx", size: Buffer.byteLength("被篡改的权重"), sha256: sha256("模型权重") }];
    await expect(downloadModelFiles({ baseUrl: "https://hf.example/repo/resolve/rev", files: bad, dir, log: () => {}, fetch: remote.fetch })).rejects.toThrow("下载的内容不对");
    expect(fs.readdirSync(path.join(dir, "onnx"))).toEqual([]);
  });

  test("服务端回错误：报错，写明状态码", async () => {
    const dir = makeTempDir();
    const remote = fakeRemote({});
    await expect(downloadModelFiles({ baseUrl: "https://hf.example/repo/resolve/rev", files: manifest, dir, log: () => {}, fetch: remote.fetch })).rejects.toThrow("HTTP 404");
  });

  test("大小不对的文件不算\"在\"（比如被截断了）", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "config.json"), "短");
    expect(modelFilesPresent(dir, [{ path: "config.json", size: 9 }])).toBe(false);
  });
});

describe("bge-m3", () => {
  test("模型区里没有文件时不可用，提示里写明放在哪、运行哪条下载命令", () => {
    const root = makeTempDir();
    const embedder = createBgeM3Embedder(root);
    expect(embedder.available()).toBe(false);
    expect(bgeM3Dir(root)).toBe(path.join(root, "models", "Xenova", "bge-m3"));
    expect(embedder.unavailableHint()).toContain(bgeM3Dir(root));
    expect(embedder.unavailableHint()).toContain(`npm run download-model -- --data-dir "${root}"`);
    expect(embedder.model).toBe(`Xenova/bge-m3:q8@${BGE_M3.revision.slice(0, 8)}`);
  });

  test("下载清单是 transformers.js 加载 q8 模型要的那几个文件", () => {
    expect(BGE_M3.files.map((f) => f.path)).toEqual(["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quantized.onnx"]);
  });
});
