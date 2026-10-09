// 麦克风预热的开关时机（37 号票，state/voice-mic.ts）：进语音模式（页面在前台）就开着、不录；离开语音模式、页面切到后台就关；
// 回到前台、按下时再开；语音模式里闲置不关（44 号票）。自动要麦克风被拒过就不再自动要（按下照样要）。
// 61 号票：打字、分屏时让路，焦点回来 0.5 秒后再预热；开关的原因；录到的是不是静音。纯函数，表格和输入序列断言。
import { describe, expect, test } from "vitest";
import {
  initialVoiceMic,
  isTextEntry,
  VOICE_MIC_RETURN_DELAY_MS,
  VOICE_SILENT_MIN_READS,
  VOICE_SILENT_PEAK,
  voiceMic,
  type VoiceMicCloseReason,
  voiceMicCloseReason,
  type VoiceMicInput,
  type VoiceMicOpenReason,
  voiceMicOpenReason,
  voiceMicReturnAt,
  type VoiceMicState,
  voiceMicWanted,
  voiceTakeSilent,
} from "../../src/state/index.ts";

function run(inputs: readonly VoiceMicInput[], from: VoiceMicState = initialVoiceMic): VoiceMicState {
  return inputs.reduce(voiceMic, from);
}

/** 依次喂输入，记下每一步之后麦克风该不该开着 */
function wantedAlong(inputs: readonly VoiceMicInput[], from: VoiceMicState = initialVoiceMic): boolean[] {
  const out: boolean[] = [];
  let state = from;
  for (const input of inputs) {
    state = voiceMic(state, input);
    out.push(voiceMicWanted(state));
  }
  return out;
}

const enter: VoiceMicInput = { kind: "enter", visible: true, focused: true, editing: false, denied: false };
const hidden: VoiceMicInput = { kind: "visibility", visible: false };
const shown: VoiceMicInput = { kind: "visibility", visible: true };
const press: VoiceMicInput = { kind: "hold", held: true };
const lift: VoiceMicInput = { kind: "hold", held: false };

describe("什么时候开着、什么时候关", () => {
  test.each<[string, VoiceMicInput[], boolean]>([
    ["没进语音模式", [], false],
    ["进语音模式（页面在前台，包括打开页面时恢复成语音模式）", [enter], true],
    ["进语音模式时页面在后台", [{ ...enter, visible: false }], false],
    ["在后台进的语音模式，切回前台", [{ ...enter, visible: false }, shown], true],
    ["离开语音模式（切回文字、离开页面）", [enter, { kind: "leave" }], false],
    ["页面切到后台", [enter, hidden], false],
    ["切到后台又回到前台", [enter, hidden, shown], true],
    ["离开语音模式后页面回到前台：不开", [enter, { kind: "leave" }, shown], false],
    ["按着的时候切到后台：关", [enter, press, hidden], false],
    ["语音模式里很久不按也不关（44 号票）：录完一条、再录一条，一直开着", [enter, press, lift, press, lift], true],
  ])("%s", (_name, inputs, wanted) => {
    expect(voiceMicWanted(run(inputs))).toBe(wanted);
  });
});

// 61 号票（用户 2026-10-09 反馈"麦克风被占用"，调研 docs/research/16 的方案一）：页面里可输入的元素拿到焦点、窗口失去焦点（分屏）时
// 立即放开麦克风，让系统输入法的语音能用；焦点回来 0.5 秒后（仍在语音模式、页面在前台）再预热。按住说话的时候焦点怎么变都不打断。
const T = 1_000_000;
const typing = (time = T): VoiceMicInput => ({ kind: "editing", editing: true, time });
const typed = (time = T): VoiceMicInput => ({ kind: "editing", editing: false, time });
const blurred = (time = T): VoiceMicInput => ({ kind: "focus", focused: false, time });
const refocused = (time = T): VoiceMicInput => ({ kind: "focus", focused: true, time });
const tick = (time: number): VoiceMicInput => ({ kind: "tick", time });
const D = VOICE_MIC_RETURN_DELAY_MS;

