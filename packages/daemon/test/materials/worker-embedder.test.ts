// 在工作线程里算向量（规格第 15 节）：模型在线程里加载和推理，不阻塞守护进程的事件循环。
// 这里给工作线程一个假的后端（test/fixtures/fake-embed-backend.ts），不跑真模型。
import { describe, expect, test } from "vitest";
import { createWorkerEmbedder } from "../../src/materials/embedding/worker-host.ts";

const FAKE_BACKEND = new URL("../fixtures/fake-embed-backend.ts", import.meta.url);

function embedder(backendOptions: object, idleMs?: number) {
  return createWorkerEmbedder({
    model: "fake-worker@1",
    backend: FAKE_BACKEND,
    backendOptions,
    available: () => true,
    unavailableHint: () => "",
    ...(idleMs === undefined ? {} : { idleMs }),
  });
}

describe("工作线程里的向量函数", () => {
  test("文字送进工作线程，按顺序拿回向量", async () => {
    const e = embedder({});
    try {
      const vectors = await e.embed(["搬家", "跑步了"]);
      expect(vectors.map((v) => Array.from(v))).toEqual([
        [2, "搬".codePointAt(0)],
        [3, "跑".codePointAt(0)],
      ]);
    } finally {
      await e.close();
    }
  });

  test("推理占满 CPU 时，守护进程的事件循环照常转", async () => {
    const e = embedder({ busyMs: 300 });
    try {
      let ticks = 0;
      const timer = setInterval(() => (ticks += 1), 10);
      await e.embed(["算一会儿"]);
      clearInterval(timer);
      // 300 毫秒里每 10 毫秒一次；要是阻塞了主线程，一次都转不了
      expect(ticks).toBeGreaterThan(5);
    } finally {
      await e.close();
    }
  });

  test("模型加载失败：每次请求都以出错结束，带上原因", async () => {
    const e = embedder({ failLoad: "模型文件坏了" });
    try {
      await expect(e.embed(["一"])).rejects.toThrow("模型文件坏了");
      await expect(e.embed(["二"])).rejects.toThrow("模型文件坏了");
    } finally {
      await e.close();
    }
  });

  test("关掉时正在算的请求以出错结束；关掉后再用会重新拉起线程", async () => {
    const e = embedder({ busyMs: 200 });
    try {
      const inFlight = e.embed(["很慢"]).then(
        () => "算完了",
        (err: Error) => err.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await e.close();
      expect(await inFlight).toContain("已结束");
      expect(await e.embed(["好"])).toHaveLength(1);
    } finally {
      await e.close();
    }
  });

  test("闲置一段时间后结束线程，下次要算时重新拉起", async () => {
    const e = embedder({}, 50);
    try {
      expect(await e.embed(["一"])).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await e.embed(["二"])).toHaveLength(1);
    } finally {
      await e.close();
    }
  });
});
