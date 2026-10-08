// 麦克风预热的开关时机（37 号票，state/voice-mic.ts）：进语音模式（页面在前台）就开着、不录；离开语音模式、页面切到后台就关；
// 回到前台、按下时再开；语音模式里闲置不关（44 号票）。自动要麦克风被拒过就不再自动要（按下照样要）。纯函数，表格和输入序列断言。
import { describe, expect, test } from "vitest";
import { initialVoiceMic, voiceMic, type VoiceMicInput, type VoiceMicState, voiceMicWanted } from "../../src/state/index.ts";

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

const enter: VoiceMicInput = { kind: "enter", visible: true, denied: false };
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
