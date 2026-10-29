// 158 号票：设置里删除素材的地方能看每条素材的内容。状态层推导列表的一行、详情里的每一段（照会话里的样子画什么）、来源的各行、
// 标记、能不能跳到出处的那条消息，以及详情里三种删法能不能点。
import { describe, expect, test } from "vitest";
import {
  initialUiState,
  type MaterialDetailView,
  type MaterialListItem,
  materialBlocks,
  materialDeleteChoices,
  materialFacts,
  materialJump,
  materialMarkChips,
  materialRow,
  type MessagePart,
  type Project,
  type Task,
  type UiState,
} from "../../src/state/index.ts";

const image: Extract<MessagePart, { type: "image" }> = { type: "image", mediaId: "a".repeat(64), name: "发票-0927.jpg", mime: "image/jpeg", width: 1200, height: 1600 };
const voicePart: Extract<MessagePart, { type: "voice" }> = { type: "voice", voiceId: "v-1", mediaId: "b".repeat(64), mime: "audio/webm", durationMs: 6200, waveform: [6, 22, 48] };

function view(overrides: Partial<MaterialDetailView> = {}): MaterialDetailView {
  return {
    id: "mat-1",
    kind: "用户发言",
    mode: "say",
    time: "2026-10-06T22:40:00.000+08:00",
    conversation: "secretary",
    source: "self",
    context: ["secretary", "with_quote", "with_attachment"],
    segments: [],
    event: { channel: "secretary", seq: 12, type: "message" },
    message: { id: "msg-9", state: "shown" },
    original: "originals/2026-10/mat-1.json",
    marks: {},
    ...overrides,
  };
}

describe("列表的一行", () => {
  test("种类和时间（到分钟）；按时间段看时带上会话；摘录；标记的小签", () => {
    const item: MaterialListItem = { id: "mat-1", kind: "用户发言", time: "2026-10-06T22:40:00.000+08:00", conversation: "maintainer:tm-1", excerpt: "这张帮我算一下", marks: { noInfer: true, abandoned: true } };
    expect(materialRow(item)).toEqual({ id: "mat-1", title: "用户发言 · 10-06 22:40", conversation: "maintainer:tm-1", excerpt: "这张帮我算一下", chips: ["不参与推断", "在废弃分支里"] });
    expect(materialRow({ ...item, excerpt: "", conversation: undefined, marks: {} } as MaterialListItem)).toEqual({ id: "mat-1", title: "用户发言 · 10-06 22:40", conversation: undefined, excerpt: "（没有文字）", chips: [] });
  });

  test("项目内部的记录写明是哪个项目的", () => {
    expect(materialMarkChips({ internal: { projectId: "p-1", projectName: "记账本" } })).toEqual(["项目「记账本」的内部记录"]);
  });
});

