// 看图（145 号票的 view_files，149 号票起是秘书在用）那一步的缩小：一次性子进程（runtime/thumbnails.ts 拉起 agent-child/thumbnails-main.ts，
// 用 pi 自带的图片缩放）把几张图缩成长边不超过 384 的小图。真的拉起子进程、真的解码缩小（不加图片库）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readImageInfo } from "../../src/media/image.ts";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { runThumbnails } from "../../src/runtime/index.ts";
import { gradientPng, png } from "../helpers/images.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

describe("缩小成小图", () => {
  it("长边缩到 384（像照片的大图存成 JPEG），本来就小的不放大；解不开的说明原因，别的照常；按给的顺序回", async () => {
    const dir = makeTempDir("ergo-thumbs-");
    const file = (name: string, body: Buffer | string) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, body);
      return p;
    };
    const wide = file("wide.png", gradientPng(1600, 1200));
    const tall = file("tall.png", gradientPng(300, 900));
    const small = file("small.png", png({ width: 200, height: 100 }));
    const broken = file("broken.jpg", "这不是一张图");
    const gone = path.join(dir, "没有.jpg");
    const { thumbs } = await runThumbnails(
      {
        files: [
          { path: wide, mime: "image/png" },
          { path: broken, mime: "image/jpeg" },
          { path: tall, mime: "image/png" },
          { path: gone, mime: "image/jpeg" },
          { path: small, mime: "image/png" },
        ],
        maxEdge: 384,
      },
      { env: buildChildEnv(process.env) },
    );
    expect(thumbs).toHaveLength(5);
    const info = (i: number) => {
      const t = thumbs[i]!;
      if (!t.ok) throw new Error(`第 ${i} 张没缩成：${t.reason}`);
      const read = readImageInfo(Buffer.from(t.data, "base64"));
      return { mime: t.mime, width: t.width, height: t.height, read: read && { mime: read.mime, width: read.width, height: read.height } };
    };
    expect(info(0)).toEqual({ mime: "image/jpeg", width: 384, height: 288, read: { mime: "image/jpeg", width: 384, height: 288 } });
    // 小一些的：缩小后哪种格式先够小用哪种（PNG 先试）
    expect(info(2)).toMatchObject({ width: 128, height: 384, read: { width: 128, height: 384 } });
    expect(info(2).read?.mime).toBe(info(2).mime);
    expect(info(4)).toMatchObject({ width: 200, height: 100 });
    expect(thumbs[1]).toEqual({ ok: false, reason: expect.stringContaining("解不开") });
    expect(thumbs[3]).toEqual({ ok: false, reason: expect.stringContaining("读不了") });
    // 小图真的小：几十 KB 以内
    expect(thumbs.every((t) => !t.ok || t.data.length < 64 * 1024)).toBe(true);
  });
});
