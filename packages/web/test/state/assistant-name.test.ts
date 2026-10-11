// 前端状态层：个人助理的名字（43 号票）。名字频道上的 assistant_name 事件归并成现在的名字（没收到过是默认的"个人助理"）；
// 守护进程生成的话里的名字占位按现在的名字显示，所以改名后旧的话也跟着变。
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ASSISTANT_NAME_MARK,
  assistantInitial,
  assistantNameOf,
  CHANNELS,
  daemonTextPlain,
  daemonTextSegments,
  EVENT_TYPES,
  inboxEntries,
  reduce,
  replay,
  splitAssistantName,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";
import { frame, inboxItem, textMessage } from "./events.ts";

const named = (seq: number, name: string, source: "settings" | "config_file" = "settings") => frame(CHANNELS.assistantName, seq, EVENT_TYPES.assistantName, { name, source });

/** 一条消息的文字（只有一段文字的） */
const textOf = (state: UiState, index: number) => {
  const entry = state.conversations.secretary!.messages.at(index)!;
  const part = "message" in entry ? entry.message.parts[0] : undefined;
  return part?.type === "text" ? part.text : "";
};
/** 秘书会话里的一条消息、待办里的一条事项（回放用） */
const say = (seq: number, speaker: "user" | "agent" | "system", text: string): UiInput => ({
  kind: "frame",
  frame: frame(CHANNELS.secretary, seq, EVENT_TYPES.message, { message: textMessage(`m-${seq}`, speaker, text) }),
});
const inbox = (seq: number, source: string, body: string): UiInput => ({
  kind: "frame",
  frame: frame(CHANNELS.inbox, seq, EVENT_TYPES.inboxItem, { item: inboxItem(`i-${seq}`, { source, body }) }),
});
/** 会话里最后一条消息的文字，名字占位按现在的名字换好（界面上显示成带底色的小标签，这里只看换成了什么） */
const lastText = (state: UiState) => daemonTextPlain(textOf(state, -1), assistantNameOf(state));

