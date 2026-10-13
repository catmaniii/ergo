// 109 号票：秘书来了新消息要让用户知道——"秘书"页签的红点（已读位置存在守护进程、几台设备同步）、怎么算看过、
// 不在看秘书会话时秘书说完一轮在顶上提醒一条（一轮一条、语音合成好了再提醒、看着时不出）、打开时"秘书有 N 条新消息"、
// 不在时念的语音小栏（出现、放过了拿掉）。
// 先回放主切面录下的真实事件流：task-done-voice（定时任务跑完，秘书收到【任务做完】【跑完自动播报】——115 号票起后面跟着一条
// 交付的日报附件——，用 send_voice 念了一段、
// 附一行字；daemon/test/main/auto-voice-announce.test.ts）、send-voice（三轮：语音、语音加表、语音没发出去改用文字）、
// voice-reply（用户说语音，秘书回合结束之后才合成语音），再用手写的事件测录不出来的边角。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  type AgentVoiceRecord,
  alertNotifiesSystem,
  ASSISTANT_NAME_MARK as NAME,
  CHANNELS,
  chatItems,
  EVENT_TYPES,
  missedVoiceBar,
  missedVoicesAfterHeard,
  missedVoicesOnOpen,
  type PageAlert,
  reduce,
  replay,
  SECRETARY_TURN_ALERT,
  SECRETARY_UNREAD_ALERT,
  secretaryNavDot,
  secretaryReadSeq,
  secretaryTurnAlert,
  secretaryUnread,
  secretaryUnreadAlert,
  seenThrough,
  spokenDuration,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const SECRETARY = CHANNELS.secretary;

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

/** 守护进程推来的一条已读位置（已读位置频道上第 n 条） */
const markFrame = (n: number, seq: number): UiInput => ({ kind: "frame", frame: frame(CHANNELS.readMarks, n, EVENT_TYPES.readMark, { conversation: SECRETARY, seq, time: "2026-10-13T08:05:00.000+08:00" }) });
/** 秘书会话上的帧 */
const secretaryFrames = (inputs: UiInput[]) => inputs.filter((i) => i.kind === "frame" && i.frame.channel === SECRETARY);
/** 回放到秘书会话上第 seq 号的落盘事件为止（含它） */
function upToSeq(inputs: UiInput[], seq: number, from?: UiState): UiState {
  const at = inputs.findIndex((i) => i.kind === "frame" && i.frame.channel === SECRETARY && i.frame.seq === seq);
  expect(at).toBeGreaterThanOrEqual(0);
  return replay(inputs.slice(0, at + 1), from);
}
/** 没看过的，写成一行：种类和要点 */
const unreadLines = (state: UiState) => secretaryUnread(state).map((it) => `${it.seq} ${it.kind}`);
const NOT_VIEWING = { viewing: false } as const;
const VIEWING = { viewing: true } as const;
/** 回放之后对秘书说完的每一轮决定一次（界面上 useSecretaryAlerts 做的），出的提醒 */
function turnAlerts(state: UiState, env: { viewing: boolean } = NOT_VIEWING): Array<PageAlert | "wait" | undefined> {
  return state.secretaryTurns.map((since) => secretaryTurnAlert(state, since, env));
}

