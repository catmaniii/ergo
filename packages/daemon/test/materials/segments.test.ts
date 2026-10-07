// 素材的切段与来源标记（规格第 15 节）：确定的规则，纯函数，不靠模型判断。
// - 用户自己打的字标"本人"；判断不了的纯文本默认"本人"；
// - 引用块、附件、抓取的网页标"外部、不可信"；
// - 用户接受了 agent 的提议算用户的选择（本人），注明"agent 先提出"；
// - 语音转写标"本人"，注明"转写"（第一阶段只预留）。
// 只有"本人"的切段留下文字（另存原文副本）；agent 的产出、附件和外部内容只留引用加内容哈希。
import { createHash } from "node:crypto";
import type { MessagePart } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { type MaterialPiece, segmentMessage, segmentPieces } from "../../src/materials/segments.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const MEDIA = "a".repeat(64);

describe("切段：每种来源一条规则", () => {
  const cases: Array<[string, MaterialPiece, object]> = [
    ["用户自己打的字 → 本人", { kind: "typed", text: "我想周末搬家", locator: { part: 0 } }, { form: "typed", source: "self", notes: [], text: "我想周末搬家" }],
    ["判断不了的纯文本 → 默认本人", { kind: "text", text: "下周三有空", locator: {} }, { form: "text", source: "self", notes: [], text: "下周三有空" }],
    ["引用块 → 外部、不可信，只留哈希", { kind: "quote", text: "> 专家说房价会涨", locator: { part: 0, start: 3, end: 12 } }, { form: "quote", source: "external_untrusted", notes: [], sha256: sha256("> 专家说房价会涨") }],
    [
      "附件 → 外部、不可信，只留引用和内容哈希",
      { kind: "attachment", media: { mediaId: MEDIA, name: "报价单.pdf", mime: "application/pdf" }, locator: { part: 1 } },
      { form: "attachment", source: "external_untrusted", notes: [], media: { mediaId: MEDIA, name: "报价单.pdf", mime: "application/pdf" }, sha256: MEDIA },
    ],
    [
      "抓取的网页 → 外部、不可信",
      { kind: "web_page", url: "https://example.com/news", text: "网页正文", locator: {} },
      { form: "web_page", source: "external_untrusted", notes: [], url: "https://example.com/news", sha256: sha256("网页正文") },
    ],
    [
      "用户接受了 agent 的提议 → 本人，注明 agent 先提出",
      { kind: "accepted_proposal", text: "发起任务：整理家庭照片", locator: {} },
      { form: "choice", source: "self", notes: ["agent_proposed"], text: "发起任务：整理家庭照片" },
    ],
    [
      "语音转写 → 本人，注明转写",
      { kind: "voice", mediaId: MEDIA, transcript: "明早八点叫我", locator: { part: 0 } },
      { form: "voice", source: "self", notes: ["transcribed"], text: "明早八点叫我", media: { mediaId: MEDIA } },
    ],
    ["agent 的产出 → agent，只留哈希", { kind: "agent_output", text: "这是计划草稿", locator: {} }, { form: "agent_output", source: "agent", notes: [], sha256: sha256("这是计划草稿") }],
  ];

  test.each(cases)("%s", (_name, piece, expected) => {
    const [segment] = segmentPieces([piece]);
    expect(segment).toMatchObject(expected);
    expect(segment!.locator).toEqual(piece.locator);
  });

  test("本人的切段留文字、带文字的哈希；其余来源一律不留文字", () => {
    const segments = segmentPieces(cases.map(([, piece]) => piece));
    const self = segments.filter((s) => s.source === "self");
    const others = segments.filter((s) => s.source !== "self");
    expect(self.map((s) => s.form)).toEqual(["typed", "text", "choice", "voice"]);
    expect(self.map((s) => s.sha256)).toEqual(self.map((s) => sha256(s.text!)));
    expect(others.map((s) => s.form)).toEqual(["quote", "attachment", "web_page", "agent_output"]);
    expect(others.filter((s) => "text" in s)).toEqual([]);
  });

  test("只有空白的切段丢掉", () => {
    expect(segmentPieces([{ kind: "typed", text: "  \n ", locator: {} }, { kind: "quote", text: "", locator: {} }])).toEqual([]);
  });
});