describe("让路：打字、分屏时放开，焦点回来 0.5 秒后再预热", () => {
  test("常量：焦点回来之后等 0.5 秒", () => {
    expect(VOICE_MIC_RETURN_DELAY_MS).toBe(500);
  });

  test.each<[string, VoiceMicInput[], boolean]>([
    ["输入框拿到焦点：放开", [enter, typing()], false],
    ["输入框失焦：还没到 0.5 秒先不开", [enter, typing(), typed(T + 1000), tick(T + 1000 + D - 1)], false],
    ["输入框失焦 0.5 秒后：重新预热", [enter, typing(), typed(T + 1000), tick(T + 1000 + D)], true],
    ["焦点从一个输入框跳到另一个：一直放着", [enter, typing(), typed(T + 100), typing(T + 120), tick(T + 100 + D)], false],
    ["跳过去又离开：从最后一次离开算 0.5 秒", [enter, typing(), typed(T + 100), typing(T + 120), typed(T + 300), tick(T + 100 + D)], false],
    ["跳过去又离开，最后一次离开 0.5 秒后：开", [enter, typing(), typed(T + 100), typing(T + 120), typed(T + 300), tick(T + 300 + D)], true],
    ["窗口失去焦点（分屏切到另一边）：放开", [enter, blurred()], false],
    ["窗口回来：还没到 0.5 秒先不开", [enter, blurred(), refocused(T + 50)], false],
    ["窗口回来 0.5 秒后：重新预热", [enter, blurred(), refocused(T + 50), tick(T + 50 + D)], true],
    ["窗口回来了但焦点还在输入框里：不开", [enter, typing(), blurred(), refocused(T + 50), tick(T + 50 + D)], false],
    ["输入框失焦时窗口没有焦点：等窗口回来再算 0.5 秒", [enter, typing(), blurred(), typed(T + 10), tick(T + 10 + D)], false],
    ["失焦后 0.5 秒到之前离开了语音模式：不开", [enter, typing(), typed(T + 10), { kind: "leave" }, tick(T + 10 + D)], false],
    ["失焦后 0.5 秒到之前切到后台：不开", [enter, typing(), typed(T + 10), hidden, tick(T + 10 + D)], false],
    ["进语音模式时焦点在输入框里：先不开", [{ ...enter, editing: true }], false],
    ["进语音模式时窗口没有焦点：先不开", [{ ...enter, focused: false }], false],
    ["进语音模式时焦点在输入框里，离开 0.5 秒后：开", [{ ...enter, editing: true }, typed(T), tick(T + D)], true],
    // 切到别的 App 时窗口也失去焦点，回来时 visibilitychange 和窗口的 focus 先后不定：都按回到前台算，马上预热
    ["从后台回来（走的时候先失焦、后切后台）：马上预热，不等 0.5 秒", [enter, blurred(), hidden, shown], true],
    ["从后台回来，窗口的 focus 先到：马上预热", [enter, hidden, blurred(T + 5), refocused(T + 10), shown], true],
    ["从后台回来，窗口的 focus 后到：不再加 0.5 秒", [enter, blurred(), hidden, shown, refocused(T + 10)], true],
  ])("%s", (_name, inputs, wanted) => {
    expect(voiceMicWanted(run(inputs))).toBe(wanted);
  });

  test("按住说话的时候焦点怎么变都不打断；抬手后照规矩来", () => {
    // 按着的时候：输入框拿到焦点、窗口失去焦点，都照样开着
    expect(wantedAlong([enter, press, typing(), blurred()])).toEqual([true, true, true, true]);
    // 抬手时焦点还在输入框里：放开
    expect(wantedAlong([enter, press, typing(), lift])).toEqual([true, true, true, false]);
    // 按下时焦点从输入框移到别处（"按住 说话"不是输入元素）：不等 0.5 秒，抬手后也接着开着
    expect(wantedAlong([enter, typing(), press, typed(T + 10), lift])).toEqual([true, false, true, true, true]);
  });

  test("刚回来还没到 0.5 秒就按下：马上要（这一段等准备中），抬手后接着开着", () => {
    expect(wantedAlong([enter, typing(), typed(T + 10), press, lift])).toEqual([true, false, false, true, true]);
  });

  test("什么时候该再看一眼：回来之后的那一刻", () => {
    expect(voiceMicReturnAt(run([enter]))).toBeUndefined();
    expect(voiceMicReturnAt(run([enter, typing(), typed(T + 10)]))).toBe(T + 10 + D);
    expect(voiceMicReturnAt(run([enter, blurred(), refocused(T + 20)]))).toBe(T + 20 + D);
    expect(voiceMicReturnAt(run([enter, typing(), typed(T + 10), tick(T + 10 + D)]))).toBeUndefined();
  });

  test("自动打开失败歇着的：窗口回来算回到前台，再试一次；输入框失焦不算", () => {
    const failed = run([enter, { kind: "failed" }]);
    expect(voiceMicWanted(run([blurred(), refocused(T + 10), tick(T + 10 + D)], failed))).toBe(true);
    expect(voiceMicWanted(run([typing(), typed(T + 10), tick(T + 10 + D)], failed))).toBe(false);
  });
});

