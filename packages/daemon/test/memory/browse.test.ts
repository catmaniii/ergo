// 设置里看素材（158 号票，模块层）：范围里的素材一页一页列出来（新的在前），点开一条看完整内容和来源。
// 素材只记了本人的话和别的内容的引用；出处的消息还在时，引用块的原文、附件和语音在消息里的样子从消息里补上，界面照会话里的样子画。
// 标记：别推断过的、在废弃分支里的（150）、项目内部的记录（64）。
// 167 号票：记忆 · 素材按时间范围浏览、按种类和会话筛、按关键词搜（filter），新的在前按素材的时间；搜的时候摘录换成命中的那一段。
import { CHANNELS, EVENT_TYPES, maintainerChannel, type MemoryCommandEventPayload, type MessagePart, type VoiceRecord } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { deletedMarker } from "../../src/events/purge.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import { createSavedPages, webPageSavedSource } from "../../src/browsing/saved-pages.ts";
import { createMaterialBrowser } from "../../src/memory/browse.ts";
import { voiceMaterialSource } from "../../src/voice-records/index.ts";
import { materialsSetup, postMessage, text } from "../materials/helpers.ts";

type Setup = ReturnType<typeof materialsSetup>;

const MAINTAINER = maintainerChannel("tm-1");

function browser(t: Setup, options: { abandoned?: (id: string) => boolean; internal?: (id: string) => { projectId: string; projectName: string } | undefined } = {}) {
  return createMaterialBrowser({
    store: t.store,
    materials: t.materials,
    abandoned: (m) => options.abandoned?.(m.id) ?? false,
    internal: (m) => options.internal?.(m.id),
  });
}

const image: MessagePart = { type: "image", mediaId: "a".repeat(64), name: "发票-0927.jpg", mime: "image/jpeg", width: 1200, height: 1600 };

describe("列表", () => {
  test("范围里的素材新的在前，一页一页取；带种类、时间、会话、摘录；范围可以是全部、一个会话、一个时间段、这一条", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("第一句：想换工作")], { time: "2026-10-08T09:00:00.000+08:00" });
    postMessage(t.store, [text("第二句：猎头又来了")], { time: "2026-10-08T10:00:00.000+08:00" });
    postMessage(t.store, [text("把分类规则里外卖单独拆出来")], { conversation: MAINTAINER, taskId: "t-1", time: "2026-10-08T11:00:00.000+08:00" });
    const [first, second, third] = t.materials.list();
    const b = browser(t);

    expect(b.list(undefined, {})).toEqual({
      total: 3,
      items: [
        { id: third!.id, kind: "用户发言", time: "2026-10-08T11:00:00.000+08:00", conversation: MAINTAINER, excerpt: "把分类规则里外卖单独拆出来", marks: {} },
        { id: second!.id, kind: "用户发言", time: "2026-10-08T10:00:00.000+08:00", conversation: CHANNELS.secretary, excerpt: "第二句：猎头又来了", marks: {} },
        { id: first!.id, kind: "用户发言", time: "2026-10-08T09:00:00.000+08:00", conversation: CHANNELS.secretary, excerpt: "第一句：想换工作", marks: {} },
      ],
    });
    expect(b.list({ kind: "conversation", conversation: CHANNELS.secretary }, {}).items.map((i) => i.id)).toEqual([second!.id, first!.id]);
    expect(b.list({ kind: "time_range", from: "2026-10-08T09:30:00.000+08:00", to: "2026-10-08T10:30:00.000+08:00" }, {}).items.map((i) => i.id)).toEqual([second!.id]);
    expect(b.list({ kind: "material", materialId: first!.id }, {})).toMatchObject({ total: 1, items: [{ id: first!.id }] });
    expect(b.list({ kind: "material", materialId: "mat-没有这条" }, {})).toEqual({ total: 0, items: [] });
    // 分页：总数不变
    expect(b.list(undefined, { offset: 1, limit: 1 })).toMatchObject({ total: 3, items: [{ id: second!.id }] });
    expect(b.list(undefined, { offset: 3, limit: 10 })).toEqual({ total: 3, items: [] });
  });

  test("标记：说过别推断的、在废弃分支里的、项目内部的记录；没有的不带", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("先别跟人说")]);
    postMessage(t.store, [text("撤回之前说的一句")]);
    postMessage(t.store, [text("普通的一句")]);
    const [quiet, abandoned, plain] = t.materials.list();
    const payload: MemoryCommandEventPayload = { commandId: "cmd-1", command: "no_infer", materialIds: [quiet!.id], from: { kind: "settings", scope: { kind: "material", materialId: quiet!.id } } };
    t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload });
    const b = browser(t, { abandoned: (id) => id === abandoned!.id, internal: (id) => (id === plain!.id ? { projectId: "p-1", projectName: "记账本" } : undefined) });

    const marks = Object.fromEntries(b.list({ kind: "conversation", conversation: CHANNELS.secretary }, {}).items.map((i) => [i.id, i.marks]));
    expect(marks).toEqual({ [quiet!.id]: { noInfer: true }, [abandoned!.id]: { abandoned: true }, [plain!.id]: { internal: { projectId: "p-1", projectName: "记账本" } } });
  });
});

