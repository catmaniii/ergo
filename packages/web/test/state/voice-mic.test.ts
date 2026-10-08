// 麦克风预热的开关时机（37 号票，state/voice-mic.ts）：进语音模式（页面在前台）就开着、不录；离开语音模式、页面切到后台、
// 闲置超过 10 分钟就关；回到前台、按下时再开。自动要麦克风被拒过就不再自动要（按下照样要）。纯函数，表格和输入序列断言。
import { describe, expect, test } from "vitest";
import { initialVoiceMic, VOICE_MIC_IDLE_MS, voiceMic, voiceMicIdleAt, type VoiceMicInput, type VoiceMicState, voiceMicWanted } from "../../src/state/index.ts";

const T0 = 1_000_000;
const MIN = 60_000;

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

const enter: VoiceMicInput = { kind: "enter", time: T0, visible: true, denied: false };

describe("什么时候开着、什么时候关", () => {
  test.each<[string, VoiceMicInput[], boolean]>([
    ["没进语音模式", [], false],
    ["进语音模式（页面在前台，包括打开页面时恢复成语音模式）", [enter], true],
    ["进语音模式时页面在后台", [{ ...enter, visible: false }], false],
    ["在后台进的语音模式，切回前台", [{ ...enter, visible: false }, { kind: "visibility", visible: true, time: T0 + MIN }], true],
    ["离开语音模式（切回文字、离开页面）", [enter, { kind: "leave" }], false],
    ["页面切到后台", [enter, { kind: "visibility", visible: false, time: T0 + MIN }], false],
    ["切到后台又回到前台", [enter, { kind: "visibility", visible: false, time: T0 + MIN }, { kind: "visibility", visible: true, time: T0 + 2 * MIN }], true],
    ["离开语音模式后页面回到前台：不开", [enter, { kind: "leave" }, { kind: "visibility", visible: true, time: T0 + MIN }], false],
    ["闲置不到 10 分钟", [enter, { kind: "tick", time: T0 + VOICE_MIC_IDLE_MS - 1 }], true],
    ["闲置满 10 分钟", [enter, { kind: "tick", time: T0 + VOICE_MIC_IDLE_MS }], false],
    ["闲置关掉后按下：要麦克风", [enter, { kind: "tick", time: T0 + VOICE_MIC_IDLE_MS }, { kind: "hold", held: true, time: T0 + 11 * MIN }], true],
    ["闲置关掉后回到前台：重新预热", [enter, { kind: "tick", time: T0 + VOICE_MIC_IDLE_MS }, { kind: "visibility", visible: false, time: T0 + 11 * MIN }, { kind: "visibility", visible: true, time: T0 + 12 * MIN }], true],
    ["按着的时候不算闲置", [enter, { kind: "hold", held: true, time: T0 + MIN }, { kind: "tick", time: T0 + 30 * MIN }], true],
    ["按着的时候切到后台：关", [enter, { kind: "hold", held: true, time: T0 + MIN }, { kind: "visibility", visible: false, time: T0 + 2 * MIN }], false],
  ])("%s", (_name, inputs, wanted) => {
    expect(voiceMicWanted(run(inputs))).toBe(wanted);
  });

  test("闲置从最后一次用到算起（进语音模式、回到前台、按下、抬手）：录完一条，再过 10 分钟才关", () => {
    const used = run([enter, { kind: "hold", held: true, time: T0 + 4 * MIN }, { kind: "hold", held: false, time: T0 + 5 * MIN }]);
    expect(voiceMicIdleAt(used)).toBe(T0 + 5 * MIN + VOICE_MIC_IDLE_MS);
    expect(voiceMicWanted(run([{ kind: "tick", time: T0 + 14 * MIN }], used))).toBe(true);
    expect(voiceMicWanted(run([{ kind: "tick", time: T0 + 15 * MIN }], used))).toBe(false);
    // 按着的时候没有闲置的期限；关着的也没有
    expect(voiceMicIdleAt(run([enter, { kind: "hold", held: true, time: T0 + MIN }]))).toBeUndefined();
    expect(voiceMicIdleAt(run([enter, { kind: "visibility", visible: false, time: T0 + MIN }]))).toBeUndefined();
    expect(voiceMicIdleAt(initialVoiceMic)).toBeUndefined();
  });
});

describe("权限", () => {
  test("自动要麦克风被拒：不再自动要（切后台再回来、重新进语音模式都不弹）；按下照样要，要到了恢复预热", () => {
    const denied = run([enter, { kind: "denied" }]);
    expect(voiceMicWanted(denied)).toBe(false);
    expect(denied.denied).toBe(true);
    expect(wantedAlong([{ kind: "visibility", visible: false, time: T0 + MIN }, { kind: "visibility", visible: true, time: T0 + 2 * MIN }], denied)).toEqual([false, false]);
    // 重新进语音模式：拒过的记在页面上（enter 带着 denied）
    expect(voiceMicWanted(run([{ kind: "leave" }, { ...enter, time: T0 + 3 * MIN, denied: true }], denied))).toBe(false);
    // 按下：用户自己的动作，照样要；又被拒了，这一段随之结束（不会因为还按着又要一次），不再自动要
    expect(wantedAlong([{ kind: "hold", held: true, time: T0 + 4 * MIN }, { kind: "denied" }, { kind: "hold", held: false, time: T0 + 4 * MIN }], denied)).toEqual([true, false, false]);
    // 按下时要到了：之后照常预热
    const granted = run([{ kind: "hold", held: true, time: T0 + 5 * MIN }, { kind: "granted" }, { kind: "hold", held: false, time: T0 + 6 * MIN }], denied);
    expect(granted.denied).toBe(false);
    expect(voiceMicWanted(granted)).toBe(true);
  });

  test("自动打开失败（没有麦克风、被别的程序占着）：先关着不反复试，按下、回到前台、重新进语音模式时再试", () => {
    const failed = run([enter, { kind: "failed" }]);
    expect(voiceMicWanted(failed)).toBe(false);
    expect(voiceMicWanted(run([{ kind: "hold", held: true, time: T0 + MIN }], failed))).toBe(true);
    // 按下时又失败了：这一段结束，抬手后接着歇着，不反复试
    expect(wantedAlong([{ kind: "hold", held: true, time: T0 + MIN }, { kind: "failed" }, { kind: "hold", held: false, time: T0 + MIN }], failed)).toEqual([true, false, false]);
    expect(voiceMicWanted(run([{ kind: "visibility", visible: false, time: T0 + MIN }, { kind: "visibility", visible: true, time: T0 + 2 * MIN }], failed))).toBe(true);
    expect(voiceMicWanted(run([{ kind: "leave" }, { ...enter, time: T0 + MIN }], failed))).toBe(true);
  });
});
