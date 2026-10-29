// 主切面：媒体的分片续传上传与下载（规格第 5 节 HTTP）。
// 真的守护进程（临时数据目录），测试扮演前端经本机端口的 HTTP 接口上传、下载。
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startTestDaemon } from "../helpers/daemon.ts";
import { media, putThenDrop, sha256Hex } from "../helpers/http.ts";
import { CAMERA_MODEL, GPS_LATITUDE, jpeg, jpegMarkers } from "../helpers/images.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("媒体上传", () => {
  it("建上传 → 按偏移写分片 → 带原始字节的 sha256 收尾：入库到数据目录的素材区，按媒体 id 下载回来字节不变", async () => {
    const { url, dataDir } = await startTestDaemon();
    const bytes = randomBytes(300_000);
    const sha = sha256Hex(bytes);

    const created = await media.create(url, { name: "数据.bin", mime: "application/octet-stream", size: bytes.length });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ uploadId: expect.any(String), name: "数据.bin", mime: "application/octet-stream", size: 300_000, offset: 0 });
    const { uploadId } = created.body;

    let offset = 0;
    for (const size of [100_000, 100_000, 100_000]) {
      const put = await media.put(url, uploadId, offset, bytes.subarray(offset, offset + size));
      offset += size;
      expect(put).toEqual({ status: 200, body: expect.objectContaining({ uploadId, offset }) });
    }

    const done = await media.complete(url, uploadId, sha);
    expect(done).toEqual({ status: 200, body: { mediaId: sha, kind: "file", name: "数据.bin", mime: "application/octet-stream", size: 300_000 } });

    const down = await media.download(url, sha);
    expect(down.status).toBe(200);
    expect(down.headers["accept-ranges"]).toBe("bytes");
    expect(down.body.equals(bytes)).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, "materials", "media", sha)).equals(bytes)).toBe(true);
  });

  it("传到一半断网：重新连上后查到服务端已收到的偏移，从那里接着传，不重传已收到的字节", async () => {
    const { url } = await startTestDaemon();
    const bytes = randomBytes(200_000);
    const { body: created } = await media.create(url, { name: "大文件.bin", mime: "application/octet-stream", size: bytes.length });
    const { uploadId } = created;

    // 第一个分片完整送到
    expect((await media.put(url, uploadId, 0, bytes.subarray(0, 50_000))).body.offset).toBe(50_000);
    // 第二个分片（10 万字节）发出 3 万字节时网断了
    await putThenDrop(url, uploadId, 50_000, bytes.subarray(50_000, 150_000), 30_000);

    // 重新连上：服务端已收到的字节照样算数
    const status = await media.status(url, uploadId);
    expect(status).toEqual({ status: 200, body: expect.objectContaining({ uploadId, size: 200_000, offset: 80_000 }) });

    // 从错的偏移写（比如从头重传）被拒，响应里告诉前端服务端的偏移
    const wrong = await media.put(url, uploadId, 50_000, bytes.subarray(50_000, 150_000));
    expect(wrong).toEqual({ status: 409, body: { code: "offset_mismatch", message: expect.any(String), offset: 80_000 } });

    // 从服务端的偏移接着传剩下的 12 万字节
    expect((await media.put(url, uploadId, 80_000, bytes.subarray(80_000))).body.offset).toBe(200_000);
    const done = await media.complete(url, uploadId, sha256Hex(bytes));
    expect(done.status).toBe(200);
    expect((await media.download(url, done.body.mediaId)).body.equals(bytes)).toBe(true);
  });

  it("收尾的 sha256 和收到的原始字节对不上：拒绝，不入库", async () => {
    const { url, dataDir } = await startTestDaemon();
    const bytes = randomBytes(10_000);
    const { body: created } = await media.create(url, { name: "坏的.bin", mime: "application/octet-stream", size: bytes.length });
    await media.put(url, created.uploadId, 0, bytes);

    const wrongSha = sha256Hex(Buffer.from("别的内容"));
    const done = await media.complete(url, created.uploadId, wrongSha);
    expect(done).toEqual({ status: 422, body: { code: "sha256_mismatch", message: expect.stringContaining("sha256") } });
    expect(fs.readdirSync(path.join(dataDir, "materials", "media"))).toEqual([]);
    expect((await media.download(url, sha256Hex(bytes))).status).toBe(404);
    expect((await media.download(url, wrongSha)).status).toBe(404);
  });

  it("同样的内容只存一份：换个文件名再传一次，得到同一个媒体 id，素材区里还是一个文件", async () => {
    const { url, dataDir } = await startTestDaemon();
    const bytes = randomBytes(5_000);
    const first = await media.upload(url, bytes, { name: "一.bin", mime: "application/octet-stream" });
    const second = await media.upload(url, bytes, { name: "二.dat", mime: "application/x-whatever" });
    expect(second.mediaId).toBe(first.mediaId);
    expect(second.name).toBe("二.dat");
    expect(fs.readdirSync(path.join(dataDir, "materials", "media"))).toEqual([first.mediaId]);
  });

  it("下载支持 Range：返回 206 和正确的字节段；超出范围回 416", async () => {
    const { url } = await startTestDaemon();
    const bytes = randomBytes(1_000);
    const { mediaId } = await media.upload(url, bytes, { name: "段.bin", mime: "application/octet-stream" });

    const middle = await media.download(url, mediaId, { range: "bytes=100-199" });
    expect(middle.status).toBe(206);
    expect(middle.headers["content-range"]).toBe("bytes 100-199/1000");
    expect(middle.headers["content-length"]).toBe("100");
    expect(middle.body.equals(bytes.subarray(100, 200))).toBe(true);

    const tail = await media.download(url, mediaId, { range: "bytes=-50" });
    expect(tail.status).toBe(206);
    expect(tail.body.equals(bytes.subarray(950))).toBe(true);

    const open = await media.download(url, mediaId, { range: "bytes=990-" });
    expect(open.headers["content-range"]).toBe("bytes 990-999/1000");
    expect(open.body.equals(bytes.subarray(990))).toBe(true);

    const beyond = await media.download(url, mediaId, { range: "bytes=1000-1010" });
    expect(beyond.status).toBe(416);
    expect(beyond.headers["content-range"]).toBe("bytes */1000");

    // 不是图片的一律作为附件下载，文件名用消息里的名字
    const whole = await media.download(url, mediaId, { name: "报告 v2.bin" });
    expect(whole.headers["content-type"]).toBe("application/octet-stream");
    expect(whole.headers["content-disposition"]).toBe(`attachment; filename="__ v2.bin"; filename*=UTF-8''${encodeURIComponent("报告 v2.bin")}`);
    expect((await media.download(url, "0".repeat(64))).status).toBe(404);
    expect((await media.download(url, "not-a-media-id")).status).toBe(404);
  });

  it("图片入库时剥掉 EXIF：上传带 GPS 的 JPEG，收尾校验原始字节，入库和下载的是剥过之后的版本，媒体 id 是它的哈希", async () => {
    const { url, dataDir } = await startTestDaemon();
    const original = jpeg({ width: 40, height: 30, exif: { gps: true } });
    expect(original.includes(GPS_LATITUDE)).toBe(true);
    const rawSha = sha256Hex(original);

    // 收尾带的是原始上传字节的 sha256
    const stored = await media.upload(url, original, { name: "IMG_0001.JPG", mime: "image/jpeg" }, 100);
    expect(stored).toEqual({ mediaId: expect.any(String), kind: "image", name: "IMG_0001.JPG", mime: "image/jpeg", size: expect.any(Number), width: 40, height: 30 });

    const down = await media.download(url, stored.mediaId);
    expect(down.headers["content-type"]).toBe("image/jpeg");
    expect(down.headers["content-disposition"]).toMatch(/^inline;/);
    // 下载回来的文件里没有 EXIF：没有 EXIF 段，GPS 和相机型号的字节都不在了；其余各段原样保留
    expect(jpegMarkers(down.body)).toEqual(["ffe0", "ffe2", "ffdb", "ffc0", "ffda"]);
    expect(down.body.includes(GPS_LATITUDE)).toBe(false);
    expect(down.body.includes(Buffer.from(CAMERA_MODEL))).toBe(false);
    expect(down.body.subarray(-8).equals(original.subarray(-8))).toBe(true);

    // 入库版本的哈希就是媒体 id，和原始字节的哈希不同
    expect(stored.mediaId).toBe(sha256Hex(down.body));
    expect(stored.mediaId).not.toBe(rawSha);
    expect(stored.size).toBe(down.body.length);
    expect(fs.readdirSync(path.join(dataDir, "materials", "media"))).toEqual([stored.mediaId]);
  });

  it("手机竖拍的照片（方向 6，带 GPS、多图索引和附带的第二张图）：入库版本只剩方向，GPS 和附带数据都没了，宽高按显示方向给", async () => {
    const { url } = await startTestDaemon();
    const original = jpeg({ width: 40, height: 30, exif: { orientation: 6, gps: true }, mpf: true, trailing: Buffer.concat([jpeg({ exif: { gps: true } }), Buffer.from("MotionPhoto_Data")]) });
    const stored = await media.upload(url, original, { name: "IMG_2026.JPG", mime: "image/jpeg" });
    expect(stored).toMatchObject({ kind: "image", mime: "image/jpeg", width: 30, height: 40 });

    const down = (await media.download(url, stored.mediaId)).body;
    expect(jpegMarkers(down)).toEqual(["ffe0", "ffe1:exif", "ffe2", "ffdb", "ffc0", "ffda"]);
    // 留下的 EXIF 只有一项：方向 = 6
    const exif = down.subarray(down.indexOf("Exif\0\0") + 6);
    expect([...exif.subarray(0, 22)]).toEqual([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]);
    expect(down.includes(GPS_LATITUDE)).toBe(false);
    expect(down.includes(Buffer.from(CAMERA_MODEL))).toBe(false);
    expect(down.includes(Buffer.from("MotionPhoto_Data"))).toBe(false);
    // 图像结束标记就是最后两个字节
    expect([...down.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(down.indexOf(Buffer.from([0xff, 0xd9]))).toBe(down.length - 2);
  });

  it("超过单文件上限：建上传时就被拒；默认 200 MB，可以在配置里改", async () => {
    const { url } = await startTestDaemon();
    const tooBig = await media.create(url, { name: "电影.mkv", mime: "video/x-matroska", size: 200 * 1024 * 1024 + 1 });
    expect(tooBig).toEqual({ status: 413, body: { code: "too_large", message: expect.stringContaining("上限") } });
    expect((await media.create(url, { name: "刚好.bin", mime: "", size: 200 * 1024 * 1024 })).status).toBe(201);

    const dataDir = makeTempDir("ergo-data-");
    fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config", "ergo.json"), JSON.stringify({ media: { maxUploadBytes: 1000 } }));
    const small = await startTestDaemon({ reuse: { dataDir, homeDir: makeTempDir("ergo-home-") } });
    expect((await media.create(small.url, { name: "a.txt", mime: "text/plain", size: 1001 })).status).toBe(413);
    expect((await media.create(small.url, { name: "a.txt", mime: "text/plain", size: 1000 })).status).toBe(201);
  });
});
