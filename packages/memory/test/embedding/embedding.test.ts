import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cosine } from "../../src/embedding/embedder.ts";
import { FakeEmbedder } from "../../src/embedding/fake.ts";
import { BGE_M3, createBgeM3Embedder, resolveModelsDir, TransformersEmbedder } from "../../src/embedding/transformers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lab-models-"));
  dirs.push(dir);
  return dir;
}

describe("假向量", () => {
  it("同一组概念的话相近，不同组的远；向量归一化", async () => {
    const fake = new FakeEmbedder();
    const [party, dinner, hike] = await fake.embedDocuments(["这周六的聚会我不去了", "朋友约的饭局推掉了", "周日去爬山"]);
    expect(cosine(party!, dinner!)).toBeGreaterThan(cosine(party!, hike!));
    expect(Math.hypot(...party!)).toBeCloseTo(1, 5);
    expect(fake.available()).toBe(true);
    expect(fake.model).toBe("fake-embed@1");
  });

  it("查询和文档分开算：查询可以加前缀（模拟 Qwen3 那种要指令前缀的模型）", async () => {
    const fake = new FakeEmbedder({ queryPrefix: "查询：" });
    await fake.embedQueries(["周末社交"]);
    await fake.embedDocuments(["周末社交"]);
    expect(fake.calls).toEqual([
      { role: "query", texts: ["查询：周末社交"] },
      { role: "document", texts: ["周末社交"] },
    ]);
  });

  it("能模拟模型不在", async () => {
    const fake = new FakeEmbedder({ available: false });
    expect(fake.available()).toBe(false);
    expect(fake.unavailableHint()).toMatch(/fake-embed@1/);
    await expect(fake.embedDocuments(["x"])).rejects.toThrow(/不在/);
  });
});

describe("真向量适配器（不加载模型）", () => {
  it("bge-m3：CLS 池化、归一化、查询和文档都不加前缀，模型名和守护进程一致", () => {
    expect(BGE_M3).toMatchObject({ repo: "Xenova/bge-m3", dtype: "q8", pooling: "cls", normalize: true, queryPrefix: "", documentPrefix: "" });
    expect(BGE_M3.model).toBe("Xenova/bge-m3:q8@4de13258");
  });

  it("模型目录：参数 > ERGO_MODELS_DIR > ERGO_DATA_DIR/models > ~/.ergo/models", () => {
    expect(resolveModelsDir("D:/m", { ERGO_MODELS_DIR: "E:/x" })).toBe(path.resolve("D:/m"));
    expect(resolveModelsDir(undefined, { ERGO_MODELS_DIR: "E:/x", ERGO_DATA_DIR: "F:/d" })).toBe(path.resolve("E:/x"));
    expect(resolveModelsDir(undefined, { ERGO_DATA_DIR: "F:/d" })).toBe(path.resolve("F:/d/models"));
    const home = tempDir();
    expect(resolveModelsDir(undefined, {}, home)).toBe(path.join(home, ".ergo", "models"));
  });

  it("312 号票：两个环境变量的旧名字也认（新的优先），~/.ergo 不在而旧的 ~/.ergou 在时用旧的", () => {
    expect(resolveModelsDir(undefined, { ERGOU_MODELS_DIR: "E:/old" })).toBe(path.resolve("E:/old"));
    expect(resolveModelsDir(undefined, { ERGO_MODELS_DIR: "E:/x", ERGOU_MODELS_DIR: "E:/old" })).toBe(path.resolve("E:/x"));
    expect(resolveModelsDir(undefined, { ERGOU_DATA_DIR: "F:/old" })).toBe(path.resolve("F:/old/models"));
    const home = tempDir();
    expect(resolveModelsDir(undefined, {}, home)).toBe(path.join(home, ".ergo", "models"));
    fs.mkdirSync(path.join(home, ".ergou"));
    expect(resolveModelsDir(undefined, {}, home)).toBe(path.join(home, ".ergou", "models"));
    fs.mkdirSync(path.join(home, ".ergo"));
    expect(resolveModelsDir(undefined, {}, home)).toBe(path.join(home, ".ergo", "models"));
  });

  it("文件不在时 available 是 false、给出提示，算向量直接报错，不去加载", async () => {
    const dir = tempDir();
    const embedder = createBgeM3Embedder({ modelsDir: dir });
    expect(embedder.model).toBe(BGE_M3.model);
    expect(embedder.available()).toBe(false);
    expect(embedder.unavailableHint()).toContain(path.join(dir, "Xenova", "bge-m3"));
    await expect(embedder.embedQueries(["周末"])).rejects.toThrow(/不在/);
    await embedder.close();
  });

  it("文件大小都对上才算在（不核哈希，不读内容）", () => {
    const dir = tempDir();
    const spec = { ...BGE_M3, files: [{ path: "config.json", size: 3 }, { path: "onnx/model.onnx", size: 2 }] };
    const embedder = new TransformersEmbedder({ modelsDir: dir, spec });
    expect(embedder.available()).toBe(false);
    fs.mkdirSync(path.join(dir, "Xenova", "bge-m3", "onnx"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Xenova", "bge-m3", "config.json"), "abc");
    fs.writeFileSync(path.join(dir, "Xenova", "bge-m3", "onnx", "model.onnx"), "x");
    expect(embedder.available()).toBe(false);
    fs.writeFileSync(path.join(dir, "Xenova", "bge-m3", "onnx", "model.onnx"), "xy");
    expect(embedder.available()).toBe(true);
  });

  it("池化方式和前缀是配置项：换一个要指令前缀、末位池化的模型只改配置，模型名跟着变", () => {
    const qwenLike = { ...BGE_M3, repo: "onnx-community/Qwen3-Embedding-0.6B-ONNX", revision: "0123456789abcdef", pooling: "last_token" as const, queryPrefix: "Instruct: 找出相关的记忆\nQuery: ", model: undefined };
    const embedder = new TransformersEmbedder({ modelsDir: tempDir(), spec: qwenLike });
    expect(embedder.model).toBe("onnx-community/Qwen3-Embedding-0.6B-ONNX:q8@01234567/last_token");
    expect(embedder.prepare("query", ["周末"])).toEqual(["Instruct: 找出相关的记忆\nQuery: 周末"]);
    expect(embedder.prepare("document", ["周末"])).toEqual(["周末"]);
  });
});
