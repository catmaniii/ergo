// 替网页的上传框找文件（134 号票，212 号票起在浏览插件里：browsing/find-files.ts、exif.ts）：照片的拍摄时间（JPEG 的 EXIF），
// 授权的文件夹里按文件夹名和文件名里的词、时间、种类找，素材里按附件找。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exifTimeOf, jpegCaptureTime } from "../../src/browsing/exif.ts";
import { type CaptureTimeCache, type FileQuery, folderOverviewText, localDateTime, mimeOfName, searchFolders, searchMaterialFiles } from "../../src/browsing/find-files.ts";
import type { Material } from "../../src/materials/index.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { jpegWithCaptureTime } from "./jpeg-exif.ts";

const TZ = "Asia/Shanghai";
const query = (over: Partial<FileQuery>): FileQuery => ({ keywords: [], kind: "any", limit: 30, ...over });

describe("照片的拍摄时间", () => {
  it("Exif 子目录的 DateTimeOriginal 优先，没有用 IFD0 的 DateTime；大端、小端都认", () => {
    expect(jpegCaptureTime(jpegWithCaptureTime("2026:10:11 10:20:33", { dateTime: "2026:10:20 08:00:00" }))).toBe("2026-10-11 10:20");
    expect(jpegCaptureTime(jpegWithCaptureTime("2026:10:11 10:20:33", { bigEndian: true }))).toBe("2026-10-11 10:20");
    expect(jpegCaptureTime(jpegWithCaptureTime(undefined, { dateTime: "2026:10:20 08:00:00" }))).toBe("2026-10-20 08:00");
  });

  it("不是 JPEG、没有 EXIF、写法不对：没有", () => {
    expect(jpegCaptureTime(Buffer.from("not a jpeg"))).toBeUndefined();
    expect(jpegCaptureTime(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
    expect(exifTimeOf("0000:00:00 00:00:00")).toBeUndefined();
    expect(exifTimeOf("2026:10:11 10:20:33")).toBe("2026-10-11 10:20");
  });
});

describe("在授权的文件夹里找", () => {
  it("关键词按文件夹名加相对路径找；照片按拍摄时间、别的按修改时间筛；种类按扩展名；隐藏的、系统的文件夹不进", async () => {
    const root = makeTempDir("ergo-find-");
    const trip = path.join(root, "2026-10 杭州");
    fs.mkdirSync(trip);
    fs.writeFileSync(path.join(trip, "a.jpg"), jpegWithCaptureTime("2026:10:11 09:00:00"));
    fs.writeFileSync(path.join(trip, "b.JPG"), jpegWithCaptureTime("2026:08:01 09:00:00"));
    fs.writeFileSync(path.join(trip, "行程.pdf"), "%PDF-1.4");
    fs.mkdirSync(path.join(root, ".thumbnails"));
    fs.writeFileSync(path.join(root, ".thumbnails", "杭州.jpg"), jpegWithCaptureTime("2026:10:11 09:00:00"));
    // 138 号票起和设置里选文件夹的框同一条规则：$ 开头的、Windows 本来藏着的 AppData 这类也不进
    for (const hidden of ["$RECYCLE.BIN", "AppData"]) {
      fs.mkdirSync(path.join(root, hidden));
      fs.writeFileSync(path.join(root, hidden, "杭州.jpg"), jpegWithCaptureTime("2026:10:11 09:00:00"));
    }
    const cache: CaptureTimeCache = new Map();

    const photos = await searchFolders([root], query({ keywords: ["杭州"], kind: "image", from: "2026-10-10", to: "2026-10-12" }), { timeZone: TZ, cache });
    expect(photos.files.map((f) => [f.name, f.when, f.whenKind])).toEqual([["a.jpg", "2026-10-11 09:00", "taken"]]);
    expect(photos.files[0]).toMatchObject({ mime: "image/jpeg", image: true, source: "folder", where: path.join(path.basename(root), "2026-10 杭州", "a.jpg") });

    const all = await searchFolders([root], query({ keywords: ["杭州"] }), { timeZone: TZ, cache });
    expect(all.files.map((f) => f.name).toSorted()).toEqual(["a.jpg", "b.JPG", "行程.pdf"]);
    expect(all.files.find((f) => f.name === "行程.pdf")).toMatchObject({ whenKind: "modified", mime: "application/pdf", image: false });
    expect((await searchFolders([root], query({ keywords: ["杭州"], kind: "document" }), { timeZone: TZ, cache })).files.map((f) => f.name)).toEqual(["行程.pdf"]);
    // 拍摄时间记着：同一个文件不再读
    expect(cache.size).toBe(2);
  });

  it("子文件夹概况（145 号票）：每个授权的文件夹下按第一层子文件夹数这次种类的文件（含更深的，不看关键词和时间），直接放着的算（顶层）", async () => {
    const root = makeTempDir("ergo-overview-");
    const put = (rel: string, body: Buffer | string = "x") => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    };
    for (let i = 0; i < 5; i++) put(`Screenshots/s${i}.png`);
    for (let i = 0; i < 3; i++) put(`头像/2025/p${i}.jpg`);
    put("头像/简介.pdf");
    put("top.jpg");
    put("说明.txt");
    put(".hidden/h.jpg");
    fs.mkdirSync(path.join(root, "空的"));
    const result = await searchFolders([root], query({ keywords: ["杭州"], kind: "image" }), { timeZone: TZ, cache: new Map() });
    // 关键词一个都没对上，概况照样有
    expect(result.files).toEqual([]);
    expect(result.overview).toEqual([{ root, counts: [{ name: "Screenshots", count: 5 }, { name: "头像", count: 3 }, { name: "", count: 1 }] }]);
    const any = await searchFolders([root], query({ kind: "any" }), { timeZone: TZ, cache: new Map() });
    expect(any.overview[0]?.counts).toEqual([{ name: "Screenshots", count: 5 }, { name: "头像", count: 4 }, { name: "", count: 2 }]);
  });

  it("子文件夹概况写给秘书：按数量排，最多列 20 个，多了写还有几个，（顶层）放最后；没有这种文件的写明", () => {
    const counts = [...Array.from({ length: 22 }, (_, i) => ({ name: `d${String(i).padStart(2, "0")}`, count: 30 - i })), { name: "", count: 4 }];
    const lines = folderOverviewText([{ root: path.join("C:", "Users", "me", "Pictures"), counts }, { root: path.join("D:", "下载"), counts: [] }], "image");
    expect(lines).toContain("子文件夹概况（每个子文件夹里有几张图片，含更深的；可以把文件夹名当关键词再找）：");
    expect(lines).toContain(`- Pictures：${counts.slice(0, 20).map((c) => `${c.name} ${c.count}`).join("、")}，还有 2 个子文件夹（共 19 张），（顶层）4`);
    expect(lines).toContain("- 下载：没有图片");
  });

  it("文件夹不在了：什么都没找到，不出错", async () => {
    expect((await searchFolders([path.join(makeTempDir(), "没有")], query({}), { timeZone: TZ, cache: new Map() })).files).toEqual([]);
  });

  it("类型按扩展名；时间按时区写", () => {
    expect(mimeOfName("IMG.HEIC")).toBe("image/heic");
    expect(mimeOfName("x.unknown")).toBe("application/octet-stream");
    expect(localDateTime(Date.UTC(2026, 9, 11, 16, 30), TZ)).toBe("2026-10-12 00:30");
  });
});

const material = (id: string, time: string, segments: Material["segments"]): Material =>
  ({ id, kind: "user_message", mode: "self", time, conversation: "secretary", task: null, project: null, source: "self", ref: { event: { globalSeq: 1, channel: "secretary", seq: 1, type: "message" } }, context: [], segments, original: null, noInfer: false }) as unknown as Material;
const attachment = (mediaId: string, name: string) => ({ form: "attachment" as const, source: "self" as const, notes: [], locator: { part: 0 }, label: name, media: { mediaId, name, mime: "application/pdf" } });

describe("在素材里找附件", () => {

  it("关键词检索加语义检索的结果里，附件切段有媒体的列出来（去重），时间是发来的时间；没有关键词不找", async () => {
    const materials = {
      searchKeyword: () => [material("m1", "2026-10-01T10:00:00+08:00", [attachment("a".repeat(64), "发票.pdf")])],
      searchSemantic: async () => [{ score: 0.9, material: material("m2", "2026-10-02T10:00:00+08:00", [attachment("a".repeat(64), "发票.pdf"), attachment("b".repeat(64), "发票2.pdf")]) }],
    };
    const media = { info: (id: string) => ({ mediaId: id, size: 10, image: undefined, audio: undefined }), filePath: (id: string) => `/media/${id}` };
    const found = await searchMaterialFiles(materials, media, query({ keywords: ["发票"] }), TZ);
    expect(found.map((f) => [f.name, f.when, f.source, f.path])).toEqual([
      ["发票.pdf", "2026-10-01 10:00", "material", `/media/${"a".repeat(64)}`],
      ["发票2.pdf", "2026-10-02 10:00", "material", `/media/${"b".repeat(64)}`],
    ]);
    expect(await searchMaterialFiles(materials, media, query({}), TZ)).toEqual([]);
  });
});
