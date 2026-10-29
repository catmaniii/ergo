// 内核的向量函数 → @ergo/memory 的向量函数（224 号票，模块层）：内核的 Embedder 只有 embed(texts)，
// @ergo/memory 要分开 embedDocuments / embedQueries（bge-m3 两种角色同义，都走 embed）；
// 模型文件不在时 available() 透传成 false，记忆引擎照常跑关键词检索、不算向量；不下载、不打包模型。
import path from "node:path";
import { MemoryEngine, type EvidenceDraft } from "@ergo/memory";
import { onTestFinished, describe, expect, test } from "vitest";
import { kernelEmbedderAdapter } from "../../src/memory/embedder-adapter.ts";
import { FakeEmbedder } from "../helpers/embedder.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NOW = "2026-10-08T09:00:00.000+08:00";

function draft(text: string, context: string[] = []): EvidenceDraft {
  return { sourceLevel: "self", mode: "say", kind: "utterance", text, context, eventTime: NOW, observedAt: NOW, sourceRef: "mat-test" };
}

/** 打开一个引擎（临时目录），测试结束时关掉 */
function openEngine(embedder: ReturnType<typeof kernelEmbedderAdapter>) {
  const engine = MemoryEngine.open({ file: path.join(makeTempDir("ergo-embed-adapter-"), "rg.db"), clock: () => NOW, embedder });
  onTestFinished(() => engine.close());
  return engine;
}

describe("内核向量函数转接", () => {
  test("两个角色都走内核的 embed，模型名、可用状态、提示照搬", async () => {
    const kernel = new FakeEmbedder({ model: "bge-m3-test" });
    const embedder = kernelEmbedderAdapter(kernel);
    expect(embedder.model).toBe("bge-m3-test");
    expect(embedder.available()).toBe(true);
    expect(embedder.unavailableHint()).toBe(kernel.unavailableHint());

    const [document] = await embedder.embedDocuments(["搬家"]);
    const [query] = await embedder.embedQueries(["搬家"]);
    expect(kernel.calls).toEqual([["搬家"], ["搬家"]]);
    expect(document).toBeInstanceOf(Float32Array);
    // bge-m3 两种角色一样：同一段文字出来的向量一样
    expect(Array.from(query!)).toEqual(Array.from(document!));

    kernel.setAvailable(false);
    expect(embedder.available()).toBe(false);
  });

  test("接到引擎上：补算向量、按向量检索拿得到这条证据", async () => {
    const engine = openEngine(kernelEmbedderAdapter(new FakeEmbedder()));
    const evidence = engine.ingestEvidence(draft("周末和朋友吃饭", ["weekend", "social"]));

    const report = await engine.indexVectors();
    expect(report.model).toBe("fake-embed@1");
    expect(report.evidence).toBe(1);
    expect(report.skipped).toBeUndefined();

    const hits = await engine.search("周末吃饭", { mode: "vector", layers: "evidence" });
    expect(hits.map((h) => h.evidenceId)).toContain(evidence.id);
    expect(hits[0]!.channels.evidence_vector).toBeDefined();
  });

  test("模型不在时 available() 是 false，引擎照常跑关键词检索", async () => {
    const kernel = new FakeEmbedder({ available: false });
    const embedder = kernelEmbedderAdapter(kernel);
    expect(embedder.available()).toBe(false);

    const engine = openEngine(embedder);
    const evidence = engine.ingestEvidence(draft("周末和朋友吃饭"));
    const report = await engine.indexVectors();
    expect(report.evidence).toBe(0);
    expect(report.skipped).toContain("向量模型");
    expect(kernel.calls).toEqual([]);

    const hits = await engine.search("吃饭", { mode: "hybrid", layers: "evidence" });
    expect(hits.map((h) => h.evidenceId)).toContain(evidence.id);
  });

  test("close 默认不关内核的模型（模型是内核的、素材库也在用）；closeKernel 时才转给内核", async () => {
    const shared = new FakeEmbedder();
    await kernelEmbedderAdapter(shared).close();
    await expect(shared.embed(["搬家"])).resolves.toHaveLength(1);

    // 关掉时正在算的那批出错（FakeEmbedder 的 close 语义）：说明适配器真的把 close 转给了内核
    const owned = new FakeEmbedder();
    const release = owned.hold();
    const computing = owned.embed(["搬家"]);
    await kernelEmbedderAdapter(owned, { closeKernel: true }).close();
    await expect(computing).rejects.toThrow("向量函数已关闭");
    release();
  });
});