describe("回放：定时任务跑完，秘书念了一段语音、附一行字（task-done-voice）", () => {
  const inputs = load("task-done-voice");
  const state = replay(inputs);
  const voice = Object.values(state.agentVoices)[0]!;
  const voiceItem = chatItems(state, SECRETARY).find((it) => it.kind === "voice")!;

  test("已读位置是守护进程启动时记的 0（新装的空会话）；没看过的只有那个语音气泡：附的那行字收进了气泡，通知、工具调用不算", () => {
    expect(secretaryReadSeq(state)).toBe(0);
    expect(voice).toMatchObject({ mode: "tool", status: "done", coversReply: true });
    expect(unreadLines(state)).toEqual(["8 voice"]);
    expect(secretaryNavDot(state)).toBe(true);
  });

  test("还没收到已读位置（订阅之前、守护进程还没记）：当作全部看过，不亮红点", () => {
    const noMarks = replay(inputs.filter((i) => !(i.kind === "frame" && i.frame.channel === CHANNELS.readMarks)));
    expect(secretaryReadSeq(noMarks)).toBeUndefined();
    expect(secretaryUnread(noMarks)).toEqual([]);
    expect(secretaryNavDot(noMarks)).toBe(false);
  });

  test("看过了：这台设备看到最后（read_seen）红点马上消失；守护进程推来的已读位置（别的设备上看过）同样；只往后挪", () => {
    const seenHere = reduce(state, { kind: "read_seen", conversation: SECRETARY, seq: 12 });
    expect(secretaryNavDot(seenHere)).toBe(false);
    // 守护进程晚到的、靠前的那条不往回挪
    expect(secretaryReadSeq(reduce(seenHere, markFrame(2, 6)))).toBe(12);
    const seenElsewhere = reduce(state, markFrame(2, 12));
    expect(secretaryReadSeq(seenElsewhere)).toBe(12);
    expect(secretaryNavDot(seenElsewhere)).toBe(false);
    // 只看到语音之前：语音还算没看过
    expect(secretaryNavDot(reduce(state, markFrame(2, 6)))).toBe(true);
  });

  test("秘书说完一轮（实时收到的回合结束）：记下这一轮；不在看秘书会话时顶上提醒一条，标题是语音念的稿子的开头，查看去那个气泡", () => {
    expect(state.secretaryTurns).toEqual([3]);
    const [alert] = turnAlerts(state);
    expect(alert).toEqual({
      id: `${SECRETARY_TURN_ALERT}${voiceItem.id}`,
      title: `${NAME}：今天的 AI 新闻有三条要点：第一，新模型发布；第二，开源社区很热闹；第三，芯片又涨价了。链接在任务里。`,
      body: "语音 11 秒",
      secretary: { at: voiceItem.id, through: 8 },
    });
    // 正在看秘书会话：不提醒
    expect(turnAlerts(state, VIEWING)).toEqual([undefined]);
    // 决定过了：去掉
    expect(reduce(state, { kind: "secretary_turn_seen", since: 3 }).secretaryTurns).toEqual([]);
  });

  test("提醒进了顶上（和到点的提醒同一个框）；同一个 id 不重复出；别的设备上看过了（已读位置到了）拿掉，到点的提醒不动", () => {
    const alert = turnAlerts(state)[0] as PageAlert;
    const due = { id: "n-due", title: "到点：交周报", itemId: "i-due" };
    let s = reduce(state, { kind: "frame", frame: frame(CHANNELS.inbox, 0, EVENT_TYPES.notify, due) });
    s = reduce(s, { kind: "alert", alert });
    s = reduce(s, { kind: "alert", alert });
    expect(s.alerts.map((a) => a.id)).toEqual(["n-due", alert.id]);
    expect(reduce(s, markFrame(2, 6)).alerts.map((a) => a.id)).toEqual(["n-due", alert.id]);
    expect(reduce(s, markFrame(2, 8)).alerts.map((a) => a.id)).toEqual(["n-due"]);
  });

  test("系统通知：秘书说完一轮的提醒照常发；\"<名字>有 N 条新消息\"只在顶上框里出（切回、刷新页面时才生成，那几轮在后台时已经发过）", () => {
    expect(alertNotifiesSystem(turnAlerts(state)[0] as PageAlert)).toBe(true);
    expect(alertNotifiesSystem(secretaryUnreadAlert(state, NOT_VIEWING)!)).toBe(false);
    expect(alertNotifiesSystem({ id: "n-due", title: "到点：交周报", itemId: "i-due" })).toBe(true);
  });

  test("打开时（补发推完了）还没看过：出\"秘书有 1 条新消息\"，查看去第一条没看过的；看着秘书会话、都看过了不出", () => {
    expect(secretaryUnreadAlert(state, NOT_VIEWING)).toEqual({
      id: `${SECRETARY_UNREAD_ALERT}8`,
      title: `${NAME}有 1 条新消息`,
      body: `${NAME}：今天的 AI 新闻有三条要点：第一，新模型发布；第二，开源社区很热闹；第三，芯片又涨价了。链接在任务里。`,
      secretary: { at: voiceItem.id, through: 8 },
    });
    expect(secretaryUnreadAlert(state, VIEWING)).toBeUndefined();
    expect(secretaryUnreadAlert(reduce(state, markFrame(2, 12)), NOT_VIEWING)).toBeUndefined();
  });

  test("不在时念的语音：打开秘书会话时没看过、没放过的那段进小栏；放过了（点了播放、点了气泡）拿掉，小栏没了", () => {
    const ids = missedVoicesOnOpen(state, [], new Set());
    expect(ids).toEqual([voice.id]);
    expect(missedVoiceBar(state, ids)).toEqual({ voiceIds: [voice.id], text: `你不在时${NAME}念了 1 段语音（11 秒）`, firstItemId: voiceItem.id });
    // 打开之后看过了（已读位置挪到了最后）：小栏照旧，等放过才拿掉
    const read = reduce(state, { kind: "read_seen", conversation: SECRETARY, seq: 12 });
    expect(missedVoicesOnOpen(read, ids, new Set())).toBe(ids);
    expect(missedVoicesAfterHeard(ids, new Set([voice.id]))).toEqual([]);
    expect(missedVoiceBar(read, [])).toBeUndefined();
    // 已经看过的（下一次打开时）、这台设备上放过的（自动播了）不进小栏
    expect(missedVoicesOnOpen(read, [], new Set())).toEqual([]);
    expect(missedVoicesOnOpen(state, [], new Set([voice.id]))).toEqual([]);
  });
});

