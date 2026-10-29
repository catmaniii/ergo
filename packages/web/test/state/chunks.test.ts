// 90 号票评审：批量请求按协议上限分批交（看板一次 200 个、待办一次 500 条），结果按原来的先后接起来。
import { describe, expect, test } from "vitest";
import { INBOX_ACTION_MAX, inChunks, TASK_BATCH_MAX } from "../../src/state/index.ts";

describe("批量请求分批", () => {
  test("按上限切，保持先后；最后一批是剩下的", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `t-${i + 1}`);
    const batches = inChunks(ids, TASK_BATCH_MAX);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat()).toEqual(ids);
    expect(batches[1]![0]).toBe("t-201");
  });

  test("不超过上限的一批交完；正好上限的也是一批；空的没有批", () => {
    expect(inChunks(["a", "b"], INBOX_ACTION_MAX)).toEqual([["a", "b"]]);
    expect(inChunks(Array.from({ length: INBOX_ACTION_MAX }, (_, i) => i), INBOX_ACTION_MAX)).toHaveLength(1);
    expect(inChunks(Array.from({ length: INBOX_ACTION_MAX + 1 }, (_, i) => i), INBOX_ACTION_MAX).map((b) => b.length)).toEqual([INBOX_ACTION_MAX, 1]);
    expect(inChunks([], TASK_BATCH_MAX)).toEqual([]);
  });

  test("上限写错（0、负数、小数）也不会死循环", () => {
    expect(inChunks([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(inChunks([1, 2, 3], 2.7)).toEqual([[1, 2], [3]]);
  });

  test("协议上的上限", () => {
    expect(TASK_BATCH_MAX).toBe(200);
    expect(INBOX_ACTION_MAX).toBe(500);
  });
});
