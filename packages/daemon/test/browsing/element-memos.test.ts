// 这一轮取回来的元素文件（366 号票）：记下来时只认这一轮取回来的编号，文件要还在、大小在附件的上限之内；来源只留 http、https 的；
// 没带编号时，这一轮长按的是文件类元素才说明为什么只记了文字。
import type { BrowsingMark, ElementFile, PickedElement } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createElementMemos } from "../../src/browsing/element-memos.ts";
import type { MediaInfo } from "../../src/media/media-store.ts";

const mediaId = "a".repeat(64);
const FILE: ElementFile = { mediaId, name: "cat.png", mime: "image/png", size: 100, via: "original" };
const IMAGE: PickedElement = { id: "x1", kind: "image", source: "http", src: "https://cdn.example.cn/cat.png?sig=abc", href: "https://photos.example.cn/cat" };

function setup(options: { element?: PickedElement; url?: string; info?: MediaInfo | undefined; max?: number } = {}) {
  const mark: BrowsingMark = { browser: "b-0123456789abcdef", title: "相册", url: options.url ?? "https://photos.example.cn/album", via: "button", element: options.element ?? IMAGE };
  const info = "info" in options ? options.info : { mediaId, size: 100, image: { mime: "image/png" as const, width: 8, height: 6 }, audio: undefined };
  return createElementMemos({
    markOf: (id) => (id === "m-none" ? undefined : mark),
    media: { maxUploadBytes: options.max ?? 1000, info: () => info },
  });
}

const turn = (id: string, toolCallId = "call-1") => ({ inputMessageId: id, toolCallId });

describe("带文件编号", () => {
  it("这一轮取回来的：给文件（图片的类型、宽高照媒体库认的）、来源网页和地址、取回它的那次调用", () => {
    const memos = setup();
    memos.fetched(turn("m-1", "call-fetch"), "ref-00000001", FILE);
    expect(memos.toRemember("ref-00000001", turn("m-1"))).toEqual({
      file: { mediaId, kind: "image", name: "cat.png", mime: "image/png", size: 100, width: 8, height: 6, via: "original", fetchCallId: "call-fetch" },
      origin: { page: { title: "相册", url: "https://photos.example.cn/album" }, address: IMAGE.src },
    });
  });

  it("浏览器显示不了的（SVG……）算文件；截图带着怎么来的", () => {
    const memos = setup({ info: { mediaId, size: 100, image: undefined, audio: undefined } });
    memos.fetched(turn("m-1"), "ref-00000001", { ...FILE, mime: "image/svg+xml", via: "screenshot", partial: true });
    expect(memos.toRemember("ref-00000001", turn("m-1"))).toMatchObject({ file: { kind: "file", mime: "image/svg+xml", via: "screenshot", partial: true } });
  });

  it("别的轮次的、没取过的编号都拒；一起交出的一批看最后一条；同一个文件这一轮重新取了就认", () => {
    const memos = setup();
    memos.fetched(turn("m-1"), "ref-00000001", FILE);
    expect(memos.toRemember("ref-00000001", turn("m-2"))).toHaveProperty("refused");
    expect(memos.toRemember("ref-00000002", turn("m-1"))).toHaveProperty("refused");
    expect(memos.toRemember("ref-00000001", { inputMessageId: "m-0", moreInputMessageIds: ["m-1"] })).toHaveProperty("file");
    expect(memos.toRemember("ref-00000001", { inputMessageId: "m-1", moreInputMessageIds: ["m-3"] })).toHaveProperty("refused");
    memos.fetched(turn("m-2"), "ref-00000001", FILE);
    expect(memos.toRemember("ref-00000001", turn("m-2"))).toHaveProperty("file");
    expect(memos.toRemember("ref-00000001", turn("m-1"))).toHaveProperty("refused");
  });

  it("超了附件的上限：不带文件，照实说；来源照带", () => {
    const memos = setup({ max: 50 });
    memos.fetched(turn("m-1"), "ref-00000001", FILE);
    const out = memos.toRemember("ref-00000001", turn("m-1"));
    expect(out).not.toHaveProperty("file");
    expect(out).toMatchObject({ origin: { address: IMAGE.src } });
    expect("note" in out ? out.note : "").toContain("超过了附件的上限");
  });

  it("文件不在媒体库里了：不带文件，照实说", () => {
    const memos = setup({ info: undefined });
    memos.fetched(turn("m-1"), "ref-00000001", FILE);
    const out = memos.toRemember("ref-00000001", turn("m-1"));
    expect(out).not.toHaveProperty("file");
    expect("note" in out ? out.note : "").toContain("不在了");
  });
});

describe("来源", () => {
  it("只留 http、https 的：blob、data 的地址不要，图片没有地址时用外面的链接；网页不是 http 的不写", () => {
    const blob = setup({ element: { id: "x1", kind: "image", source: "blob", src: "blob:https://photos.example.cn/1", href: "https://photos.example.cn/cat" } });
    blob.fetched(turn("m-1"), "ref-00000001", FILE);
    expect(blob.toRemember("ref-00000001", turn("m-1"))).toMatchObject({ origin: { address: "https://photos.example.cn/cat" } });

    const nothing = setup({ element: { id: "x1", kind: "image", source: "canvas" }, url: "about:blank" });
    nothing.fetched(turn("m-1"), "ref-00000001", FILE);
    expect(nothing.toRemember("ref-00000001", turn("m-1"))).not.toHaveProperty("origin");
  });
});

describe("不带文件编号", () => {
  it("这一轮取过但没取到：说原因", () => {
    const memos = setup();
    memos.failed(turn("m-1"), "网页换了");
    const out = memos.toRemember(undefined, turn("m-1"));
    expect(out).toMatchObject({ origin: { address: IMAGE.src } });
    expect("note" in out ? out.note : "").toContain("网页换了");
  });

  it("没取过：说还没取、怎么带上；上一轮没取到的不算这一轮的", () => {
    const memos = setup();
    memos.failed(turn("m-1"), "网页换了");
    const out = memos.toRemember(undefined, turn("m-2"));
    expect("note" in out ? out.note : "").toContain("还没有取");
  });

  it("文字元素、不是圆钮那一轮：和平常一样，什么都不带", () => {
    const text = setup({ element: { id: "x1", kind: "text", text: { text: "一段话", total: 3 } } });
    expect(text.toRemember(undefined, turn("m-1"))).toEqual({});
    expect(setup().toRemember(undefined, turn("m-none"))).toEqual({});
    expect(setup().toRemember(undefined, {})).toEqual({});
  });
});