describe("回放：三轮语音（send-voice）", () => {
  const inputs = load("send-voice");
  // 这段录制没订阅已读位置：开头补一条，什么都没看过
  const state = replay([markFrame(1, 0), ...inputs]);

  test("一轮只出一条提醒，各说各的：第一轮语音；第二轮语音加一张表（还有 1 条）；第三轮语音没发出去，提醒秘书改用文字说的那句", () => {
    expect(state.secretaryTurns).toEqual([2, 11, 20]);
    const alerts = turnAlerts(state) as PageAlert[];
    expect(alerts.map((a) => [a.title, a.body, a.secretary?.through])).toEqual([
      [`${NAME}：明早九点开会，记得带上周报。`, "语音 3 秒", 5],
      [`${NAME}：明天的安排我列成表了，一共两件事。`, "语音 3 秒，还有 1 条", 16],
      [`${NAME}：语音服务忙，我用文字说：好的。`, undefined, 25],
    ]);
    expect(new Set(alerts.map((a) => a.id)).size).toBe(3);
  });

  test("打开时：没看过的一共 4 条（三个气泡里两个、表、改用文字的那句），查看去第一条", () => {
    expect(unreadLines(state)).toEqual(["5 voice", "14 voice", "16 reply", "25 reply"]);
    const summary = secretaryUnreadAlert(state, NOT_VIEWING)!;
    expect(summary).toMatchObject({ id: `${SECRETARY_UNREAD_ALERT}25`, title: `${NAME}有 4 条新消息`, body: `${NAME}：明早九点开会，记得带上周报。`, secretary: { through: 25 } });
    // "秘书有 N 条新消息"说到了所有没看过的：之前出的每一轮的提醒拿掉
    let s = state;
    for (const a of turnAlerts(state) as PageAlert[]) s = reduce(s, { kind: "alert", alert: a });
    expect(reduce(s, { kind: "alert", alert: summary }).alerts.map((a) => a.title)).toEqual([`${NAME}有 4 条新消息`]);
  });

  test("看到了第二轮的表（视口 40% 高处那一条）：之前的都算看过，第三轮的还没看过；停在最底部是全部看过", () => {
    const items = chatItems(state, SECRETARY);
    const table = items.find((it) => it.seq === 16)!;
    expect(seenThrough(items, table.id, false, state.cursors[SECRETARY])).toBe(16);
    expect(unreadLines(reduce(state, { kind: "read_seen", conversation: SECRETARY, seq: 16 }))).toEqual(["25 reply"]);
    expect(seenThrough(items, table.id, true, state.cursors[SECRETARY])).toBe(27);
    expect(seenThrough(items, "不在会话里的", false, 27)).toBeUndefined();
    expect(seenThrough(items, undefined, false, 27)).toBeUndefined();
    expect(seenThrough([], undefined, true, 27)).toBe(27);
  });

  test("不在时念的语音：三段里合成出来的两段，按先后；时长加起来", () => {
    const ids = missedVoicesOnOpen(state, [], new Set());
    expect(ids).toHaveLength(2);
    const total = ids.reduce((sum, id) => sum + state.agentVoices[id]!.durationMs!, 0);
    expect(missedVoiceBar(state, ids)?.text).toBe(`你不在时${NAME}念了 2 段语音（${spokenDuration(total)}）`);
    // 放了第一段：还剩第二段
    expect(missedVoicesAfterHeard(ids, new Set([ids[0]!]))).toEqual([ids[1]]);
  });
});

