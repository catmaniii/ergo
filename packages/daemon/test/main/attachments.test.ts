// 主切面：聊天里的附件（规格第 5 节消息与 part、第 21 节附件）。
// 用户给秘书发图片和文件；秘书看到的是发给模型前的投影；"读取附件"工具（含读图，79 号票）；秘书把草稿区里的文件作为附件发出来。
// 看图能力（79 号票）：不写配置按模型目录（测试里的 faux 和 deepseek-flash 一样能收图片），配置写明的为准。
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, type MessagePart } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { appendMessage } from "../../src/conversation/messages.ts";
import { stripImageMetadata } from "../../src/media/image.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { media, sha256Hex } from "../helpers/http.ts";
import { suggestTaskFixture } from "../helpers/card-fixtures.ts";
import { jpeg, png } from "../helpers/images.ts";
import { pdf } from "../helpers/pdf.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const SECRETARY = CHANNELS.secretary;
const { message: MESSAGE, turnEnd: TURN_END } = EVENT_TYPES;
/** 测试里秘书的模型是 faux provider，它在模型能力配置里的名字就是 faux：写明看不了图 */
const NO_VISION = { models: { faux: { vision: false } } };
/** 看不了图的模型在图片占位下面看到的那句 */
const UNSEEN_NOTE = "（这个模型看不了图片，看不到图里的内容，不要猜。要用到图里的内容，请用户用文字说一下；read_attachment 按这个附件引用只取得到图片的基本信息）";

function textOf(parts: readonly MessagePart[]): string {
  return parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** 等秘书这一轮回完，取它最后一条回复的文字（回显的上下文里每条用户消息前的时间标记去掉，标记本身另有用例） */
async function replyText(frontend: TestFrontend): Promise<string> {
  await frontend.next(SECRETARY, TURN_END);
  const replies = frontend.events({ channel: SECRETARY, type: MESSAGE }).map((f) => (f.payload as MessageEventPayload).message).filter((m) => m.speaker === "agent");
  return stripTimeMarkers(textOf(replies.at(-1)!.parts));
}

/** 回显的上下文里最后一个工具结果（从 [toolResult] 起到末尾） */
function lastToolResult(context: string): string {
  return context.slice(context.lastIndexOf("[toolResult]"));
}

describe("发给模型的输入", () => {
  it("每条用户消息前面一行本地时间标记（按配置的时区换算发送时间），秘书据此知道当天的日期和星期", async () => {
    const dataDir = makeTempDir("ergou-data-");
    fs.mkdirSync(path.join(dataDir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config", "ergou.json"), JSON.stringify({ timeZone: "Asia/Shanghai" }));
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], reuse: { dataDir, homeDir: makeTempDir("ergou-home-") } });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("明早 9 点提醒我交报告");
    const sent = (await frontend.next(SECRETARY, MESSAGE)).payload as MessageEventPayload;
    await frontend.next(SECRETARY, TURN_END);
    const echo = textOf(((frontend.events({ channel: SECRETARY, type: MESSAGE }).at(-1)!.payload) as MessageEventPayload).message.parts);

    // 发送时间换到北京时间（UTC+8，没有夏令时）
    const local = new Date(Date.parse(sent.message.time) + 8 * 3600_000).toISOString();
    const weekday = "日一二三四五六"[new Date(local).getUTCDay()];
    expect(echo).toContain(`[user] [${local.slice(0, 10)} 周${weekday} ${local.slice(11, 16)} +08:00]\n明早 9 点提醒我交报告`);
  });

  it("消息里引用的卡片投影成一行摘要：卡片类型注册表给出的纯文本降级版本", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], cardTypes: [suggestTaskFixture] });
    const card = daemon.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "你提过三次\n重复照片太多" } });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    appendMessage(daemon.store, { conversation: SECRETARY, speaker: "user", parts: [{ type: "card_ref", cardId: card.id }, { type: "text", text: "这个先不做" }] });
    expect(await replyText(frontend)).toContain("[user] [卡片：建议发起任务：整理家庭照片（你提过三次 重复照片太多）]\n\n这个先不做");
  });
});

