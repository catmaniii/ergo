// 语音识别走 audio.cpp 时服务只收 WAV：浏览器录完先转好再交出去。
// 录音器（voice-recorder.ts）只管"交出去之前过一道、转不了照原样交"；做成 WAV 的算法在 voice-wav.ts；要不要转看 voice-format.ts。
// 真的解码（OfflineAudioContext）在 voice-browser.ts，要真浏览器，这里测不到。
import { afterEach, describe, expect, test } from "vitest";
import { noteRecognizerInput, recognizerWantsWav } from "../../src/app/voice-format.ts";
import type { MicRecorder, MicStream, VoiceMedia } from "../../src/app/voice-recorder.ts";
import { VoiceRecorder } from "../../src/app/voice-recorder.ts";
import { wavOfSamples } from "../../src/app/voice-wav.ts";

function fakeMedia(finishTake?: VoiceMedia["finishTake"], loud = true): VoiceMedia {
  const stream: MicStream = { getTracks: () => [{ readyState: "live", muted: false, stop() {}, addEventListener() {} }] };
  return {
    getUserMedia: () => Promise.resolve(stream),
    isTypeSupported: (mime) => mime === "audio/webm;codecs=opus",
    createMeter: () => ({
      size: 8,
      running: true,
      read: (buffer) => buffer.fill(loud ? 0.5 : 0),
      wake() {},
      close() {},
    }),
    createRecorder: (_stream, mimeType): MicRecorder => {
      const listeners = new Map<string, ((event: { data: Blob }) => void)[]>();
      const emit = (type: string, data = new Blob([])) => {
        for (const fn of listeners.get(type) ?? []) fn({ data });
      };
      return {
        state: "recording",
        mimeType: mimeType ?? "audio/webm",
        start() {},
        stop() {
          emit("dataavailable", new Blob(["opus-audio"], { type: mimeType }));
          emit("stop");
        },
        addEventListener(type, listener) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
      };
    },
    ...(finishTake ? { finishTake } : {}),
  };
}

async function record(media: VoiceMedia, levels = 8) {
  const recorder = new VoiceRecorder(media, () => 0);
  await recorder.open();
  recorder.begin({ pressedAt: 0, prewarmed: true });
  for (let i = 0; i < levels; i++) recorder.level();
  return recorder.stop();
}

describe("录好的一段交出去之前过一道", () => {
  test("没有这一道：照原样（webm）", async () => {
    const take = await record(fakeMedia());
    expect(take.mime).toBe("audio/webm;codecs=opus");
    expect(await take.blob.text()).toBe("opus-audio");
  });

  test("有这一道：交出去的是转好的，诊断照带", async () => {
    const seen: string[] = [];
    const take = await record(
      fakeMedia(async (input) => {
        seen.push(input.mime, await input.blob.text());
        return { blob: new Blob(["wav-bytes"], { type: "audio/wav" }), mime: "audio/wav" };
      }),
    );
    expect(seen).toEqual(["audio/webm;codecs=opus", "opus-audio"]);
    expect(take.mime).toBe("audio/wav");
    expect(await take.blob.text()).toBe("wav-bytes");
    expect(take.capture.prewarmed).toBe(true);
    expect(take.silent).toBe(false);
  });

  test("转不了：照原样交（守护进程那边还能用 ffmpeg 转），录音不能丢", async () => {
    const take = await record(fakeMedia(() => Promise.reject(new Error("解不了"))));
    expect(take.mime).toBe("audio/webm;codecs=opus");
    expect(await take.blob.text()).toBe("opus-audio");
  });

  test("整段静音的不转（反正不发）", async () => {
    let called = 0;
    const take = await record(
      fakeMedia(() => {
        called += 1;
        return Promise.reject(new Error("不该转"));
      }, false),
      60,
    );
    expect(take.silent).toBe(true);
    expect(called).toBe(0);
  });
});

describe("要不要转看守护进程说的", () => {
  afterEach(() => noteRecognizerInput(undefined));

  test("recognizerInput 是 wav 才转；换回去、还没取到都不转", () => {
    expect(recognizerWantsWav()).toBe(false);
    noteRecognizerInput({ recognizerInput: "wav" });
    expect(recognizerWantsWav()).toBe(true);
    noteRecognizerInput({});
    expect(recognizerWantsWav()).toBe(false);
    noteRecognizerInput({ recognizerInput: "wav" });
    noteRecognizerInput(undefined);
    expect(recognizerWantsWav()).toBe(false);
  });
});

describe("样本做成 WAV", () => {
  const view = (wav: Uint8Array) => new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = (wav: Uint8Array, at: number, length: number) => String.fromCharCode(...wav.subarray(at, at + length));

  test("16 位单声道：头对、样本按 -1 到 1 换算，超出的夹住", () => {
    const wav = wavOfSamples([new Float32Array([0, 1, -1, 2, -2])], 16_000);
    expect(text(wav, 0, 4)).toBe("RIFF");
    expect(text(wav, 8, 4)).toBe("WAVE");
    const v = view(wav);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32767, 32767, -32767]);
  });

  test("几个声道混成一个", () => {
    const wav = wavOfSamples([new Float32Array([1, 0.5]), new Float32Array([-1, 0.5])], 16_000);
    const v = view(wav);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 32767));
  });

  test("空的：只有头", () => {
    expect(wavOfSamples([], 16_000).length).toBe(44);
  });
});
