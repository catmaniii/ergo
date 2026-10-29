// 流式增量的节流（规格第 5 节：每 100 毫秒最多一次）。主切面里按收到的时间量过一遍；
// 这里用假的钟把边界情形钉死：换了一条消息也不能在 100 毫秒内连推两帧。
import type { EventFrame, StreamEventPayload } from "@ergo/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStreamHub } from "../src/conversation/stream-hub.ts";

let frames: Array<{ at: number; frame: EventFrame }>;

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
});
afterEach(() => {
  vi.useRealTimers();
});

function hub() {
  const h = createStreamHub({ lastSeq: () => 7, now: () => Date.now() });
  h.onFrame((frame) => frames.push({ at: Date.now(), frame }));
  return h;
}

const deltas = (i: number) => (frames[i]!.frame.payload as StreamEventPayload).deltas;

describe("流式增量的节流", () => {
  test("第一段马上推；之后 100 毫秒内的攒成一帧，序号是频道最后一条落盘事件的序号", () => {
    const h = hub();
    h.delta("secretary", "m1", "text", "在");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.frame).toMatchObject({ channel: "secretary", seq: 7, type: "stream" });
    h.delta("secretary", "m1", "text", "的");
    h.delta("secretary", "m1", "text", "，");
    vi.advanceTimersByTime(99);
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(frames).toHaveLength(2);
    expect(deltas(1)).toEqual([{ part: 0, type: "text", offset: 1, text: "的，" }]);
  });

  test("换了一条消息，第一帧也要和上一帧隔开 100 毫秒", () => {
    const h = hub();
    h.delta("secretary", "m1", "text", "第一条");
    h.end("secretary", "m1");
    vi.advanceTimersByTime(30);
    h.delta("secretary", "m2", "text", "第二条");
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(69);
    expect(frames).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(frames.map((f) => [f.at, (f.frame.payload as StreamEventPayload).messageId])).toEqual([
      [frames[0]!.at, "m1"],
      [frames[0]!.at + 100, "m2"],
    ]);
  });

  test("消息定稿时还没推出去的增量直接丢掉", () => {
    const h = hub();
    h.delta("secretary", "m1", "reasoning", "想");
    h.delta("secretary", "m1", "text", "答");
    h.end("secretary", "m1");
    vi.advanceTimersByTime(500);
    expect(frames).toHaveLength(1);
    expect(deltas(0)).toEqual([{ part: 0, type: "reasoning", offset: 0, text: "想" }]);
  });

  test("不同会话各自节流", () => {
    const h = hub();
    h.delta("secretary", "m1", "text", "秘书");
    h.delta("maintainer:p-notes", "w1", "text", "维护者");
    expect(frames.map((f) => f.frame.channel)).toEqual(["secretary", "maintainer:p-notes"]);
  });
});
