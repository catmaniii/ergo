// 主切面：文本类附件的内容（113 号票，报告页用）：GET /api/media/<媒体 id>/text 回 JSON，不让浏览器直接渲染文件。
// 真的守护进程（临时数据目录）：附件经 HTTP 上传入库，再像 agent 发附件那样作为一条消息追加进秘书会话（名字、类型以消息里
// 最近一次引用它的文件 part 为准）；测试扮演前端取内容。媒体接口原有的内联、下载规矩不变（回归）。
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

const SECRETARY = CHANNELS.secretary;

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

  it("不能预览的类型回 415 并说明原因：xhtml、zip、图片，以及本版还没做的 CSV（HTML、SVG 117 号票起在沙箱里预览，见 media-frame.test.ts）", async () => {
    const test = await startTestDaemon();
    // 浏览器会当页面跑的 xhtml：就算 part 上写成纯文本也不预览
    const xhtml = await sendFile(test, '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>', "活动页.xhtml", "text/plain");
    const zip = await sendFile(test, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "资料.zip", "application/zip");
    const csv = await sendFile(test, "日期,金额\n10-13,12.5\n", "流水.csv", "text/csv");
    const image = await media.upload(test.url, png({ width: 4, height: 4 }), { name: "截图.png", mime: "image/png" });
    appendMessage(test.daemon.store, { conversation: SECRETARY, speaker: "user", parts: [attachmentPartFrom(image)] });

    for (const [id, name] of [
      [xhtml, "活动页.xhtml"],
      [zip, "资料.zip"],
      [csv, "流水.csv"],
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

  it("解不出来如实报错（422）：不是 UTF-8 的（GBK 存的）、二进制（含 NUL）；不猜编码、不吐乱码", async () => {
    const test = await startTestDaemon();
    // "日报" 的 GBK 编码
    const gbk = await sendFile(test, Buffer.concat([Buffer.from("# "), Buffer.from([0xc8, 0xd5, 0xb1, 0xa8])]), "旧日报.md", "text/markdown");
    const res = await media.text(test.url, gbk);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: "undecodable", message: expect.stringContaining("UTF-8") });
    expect(res.body.message).toContain("旧日报.md");

    const binary = await sendFile(test, Buffer.from("abc\u0000def"), "看着像文本.txt", "text/plain");
    expect((await media.text(test.url, binary)).body).toMatchObject({ code: "undecodable" });
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

  it("媒体接口原有的行为不变：Markdown、HTML 照旧作为附件下载（octet-stream），图片照旧在页面里显示", async () => {
    const test = await startTestDaemon();
    const md = await sendFile(test, DAILY, "10 月 13 日日报.md", "text/markdown");
    const html = await sendFile(test, "<script>alert(1)</script>", "活动页.html", "text/html");
    for (const id of [md, html]) {
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
