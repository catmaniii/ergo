// 100 号票：任务做完的通知被打断后重新交时，上次那一轮念过没有——按这一轮（turn_start 的序号）认语音，语音记在这一轮收下的插话
// 那条上的也算、别的轮的不算；合成好（done、partial）的算念过，还在合成的等结局，没发出去的算没念。开着、关着的不并在一条里。
// 214 号票：语音插件没在运行时通知里不问要不要念。
import path from "node:path";
import { type AgentVoiceRecord, CHANNELS, EVENT_TYPES } from "@ergo/protocol";
import { describe, expect, onTestFinished, test } from "vitest";
import { openEventStore } from "../src/events/event-store.ts";
import { letterNoticeText } from "../src/secretary/letter-texts.ts";
import { announcedState, AUTO_ANNOUNCE_TAG, noticeTurnVoices, TASK_DONE_TAG, taskDoneNoticeText } from "../src/secretary/task-done.ts";
import { agentVoicesView } from "../src/voice-records/index.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const TIME = "2026-10-12T09:00:00.000+08:00";

function setup() {
  const store = openEventStore({ file: path.join(makeTempDir(), "ergo.db"), views: [agentVoicesView] });
  // 先关掉数据库，临时目录才删得掉
  onTestFinished(() => store.close());
  const turnStart = (inputMessageId: string) => store.append({ channel: CHANNELS.secretary, type: EVENT_TYPES.turnStart, payload: { inputMessageId } }).event.seq;
  const voice = (id: string, fields: Partial<AgentVoiceRecord>) => {
    const record: AgentVoiceRecord = {
      id,
      conversation: CHANNELS.secretary,
      scope: {},
      inputMessageId: "m-notice",
      replyMessageIds: [],
      mode: "tool",
      text: "要点",
      status: "synthesizing",
      createdAt: TIME,
      updatedAt: TIME,
      version: 1,
      ...fields,
    };
    store.append({ channel: CHANNELS.secretary, type: EVENT_TYPES.agentVoice, payload: { voice: record } });
  };
  return { store, turnStart, voice };
}

describe("上次那一轮的语音", () => {
  test("按这一轮的序号认：语音记在这一轮收下的插话那条上的也算，别的轮的不算", () => {
    const { store, turnStart, voice } = setup();
    const seq = turnStart("m-notice");
    // 处理通知时用户插了话：语音记在用户那条上
    voice("av-1", { inputMessageId: "m-user", turnSeq: seq });
    const other = turnStart("m-other");
    voice("av-2", { inputMessageId: "m-other", turnSeq: other });
    expect(noticeTurnVoices(store, "m-notice").map((v) => v.id)).toEqual(["av-1"]);
    expect(noticeTurnVoices(store, "m-nothing")).toEqual([]);
  });

  test("合成好（done、partial）的算念过；还在合成的等结局；没有、没发出去的算没念", () => {
    expect(announcedState([{ status: "done" }])).toBe("announced");
    expect(announcedState([{ status: "failed" }, { status: "partial" }])).toBe("announced");
    expect(announcedState([{ status: "synthesizing" }])).toBe("pending");
    expect(announcedState([{ status: "failed" }])).toBe("none");
    expect(announcedState([])).toBe("none");
  });
});

describe("开着、关着的不并在一条里", () => {
  test("全是开着的才打自动播报的标记；混着交进来的按关着的写（不放行语音）", () => {
    const on = { text: "普通任务 t-1「日报」在后台做完了。这件开了跑完自动播报。", announce: true };
    const off = { text: "普通任务 t-2「周报」在后台做完了。", announce: false };
    expect(taskDoneNoticeText([on]).startsWith(`${TASK_DONE_TAG}${AUTO_ANNOUNCE_TAG}`)).toBe(true);
    expect(taskDoneNoticeText([off]).startsWith(`${TASK_DONE_TAG}后台`)).toBe(true);
    const mixed = taskDoneNoticeText([on, off]);
    expect(mixed).not.toContain(AUTO_ANNOUNCE_TAG);
    expect(mixed).toContain("然后问“要我念给你听吗？”");
  });
});

describe("语音插件没在运行（214 号票）", () => {
  test("任务做完、维护者来信的通知只用文字说一声，不问要不要念、不提发语音；开着时照旧问", () => {
    const off = { text: "普通任务 t-2「周报」在后台做完了。", announce: false };
    const quiet = taskDoneNoticeText([off], false);
    expect(quiet).toContain("在主线里主动跟用户说一声：用一两句话说这件做完了、结果大概是什么。");
    expect(quiet).not.toContain("念给你听");
    expect(quiet).not.toContain("send_voice");
    expect(taskDoneNoticeText([off])).toBe(taskDoneNoticeText([off], true));
    const letter = letterNoticeText(["项目 p-1「记账本」的维护者说：导入做完了。"], false, false);
    expect(letter).toContain("不要追问。");
    expect(letter).not.toContain("念给你听");
    expect(letterNoticeText(["项目 p-1「记账本」的维护者说：导入做完了。"])).toContain("然后问“要我念给你听吗？”");
  });
});