describe("一条的完整内容", () => {
  test("本人的话全文；引用块的原文、附件在消息里的样子从出处的消息补上；来源、原文副本、原始事件都写明；出处的消息还在就能跳过去", () => {
    const t = materialsSetup();
    const { message, event } = postMessage(t.store, [image, text("> 发票上写的：餐饮 1280 元\n这张帮我算一下能报多少，按 85% 报")], { conversation: MAINTAINER, taskId: "t-1", projectId: "p-1" });
    const [m] = t.materials.list();

    const view = browser(t).detail(m!.id);
    expect(view).toEqual({
      id: m!.id,
      kind: "用户发言",
      mode: "say",
      time: message.time,
      conversation: MAINTAINER,
      taskId: "t-1",
      projectId: "p-1",
      source: "self",
      context: ["maintainer", "with_quote", "with_attachment"],
      segments: [
        { form: "attachment", source: "external_untrusted", notes: [], sha256: "a".repeat(64), label: "发票-0927.jpg", media: { mediaId: "a".repeat(64), name: "发票-0927.jpg", mime: "image/jpeg" }, part: image },
        { form: "quote", source: "external_untrusted", notes: [], sha256: expect.any(String), quoted: "> 发票上写的：餐饮 1280 元" },
        { form: "typed", source: "self", notes: [], sha256: expect.any(String), text: "这张帮我算一下能报多少，按 85% 报" },
      ],
      event: { channel: MAINTAINER, seq: event.seq, type: EVENT_TYPES.message },
      message: { id: message.id, state: "shown" },
      original: m!.original!.path,
      marks: {},
    });
  });

  test("出处的消息被彻底删除了（素材还在）：消息写已经不在、补不上引用块的原文；在废弃分支里的写在废弃分支里；没有这条素材是 undefined", () => {
    const t = materialsSetup();
    const gone = postMessage(t.store, [text("> 别人转来的一段\n我看看")]);
    postMessage(t.store, [text("撤回之前的一句")]);
    const [goneMaterial, abandoned] = t.materials.list();
    t.store.appendBatch([], { purge: [{ globalSeq: gone.event.globalSeq, payload: deletedMarker(gone.event, "2026-10-08T10:00:00.000+08:00") }] });
    const b = browser(t, { abandoned: (id) => id === abandoned!.id });

    const view = b.detail(goneMaterial!.id)!;
    expect(view.message).toEqual({ id: gone.message.id, state: "gone" });
    expect(view.segments.find((s) => s.form === "quote")).not.toHaveProperty("quoted");
    expect(b.detail(abandoned!.id)).toMatchObject({ message: { state: "abandoned" }, marks: { abandoned: true } });
    expect(b.detail("mat-没有这条")).toBeUndefined();
  });

  test("语音转写：文字是识别出的，语音条照会话里画（消息里的语音 part）；不来自消息的素材（关掉的卡）没有出处的消息，卡片只记了说明", () => {
    const t = materialsSetup({ sources: [voiceMaterialSource] });
    const voicePart: MessagePart = { type: "voice", voiceId: "v-1", mediaId: "b".repeat(64), mime: "audio/webm", durationMs: 6200, waveform: [6, 22, 48] };
    const { message } = postMessage(t.store, [voicePart]);
    const voice: VoiceRecord = {
      id: "v-1",
      messageId: message.id,
      conversation: CHANNELS.secretary,
      mediaId: "b".repeat(64),
      mime: "audio/webm",
      durationMs: 6200,
      waveform: [6, 22, 48],
      status: "done",
      attempt: 1,
      recognition: { text: "周五下午三点的牙医改到下周一", segments: [], engine: "sensevoice" } as unknown as NonNullable<VoiceRecord["recognition"]>,
      createdAt: message.time,
      updatedAt: message.time,
      version: 2,
    };
    t.store.append({ channel: CHANNELS.secretary, type: EVENT_TYPES.voice, payload: { voice } });
    const card = t.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "你提过三次重复照片太多" } });
    t.cards.act({ cardId: card.id, action: "dismiss", expectedVersion: 1, idempotencyKey: "k-1" });
    const [spoken, dismissed] = t.materials.list();
    const b = browser(t);

    expect(b.detail(spoken!.id)).toMatchObject({
      kind: "用户发言",
      recordId: "v-1",
      message: { id: message.id, state: "shown" },
      segments: [{ form: "voice", source: "self", notes: ["transcribed"], text: "周五下午三点的牙医改到下周一", media: { mediaId: "b".repeat(64) }, part: voicePart }],
    });
    const view = b.detail(dismissed!.id)!;
    expect(view).toMatchObject({ kind: "回避信号", mode: "do", cardId: card.id, segments: [{ form: "agent_output", source: "agent", cardId: card.id, label: expect.stringContaining("整理家庭照片") }] });
    expect(view).not.toHaveProperty("message");
    expect(view).not.toHaveProperty("conversation");
  });
});

