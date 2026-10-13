// 113 号票：聊天里的文件附件画成卡片——类型图标（方块里写类型，按类别上色）、标题、"预览""下载"；一条消息里连着的几个附件排成一横排。
// 能预览的（Markdown、纯文本）点图标去报告页，不能预览的点图标直接下载并标明"仅下载"；按 part 上的类型判断，历史消息里的附件也一样。
// 117 号票：HTML、SVG（1 MB 以内）也能预览，在报告页的沙箱框（HTML）、<img>（SVG）里看。
// 报告页显示什么：取到的内容（按 Markdown 还是纯文本画，HTML、SVG 在框里看）、截断的提示、取不到时说什么。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  attachmentCategory,
  attachmentTypeLabel,
  conversationView,
  fileCards,
  type FilePartValue,
  markdownChunks,
  MEDIA_FRAME_MAX_BYTES,
  MEDIA_TEXT_MAX_BYTES,
  type MediaTextView,
  type MessagePart,
  partRuns,
  replay,
  reportPageView,
  type UiInput,
} from "../../src/state/index.ts";
import { msg as messageOf } from "./events.ts";

const file = (name: string, mime: string, size = 1024, mediaId = `m-${name}`): FilePartValue => ({ type: "file", mediaId, name, mime, size });

describe("类型图标上写的类型", () => {
  test.each<[string, string]>([
    ["10 月 13 日日报.md", "MD"],
    ["说明.markdown", "MD"],
    ["季度汇报.pptx", "PPT"],
    ["合同.docx", "DOC"],
    ["预算.xlsx", "XLS"],
    ["发票.pdf", "PDF"],
    ["流水.csv", "CSV"],
    ["配置.json", "JSON"],
    ["周会录像.mp4", "MP4"],
    ["录音.mp3", "MP3"],
    ["截图.png", "PNG"],
    ["照片.jpg", "JPG"],
    ["照片.JPEG", "JPG"],
    ["资料.zip", "ZIP"],
    ["Makefile", "FILE"],
    ["奇怪的.名字", "FILE"],
    ["太长的扩展名.properties", "FILE"],
  ])("%s → %s", (name, label) => {
    expect(attachmentTypeLabel(name)).toBe(label);
  });
});

describe("按类别上色：文档、表格、图片、音视频、其它", () => {
  test.each<[string, string, string]>([
    ["日报.md", "text/markdown", "doc"],
    ["说明.txt", "text/plain", "doc"],
    ["发票.pdf", "application/pdf", "doc"],
    ["汇报.pptx", "application/octet-stream", "doc"],
    ["流水.csv", "text/csv", "sheet"],
    ["预算.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet"],
    ["原图.heic", "image/heic", "image"],
    ["图标.svg", "image/svg+xml", "image"],
    ["周会录像.mp4", "video/mp4", "media"],
    ["录音", "audio/webm", "media"],
    ["资料.zip", "application/zip", "other"],
    ["活动页.html", "text/html", "other"],
    ["配置.json", "application/json", "other"],
  ])("%s（%s）→ %s", (name, mime, category) => {
    expect(attachmentCategory(name, mime)).toBe(category);
  });
});

