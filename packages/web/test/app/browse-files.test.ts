// 160 号票：鸿蒙 App "浏览"页签的原生浏览器里，能渲染的文件用二狗的渲染打开（app/browse-files.ts）。
// App 报来的文件（加载完的一页、拦下的下载）按扩展名和类型定渲不渲染；浏览器换了页渲染层收起；取内容、下载、系统浏览器打开都交给 App；
// 返回手势：页面上的文件浏览器能后退就后退，拦下的下载收起渲染层。App 是假的。
import { describe, expect, test } from "vitest";
import { BrowseFiles } from "../../src/plugins/browsing/browse-files.ts";
import { BLANK_BROWSER, type BrowserDoc, type BrowserState, type NativeDocControl } from "../../src/app/native-browser.ts";

function fakeDocs(reply = "") {
  const calls: string[] = [];
  const docs: NativeDocControl & { reply: string } = {
    reply,
    enable: () => void calls.push("enable"),
    source(id) {
      calls.push(`source ${id}`);
      return Promise.resolve(this.reply);
    },
    save: (id) => void calls.push(`save ${id}`),
    outside: (id) => void calls.push(`outside ${id}`),
    drop: (id) => void calls.push(`drop ${id}`),
  };
  return { docs, calls };
}

function setup(reply = "") {
  const { docs, calls } = fakeDocs(reply);
  const nav: string[] = [];
  const files = new BrowseFiles({ docs, back: () => void nav.push("back") });
  let changes = 0;
  files.subscribe(() => void (changes += 1));
  const state = (over: Partial<BrowserState>) => files.handle({ type: "state", state: { ...BLANK_BROWSER, ...over } });
  const doc = (d: Partial<BrowserDoc> & Pick<BrowserDoc, "id" | "url">) => files.handle({ type: "document", doc: { mime: "", name: "", via: "page", ...d } });
  return { files, calls, nav, state, doc, changes: () => changes };
}

describe("哪些用二狗的渲染打开", () => {
  test("加载完的一页是能渲染的文件（GitHub raw 的 README.md 是 text/plain）：渲染层出来；网页不渲染", () => {
    const s = setup();
    s.state({ url: "https://raw.example.com/u/r/main/README.md" });
    s.doc({ id: "p1", url: "https://raw.example.com/u/r/main/README.md", mime: "text/plain" });
    expect(s.files.snapshot()).toEqual({ id: "p1", url: "https://raw.example.com/u/r/main/README.md", name: "README.md", mime: "text/plain", via: "page", kind: "markdown", seq: 1 });
    expect(s.changes()).toBe(1);
    s.state({ url: "https://github.com/u/r/blob/main/README.md" });
    s.doc({ id: "p2", url: "https://github.com/u/r/blob/main/README.md", mime: "text/html" });
    expect(s.files.snapshot()).toBeUndefined();
  });

  test("没有扩展名的地址按类型：text/markdown、application/json 的也算", () => {
    const s = setup();
    s.doc({ id: "p1", url: "https://api.example.com/status", mime: "application/json" });
    expect(s.files.snapshot()?.kind).toBe("json");
  });

  test("拦下的下载：服务端给的文件名准；能渲染的出渲染层，不能渲染的照常保存（交回 App）", () => {
    const s = setup();
    s.state({ url: "https://files.example.com/list" });
    s.doc({ id: "d1", url: "https://files.example.com/get?id=7", mime: "application/octet-stream", name: "10 月 7 日日报.md", via: "download", bytes: 2048 });
    expect(s.files.snapshot()).toMatchObject({ id: "d1", name: "10 月 7 日日报.md", via: "download", kind: "markdown" });
    s.doc({ id: "d2", url: "https://files.example.com/get?id=8", mime: "application/octet-stream", name: "source.zip", via: "download" });
    expect(s.calls).toEqual(["save d2"]);
    // 不能渲染的下载不动正在看的
    expect(s.files.snapshot()?.id).toBe("d1");
  });
});