describe("用户给秘书发附件", () => {
  it("消息带图片 part 和文件 part，引用入库版本的哈希；多个前端同步看到；秘书看到图片名和内联的文本", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }], config: NO_VISION });
    const photo = jpeg({ width: 40, height: 30, exif: { gps: true } });
    const image = await media.upload(url, photo, { name: "IMG_0001.JPG", mime: "image/jpeg" });
    const listText = "- 买牛奶\n- 交房租\n";
    const list = await media.upload(url, Buffer.from(listText), { name: "清单.md", mime: "" });

    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const other = await TestFrontend.connect(url);
    await other.subscribe({ [SECRETARY]: 0 });

    const sent = await frontend.sendParts(
      [
        // 前端带来的尺寸、大小、类型不作数，以服务端入库的为准（"作为材料投喂"见 materials-delete.test.ts）
        { type: "image", mediaId: image.mediaId, name: "IMG_0001.JPG", mime: "image/png", width: 1, height: 1 },
        { type: "file", mediaId: list.mediaId, name: "清单.md", mime: "text/markdown", size: 999_999 },
        { type: "text", text: "帮我看看这两样" },
      ],
      { idempotencyKey: "k-attach" },
    );

    const userEvent = await frontend.next(SECRETARY, MESSAGE);
    const payload = userEvent.payload as MessageEventPayload;
    expect(payload).toEqual({
      message: {
        id: sent.messageId,
        conversation: SECRETARY,
        speaker: "user",
        time: expect.any(String),
        parts: [
          { type: "image", mediaId: image.mediaId, name: "IMG_0001.JPG", mime: "image/jpeg", width: 40, height: 30 },
          { type: "file", mediaId: list.mediaId, name: "清单.md", mime: "text/markdown", size: Buffer.byteLength(listText) },
          { type: "text", text: "帮我看看这两样" },
        ],
      },
      idempotencyKey: "k-attach",
    });
    // 附件引用的是入库版本（剥过 EXIF）的哈希，不是原始上传字节的哈希
    expect(image.mediaId).not.toBe(sha256Hex(photo));
    expect((await media.download(url, image.mediaId)).body.length).toBe(image.size);
    // 另一个前端同步看到同一条消息
    expect((await other.next(SECRETARY, MESSAGE)).payload).toEqual(payload);

    // 秘书看到的是投影：看不了图的模型看到图片的名字、类型、尺寸和附件引用，下面一句说明出路；文本类附件内联
    const reply = (await frontend.next(SECRETARY, MESSAGE)).payload as MessageEventPayload;
    await frontend.next(SECRETARY, TURN_END);
    expect(stripTimeMarkers(textOf(reply.message.parts))).toContain(
      [
        `[user] [图片：IMG_0001.JPG（image/jpeg，40×30，附件引用 ${image.mediaId}）]`,
        UNSEEN_NOTE,
        "",
        `[附件：清单.md（text/markdown，${Buffer.byteLength(listText)} B，附件引用 ${list.mediaId}）]`,
        "----- 附件内容开始 -----",
        "- 买牛奶",
        "- 交房租",
        "",
        "----- 附件内容结束 -----",
        "",
        "帮我看看这两样",
      ].join("\n"),
    );
  });

  it("不写配置时按模型目录（faux 能收图片）：图片作为图片输入交给模型（入库版本），正文里按顺序编号、带附件引用；之后每一轮历史里的这张图也在", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "echo_context" }, { kind: "echo_context" }] });
    // pi 发给模型前会解码、缩放图片，所以这里用一张能解码的 PNG
    const image = await media.upload(url, png({ width: 8, height: 8, exif: true }), { name: "猫.png", mime: "image/png" });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendParts([{ type: "image", mediaId: image.mediaId, name: "猫.png", mime: "image/png" }, { type: "text", text: "这是什么猫" }]);
    const seen = `[user] [图片 1：猫.png（附件引用 ${image.mediaId}）]\n\n这是什么猫\n[image image/png]`;
    expect(await replyText(frontend)).toContain(seen);
    await frontend.sendText("再看一眼");
    const next = await replyText(frontend);
    expect(next).toContain(seen);
    expect(next).toContain("[user] 再看一眼");
  });

  it("看不了图的模型（配置写明 vision: false）：占位里的附件引用拿去 read_attachment 能取到，回的是图片的基本信息和一句清楚的话，没有图片", async () => {
    const photo = png({ width: 8, height: 6, exif: true });
    // 媒体 id 是入库版本（剥过元数据）的哈希
    const ref = sha256Hex(stripImageMetadata(photo, "image/png"));
    const { url } = await startTestDaemon({
      config: NO_VISION,
      secretary: [{ kind: "echo_context" }, { kind: "reply", toolCalls: [{ name: "read_attachment", arguments: { ref } }] }, { kind: "echo_context" }],
    });
    const image = await media.upload(url, photo, { name: "截图.png", mime: "image/png" });
    expect(image.mediaId).toBe(ref);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendParts([{ type: "image", mediaId: ref, name: "截图.png", mime: "image/png" }, { type: "text", text: "看看这个报错" }]);
    const first = await replyText(frontend);
    expect(first).toContain(`[user] [图片：截图.png（image/png，8×6，附件引用 ${ref}）]\n${UNSEEN_NOTE}\n\n看看这个报错`);
    expect(first).not.toContain("[image ");

    await frontend.sendText("读一下那张图");
    const read = lastToolResult(await replyText(frontend));
    expect(read).toBe(`[toolResult] read_attachment: 附件「截图.png」是图片（image/png，8×6，${image.size} B）。当前的模型看不了图片，读不出图里的内容；要用到图里的内容，请用户用文字说一下。`);
  });

  it("看得了图的模型：read_attachment 读图片，把这张图（入库版本）作为图片交给模型看", async () => {
    const photo = png({ width: 8, height: 8, exif: true });
    const ref = sha256Hex(stripImageMetadata(photo, "image/png"));
    const { url } = await startTestDaemon({
      secretary: [{ kind: "reply", text: "收到" }, { kind: "reply", toolCalls: [{ name: "read_attachment", arguments: { ref: ref.slice(0, 12) } }] }, { kind: "echo_context" }],
    });
    const image = await media.upload(url, photo, { name: "猫.png", mime: "image/png" });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendParts([{ type: "image", mediaId: image.mediaId, name: "猫.png", mime: "image/png" }]);
    await replyText(frontend);
    await frontend.sendText("再仔细看看那张图");
    expect(lastToolResult(await replyText(frontend))).toBe(`[toolResult] read_attachment: 附件「猫.png」是图片（image/png，8×8，${image.size} B），见下面的图。\n[image image/png]`);
  });

  it("超过 32 KB 的文本文件：秘书看到前 32 KB，调用 read_attachment 读到全文；伪造别的会话的附件引用去读，被拒并说明原因", async () => {
    const log = Buffer.from(`开头第一行\n${"x".repeat(40_000)}\n结尾 MARKER-END`);
    const ref = sha256Hex(log);
    const secret = Buffer.from("别的会话里的附件 MARKER-OTHER");
    const otherRef = sha256Hex(secret);
    const { url, daemon } = await startTestDaemon({
      secretary: [
        { kind: "echo_context" },
        { kind: "reply", toolCalls: [{ name: "read_attachment", arguments: { ref } }] },
        { kind: "echo_context" },
        { kind: "reply", toolCalls: [{ name: "read_attachment", arguments: { ref: otherRef } }] },
        { kind: "echo_context" },
      ],
    });
    await media.upload(url, log, { name: "日志.txt", mime: "text/plain" });
    await media.upload(url, secret, { name: "秘密.txt", mime: "text/plain" });
    // 别的会话（维护者会话，13 号票才能从前端发消息）里有一个附件：直接往事件日志里追加一条消息来布置
    appendMessage(daemon.store, { conversation: maintainerChannel("demo"), speaker: "user", parts: [{ type: "file", mediaId: otherRef, name: "秘密.txt", mime: "text/plain", size: secret.length }] });

    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    await frontend.sendParts([{ type: "file", mediaId: ref, name: "日志.txt", mime: "text/plain", size: log.length }, { type: "text", text: "看看这个日志" }]);
    const first = await replyText(frontend);
    expect(first).toContain(`[user] [附件：日志.txt（text/plain，39.1 KB，附件引用 ${ref}）]`);
    expect(first).toContain("开头第一行");
    expect(first).toContain("只有前 32 KB");
    expect(first).not.toContain("MARKER-END");

    await frontend.sendText("读一下全文");
    const second = lastToolResult(await replyText(frontend));
    expect(second).toMatch(/^\[toolResult\] read_attachment: /);
    expect(second).toContain("开头第一行");
    expect(second).toContain("结尾 MARKER-END");

    await frontend.sendText("再读一下这个");
    const third = lastToolResult(await replyText(frontend));
    expect(third).toContain("不在这个会话里");
    expect(third).not.toContain("MARKER-OTHER");
  });

  it("PDF 先抽取文本再按文本类内联；read_attachment 读到抽出的文本；其他类型只给文件名、类型和大小", async () => {
    const contract = pdf([["Contract page one MARKER-P1"], ["Page two says MARKER-P2"]]);
    const contractRef = sha256Hex(contract);
    const zip = randomBytes(300);
    const { url } = await startTestDaemon({
      secretary: [{ kind: "echo_context" }, { kind: "reply", toolCalls: [{ name: "read_attachment", arguments: { ref: contractRef.slice(0, 12) } }] }, { kind: "echo_context" }],
    });
    await media.upload(url, contract, { name: "合同.pdf", mime: "application/pdf" });
    const zipped = await media.upload(url, zip, { name: "资料.zip", mime: "application/zip" });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    await frontend.sendParts([
      { type: "file", mediaId: contractRef, name: "合同.pdf", mime: "application/pdf", size: contract.length },
      { type: "file", mediaId: zipped.mediaId, name: "资料.zip", mime: "application/zip", size: zip.length },
    ]);
    const seen = await replyText(frontend);
    expect(seen).toContain(`[附件：合同.pdf（application/pdf，${contract.length} B，附件引用 ${contractRef}）]\n----- PDF 抽取的文本开始 -----\nContract page one MARKER-P1`);
    expect(seen).toContain("Page two says MARKER-P2\n----- PDF 抽取的文本结束 -----");
    expect(seen).toContain(`[附件：资料.zip（application/zip，300 B，附件引用 ${zipped.mediaId}）]`);

    // 附件引用可以是本会话里唯一的前缀
    await frontend.sendText("把合同全文读一下");
    const read = lastToolResult(await replyText(frontend));
    expect(read).toContain("附件「合同.pdf」");
    expect(read).toContain("MARKER-P1");
    expect(read).toContain("MARKER-P2");
  });

  it("引用不存在的媒体、或者把不是图片的东西当图片发：被拒，说明原因，不落事件", async () => {
    const { url, daemon } = await startTestDaemon();
    const data = await media.upload(url, randomBytes(100), { name: "a.bin", mime: "application/octet-stream" });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    const missing = await frontend.trySendParts([{ type: "file", mediaId: "a".repeat(64), name: "x.txt", mime: "text/plain", size: 1 }]);
    expect(missing).toMatchObject({ ok: false, error: { code: "bad_params", message: expect.stringContaining("x.txt") } });
    const notImage = await frontend.trySendParts([{ type: "image", mediaId: data.mediaId, name: "a.bin", mime: "image/png" }]);
    expect(notImage).toMatchObject({ ok: false, error: { code: "bad_params", message: expect.stringContaining("不是图片") } });
    // 当文件发没问题
    await frontend.sendParts([{ type: "file", mediaId: data.mediaId, name: "a.bin", mime: "application/octet-stream", size: 100 }]);
    expect(daemon.store.read(SECRETARY).filter((e) => e.type === MESSAGE)).toHaveLength(1);
  });
});