describe("开麦、关麦的原因（诊断记录用）", () => {
  test.each<[string, VoiceMicInput[], VoiceMicInput, VoiceMicOpenReason]>([
    ["进语音模式", [], enter, "enter"],
    ["回到前台", [enter, hidden], shown, "visible"],
    ["从后台回来、窗口同时拿回焦点", [enter, blurred(), hidden], shown, "visible"],
    ["按下（之前没开着：歇着、被拒、在打字）", [enter, { kind: "failed" }], press, "press"],
    ["按下时本来就该开着：预热的流失效了才要重开", [enter], press, "stale"],
    ["输入框失焦 0.5 秒后", [enter, typing(), typed(T)], tick(T + D), "edit-out"],
    ["窗口回来 0.5 秒后", [enter, blurred(), refocused(T)], tick(T + D), "focus"],
    ["兜底 (a) 播完", [enter, { kind: "playback", playing: true }], { kind: "playback", playing: false }, "playback-end"],
  ])("开：%s", (_name, before, input, reason) => {
    expect(voiceMicOpenReason(run(before), input)).toBe(reason);
  });

  test.each<[string, VoiceMicInput[], VoiceMicCloseReason | undefined]>([
    ["该开着：没有", [enter], undefined],
    ["按着：没有（焦点怎么变都不关）", [enter, press, typing(), blurred()], undefined],
    ["离开语音模式", [enter, { kind: "leave" }], "leave"],
    ["切到后台", [enter, hidden], "hidden"],
    ["输入框拿到焦点", [enter, typing()], "edit-in"],
    ["窗口失去焦点", [enter, blurred()], "blur"],
    ["刚回来还在等", [enter, typing(), typed(T)], "returning"],
    ["兜底 (a) 在播", [enter, { kind: "playback", playing: true }], "playback"],
    ["要麦克风被拒", [enter, { kind: "denied" }], "denied"],
    ["打开失败歇着", [enter, { kind: "failed" }], "failed"],
  ])("关：%s", (_name, inputs, reason) => {
    const state = run(inputs);
    expect(voiceMicCloseReason(state)).toBe(reason);
    // 该不该开着和关麦的原因出自同一处
    expect(voiceMicWanted(state)).toBe(reason === undefined);
  });
});

describe("录到的是不是一段静音（录完时检查，是就不发）", () => {
  test("阈值：整段最大振幅低于 0.001（约 -60 dBFS）算静音；音量分析读到 5 次以上才判断", () => {
    expect(VOICE_SILENT_PEAK).toBe(0.001);
    expect(VOICE_SILENT_MIN_READS).toBe(5);
  });

  test.each<[string, { peak: number; reads: number }, boolean]>([
    ["全零（安卓上被别的应用占着时 Chrome 收到的）", { peak: 0, reads: 20 }, true],
    ["一直低于阈值", { peak: 0.0009, reads: 20 }, true],
    ["到了阈值", { peak: 0.001, reads: 20 }, false],
    ["小声说话", { peak: 0.02, reads: 20 }, false],
    ["正常说话", { peak: 0.4, reads: 20 }, false],
    ["只读到 4 次（判断不了）", { peak: 0, reads: 4 }, false],
    ["音量分析没在跑（iOS 上挂起，一次也没读到）", { peak: 0, reads: 0 }, false],
  ])("%s", (_name, levels, silent) => {
    expect(voiceTakeSilent(levels)).toBe(silent);
  });
});