describe("详情里的每一段", () => {
  test("本人的话全文；引用块写原文（去掉行首的 >），补不上时写明只记了引用；附件按消息里的 part 照会话里画", () => {
    const blocks = materialBlocks(
      view({
        segments: [
          { form: "attachment", source: "external_untrusted", notes: [], label: "发票-0927.jpg", media: { mediaId: image.mediaId, name: image.name, mime: image.mime }, part: image },
          { form: "quote", source: "external_untrusted", notes: [], sha256: "c".repeat(64), quoted: "> 发票上写的：\n>  餐饮 1280 元" },
          { form: "quote", source: "external_untrusted", notes: [], sha256: "d".repeat(64) },
          { form: "typed", source: "self", notes: [], text: "这张帮我算一下能报多少\n按 85% 报" },
        ],
      }),
    );
    expect(blocks).toEqual([
      { kind: "part", title: "外部、不可信 · 附件", part: image },
      { kind: "quote", title: "外部、不可信 · 引用块", text: "发票上写的：\n 餐饮 1280 元" },
      { kind: "ref", title: "外部、不可信 · 引用块", text: "只记了引用（内容哈希 dddddddd…），原文在出处的消息里，消息已经不在了" },
      { kind: "text", title: "本人 · 打的字", text: "这张帮我算一下能报多少\n按 85% 报" },
    ]);
  });

  test("语音转写：语音条（消息里的语音 part）加识别出的文字；用户接受的提议注明 agent 先提出；网页、卡片、出处不在了的附件只有引用的说明", () => {
    const blocks = materialBlocks(
      view({
        segments: [
          { form: "voice", source: "self", notes: ["transcribed"], text: "周五的牙医改到下周一", media: { mediaId: voicePart.mediaId }, part: voicePart },
          { form: "voice", source: "self", notes: ["transcribed"], text: "记住这个" },
          { form: "choice", source: "self", notes: ["agent_proposed"], text: "每周日晚上自动导出账单" },
          { form: "web_page", source: "external_untrusted", notes: [], label: "https://example.com/a", url: "https://example.com/a" },
          { form: "agent_output", source: "agent", notes: [], cardId: "c-1", label: "建议发起任务：整理家庭照片" },
          { form: "attachment", source: "external_untrusted", notes: [], label: "报销明细.csv", media: { mediaId: "e".repeat(64), name: "报销明细.csv" } },
        ],
      }),
    );
    expect(blocks).toEqual([
      { kind: "voice", title: "本人 · 语音转写", part: voicePart, text: "周五的牙医改到下周一" },
      { kind: "text", title: "本人 · 语音转写", text: "记住这个" },
      { kind: "text", title: "本人 · 你的选择（agent 先提出）", text: "每周日晚上自动导出账单" },
      { kind: "ref", title: "外部、不可信 · 网页", text: "https://example.com/a", url: "https://example.com/a" },
      { kind: "ref", title: "agent 的产出 · 卡片", text: "建议发起任务：整理家庭照片" },
      { kind: "ref", title: "外部、不可信 · 附件", text: "报销明细.csv（只记了引用，出处的消息已经不在了）" },
    ]);
  });
});

describe("你存的网页（165 号票）", () => {
  const page = "https://travel.example.com/hangzhou";
  const saved = (truncated: boolean) =>
    view({
      kind: "用户主动投喂的材料",
      conversation: undefined,
      message: undefined,
      context: ["saved_web_page"],
      recordId: "wp-1",
      event: { channel: "materials", seq: 3, type: "web_page_saved" },
      segments: [
        {
          form: "web_page",
          source: "external_untrusted",
          notes: [],
          label: `周末去杭州玩什么（${page}）`,
          url: page,
          saved: { title: "周末去杭州玩什么", text: "西湖、灵隐寺、龙井村", truncated, total: truncated ? 5200 : 10 },
        },
      ],
    });

  test("网页那一段画成标题、网址（能点）和存下的正文；截断了写明只存了前几个字、原文一共多少字", () => {
    expect(materialBlocks(saved(false))).toEqual([{ kind: "page", title: "外部、不可信 · 网页", pageTitle: "周末去杭州玩什么", url: page, text: "西湖、灵隐寺、龙井村" }]);
    expect(materialBlocks(saved(true))).toEqual([{ kind: "page", title: "外部、不可信 · 网页", pageTitle: "周末去杭州玩什么", url: page, text: "西湖、灵隐寺、龙井村", note: "只存了前 10 字，原文一共 5200 字" }]);
  });

  test("存下的正文补不上（事件不在了）时照只记了引用的写引用的说明（标题和网址）", () => {
    const v = saved(false);
    const { saved: _gone, ...segment } = v.segments[0]!;
    expect(materialBlocks({ ...v, segments: [segment] })).toEqual([{ kind: "ref", title: "外部、不可信 · 网页", text: `周末去杭州玩什么（${page}）`, url: page }]);
  });

  test("情境里写成你存的网页；不来自会话、不来自消息，没有那两行", () => {
    const rows = factRows(saved(false));
    expect(rows["情境"]).toBe("你存的网页");
    expect(rows["记录"]).toBe("wp-1");
    expect(rows).not.toHaveProperty("会话");
    expect(rows).not.toHaveProperty("消息");
    expect(materialFacts(saved(false)).head).toBe("用户主动投喂的材料 · 说 · 本人");
    // 别的情境标签照原样
    expect(factRows(view({ context: ["secretary", "saved_web_page"] }))["情境"]).toBe("secretary、你存的网页");
  });
});