/** 2026 年 10 月某天某时（167 号票的筛选用） */
const day = (d: string, hm: string) => `2026-10-${d}T${hm}:00.000+08:00`;

/** 几天里的几条：秘书主线说的话、维护者会话里说的话、发的图片、存的网页 */
function seed() {
  const t = materialsSetup({ sources: [webPageSavedSource] });
  postMessage(t.store, [text("周末想去杭州爬山")], { time: day("13", "09:00") });
  postMessage(t.store, [image], { time: day("15", "21:00") });
  postMessage(t.store, [text("把分类规则里外卖单独拆出来")], { conversation: MAINTAINER, taskId: "t-1", time: day("17", "10:00") });
  createSavedPages({ store: t.store, now: () => day("18", "20:10"), newId: () => "wp-1" }).save({
    idempotencyKey: "save-1",
    title: "周末去杭州玩什么 - 旅行攻略",
    url: "https://travel.example.com/hangzhou",
    text: `${"前面的介绍。".repeat(20)}第二天去灵隐寺，下午去龙井村喝茶。${"后面的交通说明。".repeat(20)}`,
    truncated: false,
    total: 400,
  });
  postMessage(t.store, [text("杭州那次算了，改去苏州")], { time: day("19", "08:30") });
  const byText = (needle: string) => t.materials.list().find((m) => JSON.stringify(m.segments).includes(needle))!;
  return { t, b: browser(t), hike: byText("爬山"), photo: byText("发票-0927"), rule: byText("外卖"), page: byText("旅行攻略"), suzhou: byText("苏州") };
}