describe("附件卡片", () => {
  test("单个 Markdown 附件：类型 MD、标题用原名、能预览，点图标去报告页", () => {
    const [card] = fileCards([file("10 月 13 日日报.md", "text/markdown", 12_800)]);
    expect(card).toMatchObject({ label: "MD", category: "doc", title: "10 月 13 日日报.md", seq: undefined, preview: "text/markdown", iconAction: "preview" });
    expect(card!.iconHint).toContain("预览");
    expect(card!.tooltip).toBe("10 月 13 日日报.md（text/markdown，12.5 KB）");
  });

  test("纯文本也能预览（按纯文本画）", () => {
    expect(fileCards([file("备份.log", "text/plain")])[0]).toMatchObject({ label: "LOG", preview: "text/plain", iconAction: "preview" });
  });

  test("不能预览的（zip、pptx、csv……）只能下载：点图标就是下载，图标上标明仅下载", () => {
    for (const part of [file("资料.zip", "application/zip"), file("季度汇报.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), file("流水.csv", "text/csv")]) {
      const [card] = fileCards([part]);
      expect({ name: part.name, preview: card!.preview, iconAction: card!.iconAction }).toEqual({ name: part.name, preview: undefined, iconAction: "download" });
      expect(card!.iconHint).toContain("仅下载");
    }
  });

  test("HTML、SVG 能预览（117 号票，在沙箱里看）：图标照旧写 HTML、SVG，点图标是预览；按扩展名认，类型写成纯文本也一样", () => {
    for (const [part, label, preview] of [
      [file("AI 日报.html", "text/html"), "HTML", "html"],
      [file("活动页.htm", "text/plain"), "HTML", "html"],
      [file("走势图.svg", "image/svg+xml"), "SVG", "svg"],
      [file("图标.svg", "text/plain"), "SVG", "svg"],
    ] as const) {
      const [card] = fileCards([part]);
      expect({ name: part.name, label: card!.label, preview: card!.preview, iconAction: card!.iconAction }).toEqual({ name: part.name, label, preview, iconAction: "preview" });
      expect(card!.iconHint).toContain("预览");
    }
  });

  test("超过 1 MB 的 HTML、SVG 不预览（只能下载），图标上写明为什么；刚好 1 MB 的照常预览；xhtml、svgz 照旧只能下载", () => {
    const [big] = fileCards([file("全年报表.html", "text/html", MEDIA_FRAME_MAX_BYTES + 1)]);
    expect(big).toMatchObject({ preview: undefined, iconAction: "download" });
    expect(big!.iconHint).toBe("仅下载：HTML 文件超过 1.0 MB，不在这里预览，点了直接下载");
    expect(fileCards([file("刚好.svg", "image/svg+xml", MEDIA_FRAME_MAX_BYTES)])[0]).toMatchObject({ preview: "svg", iconAction: "preview" });
    // 1 MB 以上的 Markdown 照旧能预览（报告页截断显示）
    expect(fileCards([file("全年流水.md", "text/markdown", MEDIA_FRAME_MAX_BYTES * 3)])[0]).toMatchObject({ preview: "text/markdown" });
    for (const part of [file("页面.xhtml", "application/xhtml+xml"), file("图标.svgz", "image/svg+xml")]) {
      expect(fileCards([part])[0]).toMatchObject({ preview: undefined, iconAction: "download" });
    }
  });

  test("太长的名字从中间省略：留住开头、结尾和扩展名，悬停看全名", () => {
    const name = "二〇二六年十月家庭账本与训练记录以及西安行程的周度汇总报告（终版）.md";
    const [card] = fileCards([file(name, "text/markdown")]);
    expect(card!.title).not.toBe(name);
    expect(card!.title).toMatch(/^二〇二六年.*….*（终版）\.md$/);
    expect(card!.title.length).toBeLessThan(name.length);
    expect(card!.tooltip).toContain(name);
  });

  test("一次发了多个同类文件（三段视频）：按序号显示 01-3、02-3、03-3；不同类的各自不编号", () => {
    const cards = fileCards([
      file("周会录像-第1段.mp4", "video/mp4"),
      file("周会录像-第2段.mp4", "video/mp4"),
      file("周会录像-第3段.mp4", "video/mp4"),
      file("纪要.md", "text/markdown"),
    ]);
    expect(cards.map((c) => [c.label, c.seq])).toEqual([
      ["MP4", "01-3"],
      ["MP4", "02-3"],
      ["MP4", "03-3"],
      ["MD", undefined],
    ]);
    // 名字照旧在卡片上
    expect(cards[1]!.title).toBe("周会录像-第2段.mp4");
  });
});

describe("一条消息里连着的附件排成一排", () => {
  test("连着的文件附件合成一组（一组画成一横排，装不下换行）；图片、文字、语音照旧各是各的", () => {
    const parts: MessagePart[] = [
      { type: "image", mediaId: "img", name: "截图.png", mime: "image/png" },
      file("a.mp4", "video/mp4"),
      file("b.mp4", "video/mp4"),
      file("c.mp4", "video/mp4"),
      { type: "text", text: "三段录像" },
      file("纪要.md", "text/markdown"),
    ];
    expect(partRuns(parts).map((r) => (r.kind === "files" ? `files@${r.index}:${r.files.map((f) => f.name).join(",")}` : `${r.part.type}@${r.index}`))).toEqual([
      "image@0",
      "files@1:a.mp4,b.mp4,c.mp4",
      "text@4",
      "files@5:纪要.md",
    ]);
  });
});

describe("历史消息里的附件也有预览入口", () => {
  test("回放主切面录下的附件消息（113 号票之前的数据，part 上只有媒体 id、名字、类型、大小）：清单.md 照样能预览", () => {
    const inputs = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", "secretary-attachments.json"), "utf8")) as UiInput[];
    const files = conversationView(replay(inputs), "secretary")
      .flatMap((it) => messageOf(it).parts)
      .filter((p): p is FilePartValue => p.type === "file");
    expect(files.map((f) => f.name)).toContain("清单.md");
    const card = fileCards(files.filter((f) => f.name === "清单.md"))[0]!;
    expect(card).toMatchObject({ label: "MD", preview: "text/markdown", iconAction: "preview" });
  });
});

/** 守护进程回的文本类附件的内容 */
const view = (overrides: Partial<MediaTextView> = {}): MediaTextView => ({
  mediaId: "a".repeat(64),
  name: "10 月 13 日日报.md",
  mime: "text/markdown",
  text: "# 10 月 13 日日报",
  bytes: 12_800,
  truncated: false,
  sentAt: "2026-10-13T21:30:05.000+08:00",
  ...overrides,
});

describe("报告页", () => {
  test("还没取到：加载中", () => {
    expect(reportPageView(undefined)).toEqual({ kind: "loading" });
  });

  test("Markdown 按 Markdown 画：标题是文件名，下面写类型、大小、什么时候发的；没截断没有提示条", () => {
    expect(reportPageView({ ok: true, view: view() })).toEqual({
      kind: "ready",
      name: "10 月 13 日日报.md",
      facts: "Markdown · 12.5 KB · 10-13 21:30 发出",
      render: "markdown",
      text: "# 10 月 13 日日报",
      notice: undefined,
    });
  });

  test("纯文本按原文画（不当 Markdown 解析）", () => {
    expect(reportPageView({ ok: true, view: view({ name: "备份.log", mime: "text/plain", sentAt: undefined, bytes: 300 }) })).toMatchObject({ render: "plain", facts: "纯文本 · 300 B" });
  });

  test("截断了：顶上一条提示，只显示前 1 MB、完整版点下载", () => {
    const page = reportPageView({ ok: true, view: view({ bytes: 3_355_443, truncated: true }) });
    expect(MEDIA_TEXT_MAX_BYTES).toBe(1024 * 1024);
    expect(page).toMatchObject({ kind: "ready", notice: "文件有 3.2 MB，这里只显示前 1.0 MB，完整版点「下载」" });
  });

  test("HTML：在沙箱框里看（frame），写明类型、大小、什么时候发的，顶上一条说明沙箱拦着什么", () => {
    expect(reportPageView({ ok: true, view: view({ name: "AI 日报.html", mime: "text/html", text: "", bytes: 18_432, frame: "html" }) })).toEqual({
      kind: "frame",
      name: "AI 日报.html",
      facts: "HTML 页面 · 18.0 KB · 10-13 21:30 发出",
      frame: "html",
      notice: "在隔离的沙箱里打开：页面照常运行、能从外网取数据，但拿不到二狗的数据、连不上二狗；页面里的链接在新窗口打开",
    });
  });

  test("SVG：按图片显示（<img> 里的脚本不跑），没有提示条", () => {
    expect(reportPageView({ ok: true, view: view({ name: "走势图.svg", mime: "image/svg+xml", text: "", bytes: 2_048, sentAt: undefined, frame: "svg" }) })).toEqual({
      kind: "frame",
      name: "走势图.svg",
      facts: "SVG 图 · 2.0 KB",
      frame: "svg",
      notice: undefined,
    });
  });

  test.each<[string, string]>([
    ["not_found", "这个文件不在了"],
    ["unsupported_type", "这种文件不能预览"],
    ["too_large", "文件太大，不在这里预览"],
    ["undecodable", "预览不了这个文件"],
    ["network", "取文件内容失败"],
    ["internal", "取文件内容失败"],
  ])("取不到（%s）：说清楚，不白屏", (code, title) => {
    const page = reportPageView({ ok: false, code: code as "not_found", message: "守护进程说的原因" });
    expect(page).toMatchObject({ kind: "error", title, note: "守护进程说的原因" });
    expect(page.kind === "error" && page.detail.length).toBeGreaterThan(0);
  });
});


describe("大报告分段画（超过 1 MB 的不一次解析、画完，页面不卡）", () => {
  const NL = "\n";
  const lines = (...xs: string[]) => xs.join(NL);

  test("不长的不切", () => {
    const text = lines("# 日报", "", "- 一", "- 二", "");
    expect(markdownChunks(text, 100)).toEqual([text]);
  });

  test("够长了在下一个空行处切开：拼回去和原文一字不差，每段都不比上限多出一个块", () => {
    const text = Array.from({ length: 50 }, (_, k) => lines(`## 第 ${k} 节`, "", `内容第 ${k} 段，写得长一点。`, "")).join(NL);
    const chunks = markdownChunks(text, 200);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeLessThan(200 + 40);
      expect(chunk.endsWith(NL + NL)).toBe(true);
    }
  });

  test("代码块里的空行不切；缩进的续行（列表项的第二段）前面也不切；表格整个在一段里", () => {
    const code = lines("```", "a", "", "b", "", "c", "```");
    const list = lines("- 第一项", "", "  第一项的第二段", "", "- 第二项");
    const table = lines("| 甲 | 乙 |", "|---|---|", "| 1 | 2 |");
    const text = [code, list, table, "结尾"].join(NL + NL);
    const chunks = markdownChunks(text, 1);
    expect(chunks.join("")).toBe(text);
    expect(chunks).toContain(code + NL + NL);
    expect(chunks.some((c) => c.startsWith("  第一项的第二段"))).toBe(false);
    expect(chunks).toContain(table + NL + NL);
  });
});
