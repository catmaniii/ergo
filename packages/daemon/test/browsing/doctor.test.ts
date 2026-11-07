// 内置浏览器插件的体检项（414，src/browsing/doctor.ts）"缩略图"：
// - 包过的缩小图片记下缩了几次、连着出错几次、一共几次、最近一次的时间和原因（子进程起不来、超时才算出错；单张解不开不算）；
//   候选的缩略图（page-thumbnails.ts）用包过的，出错照旧回"没有"，次数记上；
// - 判法：还没缩过不适用；最近一次出错了注意（连着几次，从这一串开头起）；出错过后来好了正常（写一共几次）；都没出错正常。
// 用假的缩小，不起子进程。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countThumbnailFailures, thumbnailsCheck, thumbnailsFinding } from "../../src/browsing/doctor.ts";
import { createPageThumbnails } from "../../src/browsing/page-thumbnails.ts";
import { runDoctorCheck } from "../../src/doctor/checks.ts";
import type { ThumbnailRequest, ThumbnailResult } from "../../src/runtime/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 假的缩小：broken 时抛错（像子进程起不来），名字里有"坏"的单张解不开 */
function fakeThumbnails() {
  const state = { broken: false };
  const fn = async (request: ThumbnailRequest): Promise<ThumbnailResult> => {
    await Promise.resolve();
    if (state.broken) throw new Error("缩小图片的子进程退出了（代码 1）");
    return { thumbs: request.files.map((f) => (path.basename(f.path).includes("坏") ? { ok: false, reason: "解不开" } : { ok: true, data: Buffer.from("x").toString("base64"), mime: "image/jpeg", width: 1, height: 1 })) };
  };
  return { state, fn };
}

function photo(name: string) {
  const file = path.join(makeTempDir("ergo-thumb-doctor-"), name);
  fs.writeFileSync(file, `原图 ${name}`);
  return { path: file, mime: "image/jpeg", image: true };
}

let tick = 0;
const now = () => new Date(Date.parse("2026-11-07T10:00:00+08:00") + ++tick * 60_000).toISOString();

describe("缩略图（次数和判法）", () => {
  it("还没缩过：不适用；都没出错：正常；单张解不开不算出错", async () => {
    const fake = fakeThumbnails();
    const counted = countThumbnailFailures(fake.fn, now);
    expect(thumbnailsFinding(counted.stats())).toEqual({ level: "na", fact: { key: "browsing.doctor.thumbnails.idle" } });
    const thumbs = createPageThumbnails({ dir: path.join(makeTempDir("ergo-thumbs-"), "cache"), thumbnails: counted.thumbnails, log: () => {} });
    expect(await thumbs.get(photo("a.jpg"))).toBeDefined();
    expect(await thumbs.get(photo("坏.jpg"))).toBeUndefined();
    expect(counted.stats()).toEqual({ calls: 2, failures: 0, total: 0 });
    expect(thumbnailsFinding(counted.stats())).toEqual({ level: "ok", fact: { key: "browsing.doctor.thumbnails.ok", params: { count: 2 } } });
  });

  it("子进程出错：候选的缩略图照旧回没有，次数记上；连着两次注意（从第一次起），好了以后正常、写一共几次", async () => {
    const fake = fakeThumbnails();
    const counted = countThumbnailFailures(fake.fn, now);
    const thumbs = createPageThumbnails({ dir: path.join(makeTempDir("ergo-thumbs-"), "cache"), thumbnails: counted.thumbnails, log: () => {} });
    fake.state.broken = true;
    expect(await thumbs.get(photo("b.jpg"))).toBeUndefined();
    await expect(counted.thumbnails({ files: [], maxEdge: 100 })).rejects.toThrow("子进程退出了");
    const stats = counted.stats();
    expect(stats).toMatchObject({ calls: 2, failures: 2, total: 2, error: "缩小图片的子进程退出了（代码 1）" });
    expect(Date.parse(stats.since!)).toBeLessThan(Date.parse(stats.at!));
    const failing = await runDoctorCheck(thumbnailsCheck(counted.stats));
    expect(failing).toMatchObject({ level: "warn", fact: { key: "browsing.doctor.thumbnails.failing", params: { count: 2, error: "缩小图片的子进程退出了（代码 1）" } }, fix: { key: "browsing.doctor.thumbnails.fix" }, since: stats.since });

    fake.state.broken = false;
    expect(await thumbs.get(photo("c.jpg"))).toBeDefined();
    expect(thumbnailsFinding(counted.stats())).toEqual({ level: "ok", fact: { key: "browsing.doctor.thumbnails.recovered", params: { count: 2 } } });
  });
});
