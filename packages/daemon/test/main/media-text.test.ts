// 主切面：文本类附件的内容（报告页用）：GET /api/media/<媒体 id>/text 回 JSON，不让浏览器直接渲染文件。
// 真的守护进程（临时数据目录）：附件经 HTTP 上传入库，再像 agent 发附件那样作为一条消息追加进秘书会话（名字、类型以消息里
// 最近一次引用它的文件 part 为准）；测试扮演前端取内容。Markdown、纯文本、CSV、JSON、代码都给文字，不是 UTF-8 的按 GB18030 解；
// 音频、视频只说用哪种播放器，媒体接口只对按内容认出的音视频内联（part 的扩展名定音频还是视频），声明成音视频、内容不是的照旧当附件下载。
// PDF 只说交给 pdf.js（pdf: true，不给内容），报告页从媒体接口取字节：媒体接口对 PDF 照旧当附件下载，响应头一点不变。
import fs from "node:fs";
import path from "node:path";
import { attachmentPartFrom, CHANNELS, HTTP_PATHS, type HttpErrorBody, MEDIA_TEXT_MAX_BYTES, type MediaTextView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { appendMessage } from "../../src/conversation/messages.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { media } from "../helpers/http.ts";
import { png } from "../helpers/images.ts";
import { pdf } from "../helpers/pdf.ts";

/** 开头像某种音视频容器的几个字节（后面补些不相干的，媒体接口只按开头认） */
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(64, 7)]);
const EBML_HEAD = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]), Buffer.alloc(64, 9)]);

const SECRETARY = CHANNELS.secretary;

/** 按 GB18030（GBK 的超集）编码：Node 的 TextEncoder 只会 UTF-8，这里用 TextDecoder 反查单字（测试里的字都在 GBK 里） */
function gb18030(text: string): Buffer {
  return Buffer.concat([...text].map((ch) => (ch.charCodeAt(0) < 0x80 ? Buffer.from(ch, "latin1") : gbkOf(ch))));
}
const GBK_TABLE = new Map<string, Buffer>();
function gbkOf(ch: string): Buffer {
  if (GBK_TABLE.size === 0) {
    const decoder = new TextDecoder("gb18030");
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail === 0x7f) continue;
        const bytes = Buffer.from([lead, trail]);
        const got = decoder.decode(bytes);
        if (!GBK_TABLE.has(got)) GBK_TABLE.set(got, bytes);
      }
    }
  }
  const bytes = GBK_TABLE.get(ch);
  if (!bytes) throw new Error(`测试用的字不在 GBK 里：${ch}`);
  return bytes;
}

/** 日报：标题、列表、表格、外链 */
const DAILY = [
  "# 10 月 13 日日报",
  "",
  "- 记账本：九月账单已核对",
  "- 训练记录：本周三次",
  "",
  "| 事项 | 进度 | 备注 |",
  "|---|---|---|",
  "| 家庭账本 | 完成 | 见[账本说明](https://example.com/ledger) |",
  "",
].join("\n");

/**
 * 上传一个文件，作为 agent 的一条消息发进秘书会话（和 send_attachment 一样）；part 上的类型是发消息时守护进程补好的那个
 * （按扩展名认，这里直接写明）。返回媒体 id
 */
async function sendFile(test: TestDaemon, content: string | Buffer, name: string, mime: string): Promise<string> {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const stored = await media.upload(test.url, bytes, { name, mime }, 1024 * 1024);
  appendMessage(test.daemon.store, { conversation: SECRETARY, speaker: "agent", parts: [attachmentPartFrom({ ...stored, mime })] });
  return stored.mediaId;
}