describe("个人助理的名字", () => {
  test("没收到过名字事件：默认的\"个人助理\"", () => {
    expect(assistantNameOf(replay([]))).toBe("个人助理");
  });

  test("以最新的一条为准：设置页改的、启动时从配置文件读到的都一样", () => {
    expect(assistantNameOf(replay([named(1, "二狗")]))).toBe("二狗");
    expect(assistantNameOf(replay([named(1, "二狗"), named(2, "阿福", "config_file")]))).toBe("阿福");
    expect(assistantNameOf(replay([named(1, "二狗"), named(2, "个人助理")]))).toBe("个人助理");
  });

  test("重新同步名字频道：先回到默认，服务端从头补发后又是最新的", () => {
    const state = replay([named(1, "二狗")]);
    const resynced = reduce(state, { kind: "resync", channel: CHANNELS.assistantName });
    expect(assistantNameOf(resynced)).toBe("个人助理");
    expect(assistantNameOf(reduce(resynced, { kind: "frame", frame: named(1, "二狗") }))).toBe("二狗");
    // 别的频道重新同步不影响名字
    expect(assistantNameOf(reduce(state, { kind: "resync", channel: CHANNELS.secretary }))).toBe("二狗");
  });

  test("守护进程生成的话里的名字占位：按现在的名字显示，改名后旧的那条也跟着变", () => {
    const note = textMessage("m-1", "system", `上一条消息处理时中断了，${ASSISTANT_NAME_MARK}没有接着处理；需要的话请重发。`);
    const before = replay([named(1, "二狗"), frame(CHANNELS.secretary, 1, EVENT_TYPES.message, { message: note })]);
    expect(lastText(before)).toBe("上一条消息处理时中断了，二狗没有接着处理；需要的话请重发。");
    const after = reduce(before, { kind: "frame", frame: named(2, "阿福") });
    expect(lastText(after)).toBe("上一条消息处理时中断了，阿福没有接着处理；需要的话请重发。");
    // 界面按段画：名字那一段显示成带底色的小标签
    expect(splitAssistantName(note.parts[0]!.type === "text" ? note.parts[0]!.text : "")).toEqual([
      { text: "上一条消息处理时中断了，" },
      { name: true },
      { text: "没有接着处理；需要的话请重发。" },
    ]);
  });

  test("43 号票之前存下的旧数据：守护进程写死的那几句\"秘书\"按对照表显示成名字标签，用户和 agent 的原话不动", () => {
    const state = replay([
      { kind: "frame", frame: named(1, "二狗") },
      say(1, "user", "我的秘书对话记录在哪"),
      say(2, "agent", "我是你的秘书，在这儿"),
      say(3, "system", "上一条消息「我的秘书对话记录在哪」处理时中断了，秘书没有接着处理；需要的话请重发。"),
      inbox(1, "秘书对话", '秘书对话里要做的这件事守卫判定为"交给我做"，请你亲手完成'),
    ]);
    const shown = (text: string) => daemonTextPlain(text, assistantNameOf(state));
    // 系统说明：只换那句固定的话，引号里用户的原话不动
    expect(shown(textOf(state, -1))).toBe("上一条消息「我的秘书对话记录在哪」处理时中断了，二狗没有接着处理；需要的话请重发。");
    expect(daemonTextSegments(textOf(state, -1)).filter((s) => "name" in s)).toHaveLength(1);
    // 待办事项的来源和说明
    const [entry] = inboxEntries(state, "open");
    expect(daemonTextSegments(entry!.item.source)).toEqual([{ name: true }, { text: "对话" }]);
    expect(shown("body" in entry!.item ? (entry!.item.body ?? "") : "")).toBe('二狗对话里要做的这件事守卫判定为"交给我做"，请你亲手完成');
    // 改名后旧数据也跟着变
    const renamed = reduce(state, { kind: "frame", frame: named(2, "阿福") });
    expect(lastText(renamed)).toBe("上一条消息「我的秘书对话记录在哪」处理时中断了，阿福没有接着处理；需要的话请重发。");
    // 用户、agent 的话界面上原样显示（不经过 NamedText），就算拿去换也不在对照表里
    expect(daemonTextPlain(textOf(state, 0), "二狗")).toBe("我的秘书对话记录在哪");
    expect(daemonTextPlain(textOf(state, 1), "二狗")).toBe("我是你的秘书，在这儿");
  });
});

// 40 号票：名字的第一个字（暖纸手帐的圆形字头像画它；写成 CSS 字符串在界面层，见 test/ui/conversation-root.test.ts）
describe("名字的第一个字（字头像）", () => {
  test.each([
    ["个人助理", "个"],
    ["二狗", "二"],
    ["  阿福 ", "阿"],
    ["\n换行", "换"],
    ["🐶旺财", "🐶"],
    // 国旗是两个区域指示符，组合表情是几个表情加零宽连接符，é 是 e 加组合附加符号：都算一个字
    ["🇨🇳二狗", "🇨🇳"],
    ["👨‍👩‍👧小家", "👨‍👩‍👧"],
    ["élan", "é"],
    ["\u0007响铃", "\u0007"],
    ["", ""],
    ["   ", ""],
  ])("%j → %j", (name, initial) => {
    expect(assistantInitial(name)).toBe(initial);
  });

  describe("没有 Intl.Segmenter 的环境：退回按码点取", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    test.each([
      ["二狗", "二"],
      ["🐶旺财", "🐶"],
      // 退回之后国旗、组合表情只取到第一个码点
      ["🇨🇳二狗", "🇨"],
      ["👨‍👩‍👧小家", "👨"],
      ["", ""],
    ])("%j → %j", (name, initial) => {
      vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
      expect(assistantInitial(name)).toBe(initial);
    });
  });
});