describe("哪些元素算可输入的（拿到焦点就让路）", () => {
  test.each<[string, Parameters<typeof isTextEntry>[0], boolean]>([
    ["textarea", { tagName: "TEXTAREA" }, true],
    ["文字输入框", { tagName: "INPUT", type: "text" }, true],
    ["没写 type 的 input", { tagName: "INPUT" }, true],
    ["搜索框", { tagName: "INPUT", type: "search" }, true],
    ["邮箱", { tagName: "INPUT", type: "email" }, true],
    ["数字", { tagName: "INPUT", type: "number" }, true],
    ["contenteditable", { tagName: "DIV", isContentEditable: true }, true],
    ["按钮（包括按住 说话）", { tagName: "BUTTON" }, false],
    ["勾选框", { tagName: "INPUT", type: "checkbox" }, false],
    ["单选", { tagName: "INPUT", type: "radio" }, false],
    ["文件", { tagName: "INPUT", type: "file" }, false],
    ["日期（弹选择器，不弹键盘）", { tagName: "INPUT", type: "date" }, false],
    ["只读的 textarea", { tagName: "TEXTAREA", readOnly: true }, false],
    ["禁用的输入框", { tagName: "INPUT", type: "text", disabled: true }, false],
    ["下拉框", { tagName: "SELECT" }, false],
    ["页面本身（没有焦点）", { tagName: "BODY" }, false],
    ["什么都没有", null, false],
  ])("%s", (_name, el, editable) => {
    expect(isTextEntry(el)).toBe(editable);
  });
});

// 36 号票评审加的兜底 (a)（默认不开，app/voice-fallbacks.ts 打开时界面才送 playback）：播放语音时先关麦克风，播完再预热，
// 免得语音模式里开着的麦克风（回声消除）把播放拖进通话模式。代价：播放期间按下要等"准备中"。
const playing = (on: boolean): VoiceMicInput => ({ kind: "playback", playing: on });

describe("兜底 (a)：播放语音时关麦克风，播完再预热", () => {
  test.each<[string, VoiceMicInput[], boolean]>([
    ["在播：关", [enter, playing(true)], false],
    ["播完：重新预热", [enter, playing(true), playing(false)], true],
    ["在播的时候按下：照样要麦克风（这一段等准备中）", [enter, playing(true), press], true],
    ["按着的时候来了播放：不关", [enter, press, playing(true)], true],
    ["在播的时候进语音模式：先不开，播完再开", [playing(true), enter], false],
    ["不在语音模式：播完也不开", [playing(true), playing(false)], false],
  ])("%s", (_name, inputs, wanted) => {
    expect(voiceMicWanted(run(inputs))).toBe(wanted);
  });
});

describe("权限", () => {
  test("自动要麦克风被拒：不再自动要（切后台再回来、重新进语音模式都不弹）；按下照样要，要到了恢复预热", () => {
    const denied = run([enter, { kind: "denied" }]);
    expect(voiceMicWanted(denied)).toBe(false);
    expect(denied.denied).toBe(true);
    expect(wantedAlong([hidden, shown], denied)).toEqual([false, false]);
    // 重新进语音模式：拒过的记在页面上（enter 带着 denied）
    expect(voiceMicWanted(run([{ kind: "leave" }, { ...enter, denied: true }], denied))).toBe(false);
    // 按下：用户自己的动作，照样要；又被拒了，这一段随之结束（不会因为还按着又要一次），不再自动要
    expect(wantedAlong([press, { kind: "denied" }, lift], denied)).toEqual([true, false, false]);
    // 按下时要到了：之后照常预热
    const granted = run([press, { kind: "granted" }, lift], denied);
    expect(granted.denied).toBe(false);
    expect(voiceMicWanted(granted)).toBe(true);
  });

  test("自动打开失败（没有麦克风、被别的程序占着）：先关着不反复试，按下、回到前台、重新进语音模式时再试", () => {
    const failed = run([enter, { kind: "failed" }]);
    expect(voiceMicWanted(failed)).toBe(false);
    expect(voiceMicWanted(run([press], failed))).toBe(true);
    // 按下时又失败了：这一段结束，抬手后接着歇着，不反复试
    expect(wantedAlong([press, { kind: "failed" }, lift], failed)).toEqual([true, false, false]);
    expect(voiceMicWanted(run([hidden, shown], failed))).toBe(true);
    expect(voiceMicWanted(run([{ kind: "leave" }, enter], failed))).toBe(true);
  });
});