describe("回放：用户说语音，秘书回合结束之后才合成语音（voice-reply）", () => {
  const inputs = load("voice-reply");

  test("回合结束时语音还在回复、合成：先等着；合成好了提醒一条，标题是语音念的稿子", () => {
    const atTurnEnd = upToSeq([markFrame(1, 0), ...inputs], 8);
    expect(atTurnEnd.secretaryTurns).toEqual([5]);
    expect(turnAlerts(atTurnEnd)).toEqual(["wait"]);
    expect(turnAlerts(upToSeq([markFrame(1, 0), ...inputs], 9))).toEqual(["wait"]);
    // 合成好的那一版先到、带音频的消息晚一帧：这一轮的文字已经收进语音，气泡还没出来——接着等，不能当成"没有看得到的"丢掉
    expect(turnAlerts(upToSeq([markFrame(1, 0), ...inputs], 10))).toEqual(["wait"]);
    const done = upToSeq([markFrame(1, 0), ...inputs], 11);
    const [alert] = turnAlerts(done) as PageAlert[];
    expect(alert).toMatchObject({ title: `${NAME}：好的，明早九点提醒你交报告。`, body: "语音 3 秒", secretary: { through: 11 } });
  });

  test("语音没合成出来：不再等，提醒这一轮照常显示的文字", () => {
    // 第三轮：回合结束（32）、合成中（33）等着，没合成出来（34）就提醒那句文字
    const all = [markFrame(1, 0), ...inputs];
    expect(turnAlerts(upToSeq(all, 33)).at(-1)).toBe("wait");
    expect(turnAlerts(upToSeq(all, 34)).at(-1)).toMatchObject({ title: `${NAME}：好的，十分钟后提醒你喝水。` });
  });

  test("补发的（打开页面、重连时）回合结束不记：不在时来的另有\"秘书有 N 条新消息\"", () => {
    const caughtUp = replay([markFrame(1, 0), ...secretaryFrames(inputs).map((i) => ({ ...i, catchUp: true }) as UiInput)]);
    expect(caughtUp.secretaryTurns).toEqual([]);
    // 两个语音气泡，口语总结那一轮的全文照常显示，没合成出来的那一轮的文字
    expect(unreadLines(caughtUp)).toEqual(["11 voice", "18 reply", "24 voice", "31 reply"]);
    expect(secretaryUnreadAlert(caughtUp, NOT_VIEWING)?.title).toBe(`${NAME}有 4 条新消息`);
  });
});

describe("回放：分段合成的长语音（voice-reply-segments）", () => {
  const all = [markFrame(1, 0), ...load("voice-reply-segments")];

  test("第一段到了、几段到了还在合成，合成完了消息还没到：都接着等；气泡出来了才提醒，一轮一条", () => {
    for (const seq of [8, 9, 10, 11, 12, 13]) expect([seq, turnAlerts(upToSeq(all, seq))]).toEqual([seq, ["wait"]]);
    const [alert] = turnAlerts(upToSeq(all, 14)) as PageAlert[];
    expect(alert).toMatchObject({ body: "语音 11 秒", secretary: { through: 14 } });
  });

  test("只合成了一部分：消息到了就提醒（还有那条说明不算）", () => {
    expect(turnAlerts(upToSeq(all, 26)).at(-1)).toBe("wait");
    expect(turnAlerts(upToSeq(all, 27)).at(-1)).toMatchObject({ secretary: { through: 27 } });
  });
});