describe("记忆 · 素材的筛选（167 号票）", () => {
  test("时间段：两头都算，可以只给一头；新的在前按素材的时间", () => {
    const { t, b, hike, photo, rule, page, suzhou } = seed();
    expect(b.list(undefined, {}, {}).items.map((i) => i.id)).toEqual([suzhou.id, page.id, rule.id, photo.id, hike.id]);
    expect(b.list(undefined, {}, { from: day("15", "00:00"), to: day("17", "23:59") }).items.map((i) => i.id)).toEqual([rule.id, photo.id]);
    expect(b.list(undefined, {}, { from: day("15", "21:00"), to: day("17", "10:00") }).items.map((i) => i.id)).toEqual([rule.id, photo.id]);
    expect(b.list(undefined, {}, { from: day("18", "00:00") }).items.map((i) => i.id)).toEqual([suzhou.id, page.id]);
    expect(b.list(undefined, {}, { to: day("13", "23:59") })).toMatchObject({ total: 1, items: [{ id: hike.id }] });
    expect(() => b.list(undefined, {}, { from: "不是时间" })).toThrow(/时间/);
    expect(() => b.list(undefined, {}, { from: day("18", "00:00"), to: day("17", "00:00") })).toThrow(/开始晚于结束/);
    // 后来才记下、时间更早的（比如识别得慢的语音）排在它的时间上，不排在最前
    postMessage(t.store, [text("补记：14 号想买相机")], { time: day("14", "12:00") });
    const late = t.materials.list().at(-1)!;
    expect(b.list(undefined, {}, {}).items.map((i) => i.id)).toEqual([suzhou.id, page.id, rule.id, photo.id, late.id, hike.id]);
    expect(b.list(undefined, {}, { from: day("14", "00:00"), to: day("14", "23:59") }).items.map((i) => i.id)).toEqual([late.id]);
  });

  test("按种类：算其中任一种就行；按会话：不来自会话的这时不列", () => {
    const { b, hike, photo, rule, page, suzhou } = seed();
    expect(b.list(undefined, {}, { facets: ["attachment"] }).items.map((i) => i.id)).toEqual([photo.id]);
    expect(b.list(undefined, {}, { facets: ["web_page", "attachment"] }).items.map((i) => i.id)).toEqual([page.id, photo.id]);
    expect(b.list(undefined, {}, { facets: ["said"] }).items.map((i) => i.id)).toEqual([suzhou.id, rule.id, hike.id]);
    expect(b.list(undefined, {}, { facets: [] }).total).toBe(5);
    expect(b.list(undefined, {}, { conversation: MAINTAINER }).items.map((i) => i.id)).toEqual([rule.id]);
    expect(b.list(undefined, {}, { conversation: CHANNELS.secretary }).items.map((i) => i.id)).toEqual([suzhou.id, photo.id, hike.id]);
  });

  test("按关键词搜：用素材库的关键词检索（存的网页按正文也搜得到），摘录换成命中的那一段；和时间段、种类、会话一起筛", () => {
    const { b, hike, page, suzhou } = seed();
    expect(b.list(undefined, {}, { query: "杭州" }).items.map((i) => i.id)).toEqual([suzhou.id, page.id, hike.id]);
    // 存的网页按正文搜到：摘录是正文里挨着检索词的一段（截掉的写省略号）
    const [hit] = b.list(undefined, {}, { query: "灵隐寺" }).items;
    expect(hit!.id).toBe(page.id);
    expect(hit!.excerpt).toMatch(/^….*第二天去灵隐寺，下午去龙井村喝茶。.*…$/);
    expect(hit!.excerpt.length).toBeLessThanOrEqual(82);
    // 本人的话：摘录同样是挨着检索词的一段
    expect(b.list(undefined, {}, { query: "苏州" }).items[0]!.excerpt).toBe("杭州那次算了，改去苏州");
    // 几个词都要有（不分大小写）
    expect(b.list(undefined, {}, { query: "杭州 爬山" }).items.map((i) => i.id)).toEqual([hike.id]);
    // 和别的一起筛
    expect(b.list(undefined, {}, { query: "杭州", from: day("18", "00:00") }).items.map((i) => i.id)).toEqual([suzhou.id, page.id]);
    expect(b.list(undefined, {}, { query: "杭州", facets: ["web_page"] }).items.map((i) => i.id)).toEqual([page.id]);
    expect(b.list(undefined, {}, { query: "杭州", conversation: CHANNELS.secretary }).items.map((i) => i.id)).toEqual([suzhou.id, hike.id]);
    expect(b.list(undefined, {}, { query: "没有这个词" })).toEqual({ total: 0, items: [] });
    // 空的关键词等于不搜
    expect(b.list(undefined, {}, { query: "  " }).total).toBe(5);
    // 分页照旧
    expect(b.list(undefined, { offset: 1, limit: 1 }, { query: "杭州" })).toMatchObject({ total: 3, items: [{ id: page.id }] });
  });

  test("范围（按会话、时间段删的那种）和筛选一起用：在范围里再筛", () => {
    const { b, hike, photo } = seed();
    expect(b.list({ kind: "conversation", conversation: CHANNELS.secretary }, {}, { facets: ["attachment"] }).items.map((i) => i.id)).toEqual([photo.id]);
    expect(b.list({ kind: "time_range", from: day("13", "00:00"), to: day("16", "00:00") }, {}, { query: "杭州" }).items.map((i) => i.id)).toEqual([hike.id]);
  });

  test("记忆插件没启用（只保管）时照样能搜：只在原文副本里的也逐条比对", async () => {
    const t = materialsSetup({ collect: false });
    postMessage(t.store, [text("停着时说的：下周三体检")], { time: day("19", "08:30") });
    postMessage(t.store, [text("停着时说的：周五交房租")], { time: day("19", "09:30") });
    expect(t.materials.collecting()).toBe(false);
    const b = browser(t);
    expect(b.list(undefined, {}, {}).total).toBe(2);
    expect(b.list(undefined, {}, { query: "体检" }).items.map((i) => i.excerpt)).toEqual(["停着时说的：下周三体检"]);
    expect(b.list(undefined, {}, { query: "停着时 房租" }).total).toBe(1);
  });
});
