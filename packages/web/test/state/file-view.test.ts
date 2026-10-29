// 160 号票：内置浏览器里点到 markdown 这类能渲染的文件，用二狗的渲染打开。哪些走内置渲染（看扩展名和响应的 Content-Type）、
// 文件名、编码、JSON 格式化、CSV 拆成表格、渲染层显示什么（类型、大小、截断和表格太长的提示、能不能"看原文"）。
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { charsetOf, EXTENSION_KIND, FILE_TABLE_MAX_ROWS, fileNameOf, fileRenderOf, type FileRenderKind, fileViewOf, MEDIA_TEXT_MAX_BYTES, parseDelimited, prettyJson } from "../../src/state/index.ts";

describe("只看扩展名（点链接时、直接打开的地址）", () => {
  test.each<[string, FileRenderKind | undefined]>([
    ["/apps/notes/README.md", "markdown"],
    ["https://example.com/docs/guide.markdown", "markdown"],
    ["/apps/notes/README.MD", "markdown"],
    ["/apps/notes/%E6%97%A5%E6%8A%A5.md", "markdown"],
    ["/apps/notes/README.md?raw=1#top", "markdown"],
    ["/apps/notes/notes.txt", "plain"],
    ["/apps/notes/run.log", "plain"],
    ["/apps/notes/config.json", "json"],
    ["/apps/notes/data.csv", "csv"],
    ["/apps/notes/data.tsv", "tsv"],
    ["/apps/notes/main.py", "code"],
    ["/apps/notes/app.ts", "code"],
    ["/apps/notes/Index.ets", "code"],
    ["/apps/notes/config.yaml", "code"],
    ["/apps/notes/events.jsonl", "code"],
    // 网页、会跑脚本的照旧当网页开
    ["/apps/notes/index.html", undefined],
    ["/apps/notes/page.htm", undefined],
    ["/apps/notes/logo.svg", undefined],
    ["/apps/notes/feed.xml", undefined],
    // 浏览器自己会显示、或者只能下载的
    ["/apps/notes/photo.png", undefined],
    ["/apps/notes/report.pdf", undefined],
    ["/apps/notes/source.zip", undefined],
    // 没有扩展名、目录
    ["/apps/notes/", undefined],
    ["/apps/notes/docs", undefined],
    ["/apps/notes/v1.2/readme", undefined],
    ["https://example.com", undefined],
  ])("%s → %s", (url, kind) => {
    expect(fileRenderOf({ url })).toBe(kind);
  });
});

