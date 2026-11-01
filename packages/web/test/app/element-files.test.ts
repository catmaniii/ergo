// 长按网页元素的圆钮（359 号票，plugins/browsing/element-files.ts）：设备这边怎么取元素的内容、怎么下载。页面桥、App、上传都是假的。查：
// - http：App 取，读出来传进媒体库，交回媒体编号；取不到（防盗链也挡不住的、断网）、回的是网页的图：截这个元素的图，写明是截图；链接指向网页不取，回原因（让秘书用 browse_open）；链接取不到回原因，不截图；
// - data、blob、canvas：页面读（blob 读得慢也等）；读不了截图；SVG 直接截图；截完把页面桥这一层放回来；只截到一部分的写明；
// - 下载：有地址的走 App 的下载；没地址的字节写进 App 的缓存再弹保存到；文字回原因；
// - 换了网页、页面桥不在、旧版 App 回明确的原因。
import { describe, expect, test } from "vitest";
import type { AppElementFailure, NativeElementFiles, PageElementChunk, PageElementInfo } from "../../src/app/native-browser.ts";
import { ElementFiles, elementFileName, failureText } from "../../src/plugins/browsing/element-files.ts";
import type { PickedElement } from "../../src/state/index.ts";

const PAGE_URL = "https://photos.example.cn/album";
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

type Fetched = ({ ok: true; id: string; name: string; mime: string; size: number } | AppElementFailure) & { bytes?: Uint8Array };

function setup(element: PickedElement | PageElementInfo | "old" | undefined, options: { fetch?: Fetched; pageBytes?: Uint8Array; pageMime?: string; prepare?: string; slowPolls?: number; shot?: boolean; partial?: boolean; noFiles?: boolean; rectReason?: string; download?: { ok: true } | AppElementFailure } = {}) {
  const log: string[] = [];
  const uploads: Array<{ bytes: Uint8Array; name: string; mime: string }> = [];
  const shotBytes = new Uint8Array([9, 9, 9]);
  const cache = new Map<string, { bytes: Uint8Array }>();
  let polls = options.slowPolls ?? 0;
  const written: number[] = [];
  if (options.fetch && options.fetch.ok) cache.set(options.fetch.id, { bytes: options.fetch.bytes ?? new Uint8Array() });
  const files: NativeElementFiles = {
    fetch: (url, max) => {
      log.push(`fetch ${url} ${max}`);
      return Promise.resolve(options.fetch ?? { ok: false, code: "network" });
    },
    shot: (rect) => {
      log.push(`shot ${rect.x},${rect.y},${rect.width},${rect.height}`);
      if (options.shot === false) return Promise.resolve({ ok: false, code: "shot" });
      cache.set("s1", { bytes: shotBytes });
      return Promise.resolve({ ok: true, id: "s1", name: "element.png", mime: "image/png", size: shotBytes.length });
    },
    read: (id, offset) => {
      const got = cache.get(id);
      if (!got) return Promise.resolve({ ok: false, code: "gone" });
      const part = got.bytes.subarray(offset, offset + 2);
      return Promise.resolve({ ok: true, base64: b64(part), done: offset + part.length >= got.bytes.length });
    },
    write: (id, base64) => {
      written.push(atob(base64).length);
      log.push(`write ${id || "new"}`);
      return Promise.resolve({ ok: true, id: id || "w1" });
    },
    save: (id, name, mime) => {
      log.push(`save ${id} ${name} ${mime}`);
      return Promise.resolve({ ok: true });
    },
    download: (url) => {
      log.push(`download ${url}`);
      return Promise.resolve(options.download ?? { ok: true });
    },
    drop: (id) => void log.push(`drop ${id}`),
  };
  const info: PageElementInfo | "old" | undefined = element === "old" || element === undefined ? element : "ok" in element ? element : { ok: true, page: { title: "相册", url: PAGE_URL }, element };
  const page = {
    elementInfo: () => Promise.resolve(info),
    elementPrepare: () => {
      log.push("prepare");
      return Promise.resolve(options.prepare ? { ok: false, reason: options.prepare } : { ok: true });
    },
    elementChunk: (_id: string, offset: number): Promise<PageElementChunk> => {
      if (polls-- > 0) return Promise.resolve({ ok: true, ready: false });
      const bytes = options.pageBytes ?? new Uint8Array([1, 2, 3]);
      return Promise.resolve({ ok: true, ready: true, base64: b64(bytes.subarray(offset)), mime: options.pageMime ?? "image/png", total: bytes.length, done: true });
    },
    elementRect: () => {
      log.push("rect");
      return Promise.resolve(options.rectReason ? { ok: false as const, reason: options.rectReason } : { ok: true as const, x: 10, y: 20, width: 30, height: 40, partial: options.partial === true });
    },
    elementShotDone: () => void log.push("shotDone"),
  };
  const elements = new ElementFiles({
    page,
    ...(options.noFiles ? {} : { files }),
    upload: (bytes, name, mime) => {
      uploads.push({ bytes, name, mime });
      return Promise.resolve({ mediaId: "m".repeat(64), name, mime, size: bytes.length } as never);
    },
    sleep: () => Promise.resolve(),
  });
  return { elements, log, uploads, written };
}

