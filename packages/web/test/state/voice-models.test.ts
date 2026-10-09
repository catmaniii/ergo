// 设置 · 语音里两个语音模型的状态（45 号票：模型预热）：打开页面时经本机接口取一次，之后活动状态频道上推来的临时事件 voice_models
// 并进来，留新的；说明里写用的模型、设备、加载耗时，没开、出错写原因。
import { describe, expect, test } from "vitest";
import { replay, type VoiceModelState, type VoiceModelsView, voiceModelSummary } from "../../src/state/index.ts";
import { frame } from "./events.ts";

const SINCE = "2026-10-09T08:00:00+08:00";

function view(revision: number, recognizer: Partial<VoiceModelState>, speech: Partial<VoiceModelState> = { status: "waiting" }, startedAt = "2026-10-09T08:00:00+08:00"): VoiceModelsView {
  return {
    recognizerEngines: ["faster-whisper"],
    recognizerEngine: "faster-whisper",
    recognizer: { status: "waiting", since: SINCE, ...recognizer },
    speech: { status: "waiting", since: SINCE, ...speech },
    startedAt,
    revision,
  };
}

const pushed = (seq: number, v: VoiceModelsView) => frame("activity", seq, "voice_models", v);

describe("两个语音模型的状态", () => {
  test("经本机接口取回的和活动状态频道上推来的都并进状态层，留新的：同一次启动里版本大的；守护进程重启过的取后启动的", () => {
    const loading = view(2, { status: "loading" });
    const ready = view(3, { status: "ready", model: "large-v3", device: "cuda" });
    expect(replay([]).voiceModels).toBeUndefined();
    expect(replay([{ kind: "voice_models", view: loading }]).voiceModels).toEqual(loading);
    expect(replay([{ kind: "voice_models", view: loading }, { kind: "frame", frame: pushed(0, ready) }]).voiceModels).toEqual(ready);
    // 推来的已经更新了，接口晚到的旧结果不盖掉它
    expect(replay([{ kind: "frame", frame: pushed(0, ready) }, { kind: "voice_models", view: loading }]).voiceModels).toEqual(ready);
    // 守护进程重启过：后启动的那次的状态，哪怕版本小
    const restarted = view(1, { status: "waiting" }, {}, "2026-10-09T09:30:00+08:00");
    expect(replay([{ kind: "frame", frame: pushed(0, ready) }, { kind: "frame", frame: pushed(0, restarted) }]).voiceModels).toEqual(restarted);
    expect(replay([{ kind: "frame", frame: pushed(0, restarted) }, { kind: "voice_models", view: ready }]).voiceModels).toEqual(restarted);
    // 活动状态频道重新同步不清掉它（临时事件不补发）
    expect(replay([{ kind: "frame", frame: pushed(0, ready) }, { kind: "resync", channel: "activity" }]).voiceModels).toEqual(ready);
  });

  test("说明：已就绪的写用的模型、设备、加载耗时（识别退回了的带原因；合成写之前已经加载好还是这次加载的）；没开、出错的写原因", () => {
    expect(voiceModelSummary({ status: "ready", model: "large-v3", device: "cuda", computeType: "int8_float16", loadMs: 4200, since: SINCE })).toEqual({
      label: "已就绪",
      tone: "ok",
      detail: "large-v3 · cuda · int8_float16 · 加载用了 4.2 秒",
    });
    expect(voiceModelSummary({ status: "ready", model: "small", device: "cpu", computeType: "int8", loadMs: 900, fallbackReason: "没有可用的显卡", since: SINCE }).detail).toBe(
      "small · cpu · int8 · 加载用了 0.9 秒 · 退回的原因：没有可用的显卡",
    );
    expect(voiceModelSummary({ status: "ready", model: "fish_audio（audio.cpp/tts）", loadMs: 1234, alreadyLoaded: true, since: SINCE }).detail).toBe(
      "fish_audio（audio.cpp/tts） · 试合成用了 1.2 秒，模型之前已经加载好了",
    );
    expect(voiceModelSummary({ status: "ready", model: "fish_audio（audio.cpp/tts）", loadMs: 35_000, alreadyLoaded: false, since: SINCE }).detail).toBe(
      "fish_audio（audio.cpp/tts） · 加载用了 35.0 秒",
    );
    expect(voiceModelSummary({ status: "loading", since: SINCE })).toEqual({ label: "加载中", tone: "pending", detail: "正在加载模型" });
    expect(voiceModelSummary({ status: "off", reason: "语音合成服务没开（http://127.0.0.1:8090）", since: SINCE })).toEqual({
      label: "没开",
      tone: "problem",
      detail: "语音合成服务没开（http://127.0.0.1:8090）",
    });
    expect(voiceModelSummary({ status: "error", reason: "模型加载失败：no CUDA", since: SINCE })).toEqual({ label: "出错", tone: "problem", detail: "模型加载失败：no CUDA" });
    expect(voiceModelSummary({ status: "waiting", reason: "还没有参考音色：导入一个之后再预热", since: SINCE })).toMatchObject({ label: "等待加载", tone: "pending", detail: "还没有参考音色：导入一个之后再预热" });
    expect(voiceModelSummary({ status: "unloaded", since: SINCE })).toEqual({ label: "已卸载", tone: "idle", detail: "闲置退出了，下一条语音来了再加载" });
    expect(voiceModelSummary({ status: "busy", reason: "语音合成服务正忙（显卡在给别的任务用），稍后再试", since: SINCE })).toEqual({
      label: "忙",
      tone: "pending",
      detail: "语音合成服务正忙（显卡在给别的任务用），稍后再试",
    });
  });
});