describe("看响应的 Content-Type（服务端回 text/markdown、text/plain 等的也算）", () => {
  test.each<[string, string, FileRenderKind | undefined]>([
    // 没有扩展名的地址，按类型认
    ["/apps/notes/raw?id=3", "text/markdown; charset=utf-8", "markdown"],
    ["/apps/notes/raw?id=3", "text/x-markdown", "markdown"],
    ["/apps/notes/raw?id=3", "text/plain", "plain"],
    ["/apps/notes/api/status", "application/json", "json"],
    ["/apps/notes/api/status", "application/problem+json", "json"],
    ["/apps/notes/api/events", "application/x-ndjson", "code"],
    ["/apps/notes/export", "text/csv", "csv"],
    ["/apps/notes/export", "text/tab-separated-values", "tsv"],
    ["/apps/notes/style", "text/css", "code"],
    ["/apps/notes/script", "application/javascript", "code"],
    ["/apps/notes/x", "text/x-python", "code"],
    ["/apps/notes/subtitles", "text/vtt", "plain"],
    // text/plain 发的按扩展名细分（GitHub raw 这类）
    ["https://raw.example.com/u/r/main/README.md", "text/plain; charset=utf-8", "markdown"],
    ["https://raw.example.com/u/r/main/package.json", "text/plain", "json"],
    ["https://raw.example.com/u/r/main/data.csv", "text/plain", "csv"],
    ["https://raw.example.com/u/r/main/main.py", "text/plain", "code"],
    // 一律当下载发的（nginx 默认、对象存储），按扩展名
    ["/files/README.md", "application/octet-stream", "markdown"],
    ["/files/notes.txt", "binary/octet-stream", "plain"],
    ["/files/data.csv", "", "csv"],
    ["/files/source.zip", "application/octet-stream", undefined],
    ["/files/blob", "application/octet-stream", undefined],
    // 网页照旧当网页开：扩展名是 .md 的网页（GitHub 的 blob 页）也是
    ["https://github.com/u/r/blob/main/README.md", "text/html; charset=utf-8", undefined],
    ["/apps/notes/page", "application/xhtml+xml", undefined],
    ["/apps/notes/feed", "application/rss+xml", undefined],
    ["/apps/notes/data.xml", "text/xml", undefined],
    ["/apps/notes/logo", "image/svg+xml", undefined],
    // 流式的、明确不是文本的
    ["/apps/notes/stream", "text/event-stream", undefined],
    ["/apps/notes/README.md", "image/png", undefined],
    ["/apps/notes/clip.ts", "video/mp2t", undefined],
    ["/apps/notes/report.pdf", "application/pdf", undefined],
  ])("%s（%s）→ %s", (url, mime, kind) => {
    expect(fileRenderOf({ url, mime })).toBe(kind);
  });

  test("下载时给的文件名比地址准：有扩展名先看它", () => {
    expect(fileRenderOf({ url: "/download?id=3", mime: "application/octet-stream", name: "10 月 7 日日报.md" })).toBe("markdown");
    expect(fileRenderOf({ url: "/files/a.md", mime: "application/octet-stream", name: "a.zip" })).toBeUndefined();
    // 文件名没有扩展名就看地址
    expect(fileRenderOf({ url: "/files/notes.txt", mime: "application/octet-stream", name: "notes" })).toBe("plain");
  });
});

describe("文件名", () => {
  test.each<[string, string]>([
    ["https://example.com/docs/README.md?raw=1#x", "README.md"],
    ["/apps/notes/%E6%97%A5%E6%8A%A5.md", "日报.md"],
    ["/apps/notes/docs/", "docs"],
    ["/apps/notes/100%.txt", "100%.txt"],
    ["https://example.com", "example.com"],
  ])("%s → %s", (url, name) => {
    expect(fileNameOf(url)).toBe(name);
  });
});

test("Content-Type 里的字符集", () => {
  expect(charsetOf("text/plain; charset=GBK")).toBe("gbk");
  expect(charsetOf('text/markdown;charset="utf-8"')).toBe("utf-8");
  expect(charsetOf("text/plain")).toBeUndefined();
  expect(charsetOf("")).toBeUndefined();
});

test("JSON 格式化：认得的缩进两格，认不得的是 undefined", () => {
  expect(prettyJson('{"a":1,"b":[true,null]}')).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
  expect(prettyJson('{"a":1')).toBeUndefined();
  expect(prettyJson("")).toBeUndefined();
});

