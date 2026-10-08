// 发给模型前的投影（规格第 5 节、第 21 节附件）：带版本号的纯函数，按模块测。
// 期望的输出都是手写的字面量（快照），覆盖每一类 part；同样的输入和版本，输出逐字节相同。
import type { MessagePart } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { type AttachmentContent, MODEL_PROJECTION_VERSION, projectForModel, type ProjectionInput, projectorOf } from "../src/conversation/model-projection.ts";

const IMG = "1".repeat(64);
const MD = "2".repeat(64);
const BIG = "3".repeat(64);
const PDF = "4".repeat(64);
const ZIP = "5".repeat(64);
const CSV = "6".repeat(64);
const BIN = "7".repeat(64);
const SCAN = "8".repeat(64);
const LONG_PDF = "9".repeat(64);

const utf8 = (s: string) => new TextEncoder().encode(s);
const KB = 1024;
/** 3 个字节的汉字，正好在 32 KB 边界上被切开（前 32766 字节是 ASCII） */
const bigText = `${"a".repeat(32 * KB - 2)}汉${"b".repeat(8 * KB)}`;

/** 下面的消息都是北京时间 2026-10-08（周四）09:30 发的 */
const SENT_AT = "2026-10-08T09:30:00.000+08:00";
const MARKER = "[2026-10-08 周四 09:30 +08:00]";

function input(parts: MessagePart[], extra: Partial<ProjectionInput> = {}): ProjectionInput {
  const attachments: Record<string, AttachmentContent> = {
    [MD]: { kind: "text", head: utf8("# 清单\n- 买牛奶\n"), totalBytes: utf8("# 清单\n- 买牛奶\n").length },
    [BIG]: { kind: "text", head: utf8(bigText).subarray(0, 32 * KB), totalBytes: utf8(bigText).length },
    [CSV]: { kind: "text", head: new Uint8Array([0xc3, 0xfb, 0xd7, 0xd6, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a]), totalBytes: 10 }, // GBK 的"名字,金额\n"
    [BIN]: { kind: "text", head: new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe]), totalBytes: 5 },
    [PDF]: { kind: "pdf", text: "第一页的文字\n第二页的文字" },
    [SCAN]: { kind: "pdf", text: undefined },
    [LONG_PDF]: { kind: "pdf", text: "长".repeat(11 * KB + 1) },
  };
  return { version: MODEL_PROJECTION_VERSION, parts, sentAt: SENT_AT, timeZone: "Asia/Shanghai", vision: false, attachments, cards: {}, voices: {}, ...extra };
}

/** 投影出来的正文：第一行是时间标记（下面单独测），后面才是各个 part */
function body(text: string): string {
  const newline = text.indexOf("\n");
  expect(text.slice(0, newline)).toBe(MARKER);
  return text.slice(newline + 1);
}

const file = (mediaId: string, name: string, mime: string, size: number): Extract<MessagePart, { type: "file" }> => ({ type: "file", mediaId, name, mime, size });

