// 前端的分片续传上传：建上传 → 按偏移写分片 → 带原始字节的 sha256 收尾；网断了等一会儿，
// 查服务端已收到的偏移接着传，不重传已收到的字节。用一个内存里的假服务端驱动（真的守护进程那一侧由主切面测）。
import { createHash, randomBytes } from "node:crypto";
import { HTTP_QUERY, parseHttpPath } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { type FetchLike, type UploadProgress, uploadFile } from "../../src/app/uploader.ts";

interface Upload {
  name: string;
  mime: string;
  size: number;
  bytes: Buffer;
  done?: unknown;
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** 照着守护进程的上传协议在内存里实现一遍；可以让它"断网" */
class FakeServer {
  readonly uploads = new Map<string, Upload>();
  /** 每个分片请求：从哪个偏移起、服务端实际收下了多少字节 */
  readonly puts: Array<{ offset: number; received: number }> = [];
  maxBytes = 1_000_000;
  /** 下一个分片只收下这么多字节，然后连接断掉 */
  dropNextPutAfter: number | undefined;
  /** 断网：之后这么多个请求直接失败 */
  offlineRequests = 0;
  private seq = 0;

  fetch: FetchLike = async (url, init) => {
    if (this.offlineRequests > 0) {
      this.offlineRequests -= 1;
      throw new TypeError("Failed to fetch");
    }
    const u = new URL(url, "http://127.0.0.1:8810");
    const route = parseHttpPath(u.pathname);
    const method = init.method;
    if (method === "POST" && route?.route === "uploads") {
      const body = JSON.parse(init.body as string) as { name: string; mime: string; size: number };
      if (body.size > this.maxBytes) return json(413, { code: "too_large", message: "超过单个文件的上限" });
      const id = `u${++this.seq}`;
      this.uploads.set(id, { ...body, bytes: Buffer.alloc(0) });
      return json(201, { uploadId: id, ...body, offset: 0 });
    }
    const uploadId = route?.route === "upload" || route?.route === "upload_complete" ? route.uploadId : undefined;
    const up = uploadId === undefined ? undefined : this.uploads.get(uploadId);
    if (uploadId === undefined || !up) return json(404, { code: "not_found", message: "没有" });
    const status = () => ({ uploadId, name: up.name, mime: up.mime, size: up.size, offset: up.bytes.length });
    if (method === "GET" && route?.route === "upload") return json(200, status());
    if (method === "PUT" && route?.route === "upload") {
      const offset = Number(u.searchParams.get(HTTP_QUERY.offset));
      if (offset !== up.bytes.length) return json(409, { code: "offset_mismatch", message: "偏移不对", offset: up.bytes.length });
      const chunk = Buffer.from(init.body as ArrayBuffer);
      const keep = this.dropNextPutAfter ?? chunk.length;
      up.bytes = Buffer.concat([up.bytes, chunk.subarray(0, keep)]);
      this.puts.push({ offset, received: Math.min(keep, chunk.length) });
      if (this.dropNextPutAfter !== undefined) {
        this.dropNextPutAfter = undefined;
        throw new TypeError("network error");
      }
      return json(200, status());
    }
    if (method === "POST" && route?.route === "upload_complete") {
      if (up.done) return json(200, up.done);
      const { sha256 } = JSON.parse(init.body as string) as { sha256: string };
      if (createHash("sha256").update(up.bytes).digest("hex") !== sha256) return json(422, { code: "sha256_mismatch", message: "sha256 对不上" });
      up.done = { mediaId: sha256, kind: "file", name: up.name, mime: up.mime, size: up.size };
      return json(200, up.done);
    }
    return json(405, { code: "method_not_allowed", message: "不支持" });
  };
}

const noSleep = async () => {};

function fileOf(bytes: Buffer, name = "数据.bin", type = "application/octet-stream"): File {
  return new File([bytes], name, { type });
}

describe("分片续传上传", () => {
  test("按分片传完、收尾带原始字节的 sha256；进度一路往上走到 100%", async () => {
    const server = new FakeServer();
    const bytes = randomBytes(25_000);
    const progress: UploadProgress[] = [];
    const media = await uploadFile(fileOf(bytes), { fetch: server.fetch, chunkBytes: 10_000, sleep: noSleep, onProgress: (p) => progress.push(p) });
    expect(media).toEqual({ mediaId: createHash("sha256").update(bytes).digest("hex"), kind: "file", name: "数据.bin", mime: "application/octet-stream", size: 25_000 });
    expect(server.puts).toEqual([
      { offset: 0, received: 10_000 },
      { offset: 10_000, received: 10_000 },
      { offset: 20_000, received: 5_000 },
    ]);
    expect(progress.filter((p) => p.state === "uploading").map((p) => p.sent)).toEqual([0, 10_000, 20_000, 25_000]);
    expect(progress.at(-1)).toEqual({ state: "done", sent: 25_000, total: 25_000 });
  });

  test("传到一半断网：等网恢复，查服务端已收到的偏移接着传，已收到的字节不重传", async () => {
    const server = new FakeServer();
    const bytes = randomBytes(30_000);
    const progress: UploadProgress[] = [];
    let putCount = 0;
    const flaky: FetchLike = async (url, init) => {
      // 第二个分片发出 4000 字节后断网，之后又有两次请求失败
      if (init.method === "PUT" && ++putCount === 2) {
        server.dropNextPutAfter = 4_000;
        try {
          return await server.fetch(url, init);
        } finally {
          server.offlineRequests = 2;
        }
      }
      return server.fetch(url, init);
    };
    const waits: number[] = [];
    const media = await uploadFile(fileOf(bytes), {
      fetch: flaky,
      chunkBytes: 10_000,
      retryDelaysMs: [100, 200],
      sleep: async (ms) => {
        waits.push(ms);
      },
      onProgress: (p) => progress.push(p),
    });
    expect(media.size).toBe(30_000);
    expect(server.uploads.get("u1")!.bytes.equals(bytes)).toBe(true);
    // 断网之后从服务端已收到的 14000 字节接着传；每个字节只被服务端收下一次
    expect(server.puts.map((p) => p.offset)).toEqual([0, 10_000, 14_000, 24_000]);
    expect(server.puts.reduce((n, p) => n + p.received, 0)).toBe(30_000);
    expect(progress.some((p) => p.state === "waiting")).toBe(true);
    expect(waits).toEqual([100, 200, 200]);
  });

  test("超过单文件上限：建上传时就失败，不重试", async () => {
    const server = new FakeServer();
    server.maxBytes = 100;
    await expect(uploadFile(fileOf(randomBytes(101)), { fetch: server.fetch, sleep: noSleep })).rejects.toMatchObject({ code: "too_large" });
    expect(server.uploads.size).toBe(0);
  });

  test("取消：停下来，不再发请求", async () => {
    const server = new FakeServer();
    const controller = new AbortController();
    let puts = 0;
    const counting: FetchLike = async (url, init) => {
      if (init.method === "PUT" && ++puts === 1) controller.abort();
      return server.fetch(url, init);
    };
    await expect(uploadFile(fileOf(randomBytes(30_000)), { fetch: counting, chunkBytes: 10_000, sleep: noSleep, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(puts).toBe(1);
  });
});