describe("CSV、TSV 拆成表格", () => {
  test("引号里的逗号、换行、两个引号；CRLF；末尾的换行不多出空行", () => {
    const text = 'name,note\r\n"张三","买了 ""书""，还有笔"\r\n李四,"两行\n的备注"\r\n';
    expect(parseDelimited(text, ",")).toEqual({
      rows: [
        ["name", "note"],
        ["张三", '买了 "书"，还有笔'],
        ["李四", "两行\n的备注"],
      ],
      total: 3,
    });
  });

  test("TSV 按制表符拆", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("太长的只拆前 maxRows 行，total 是一共多少行", () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i},x`).join("\n");
    const parsed = parseDelimited(text, ",", 10);
    expect(parsed.rows).toHaveLength(10);
    expect(parsed.total).toBe(30);
  });
});

/** 取到的文本 */
const text = (body: string, extra: Partial<{ bytes: number; truncated: boolean }> = {}) => ({ status: "text" as const, mime: "text/plain", text: body, bytes: extra.bytes ?? body.length, truncated: extra.truncated ?? false });

describe("渲染层显示什么", () => {

  test("Markdown：按 Markdown 画，能看原文；上面写文件名、类型、大小", () => {
    const view = fileViewOf("markdown", "README.md", text("# 标题", { bytes: 2048 }));
    expect(view.body).toEqual({ kind: "markdown", text: "# 标题" });
    expect(view.canRaw).toBe(true);
    expect(view.raw).toBe("# 标题");
    expect(view.facts).toBe("README.md · Markdown · 2.0 KB");
    expect(view.notice).toBeUndefined();
  });

  test("纯文本、代码：原文就是渲染的样子，不给\"看原文\"", () => {
    expect(fileViewOf("plain", "a.txt", text("hi"))).toMatchObject({ body: { kind: "plain", text: "hi" }, canRaw: false });
    expect(fileViewOf("code", "a.py", text("print(1)"))).toMatchObject({ body: { kind: "code", text: "print(1)" }, canRaw: false });
  });

  test("JSON：格式化着看，能看原文；认不出来（比如截断了）按原文显示并说明", () => {
    expect(fileViewOf("json", "a.json", text('{"a":1}'))).toMatchObject({ body: { kind: "code", text: '{\n  "a": 1\n}' }, canRaw: true });
    const broken = fileViewOf("json", "a.json", text('{"a":'));
    expect(broken).toMatchObject({ body: { kind: "code", text: '{"a":' }, canRaw: false });
    expect(broken.notice).toContain("按原文显示");
  });

  test("CSV：第一行当表头；太长的只画前 FILE_TABLE_MAX_ROWS 行并说明", () => {
    expect(fileViewOf("csv", "a.csv", text("名字,数量\n苹果,3"))).toMatchObject({ body: { kind: "table", head: ["名字", "数量"], rows: [["苹果", "3"]] }, canRaw: true });
    const long = Array.from({ length: FILE_TABLE_MAX_ROWS + 20 }, (_, i) => `${i},x`).join("\n");
    const view = fileViewOf("csv", "a.csv", text(long));
    expect(view.body.kind === "table" && view.body.rows.length).toBe(FILE_TABLE_MAX_ROWS - 1);
    expect(view.notice).toContain(`${FILE_TABLE_MAX_ROWS + 20} 行`);
  });

  test("TSV 按制表符拆；空的 CSV 按纯文本", () => {
    expect(fileViewOf("tsv", "a.tsv", text("a\tb\n1\t2")).body).toEqual({ kind: "table", head: ["a", "b"], rows: [["1", "2"]] });
    expect(fileViewOf("csv", "a.csv", text("")).body).toEqual({ kind: "plain", text: "" });
  });

  test("截断了：顶上说只显示前 1 MB；大小不知道时写超过 1 MB", () => {
    expect(fileViewOf("plain", "big.log", text("x", { bytes: 3 * 1_048_576, truncated: true })).notice).toBe("文件有 3.0 MB，这里只显示前 1.0 MB；完整的点「下载」");
    const unknown = fileViewOf("plain", "big.log", { status: "text", mime: "text/plain", text: "x", bytes: undefined, truncated: true });
    expect(unknown.facts).toBe(`big.log · 纯文本 · 超过 ${MEDIA_TEXT_MAX_BYTES / 1_048_576}.0 MB`);
    expect(unknown.notice).toBe("文件超过 1.0 MB，这里只显示前 1.0 MB；完整的点「下载」");
  });
});

test("鸿蒙 App 拦下载时粗筛用的扩展名清单（FileDocs.ets 的 RENDER_EXTENSIONS）和这里的一致", () => {
  const source = fs.readFileSync(new URL("../../../../frontend/harmony/entry/src/main/ets/browser/FileDocs.ets", import.meta.url), "utf8");
  const list = /RENDER_EXTENSIONS: string\[\] = \(([^)]*)\)\.split/s.exec(source)?.[1];
  expect(list).toBeDefined();
  const native = [...list!.matchAll(/'([^']*)'/g)].map((m) => m[1]).join("").trim().split(/\s+/);
  expect(native.toSorted()).toEqual(Object.keys(EXTENSION_KIND).toSorted());
});
