// 候选的缩略图（149 号票）：缓存区里按"文件路径 + 修改时间 + 大小"存，同一张图第二次直接用；候选建出来时一批先做好，请求到了等它；
// 做不出来的不反复试；清理按多久没用、总量删。真的缩小在 thumbnails.test.ts（一次性子进程），这里用假的缩小。
import fs from "node:fs";
import path from "node:path";
import { PAGE_THUMB_EDGE } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createPageThumbnails } from "../../src/browsing/page-thumbnails.ts";
import type { ThumbnailRequest, ThumbnailResult } from "../../src/runtime/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 假的缩小：记下每次要缩的，名字里有"坏"的解不开；小图就是 "thumb:" 加原文件名 */
function fakeThumbnails() {
  const calls: ThumbnailRequest[] = [];
  const fn = async (request: ThumbnailRequest): Promise<ThumbnailResult> => {
    calls.push(request);
    await Promise.resolve();
    return {
      thumbs: request.files.map((f) =>
        path.basename(f.path).includes("坏") ? { ok: false, reason: "解不开" } : { ok: true, data: Buffer.from(`thumb:${path.basename(f.path)}`).toString("base64"), mime: "image/jpeg", width: 320, height: 240 },
      ),
    };
  };
  return { calls, fn };
}

function photos(...names: string[]) {
  const dir = makeTempDir("ergo-thumb-src-");
  return names.map((name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `原图 ${name}`);
    return { path: file, mime: "image/jpeg", image: true };
  });
}

describe("候选的缩略图", () => {
  it("做出来存进缓存区；同一个文件第二次直接用；文件改了重做；不是图片、做不出来的回没有、不反复试", async () => {
    const dir = path.join(makeTempDir("ergo-thumbs-"), "cache", "page-thumbnails");
    const fake = fakeThumbnails();
    const thumbs = createPageThumbnails({ dir, thumbnails: fake.fn, log: () => {} });
    const [a, broken] = photos("a.jpg", "坏.jpg");

    const first = await thumbs.get(a!);
    expect(first?.mime).toBe("image/jpeg");
    expect(path.dirname(first!.file)).toBe(dir);
    expect(fs.readFileSync(first!.file, "utf8")).toBe("thumb:a.jpg");
    expect(fake.calls).toEqual([{ files: [{ path: a!.path, mime: "image/jpeg" }], maxEdge: PAGE_THUMB_EDGE }]);
    // 第二次直接用缓存
    expect(await thumbs.get(a!)).toEqual(first);
    expect(fake.calls).toHaveLength(1);
    // 文件改了（大小变了）：重做
    fs.appendFileSync(a!.path, "改过");
    expect((await thumbs.get(a!))?.file).not.toBe(first!.file);
    expect(fake.calls).toHaveLength(2);

    expect(await thumbs.get(broken!)).toBeUndefined();
    expect(await thumbs.get(broken!)).toBeUndefined();
    expect(fake.calls).toHaveLength(3);
    expect(await thumbs.get({ path: a!.path, mime: "video/mp4", image: false })).toBeUndefined();
    expect(await thumbs.get({ path: path.join(dir, "没有.jpg"), mime: "image/jpeg", image: true })).toBeUndefined();
    expect(fake.calls).toHaveLength(3);
  });

  it("候选建出来时一批先做好（一个子进程），请求到了等这一批，不另做", async () => {
    const dir = makeTempDir("ergo-thumbs-");
    const fake = fakeThumbnails();
    const thumbs = createPageThumbnails({ dir, thumbnails: fake.fn, log: () => {} });
    const files = photos("1.jpg", "2.jpg", "3.jpg");
    thumbs.warm(files);
    const got = await Promise.all(files.map((f) => thumbs.get(f)));
    expect(got.map((g) => fs.readFileSync(g!.file, "utf8"))).toEqual(["thumb:1.jpg", "thumb:2.jpg", "thumb:3.jpg"]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.files).toHaveLength(3);
    // 做好了的再 warm 不再做
    thumbs.warm(files);
    expect(fake.calls).toHaveLength(1);
  });

  it("清理：多久没用的删掉，加起来超了从最久没用的删起；用过的算刚用过", async () => {
    const dir = makeTempDir("ergo-thumbs-");
    let clock = Date.parse("2026-10-18T10:00:00+08:00");
    const fake = fakeThumbnails();
    const thumbs = createPageThumbnails({ dir, thumbnails: fake.fn, log: () => {}, now: () => clock, keepMs: 24 * 3600_000, maxBytes: 30 });
    const [a, b, c] = photos("a.jpg", "b.jpg", "c.jpg");
    const ta = await thumbs.get(a!); // 11 字节
    clock += 3600_000;
    const tb = await thumbs.get(b!);
    clock += 3600_000;
    const tc = await thumbs.get(c!);
    // 三个加起来 33 字节，超了 30：最久没用的 a 删掉
    expect(thumbs.sweep()).toBe(1);
    expect(fs.existsSync(ta!.file)).toBe(false);
    expect(fs.existsSync(tb!.file) && fs.existsSync(tc!.file)).toBe(true);
    // 过了 24 小时：用过一次的 c 留着，b 删掉
    clock += 23 * 3600_000;
    await thumbs.get(c!);
    clock += 2 * 3600_000;
    expect(thumbs.sweep()).toBe(1);
    expect(fs.existsSync(tb!.file)).toBe(false);
    expect(fs.existsSync(tc!.file)).toBe(true);
  });
});
