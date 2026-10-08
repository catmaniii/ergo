// "按住 说话"的手势（31 号票，state/voice-gesture.ts）：按住开始录、上划超过阈值进"松开取消"、抬手发送、
// 不到 1 秒不发、到 60 秒自动发、最后 10 秒倒计时、没有麦克风权限时提示。纯函数，按输入序列断言。
import { describe, expect, test } from "vitest";
import {
  initialVoiceGesture,
  VOICE_CANCEL_DISTANCE_PX,
  VOICE_LIVE_BARS,
  voiceCountdown,
  voiceGesture,
  type VoiceGestureEffect,
  type VoiceGestureInput,
  type VoiceGestureState,
  voiceGestureHint,
  voiceMicOpen,
  voicePanelStatus,
  waveformSummary,
} from "../../src/state/index.ts";

/** 依次喂输入，记下每一步的副作用 */
function run(inputs: readonly VoiceGestureInput[], from: VoiceGestureState = initialVoiceGesture): { state: VoiceGestureState; effects: VoiceGestureEffect[] } {
  let state = from;
  const effects: VoiceGestureEffect[] = [];
  for (const input of inputs) {
    const step = voiceGesture(state, input);
    state = step.state;
    if (step.effect) effects.push(step.effect);
  }
  return { state, effects };
}

const T0 = 10_000;
const pressed: VoiceGestureInput[] = [
  { kind: "press", y: 500 },
  { kind: "ready", time: T0 },
];

describe("按住 说话", () => {
  test("按住开始录（先要麦克风），录着的时候收音量：面板上显示当前音量和最近一小段滚动的波形", () => {
    const start = run([{ kind: "press", y: 500 }]);
    expect(start.effects).toEqual(["start"]);
    expect(start.state.phase).toBe("starting");
    const levels = Array.from({ length: VOICE_LIVE_BARS + 5 }, (_, i) => ({ kind: "level", level: (i % 10) / 10 }) as const);
    const { state } = run([...pressed, ...levels]);
    expect(state.phase).toBe("recording");
    expect(state.level).toBe(0.4);
    // 只留最新的几秒，旧的滚出去
    expect(state.live).toHaveLength(VOICE_LIVE_BARS);
    expect(state.live.at(-1)).toBe(0.4);
    expect(state.live[0]).toBe(0.5);
    expect(voiceGestureHint(state)).toBe("手指上划，取消发送");
  });

  test("抬手发送：时长从开始录算起，带上波形摘要", () => {
    const { state, effects } = run([...pressed, { kind: "level", level: 0.2 }, { kind: "level", level: 0.9 }, { kind: "tick", time: T0 + 2000 }, { kind: "release", time: T0 + 2400 }]);
    expect(effects).toEqual(["start", "send"]);
    expect(state.phase).toBe("idle");
    expect(state.sent).toEqual({ durationMs: 2400, waveform: [20, 90] });
    expect(state.notice).toBeUndefined();
  });

  test("按住上划超过阈值：显示「松开取消」，抬手不发送；划回来又能发", () => {
    const up = run([...pressed, { kind: "move", y: 500 - VOICE_CANCEL_DISTANCE_PX - 1 }]);
    expect(up.state.cancelZone).toBe(true);
    expect(voiceGestureHint(up.state)).toBe("松开手指，取消发送");
    expect(run([{ kind: "release", time: T0 + 3000 }], up.state).effects).toEqual(["discard"]);
    const back = run([{ kind: "move", y: 490 }, { kind: "release", time: T0 + 3000 }], up.state);
    expect(back.state.cancelZone).toBe(false);
    expect(back.effects).toEqual(["send"]);
  });

  test("不到 1 秒：提示「说话时间太短」，不发送（麦克风还没开始录就抬手也算）", () => {
    const short = run([...pressed, { kind: "release", time: T0 + 600 }]);
    expect(short.effects).toEqual(["start", "discard"]);
    expect(short.state.notice).toEqual({ kind: "too_short", text: "说话时间太短" });
    const tooEarly = run([{ kind: "press", y: 500 }, { kind: "release", time: T0 }]);
    expect(tooEarly.effects).toEqual(["start", "discard"]);
    expect(tooEarly.state.notice?.kind).toBe("too_short");
    // 麦克风晚一步才准备好：已经抬手了，不再进入录音
    expect(run([{ kind: "ready", time: T0 + 50 }], tooEarly.state).state.phase).toBe("idle");
    // 下一次按住时提示收起
    expect(run([{ kind: "press", y: 400 }], short.state).state.notice).toBeUndefined();
  });

  test("最后 10 秒倒计时，到 60 秒自动发送", () => {
    const at = (ms: number) => run([...pressed, { kind: "tick", time: T0 + ms }]);
    expect(voiceCountdown(at(49_000).state)).toBeUndefined();
    expect(voiceCountdown(at(50_100).state)).toBe(10);
    expect(voiceCountdown(at(58_200).state)).toBe(2);
    const full = at(60_000);
    expect(full.effects).toEqual(["start", "send"]);
    expect(full.state).toMatchObject({ phase: "idle", sent: { durationMs: 60_000 } });
    // 自动发送之后手指才抬起：什么都不做
    expect(run([{ kind: "release", time: T0 + 60_300 }], full.state).effects).toEqual([]);
  });

  test("到 60 秒时手指在取消区：不发送", () => {
    expect(run([...pressed, { kind: "move", y: 300 }, { kind: "tick", time: T0 + 60_000 }]).effects).toEqual(["start", "discard"]);
  });

  test("页面切到后台：正在录的这一段丢掉，不发送也不提示；没在录时什么都不做", () => {
    expect(run([...pressed, { kind: "tick", time: T0 + 5000 }, { kind: "abort" }])).toMatchObject({ effects: ["start", "discard"], state: { phase: "idle", notice: undefined } });
    expect(run([{ kind: "abort" }]).effects).toEqual([]);
  });

  test("没有麦克风权限：提示怎么开，不录", () => {
    const { state, effects } = run([{ kind: "press", y: 500 }, { kind: "error", reason: "denied", text: "没有麦克风权限：在浏览器地址栏左边的网站设置里允许使用麦克风" }]);
    expect(effects).toEqual(["start", "discard"]);
    expect(state).toMatchObject({ phase: "idle", notice: { kind: "denied", text: expect.stringMatching(/允许使用麦克风/) } });
  });
});