describe("发给模型前的投影（第 1 版）", () => {
  it("每条消息前面一行本地时间标记：日期、星期、时分、时区（按配置的时区换算发送时间）", () => {
    const parts: MessagePart[] = [{ type: "text", text: "明早 9 点提醒我交报告" }];
    expect(projectForModel(input(parts)).text).toBe(`${MARKER}\n明早 9 点提醒我交报告`);
    // 同一个时刻，换个时区看：日期、星期跟着变；半小时的时区、UTC 都照写
    const at = "2026-10-08T01:30:00Z";
    expect(projectForModel(input(parts, { sentAt: at, timeZone: "Asia/Shanghai" })).text.split("\n")[0]).toBe("[2026-10-08 周四 09:30 +08:00]");
    expect(projectForModel(input(parts, { sentAt: at, timeZone: "America/New_York" })).text.split("\n")[0]).toBe("[2026-10-07 周三 21:30 -04:00]");
    expect(projectForModel(input(parts, { sentAt: at, timeZone: "Asia/Kolkata" })).text.split("\n")[0]).toBe("[2026-10-08 周四 07:00 +05:30]");
    expect(projectForModel(input(parts, { sentAt: at, timeZone: "UTC" })).text.split("\n")[0]).toBe("[2026-10-08 周四 01:30 +00:00]");
    expect(projectForModel(input(parts, { sentAt: "2026-10-11T23:59:59.999+08:00" })).text.split("\n")[0]).toBe("[2026-10-11 周日 23:59 +08:00]");
  });

  it("文本原样；推理不进模型输入；各 part 之间空一行", () => {
    const out = projectForModel(input([{ type: "text", text: "在吗" }, { type: "reasoning", text: "（不该出现）" }, { type: "text", text: "第二段" }]));
    expect(out).toEqual({ version: 1, text: `${MARKER}\n在吗\n\n第二段`, images: [] });
  });

  it("卡片引用 → 一行摘要（卡片的纯文本降级版本，多行压成一行）；没有摘要时只给卡片 id", () => {
    const out = projectForModel(
      input([{ type: "card_ref", cardId: "c-1" }, { type: "card_ref", cardId: "c-2" }], { cards: { "c-1": "简单提醒：明早 9 点\n交报告（待触发）" } }),
    );
    expect(body(out.text)).toBe("[卡片：简单提醒：明早 9 点 交报告（待触发）]\n\n[卡片 c-2]");
  });

  it("图片：不支持视觉的模型只看到「[图片：文件名]」；支持视觉时作为图片输入，正文里按顺序编号", () => {
    const parts: MessagePart[] = [
      { type: "image", mediaId: IMG, name: "IMG_0001.JPG", mime: "image/jpeg", width: 40, height: 30 },
      { type: "image", mediaId: MD, name: "截图.png", mime: "image/png" },
      { type: "text", text: "看看这两张" },
    ];
    expect(projectForModel(input(parts))).toEqual({ version: 1, text: `${MARKER}\n[图片：IMG_0001.JPG]\n\n[图片：截图.png]\n\n看看这两张`, images: [] });
    expect(projectForModel(input(parts, { vision: true }))).toEqual({
      version: 1,
      text: `${MARKER}\n[图片 1：IMG_0001.JPG]\n\n[图片 2：截图.png]\n\n看看这两张`,
      images: [
        { mediaId: IMG, mime: "image/jpeg" },
        { mediaId: MD, mime: "image/png" },
      ],
    });
  });

  it("文本类文件（markdown、代码、CSV……）：不超过 32 KB 的整个内联", () => {
    const out = projectForModel(input([file(MD, "清单.md", "text/markdown", 22)]));
    expect(body(out.text)).toBe(`[附件：清单.md（text/markdown，22 B，附件引用 ${MD}）]\n----- 附件内容开始 -----\n# 清单\n- 买牛奶\n\n----- 附件内容结束 -----`);
  });

  it("文本类文件超过 32 KB：内联前 32 KB（不切断汉字），超出的部分提示用 read_attachment 工具读", () => {
    const out = projectForModel(input([file(BIG, "日志.txt", "text/plain", utf8(bigText).length)]));
    expect(body(out.text)).toBe(
      [
        `[附件：日志.txt（text/plain，40.0 KB，附件引用 ${BIG}）]`,
        "----- 附件内容开始（只有前 32 KB）-----",
        "a".repeat(32 * KB - 2),
        `----- 附件内容到此截断：全文共 40.0 KB，要读后面的内容，用 read_attachment 工具（附件引用 ${BIG}）-----`,
      ].join("\n"),
    );
  });

  it("不是 UTF-8 的文本按 GB18030 解（Excel 导出的 CSV）；解不出来的说明不是可读的文本", () => {
    expect(body(projectForModel(input([file(CSV, "账单.csv", "text/csv", 10)])).text)).toBe(
      `[附件：账单.csv（text/csv，10 B，附件引用 ${CSV}）]\n----- 附件内容开始 -----\n名字,金额\n\n----- 附件内容结束 -----`,
    );
    expect(body(projectForModel(input([file(BIN, "其实是二进制.txt", "text/plain", 5)])).text)).toBe(`[附件：其实是二进制.txt（text/plain，5 B，附件引用 ${BIN}）]\n（内容不是可读的文本）`);
  });

  it("PDF：先抽取文本，再按文本类处理；超过 32 KB 同样截断；抽不出文字的说明一句", () => {
    expect(body(projectForModel(input([file(PDF, "合同.pdf", "application/pdf", 2048)])).text)).toBe(
      `[附件：合同.pdf（application/pdf，2.0 KB，附件引用 ${PDF}）]\n----- PDF 抽取的文本开始 -----\n第一页的文字\n第二页的文字\n----- PDF 抽取的文本结束 -----`,
    );
    expect(body(projectForModel(input([file(LONG_PDF, "长文.pdf", "application/pdf", 3 * 1024 * 1024)])).text)).toBe(
      [
        `[附件：长文.pdf（application/pdf，3.0 MB，附件引用 ${LONG_PDF}）]`,
        "----- PDF 抽取的文本开始（只有前 32 KB）-----",
        "长".repeat(10922),
        `----- PDF 抽取的文本到此截断：全文共 33.0 KB，要读后面的内容，用 read_attachment 工具（附件引用 ${LONG_PDF}）-----`,
      ].join("\n"),
    );
    expect(body(projectForModel(input([file(SCAN, "扫描件.pdf", "application/pdf", 500_000)])).text)).toBe(
      `[附件：扫描件.pdf（application/pdf，488.3 KB，附件引用 ${SCAN}）]\n（这个 PDF 抽不出文字，可能是扫描件）`,
    );
  });

  it("其他类型：只给文件名、类型和大小", () => {
    expect(body(projectForModel(input([file(ZIP, "资料.zip", "application/zip", 3_565_158)])).text)).toBe(`[附件：资料.zip（application/zip，3.4 MB，附件引用 ${ZIP}）]`);
  });

  it("语音换成「语音转写：」加识别出的文字（31 号票，文字由调用方从 VoiceRecord 取来）；识别失败的、找不到这条语音的写「[语音，识别失败]」", () => {
    const voice = (voiceId: string): MessagePart => ({ type: "voice", voiceId, mediaId: ZIP, mime: "audio/webm", durationMs: 3200, waveform: [10, 60, 30] });
    const voices = { v1: { kind: "transcript", text: "明天早上九点提醒我。" }, v2: { kind: "failed" } } as const;
    expect(body(projectForModel(input([voice("v1")], { voices })).text)).toBe("语音转写：明天早上九点提醒我。");
    expect(body(projectForModel(input([voice("v2")], { voices })).text)).toBe("[语音，识别失败]");
    expect(body(projectForModel(input([voice("v3")], { voices })).text)).toBe("[语音，识别失败]");
    expect(body(projectForModel(input([{ type: "voice", mediaId: ZIP, mime: "audio/webm", durationMs: 3200, waveform: [] }], { voices })).text)).toBe("[语音，识别失败]");
  });

  it("TTS 音频、视频占位；工具调用、工单分隔各一行", () => {
    const out = projectForModel(
      input([
        { type: "tts_audio", voiceId: "av-1", mediaId: ZIP, mime: "audio/wav", durationMs: 4200, waveform: [20, 60] },
        { type: "video", mediaId: ZIP },
        { type: "tool_call", callId: "t1", tool: "bash", argsSummary: "ls\n-la", categoryTitles: [], disposition: "do", withinGrant: false, genericBash: true, outcome: "done" },
        { type: "work_order_divider", workOrderId: "WO-7", title: "整理笔记", from: "用户" },
        { type: "work_order_divider", workOrderId: "", title: "立项问答", from: "用户" },
      ]),
    );
    expect(body(out.text)).toBe("[语音回复]\n\n[视频]\n\n[工具调用 bash：ls -la]\n\n[工单 WO-7：整理笔记]\n\n[对话段：立项问答]");
  });

  it("同样的输入和版本，输出逐字节相同；不认识的版本报错", () => {
    const parts: MessagePart[] = [file(BIG, "日志.txt", "text/plain", utf8(bigText).length), { type: "image", mediaId: IMG, name: "a.png", mime: "image/png" }, { type: "text", text: "嗯" }];
    const a = JSON.stringify(projectForModel(input(parts, { vision: true })));
    const b = JSON.stringify(projectForModel(input(structuredClone(parts), { vision: true })));
    expect(a).toBe(b);
    expect(() => projectForModel(input(parts, { version: 99 }))).toThrow(/第 99 版/);
  });

  it("第 1 版要调用方先准备的内容：文本类文件的前 32 KB 原始字节、PDF 抽出的文本，其他类型什么都不要", () => {
    const v1 = projectorOf(1);
    expect(v1.contentNeeded(file(BIG, "笔记.md", "", 10))).toEqual({ kind: "text_head", bytes: 32 * 1024 });
    expect(v1.contentNeeded(file(BIG, "main.ts", "video/mp2t", 10))).toEqual({ kind: "text_head", bytes: 32 * 1024 });
    expect(v1.contentNeeded(file(BIG, "报告.PDF", "application/octet-stream", 10))).toEqual({ kind: "pdf_text" });
    expect(v1.contentNeeded(file(BIG, "a.zip", "application/zip", 10))).toBeUndefined();
    expect(() => projectorOf(2)).toThrow(/第 2 版/);
  });
});
