// 顺口问的几个小零件（整条路径由主切面 test/main/memory-woven-questions.test.ts 走）：
// - 271 号票：秘书标了哪个问题（markedQuestionOf）：认秘书这一轮标问题的工具调用（做成了的；标错了编号、工具回错的不算）；
// - 271 号票：每晚整理判回答要的"问过以后用户说的话"（reply-follow-ups.ts）：从秘书标了问题的那一轮之后取，同一个会话、用户本人说的、
//   问过以后 24 小时内，按先后，每句对到它的素材；带上秘书那一轮的回话（问在里面）；找不到那一轮（271 以前问的）按问过的时间取；
// - 记忆的设置（memory/settings.ts）：没有文件是默认（开着）；改了写进配置区、重启照样读得到；文件坏了按默认、不覆盖它。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, type MessagePart } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { conversationFollowUps } from "../../src/memory/reply-follow-ups.ts";
import { createMemorySettings } from "../../src/memory/settings.ts";
import { MARK_WOVEN_QUESTION } from "../../src/memory/tool-names.ts";
import { markedQuestionOf } from "../../src/memory/woven-questions.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { materialsSetup, postMessage, text } from "../materials/helpers.ts";

/** 秘书调了一次工具（会话里那条工具调用记录） */
const toolCall = (tool: string, argsSummary: string, outcome: "done" | "error" = "done"): MessagePart =>
  ({ type: "tool_call", callId: `call-${argsSummary}`, tool, argsSummary, categoryTitles: [], withinGrant: true, genericBash: false, outcome }) as MessagePart;

const time = (d: number, hh: number, mm = 0) => `2026-10-${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000+08:00`;

/** agent 的一条回话 */
const agent = (parts: MessagePart[]) => ({ id: "m", conversation: CHANNELS.secretary, speaker: "agent" as const, time: time(10, 11), parts });

describe("秘书标了哪个问题", () => {
  it("认秘书标问题的那次工具调用（做成了的）；标错了编号、工具回错的不算；别的工具不算", () => {
    expect(markedQuestionOf([agent([text("看你。最近是不是挺忙的？")]), agent([toolCall(MARK_WOVEN_QUESTION, "id=qu-0003")])])).toBe("qu-0003");
    expect(markedQuestionOf([agent([toolCall(MARK_WOVEN_QUESTION, "id=qu-0002", "error")])])).toBeUndefined();
    expect(markedQuestionOf([agent([toolCall("search_materials", "query=qu-0003")])])).toBeUndefined();
    expect(markedQuestionOf([agent([text("顺便问一句：上次推掉的周末活动，要是时间由你自己定，你会去吗？")])])).toBeUndefined();
    expect(markedQuestionOf([])).toBeUndefined();
  });
});