describe("文本类附件的内容接口", () => {
  it("Markdown 附件：回 JSON（名字、类型、全文、整个文件的字节数、没截断、发出的时间），带 nosniff、不缓存；纯文本也取得到", async () => {
    const test = await startTestDaemon();
    const id = await sendFile(test, DAILY, "10 月 13 日日报.md", "text/markdown");

    const res = await media.text(test.url, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mediaId: id, name: "10 月 13 日日报.md", mime: "text/markdown", text: DAILY, bytes: Buffer.byteLength(DAILY), truncated: false, sentAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");

    const log = "09:00 开始备份\n09:03 备份完成\n";
    const logId = await sendFile(test, log, "备份.log", "text/plain");
    expect((await media.text(test.url, logId)).body).toMatchObject({ name: "备份.log", mime: "text/plain", text: log, truncated: false });
  });

  it("同样的内容换个名字又发了一次：名字、类型以最近一次引用它的 part 为准", async () => {
    const test = await startTestDaemon();
    const id = await sendFile(test, DAILY, "日报-初稿.txt", "text/plain");
    expect(await sendFile(test, DAILY, "日报-终版.md", "text/markdown")).toBe(id);
    expect((await media.text(test.url, id)).body).toMatchObject({ name: "日报-终版.md", mime: "text/markdown" });
  });

  it("CSV、JSON、代码和配置文件也给文字（报告页画成表格、格式化、等宽），按扩展名认；part 上的类型照原样回", async () => {
    const test = await startTestDaemon();
    for (const [content, name, mime] of [
      ["日期,金额\n10-13,12.5\n", "流水.csv", "text/csv"],
      ['{"a":1}', "配置.json", "application/json"],
      ["print('hi')\n", "脚本.py", "text/x-python"],
      ["[main]\nport = 8\n", "设置.ini", "text/plain"],
    ] as const) {
      const id = await sendFile(test, content, name, mime);
      const res = await media.text(test.url, id);
      expect({ name, status: res.status, body: res.body }).toEqual({ name, status: 200, body: { mediaId: id, name, mime, text: content, bytes: Buffer.byteLength(content), truncated: false, sentAt: expect.any(String) } });
    }
  });

  it("不能预览的类型回 415 并说明原因：xhtml、zip、avi、图片（HTML、SVG 在沙箱里预览，见 media-frame.test.ts）", async () => {
    const test = await startTestDaemon();
    // 浏览器会当页面跑的 xhtml：就算 part 上写成纯文本也不预览
    const xhtml = await sendFile(test, '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>', "活动页.xhtml", "text/plain");
    const zip = await sendFile(test, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "资料.zip", "application/zip");
    const avi = await sendFile(test, Buffer.concat([Buffer.from("RIFF\0\0\0\0AVI ", "latin1"), Buffer.alloc(32)]), "老录像.avi", "video/x-msvideo");
    const image = await media.upload(test.url, png({ width: 4, height: 4 }), { name: "截图.png", mime: "image/png" });
    appendMessage(test.daemon.store, { conversation: SECRETARY, speaker: "user", parts: [attachmentPartFrom(image)] });

    for (const [id, name] of [
      [xhtml, "活动页.xhtml"],
      [zip, "资料.zip"],
      [avi, "老录像.avi"],
      [image.mediaId, "截图.png"],
    ] as const) {
      const res = await media.text(test.url, id);
      expect({ name, status: res.status, code: res.body.code }).toEqual({ name, status: 415, code: "unsupported_type" });
      expect(res.body.message).toContain(name);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("找不到回 404：不是媒体 id、没有这份媒体、在库里但没有消息引用它、消息还在但文件不在了", async () => {
    const test = await startTestDaemon();
    expect((await media.text(test.url, "not-a-media-id")).status).toBe(404);
    expect((await media.text(test.url, "0".repeat(64))).status).toBe(404);
    const unsent = await media.upload(test.url, Buffer.from("# 没发出去的"), { name: "草稿.md", mime: "text/markdown" });
    expect((await media.text(test.url, unsent.mediaId)).body).toMatchObject({ code: "not_found" });

    const id = await sendFile(test, DAILY, "10 月 13 日日报.md", "text/markdown");
    fs.rmSync(path.join(test.dataDir, "materials", "media", id));
    const gone = await media.text(test.url, id);
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ code: "not_found", message: expect.stringContaining("不在了") });
  });

  it("超过 1 MB：只给开头 1 MB，截在字符边上（不出半个字），truncated 为真，bytes 是整个文件的大小；刚好 1 MB 的不算截断", async () => {
    const test = await startTestDaemon();
    // 开头 21 个字节，后面全是三个字节的汉字：1 MB 的边落在一个字的中间
    const big = `# 全年账单流水\n${"账".repeat(500_000)}`;
    const id = await sendFile(test, big, "全年账单流水.md", "text/markdown");
    const res = await media.text(test.url, id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ truncated: true, bytes: Buffer.byteLength(big) });
    const shown = Buffer.byteLength(res.body.text);
    expect(shown).toBeLessThanOrEqual(MEDIA_TEXT_MAX_BYTES);
    expect(shown).toBeGreaterThan(MEDIA_TEXT_MAX_BYTES - 3);
    expect(res.body.text).not.toContain("�");
    expect(big.startsWith(res.body.text)).toBe(true);

    const exact = "a".repeat(MEDIA_TEXT_MAX_BYTES);
    const exactId = await sendFile(test, exact, "刚好.txt", "text/plain");
    expect((await media.text(test.url, exactId)).body).toMatchObject({ truncated: false, bytes: MEDIA_TEXT_MAX_BYTES, text: exact });
  });

  it("不是 UTF-8 的按 GBK（GB18030）解：Excel 导出的中文 CSV 正常显示，写明编码；UTF-8 的不写", async () => {
    const test = await startTestDaemon();
    const csv = "日期,摘要,金额\n2026-09-01,工资,8500.00\n2026-09-03,超市,-286.40\n";
    const gbk = await sendFile(test, gb18030(csv), "招行流水.csv", "text/csv");
    const res = await media.text(test.url, gbk);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "招行流水.csv", text: csv, encoding: "gb18030", truncated: false, bytes: gb18030(csv).length });
    const utf8 = await sendFile(test, csv, "招行流水-utf8.csv", "text/csv");
    expect((await media.text(test.url, utf8)).body).not.toHaveProperty("encoding");
  });

  it("GBK 的超过 1 MB：只给开头，截在字符边上（不出半个字）", async () => {
    const test = await startTestDaemon();
    // 开头 21 个 ASCII 字节，后面全是两个字节的汉字：1 MB 的边落在一个字的中间
    const big = `${"a".repeat(21)}${"账".repeat(600_000)}`;
    const bytes = gb18030(big);
    expect(bytes.length).toBeGreaterThan(MEDIA_TEXT_MAX_BYTES);
    const id = await sendFile(test, bytes, "全年流水.csv", "text/csv");
    const res = await media.text(test.url, id);
    expect(res.body).toMatchObject({ truncated: true, bytes: bytes.length, encoding: "gb18030" });
    expect(res.body.text).not.toContain("\uFFFD");
    expect(big.startsWith(res.body.text)).toBe(true);
    expect(gb18030(res.body.text).length).toBe(MEDIA_TEXT_MAX_BYTES - 1);
  });

  it("解不出来如实报错（422）：UTF-8、GBK 都不是的，二进制（含 NUL）；不吐乱码", async () => {
    const test = await startTestDaemon();
    // 0x80、0xFF 单独出现在 UTF-8、GB18030 里都不合法
    const junk = await sendFile(test, Buffer.from([0x23, 0x20, 0x80, 0xff, 0x80]), "旧日报.md", "text/markdown");
    const res = await media.text(test.url, junk);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: "undecodable", message: expect.stringContaining("GBK") });
    expect(res.body.message).toContain("旧日报.md");

    const binary = await sendFile(test, Buffer.from("abc\u0000def"), "看着像文本.txt", "text/plain");
    expect((await media.text(test.url, binary)).body).toMatchObject({ code: "undecodable" });
    // GBK 的二进制（含 NUL）也一样
    const gbkBinary = await sendFile(test, Buffer.concat([gb18030("账单"), Buffer.from([0xff, 0, 1])]), "导出.csv", "text/csv");
    expect((await media.text(test.url, gbkBinary)).body).toMatchObject({ code: "undecodable" });
  });

  it("外网端口：没配对的设备取不到（401），配对过的设备取得到（报告页的链接发给另一台已配对的设备也能打开）", async () => {
    const test = await startTestDaemon();
    const id = await sendFile(test, DAILY, "10 月 13 日日报.md", "text/markdown");
    const stranger = await httpRequest(test.externalUrl, HTTP_PATHS.mediaText(id));
    expect(stranger.status).toBe(401);
    expect(stranger.json<HttpErrorBody>().code).toBe("unauthorized");

    const pc = await TestFrontend.connect(test.url);
    await pc.subscribe({ cards: 0, inbox: 0 });
    const phone = await pairDevice(test.externalUrl, pc, { name: "我的手机" });
    const res = await phone.request(HTTP_PATHS.mediaText(id));
    expect(res.status).toBe(200);
    expect(res.json<MediaTextView>()).toMatchObject({ name: "10 月 13 日日报.md", text: DAILY });
  });

  it("媒体接口原有的行为不变：Markdown、HTML、CSV 照旧作为附件下载（octet-stream），图片照旧在页面里显示", async () => {
    const test = await startTestDaemon();
    const md = await sendFile(test, DAILY, "10 月 13 日日报.md", "text/markdown");
    const html = await sendFile(test, "<script>alert(1)</script>", "活动页.html", "text/html");
    const csv = await sendFile(test, "日期,金额\n", "流水.csv", "text/csv");
    for (const id of [md, html, csv]) {
      const down = await media.download(test.url, id, { name: "附件" });
      expect(down.headers["content-type"]).toBe("application/octet-stream");
      expect(down.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(down.headers["content-security-policy"]).toContain("sandbox");
    }
    const image = await media.upload(test.url, png({ width: 4, height: 4 }), { name: "截图.png", mime: "image/png" });
    const shown = await media.download(test.url, image.mediaId, { name: "截图.png" });
    expect(shown.headers["content-type"]).toBe("image/png");
    expect(shown.headers["content-disposition"]).toMatch(/^inline;/);
  });
});