describe("麦克风只在按住时开着", () => {
  test("进语音模式不要麦克风；按下才要（start），抬手、上划取消、太短、切到后台、出错、到 60 秒自动发送都随即停掉（send / discard）", () => {
    expect(voiceMicOpen(initialVoiceGesture)).toBe(false);
    const endings: Array<[string, VoiceGestureInput[]]> = [
      ["抬手发送", [{ kind: "release", time: T0 + 2000 }]],
      ["上划取消", [{ kind: "move", y: 300 }, { kind: "release", time: T0 + 2000 }]],
      ["太短", [{ kind: "release", time: T0 + 300 }]],
      ["切到后台", [{ kind: "abort" }]],
      ["录音出错", [{ kind: "error", reason: "failed", text: "录音出错" }]],
      ["到 60 秒", [{ kind: "tick", time: T0 + 60_000 }]],
    ];
    for (const [name, inputs] of endings) {
      let state = initialVoiceGesture;
      const open: boolean[] = [];
      const effects: Array<VoiceGestureEffect | undefined> = [];
      for (const input of [...pressed, ...inputs]) {
        const step = voiceGesture(state, input);
        state = step.state;
        open.push(voiceMicOpen(state));
        effects.push(step.effect);
      }
      // 按下那一刻开（start），结束的那一步关，并且带着停掉麦克风的事（send / discard）
      expect({ name, first: effects[0], openWhileHeld: open.slice(0, -1).every(Boolean), openAtEnd: open.at(-1), last: effects.at(-1) }).toEqual({
        name,
        first: "start",
        openWhileHeld: true,
        openAtEnd: false,
        last: expect.stringMatching(/^(send|discard)$/),
      });
    }
  });

  test("麦克风就绪之前：面板显示「准备中」，时钟不走；就绪之后才从 0 开始计时，开头不会被吞掉", () => {
    const starting = run([{ kind: "press", y: 500 }, { kind: "tick", time: T0 - 800 }]);
    expect(voicePanelStatus(starting.state)).toBe("准备中");
    expect(starting.state.elapsedMs).toBe(0);
    // 晚了 0.8 秒才就绪：从就绪那一刻起算，抬手时录了 1.2 秒，够 1 秒
    const ready = run([{ kind: "ready", time: T0 }, { kind: "tick", time: T0 + 1000 }], starting.state);
    expect(voicePanelStatus(ready.state)).toBe("0:01");
    expect(run([{ kind: "release", time: T0 + 1200 }], ready.state)).toMatchObject({ effects: ["send"], state: { sent: { durationMs: 1200 } } });
    // 最后 10 秒是倒计时
    expect(voicePanelStatus(run([...pressed, { kind: "tick", time: T0 + 52_500 }]).state)).toBe("还可以说 8 秒");
  });
});

describe("波形摘要", () => {
  test("按格取每段的最大音量，换成 0–100 的整数，最多 32 格", () => {
    expect(waveformSummary([])).toEqual([]);
    expect(waveformSummary([0.1, 0.5, 1.2])).toEqual([10, 50, 100]);
    const many = Array.from({ length: 640 }, (_, i) => (i % 20 === 0 ? 0.8 : 0.1));
    const summary = waveformSummary(many);
    expect(summary).toHaveLength(32);
    expect(summary.every((v) => v === 80)).toBe(true);
  });
});