describe("夜里判回答要的'问过以后用户说的话'", () => {
  it("从秘书标了问题的那一轮之后取：同一个会话、用户本人说的、问过以后 24 小时内、按先后，每句对到素材；带上秘书那一轮的回话", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("这周六同学约我聚会，我还在想要不要去。")], { time: time(10, 11, 0) });
    postMessage(t.store, [toolCall(MARK_WOVEN_QUESTION, "id=qu-0003")], { speaker: "agent", time: time(10, 11, 0) });
    postMessage(t.store, [text("去不去看你状态。最近是不是挺忙的？")], { speaker: "agent", time: time(10, 11, 1) });
    const busy = postMessage(t.store, [text("最近在赶项目，天天弄到很晚")], { time: time(10, 11, 5) }).message.id;
    postMessage(t.store, [text("维护者那边说的话")], { conversation: "task:t-1:maintainer" as never, time: time(10, 11, 6) });
    const clock = postMessage(t.store, [text("周六早上的闹钟帮我关掉")], { time: time(10, 11, 10) }).message.id;
    postMessage(t.store, [text("隔了一天多才说的话")], { time: time(11, 12, 0) });
    /** 素材 id → 它是哪条消息 */
    const messageOf = (ref: string | undefined) => t.materials.list().find((m) => m.id === ref)?.ref.messageId;

    const source = conversationFollowUps({ reader: t.store.reader, materials: t.materials });
    const context = source({ id: "qu-0003", lastAskedAt: "2026-10-10T11:01:00+08:00" }, { at: "2026-10-12T03:00:00+08:00" });
    expect(context.askedAs).toBe("去不去看你状态。最近是不是挺忙的？");
    expect(context.followUps.map((f) => messageOf(f.sourceRef))).toEqual([busy, clock]);
    expect(context.followUps[0]!.at).toBe(time(10, 11, 5));

    // 同一个问题又问了一次：从最近那一次之后取
    postMessage(t.store, [toolCall(MARK_WOVEN_QUESTION, "id=qu-0003")], { speaker: "agent", time: time(11, 12, 1) });
    const soso = postMessage(t.store, [text("还行吧")], { time: time(11, 12, 5) }).message.id;
    const again = source({ id: "qu-0003", lastAskedAt: "2026-10-11T12:01:00+08:00" }, { at: "2026-10-12T03:00:00+08:00" });
    expect(again.followUps.map((f) => messageOf(f.sourceRef))).toEqual([soso]);
  });

  it("找不到秘书标的那一轮（271 以前按原样带那一句问的）：按问过的时间取之后用户说的话", () => {
    const t = materialsSetup();
    postMessage(t.store, [text("周日要不要约朋友去爬山？")], { time: time(10, 20, 0) });
    postMessage(t.store, [text("顺便问一句：……你会去吗？")], { speaker: "agent", time: time(10, 20, 1) });
    const depends = postMessage(t.store, [text("看情况吧")], { time: time(10, 20, 5) }).message.id;
    const source = conversationFollowUps({ reader: t.store.reader, materials: t.materials });
    const context = source({ id: "qu-0009", lastAskedAt: "2026-10-10T20:01:30+08:00" }, { at: "2026-10-11T03:00:00+08:00" });
    expect(context.askedAs).toBeUndefined();
    expect(context.followUps.map((f) => t.materials.list().find((m) => m.id === f.sourceRef)?.ref.messageId)).toEqual([depends]);
  });
});

describe("记忆的设置", () => {
  it("没有文件是默认（顺口问开着）；改了写进配置区，重新读照样是改过的；没变化不写", () => {
    const file = path.join(makeTempDir("ergo-memory-settings-"), "config", "memory-settings.json");
    const logs: string[] = [];
    const settings = createMemorySettings({ file, log: (line) => logs.push(line) });
    settings.start();
    expect(settings.current()).toEqual({ wovenQuestions: true, memoryBrief: true, interviewInvites: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(settings.change({ wovenQuestions: false })).toEqual({ wovenQuestions: false, memoryBrief: true, interviewInvites: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, wovenQuestions: false, memoryBrief: true, interviewInvites: true });
    expect(logs).toEqual(["记忆的设置改了：顺口问关了"]);
    settings.change({ wovenQuestions: false });
    expect(logs).toHaveLength(1);

    const again = createMemorySettings({ file, log: () => {} });
    again.start();
    expect(again.current()).toEqual({ wovenQuestions: false, memoryBrief: true, interviewInvites: true });

    // 266 号票：改哪项给哪项，没给的照旧
    expect(again.change({ memoryBrief: false })).toEqual({ wovenQuestions: false, memoryBrief: false, interviewInvites: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, wovenQuestions: false, memoryBrief: false, interviewInvites: true });

    // 284 号票：约访开不开（约访卡上点"不想做了"会关掉）
    expect(again.change({ interviewInvites: false })).toEqual({ wovenQuestions: false, memoryBrief: false, interviewInvites: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, wovenQuestions: false, memoryBrief: false, interviewInvites: false });
  });

  it("266 号票以前写的文件没有记忆简报那一项、284 号票以前的没有约访那一项：按默认（开着）", () => {
    const file = path.join(makeTempDir("ergo-memory-settings-"), "config", "memory-settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"format":1,"wovenQuestions":false}');
    const settings = createMemorySettings({ file, log: () => {} });
    settings.start();
    expect(settings.current()).toEqual({ wovenQuestions: false, memoryBrief: true, interviewInvites: true });
  });

  it("文件坏了：按默认用、记一行日志、不覆盖它", () => {
    const file = path.join(makeTempDir("ergo-memory-settings-"), "config", "memory-settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"format":1,"wovenQuestions":"no"}');
    const logs: string[] = [];
    const settings = createMemorySettings({ file, log: (line) => logs.push(line) });
    settings.start();
    expect(settings.current()).toEqual({ wovenQuestions: true, memoryBrief: true, interviewInvites: true });
    expect(logs[0]).toMatch(/记忆的设置文件不对/);
    expect(fs.readFileSync(file, "utf8")).toBe('{"format":1,"wovenQuestions":"no"}');
  });
});