describe("音频、视频附件", () => {
  it("内容接口只说用哪种播放器（不给内容）：按扩展名分音频、视频，.webm 看 part 上的类型", async () => {
    const test = await startTestDaemon();
    for (const [content, name, mime, kind] of [
      [MP4_HEAD, "周会录音.m4a", "audio/mp4", "audio"],
      [MP4_HEAD, "周会录像.mp4", "video/mp4", "video"],
      [EBML_HEAD, "录屏.webm", "video/webm", "video"],
      [EBML_HEAD, "录音.webm", "audio/webm", "audio"],
    ] as const) {
      const id = await sendFile(test, Buffer.concat([content, Buffer.from(name)]), name, mime);
      const res = await media.text(test.url, id);
      expect({ name, status: res.status, body: res.body }).toEqual({
        name,
        status: 200,
        body: { mediaId: id, name, mime, text: "", bytes: content.length + Buffer.byteLength(name), truncated: false, sentAt: expect.any(String), media: kind },
      });
    }
  });

  it("媒体接口按内容认出是音视频容器才内联：part 是视频的按视频类型发（mov 也是 video/mp4，mkv 是 video/webm），音频的按音频类型；能拖进度（Range）", async () => {
    const test = await startTestDaemon();
    for (const [content, name, mime, type] of [
      [MP4_HEAD, "周会录像.mp4", "video/mp4", "video/mp4"],
      [MP4_HEAD, "手机拍的.mov", "video/quicktime", "video/mp4"],
      [EBML_HEAD, "电影.mkv", "video/x-matroska", "video/webm"],
      [MP4_HEAD, "周会录音.m4a", "audio/mp4", "audio/mp4"],
      [EBML_HEAD, "录音.webm", "audio/webm", "audio/webm"],
    ] as const) {
      const id = await sendFile(test, Buffer.concat([content, Buffer.from(name)]), name, mime);
      const play = await media.download(test.url, id, { name, range: "bytes=0-11" });
      expect({ name, status: play.status, type: play.headers["content-type"], disposition: play.headers["content-disposition"] }).toEqual({
        name,
        status: 206,
        type,
        disposition: expect.stringMatching(/^inline;/),
      });
      expect(play.body.subarray(4, 8).toString("latin1")).toBe(content.subarray(4, 8).toString("latin1"));
      // 点"下载"照旧是附件
      const down = await media.download(test.url, id, { name, download: true });
      expect(down.headers["content-disposition"]).toMatch(/^attachment;/);
    }
  });

  it("声明成音视频、内容不是的：照旧当附件下载（octet-stream），不按 part 上的类型、文件名内联；报告页的播放器放不了时提示下载", async () => {
    const test = await startTestDaemon();
    const fake = await sendFile(test, "<!doctype html><script>alert(1)</script>", "伪装.mp4", "video/mp4");
    const fakeAudio = await sendFile(test, "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "伪装.mp3", "audio/mpeg");
    for (const id of [fake, fakeAudio]) {
      const res = await media.download(test.url, id, { name: "伪装.mp4" });
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(res.headers["content-security-policy"]).toContain("sandbox");
    }
    // 内容接口照样说是视频：放不放得了由播放器说
    expect((await media.text(test.url, fake)).body).toMatchObject({ media: "video", text: "" });
  });

  it("语音消息照常按音频播放：没有文件 part 引用的录音（WebM、MP4）是认出的音频类型", async () => {
    const test = await startTestDaemon();
    for (const [content, type] of [
      [EBML_HEAD, "audio/webm"],
      [MP4_HEAD, "audio/mp4"],
    ] as const) {
      const voice = await media.upload(test.url, Buffer.concat([content, Buffer.from("voice")]), { name: "语音", mime: type });
      const res = await media.download(test.url, voice.mediaId, { name: "语音" });
      expect({ type: res.headers["content-type"], disposition: res.headers["content-disposition"] }).toEqual({ type, disposition: expect.stringMatching(/^inline;/) });
    }
  });
});

describe("PDF 附件", () => {
  it("内容接口只说交给 pdf.js 画（pdf，不给内容）；按扩展名认，没有扩展名的看类型；坏的、不是 PDF 的也一样（打不打得开由报告页说）", async () => {
    const test = await startTestDaemon();
    const notes = pdf([["Weekly notes"], ["Page two"]]);
    for (const [content, name, mime] of [
      [notes, "周会纪要.pdf", "application/pdf"],
      [notes, "合同", "application/pdf"],
      [Buffer.from("%PDF-1.4 只传了一半"), "扫描件.PDF", "application/octet-stream"],
    ] as const) {
      const id = await sendFile(test, content, name, mime);
      const res = await media.text(test.url, id);
      expect({ name, status: res.status, body: res.body }).toEqual({ name, status: 200, body: { mediaId: id, name, mime, text: "", bytes: content.length, truncated: false, sentAt: expect.any(String), pdf: true } });
    }
  });

  it("报告页从媒体接口取字节：和下载同一个响应——整份原样、照旧当附件发（octet-stream、attachment、带 sandbox 的 CSP、不许嵌框），不按 PDF 内联", async () => {
    const test = await startTestDaemon();
    const notes = pdf([["Weekly notes"]]);
    const id = await sendFile(test, notes, "周会纪要.pdf", "application/pdf");
    for (const download of [true, false]) {
      const res = await media.download(test.url, id, { name: "周会纪要.pdf", download });
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, notes)).toBe(0);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });
});