describe("手写的事件：卡片、补发推完了、重新同步", () => {
  const cardMessage = { id: "m-card", conversation: SECRETARY, speaker: "agent" as const, time: "2026-10-13T08:04:00+08:00", parts: [{ type: "card_ref" as const, cardId: "c-1" }] };
  const base: UiInput[] = [
    markFrame(1, 0),
    { kind: "frame", frame: frame(SECRETARY, 1, EVENT_TYPES.message, { message: textMessage("m-u", "user", "帮我建个提醒") }) },
    { kind: "frame", frame: frame(SECRETARY, 2, EVENT_TYPES.turnStart, { inputMessageId: "m-u" }) },
    { kind: "frame", frame: frame(SECRETARY, 3, EVENT_TYPES.message, { message: cardMessage }) },
    { kind: "frame", frame: frame(SECRETARY, 4, EVENT_TYPES.turnEnd, { inputMessageId: "m-u", outcome: "completed" }) },
  ];

  test("秘书出了一张卡：算没看过，提醒的查看去那张卡；用户自己说的话不算", () => {
    const state = replay(base);
    expect(unreadLines(state)).toEqual(["3 card"]);
    const [alert] = turnAlerts(state) as PageAlert[];
    expect(alert).toMatchObject({ title: `${NAME}：卡片`, secretary: { at: "c-1", through: 3 } });
  });

  test("补发推完了：连接报 synced 才算；断开、重新连上回到没推完", () => {
    let s = replay(base);
    expect(s.caughtUp).toBe(false);
    s = reduce(s, { kind: "synced" });
    expect(s.caughtUp).toBe(true);
    expect(reduce(s, { kind: "connection", status: "offline" }).caughtUp).toBe(false);
    s = reduce(reduce(s, { kind: "connection", status: "offline" }), { kind: "connection", status: "online" });
    expect(s.caughtUp).toBe(false);
    expect(reduce(s, { kind: "synced" }).caughtUp).toBe(true);
  });

  test("已读位置频道、秘书会话重新同步：已读位置、还没决定的回合清掉，跟着从头补发的来", () => {
    const state = replay(base);
    expect(replay([{ kind: "resync", channel: CHANNELS.readMarks }], state).readMarks).toEqual({});
    expect(replay([{ kind: "resync", channel: SECRETARY }], state).secretaryTurns).toEqual([]);
  });

  test("语音的时长念起来的样子", () => {
    expect(spokenDuration(400)).toBe("1 秒");
    expect(spokenDuration(10_800)).toBe("11 秒");
    expect(spokenDuration(66_000)).toBe("1 分 06 秒");
    expect(spokenDuration(600_000)).toBe("10 分 00 秒");
  });

  test("118 号票：附件挪到了文字后面——没看过的照显示的先后（文字在前）；提醒写文字的开头、查看去那段文字，说到的最后一条按序号算（不是排在最后的附件）", () => {
    const attachment = { id: "m-att", conversation: SECRETARY, speaker: "agent" as const, time: "2026-10-13T08:04:00+08:00", parts: [{ type: "file" as const, mediaId: "md-1", name: "周报.md", mime: "text/markdown", size: 10 }] };
    const state = replay([
      markFrame(1, 0),
      { kind: "frame", frame: frame(SECRETARY, 1, EVENT_TYPES.message, { message: textMessage("m-u", "user", "把周报发我") }) },
      { kind: "frame", frame: frame(SECRETARY, 2, EVENT_TYPES.turnStart, { inputMessageId: "m-u" }) },
      { kind: "frame", frame: frame(SECRETARY, 3, EVENT_TYPES.message, { message: attachment }) },
      { kind: "frame", frame: frame(SECRETARY, 4, EVENT_TYPES.message, { message: textMessage("m-r", "agent", "周报发你了，重点是下周的预算") }) },
      { kind: "frame", frame: frame(SECRETARY, 5, EVENT_TYPES.turnEnd, { inputMessageId: "m-u", outcome: "completed" }) },
    ]);
    expect(unreadLines(state)).toEqual(["4 reply", "3 reply"]);
    const [alert] = turnAlerts(state) as PageAlert[];
    expect(alert).toMatchObject({ title: `${NAME}：周报发你了，重点是下周的预算`, body: "还有 1 条", secretary: { at: "m-r", through: 4 } });
    expect(secretaryUnreadAlert(state, NOT_VIEWING)).toMatchObject({ id: `${SECRETARY_UNREAD_ALERT}4`, title: `${NAME}有 2 条新消息`, secretary: { at: "m-r", through: 4 } });
    // 看到那段文字（视口 40% 高处）：算到它的序号，排在它后面、序号更小的附件也算看过
    expect(seenThrough(chatItems(state, SECRETARY), "m-r", false, 5)).toBe(4);
  });

  test("语音被彻底删除了：小栏不再算它", () => {
    const v: AgentVoiceRecord = { id: "av-1", conversation: SECRETARY, scope: {}, inputMessageId: "m-u", replyMessageIds: [], status: "done", durationMs: 66_000, version: 1, createdAt: "", updatedAt: "" } as AgentVoiceRecord;
    const s = replay([...base, { kind: "frame", frame: frame(SECRETARY, 5, EVENT_TYPES.agentVoice, { voice: v }) }]);
    expect(missedVoiceBar(s, ["av-1", "av-gone"])?.text).toBe(`你不在时${NAME}念了 1 段语音（1 分 06 秒）`);
    expect(missedVoiceBar(s, ["av-gone"])).toBeUndefined();
  });
});