const IMAGE: PickedElement = { id: "x1", kind: "image", source: "http", src: "https://cdn.example.cn/cat.png" };
const LINK: PickedElement = { id: "x2", kind: "link", href: "https://photos.example.cn/report.pdf" };
const CANVAS: PickedElement = { id: "x3", kind: "image", source: "canvas", label: "图 / 表" };
const SVG: PickedElement = { id: "x4", kind: "image", source: "svg" };
const TEXT: PickedElement = { id: "x5", kind: "text", text: { text: "一段", total: 2 } };
const okFile = (bytes: number[], mime = "image/png", name = "cat.png"): Fetched => ({ ok: true, id: "c1", name, mime, size: bytes.length, bytes: new Uint8Array(bytes) });

describe("取元素的内容", () => {
  test("http：App 取，读出来传进媒体库；放掉缓存；不截图", async () => {
    const t = setup(IMAGE, { fetch: okFile([1, 2, 3, 4, 5]) });
    const out = await t.elements.file("x1", PAGE_URL);
    expect(out).toMatchObject({ ok: true, file: { name: "cat.png", mime: "image/png", size: 5, via: "original" } });
    expect([...t.uploads[0]!.bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(t.log).toContain("drop c1");
    expect(t.log).not.toContain("rect");
    expect(t.log[0]).toContain("https://cdn.example.cn/cat.png");
  });

  test("图取不到：截这个元素的图，写明是截图；截完把页面桥这一层放回来", async () => {
    const t = setup(IMAGE, { fetch: { ok: false, code: "http", status: 403 }, partial: true });
    const out = await t.elements.file("x1", PAGE_URL);
    expect(out).toMatchObject({ ok: true, file: { via: "screenshot", partial: true, mime: "image/png" } });
    expect(t.log).toEqual(expect.arrayContaining(["rect", "shot 10,20,30,40", "shotDone", "drop s1"]));
  });

  test("图的地址回的是网页：当没取到，截图", async () => {
    const t = setup(IMAGE, { fetch: okFile([1], "text/html", "x.html") });
    expect(await t.elements.file("x1", PAGE_URL)).toMatchObject({ ok: true, file: { via: "screenshot" } });
    expect(t.log).toContain("drop c1");
  });

  test("图取不到、截图也不成：两个原因都写", async () => {
    const t = setup(IMAGE, { fetch: { ok: false, code: "network" }, shot: false });
    expect(await t.elements.file("x1", PAGE_URL)).toEqual({ ok: false, reason: expect.stringMatching(/连不上.*截图也没截成/) });
    expect(t.log).toContain("shotDone");
  });

  test("链接：取它指向的文件；指向网页的不取，回原因；取不到回原因，不截图", async () => {
    const pdf = setup(LINK, { fetch: okFile([7], "application/pdf", "report.pdf") });
    expect(await pdf.elements.file("x2", PAGE_URL)).toMatchObject({ ok: true, file: { name: "report.pdf", via: "original" } });
    const html = setup(LINK, { fetch: okFile([7], "text/html; charset=utf-8", "a.html") });
    const page = await html.elements.file("x2", PAGE_URL);
    expect(page).toEqual({ ok: false, reason: expect.stringContaining("指向的是网页") });
    expect(html.log).toContain("drop c1");
    expect(html.log).not.toContain("rect");
    const failed = setup(LINK, { fetch: { ok: false, code: "http", status: 404 } });
    expect(await failed.elements.file("x2", PAGE_URL)).toEqual({ ok: false, reason: expect.stringContaining("HTTP 404") });
    expect(failed.log).not.toContain("rect");
  });

  test("canvas、blob 页面读（读得慢也等）；读不了截图；SVG 直接截图", async () => {
    const t = setup(CANVAS, { slowPolls: 3, pageBytes: new Uint8Array([4, 5]) });
    expect(await t.elements.file("x3", PAGE_URL)).toMatchObject({ ok: true, file: { via: "original", name: "图 表.png" } });
    expect([...t.uploads[0]!.bytes]).toEqual([4, 5]);
    const tainted = setup(CANVAS, { prepare: "读不出来" });
    expect(await tainted.elements.file("x3", PAGE_URL)).toMatchObject({ ok: true, file: { via: "screenshot" } });
    const svg = setup(SVG);
    expect(await svg.elements.file("x4", PAGE_URL)).toMatchObject({ ok: true, file: { via: "screenshot" } });
    expect(svg.log).not.toContain("prepare");
  });

  test("文字没有文件；换了网页、页面桥不在、旧版 App 回明确的原因", async () => {
    expect(await setup(TEXT).elements.file("x5", PAGE_URL)).toEqual({ ok: false, reason: expect.stringContaining("是文字") });
    expect(await setup({ ok: false, reason: "网页换了，编号对不上了" }).elements.file("x1", PAGE_URL)).toEqual({ ok: false, reason: "网页换了，编号对不上了" });
    expect(await setup(undefined).elements.file("x1", PAGE_URL)).toEqual({ ok: false, reason: expect.stringContaining("页面桥不在") });
    expect(await setup("old").elements.file("x1", PAGE_URL)).toEqual({ ok: false, reason: expect.stringContaining("太旧") });
    expect(await setup(IMAGE, { noFiles: true }).elements.file("x1", PAGE_URL)).toEqual({ ok: false, reason: expect.stringContaining("太旧") });
  });
});

describe("下载元素", () => {
  test("有地址的走 App 的下载：图下图本身、链接下它指向的；开头就失败的回原因", async () => {
    const t = setup(IMAGE);
    expect(await t.elements.download("x1", PAGE_URL)).toEqual({ ok: true });
    expect(t.log).toEqual(["download https://cdn.example.cn/cat.png"]);
    const link = setup(LINK);
    expect(await link.elements.download("x2", PAGE_URL)).toEqual({ ok: true });
    expect(link.log).toEqual(["download https://photos.example.cn/report.pdf"]);
    const failed = setup(IMAGE, { download: { ok: false, code: "http", status: 403 } });
    expect(await failed.elements.download("x1", PAGE_URL)).toEqual({ ok: false, reason: expect.stringContaining("HTTP 403") });
  });

  test("没地址的：字节写进 App 的缓存再弹保存到；读不了存截的图；文字回原因", async () => {
    const t = setup(CANVAS, { pageBytes: new Uint8Array(1000) });
    expect(await t.elements.download("x3", PAGE_URL)).toEqual({ ok: true });
    expect(t.log).toEqual(["prepare", "write new", "save w1 图 表.png image/png"]);
    expect(t.written).toEqual([1000]);
    const tainted = setup(CANVAS, { prepare: "读不出来" });
    expect(await tainted.elements.download("x3", PAGE_URL)).toEqual({ ok: true });
    expect(tainted.log).toEqual(expect.arrayContaining(["rect", "shotDone", "save s1 图 表.png image/png"]));
    expect(await setup(TEXT).elements.download("x5", PAGE_URL)).toEqual({ ok: false, reason: expect.stringContaining("是文字") });
  });
});

describe("小工具", () => {
  test("名字：说明文字、不然按种类，加上类型的后缀", () => {
    expect(elementFileName(CANVAS, "image/png")).toBe("图 表.png");
    expect(elementFileName(SVG, "image/svg+xml")).toBe("image.svg");
    expect(elementFileName({ id: "x1", kind: "video" }, "video/mp4; codecs=x")).toBe("video.mp4");
    expect(elementFileName({ id: "x1", kind: "image" }, "application/x-unknown")).toBe("image");
  });

  test("App 的原因写成人话；不认识的操作（旧版 App）说太旧", () => {
    expect(failureText({ ok: false, code: "too-large" })).toContain("太大");
    expect(failureText({ ok: false, code: "http", status: 500 })).toContain("HTTP 500");
    expect(failureText({ ok: false, code: "old" })).toContain("太旧");
    expect(failureText({ ok: false, code: "whatever" })).toContain("whatever");
  });
});