/** 来源的各行：名字 → 值 */
const factRows = (v: MaterialDetailView) => Object.fromEntries(materialFacts(v).rows.map((r) => [r.label, r.value]));

describe("来源", () => {
  test("种类、说还是做、来源等级一行；时间、会话、任务、项目、消息现在怎样、卡片、记录、原文副本、原始事件、情境各一行", () => {
    const facts = materialFacts(view({ taskId: "t-1", projectId: "p-1", cardId: "c-1", recordId: "v-1" }));
    expect(facts.head).toBe("用户发言 · 说 · 本人");
    expect(facts.rows).toEqual([
      { label: "时间", value: "2026-10-06 22:40" },
      { label: "会话", value: "secretary", conversation: true },
      { label: "任务", value: "t-1" },
      { label: "项目", value: "p-1" },
      { label: "消息", value: "msg-9 · 还在会话里" },
      { label: "卡片", value: "c-1" },
      { label: "记录", value: "v-1" },
      { label: "原文副本", value: "originals/2026-10/mat-1.json" },
      { label: "原始事件", value: "secretary 第 12 条 · message", mono: true },
      { label: "情境", value: "secretary、with_quote、with_attachment" },
    ]);
  });

  test("消息在废弃分支里、已经不在了的写明；不是本人的话没有原文副本；不来自会话、不来自消息的不写那两行", () => {
    expect(factRows(view({ message: { id: "msg-9", state: "abandoned" } }))["消息"]).toBe("msg-9 · 在废弃分支里（会话里只显示当前分支）");
    expect(factRows(view({ message: { id: "msg-9", state: "gone" } }))["消息"]).toBe("msg-9 · 已经不在了（彻底删除了，或者随项目删了）");
    const card = factRows(view({ kind: "回避信号", mode: "do", source: "system", conversation: undefined, message: undefined, original: undefined }));
    expect(card).not.toHaveProperty("会话");
    expect(card).not.toHaveProperty("消息");
    expect(card["原文副本"]).toBe("没有（只有本人的话另存原文副本）");
    expect(materialFacts(view({ kind: "回避信号", mode: "do", source: "system" })).head).toBe("回避信号 · 做 · 系统");
  });
});

describe("跳到出处的那条消息", () => {
  const world: UiState = {
    ...initialUiState,
    tasks: { "t-1": { id: "t-1", maintainerId: "tm-1" } as Task },
    projects: { "p-1": { id: "p-1", maintainerId: "pm-1" } as Project },
  };

  test("秘书会话里的去秘书页定位到那条；维护者会话里的按是哪个任务、哪个项目的去整页", () => {
    expect(materialJump(world, view())).toEqual({ kind: "secretary", at: "msg-9" });
    expect(materialJump(world, view({ conversation: "maintainer:tm-1", taskId: "t-1" }))).toEqual({ kind: "task", taskId: "t-1", at: "msg-9" });
    expect(materialJump(world, view({ conversation: "maintainer:pm-1", projectId: "p-1" }))).toEqual({ kind: "project", projectId: "p-1", chat: true, at: "msg-9" });
  });

  test("没有出处的消息、消息在废弃分支里或不在了、认不出会话的：跳不过去", () => {
    expect(materialJump(world, view({ message: undefined }))).toBeUndefined();
    expect(materialJump(world, view({ message: { id: "msg-9", state: "abandoned" } }))).toBeUndefined();
    expect(materialJump(world, view({ message: { id: "msg-9", state: "gone" } }))).toBeUndefined();
    expect(materialJump(world, view({ conversation: "maintainer:tm-gone" }))).toBeUndefined();
  });
});

describe("详情里的删法", () => {
  test("忘掉、彻底删除、别推断都能点；已经标过不参与推断的，别推断灰着写明原因", () => {
    expect(materialDeleteChoices(view())).toEqual([
      { mode: "forget", label: "忘掉" },
      { mode: "purge", label: "彻底删除" },
      { mode: "no_infer", label: "别推断" },
    ]);
    expect(materialDeleteChoices(view({ marks: { noInfer: true } }))[2]).toEqual({ mode: "no_infer", label: "别推断", disabled: "已经标过不参与推断" });
  });
});