describe("秘书给用户发附件", () => {
  it("秘书把草稿区里的文件作为附件发进聊天：复制进媒体库长期保留，删掉草稿区里的原文件照样能下载；草稿区外的文件发不了", async () => {
    const { url, dataDir } = await startTestDaemon({
      secretary: [
        {
          kind: "reply",
          toolCalls: [
            { name: "send_attachment", arguments: { path: "out/月度汇总.csv" } },
            { name: "send_attachment", arguments: { path: "图表.png", name: "支出图表.png" } },
            { name: "send_attachment", arguments: { path: "../外面.txt" } },
          ],
        },
        { kind: "echo_context" },
      ],
    });
    // 草稿区：秘书的工作目录（临时区里秘书专用的一格）；这里直接往目录里放文件
    const scratch = dataDirLayout(dataDir).scratch;
    const csv = Buffer.from("月份,支出\n9 月,3200\n");
    const chart = png({ width: 8, height: 6, exif: true });
    fs.mkdirSync(path.join(scratch, "out"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "out", "月度汇总.csv"), csv);
    fs.writeFileSync(path.join(scratch, "图表.png"), chart);
    fs.writeFileSync(path.join(scratch, "..", "外面.txt"), "草稿区外面的文件");

    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("把上个月的支出汇总一下发给我");
    const context = await replyText(frontend);

    const sentByAgent = frontend
      .events({ channel: SECRETARY, type: MESSAGE })
      .map((f) => (f.payload as MessageEventPayload).message)
      .filter((m) => m.speaker === "agent" && m.parts.some((p) => p.type === "file" || p.type === "image"));
    expect(sentByAgent.map((m) => m.parts)).toEqual([
      [{ type: "file", mediaId: sha256Hex(csv), name: "月度汇总.csv", mime: "text/csv", size: csv.length }],
      [{ type: "image", mediaId: expect.any(String), name: "支出图表.png", mime: "image/png", width: 8, height: 6 }],
    ]);
    // 图片同样剥掉元数据再入库
    const imageId = (sentByAgent[1]!.parts[0] as Extract<MessagePart, { type: "image" }>).mediaId;
    expect(imageId).not.toBe(sha256Hex(chart));
    // 草稿区外的文件发不了，模型收到原因
    expect(context).toMatch(/\[toolResult\] send_attachment: [^\n]*只能发草稿区里的文件/);

    // 清理草稿区里的文件之后（目录本身是秘书子进程的工作目录，Windows 上删不掉），聊天里的附件照样能下载
    fs.rmSync(path.join(scratch, "out"), { recursive: true, force: true });
    fs.rmSync(path.join(scratch, "图表.png"));
    const csvDown = await media.download(url, sha256Hex(csv), { name: "月度汇总.csv" });
    expect(csvDown.status).toBe(200);
    expect(csvDown.body.equals(csv)).toBe(true);
    const imageDown = await media.download(url, imageId);
    expect(imageDown.status).toBe(200);
    expect(sha256Hex(imageDown.body)).toBe(imageId);
  });
});