describe("什么时候收起", () => {
  test("页面上的文件：浏览器换了页（地址变了，只差 # 的不算）就收起", () => {
    const s = setup();
    s.state({ url: "https://raw.example.com/a.md" });
    s.doc({ id: "p1", url: "https://raw.example.com/a.md", mime: "text/plain" });
    s.state({ url: "https://raw.example.com/a.md#install", loading: false });
    expect(s.files.snapshot()?.id).toBe("p1");
    s.state({ url: "https://raw.example.com/", loading: true });
    expect(s.files.snapshot()).toBeUndefined();
  });

  test("拦下的下载：浏览器换了页收起，App 缓存里那份放掉；另一个能渲染的下载、能渲染的页面来了换成它，也放掉上一个", () => {
    const s = setup();
    s.state({ url: "https://files.example.com/list" });
    s.doc({ id: "d1", url: "https://files.example.com/a.md", mime: "application/octet-stream", via: "download" });
    s.doc({ id: "d2", url: "https://files.example.com/b.txt", mime: "application/octet-stream", via: "download" });
    expect(s.files.snapshot()?.id).toBe("d2");
    expect(s.calls).toEqual(["drop d1"]);
    s.state({ url: "https://files.example.com/list", progress: 50 });
    expect(s.files.snapshot()?.id).toBe("d2");
    s.state({ url: "https://files.example.com/other" });
    expect(s.files.snapshot()).toBeUndefined();
    expect(s.calls).toEqual(["drop d1", "drop d2"]);
    s.state({ url: "https://files.example.com/list" });
    s.doc({ id: "d3", url: "https://files.example.com/c.md", mime: "application/octet-stream", via: "download" });
    s.doc({ id: "p4", url: "https://files.example.com/d.md", mime: "text/markdown" });
    expect(s.files.snapshot()?.id).toBe("p4");
    expect(s.calls).toEqual(["drop d1", "drop d2", "drop d3"]);
  });

  test("关闭：页面上的收起（露出原生网页显示的原文）；拦下的收起并放掉", () => {
    const s = setup();
    s.doc({ id: "p1", url: "https://a.example/a.md", mime: "text/plain" });
    s.files.close();
    expect(s.files.snapshot()).toBeUndefined();
    s.doc({ id: "d2", url: "https://a.example/b.md", via: "download" });
    s.files.close();
    expect(s.files.snapshot()).toBeUndefined();
    expect(s.calls).toEqual(["drop d2"]);
  });

  test("返回手势：页面上的文件浏览器能后退就后退（换了页渲染层自己收）、不能就收起；拦下的下载收起", () => {
    const s = setup();
    s.state({ url: "https://a.example/a.md", canGoBack: true });
    s.doc({ id: "p1", url: "https://a.example/a.md", mime: "text/plain" });
    s.files.back();
    expect(s.nav).toEqual(["back"]);
    expect(s.files.snapshot()?.id).toBe("p1");
    s.state({ url: "https://a.example/a.md", canGoBack: false });
    s.files.back();
    expect(s.files.snapshot()).toBeUndefined();
    s.state({ url: "https://a.example/list", canGoBack: true });
    s.doc({ id: "d2", url: "https://a.example/b.md", via: "download" });
    s.files.back();
    expect(s.files.snapshot()).toBeUndefined();
    expect(s.nav).toEqual(["back"]);
  });
});

describe("取内容、刷新、下载、系统浏览器打开", () => {
  test("取内容经 App（source），换成和网页一样的结果；类型用 App 报的", async () => {
    const s = setup(JSON.stringify({ ok: true, kind: "text", text: "# 标题", total: 4, truncated: false }));
    s.doc({ id: "p1", url: "https://a.example/a.md", mime: "text/plain; charset=utf-8" });
    expect(await s.files.load(s.files.snapshot()!)).toEqual({ status: "text", mime: "text/plain", text: "# 标题", bytes: 8, truncated: false });
    expect(s.calls).toEqual(["source p1"]);
  });

  test("刷新：再取一次（seq 加一）；下载、系统浏览器打开交给 App", () => {
    const s = setup();
    s.doc({ id: "d1", url: "https://a.example/a.md", via: "download" });
    s.files.reload();
    expect(s.files.snapshot()?.seq).toBe(2);
    s.files.save();
    s.files.outside();
    expect(s.calls).toEqual(["save d1", "outside d1"]);
  });
});