const text = (t: string): MessagePart => ({ type: "text", text: t });

describe("切段：用户消息", () => {
  test("一条只有字的消息是一段本人", () => {
    expect(segmentMessage([text("我打算下个月搬家")])).toEqual([
      { form: "typed", source: "self", notes: [], locator: { part: 0, start: 0, end: 8 }, text: "我打算下个月搬家", sha256: sha256("我打算下个月搬家") },
    ]);
  });

  test("消息里的引用块（> 开头的行）单独成段，标外部、不可信；前后自己打的字各是一段本人", () => {
    const body = "我觉得这个说法不对：\n> 房价明年会涨\n> 这是专家说的\n\n我还是想再等等";
    const segments = segmentMessage([text(body)]);
    expect(segments.map((s) => [s.form, s.source, s.text, body.slice(s.locator.start, s.locator.end)])).toEqual([
      ["typed", "self", "我觉得这个说法不对：", "我觉得这个说法不对："],
      ["quote", "external_untrusted", undefined, "> 房价明年会涨\n> 这是专家说的"],
      ["typed", "self", "我还是想再等等", "我还是想再等等"],
    ]);
    expect(segments[1]!.sha256).toBe(sha256("> 房价明年会涨\n> 这是专家说的"));
  });

  test("行首最多三个空格再接 > 也算引用；空行结束引用块", () => {
    const body = "   > 引用一行\n\n自己的话";
    expect(segmentMessage([text(body)]).map((s) => [s.form, body.slice(s.locator.start, s.locator.end)])).toEqual([
      ["quote", "> 引用一行"],
      ["typed", "自己的话"],
    ]);
  });

  test("引用块后面紧跟的、不以 > 开头的行算自己的话（不做 Markdown 的惰性续行）", () => {
    const body = "> 别人说的\n我自己的看法";
    expect(segmentMessage([text(body)]).map((s) => [s.source, body.slice(s.locator.start, s.locator.end)])).toEqual([
      ["external_untrusted", "> 别人说的"],
      ["self", "我自己的看法"],
    ]);
  });

  test("图片、文件是附件：外部、不可信，只留引用（媒体 id、文件名、类型）", () => {
    const segments = segmentMessage([
      text("看看这个"),
      { type: "image", mediaId: MEDIA, name: "截图.png", mime: "image/png" },
      { type: "file", mediaId: "b".repeat(64), name: "合同.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1024 },
    ]);
    expect(segments.map((s) => [s.form, s.source, s.locator.part, s.media?.name])).toEqual([
      ["typed", "self", 0, undefined],
      ["attachment", "external_untrusted", 1, "截图.png"],
      ["attachment", "external_untrusted", 2, "合同.docx"],
    ]);
    expect(segments[1]).not.toHaveProperty("text");
  });

  test("语音 part 记成本人的转写", () => {
    expect(segmentMessage([{ type: "voice", mediaId: MEDIA, transcript: "提醒我买牛奶" }])).toMatchObject([
      { form: "voice", source: "self", notes: ["transcribed"], text: "提醒我买牛奶", locator: { part: 0 } },
    ]);
  });

  test("用户消息里出现卡片引用，记成对 agent 产出的引用", () => {
    expect(segmentMessage([{ type: "card_ref", cardId: "c-1" }])).toMatchObject([{ form: "agent_output", source: "agent", cardId: "c-1", locator: { part: 0 } }]);
  });

  test("同样的输入切出同样的段（确定性）", () => {
    const parts = [text("前面\n> 中间\n后面"), { type: "image", mediaId: MEDIA, name: "a.png", mime: "image/png" } satisfies MessagePart];
    expect(segmentMessage(parts)).toEqual(segmentMessage(parts));
  });
});
