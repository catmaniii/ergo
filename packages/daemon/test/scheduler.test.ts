// 调度器（规格第 13 节）：按 key 登记"到点要做的事"，时钟可注入。测试用手动拨的时钟，不靠真等。
import { describe, expect, test } from "vitest";
import { createScheduler } from "../src/scheduler/scheduler.ts";
import { ManualClock } from "./helpers/clock.ts";

const T0 = new Date(2026, 9, 7, 21, 0).getTime();
const MIN = 60_000;

describe("调度器", () => {
  test("拨到点时按时间先后执行，执行时时钟正好是那一刻；还没到的不执行", () => {
    const clock = new ManualClock(T0);
    const scheduler = createScheduler({ clock });
    const ran: string[] = [];
    scheduler.schedule("b", T0 + 20 * MIN, () => ran.push(`b@${(clock.now() - T0) / MIN}`));
    scheduler.schedule("a", T0 + 10 * MIN, () => ran.push(`a@${(clock.now() - T0) / MIN}`));
    scheduler.schedule("c", T0 + 60 * MIN, () => ran.push("c"));
    clock.advanceTo(T0 + 30 * MIN);
    expect(ran).toEqual(["a@10", "b@20"]);
    expect(scheduler.pending()).toEqual([{ key: "c", at: T0 + 60 * MIN }]);
    scheduler.stop();
  });

  test("同一个 key 再登记就换掉原来的；取消了就不再执行", () => {
    const clock = new ManualClock(T0);
    const scheduler = createScheduler({ clock });
    const ran: string[] = [];
    scheduler.schedule("r1", T0 + 10 * MIN, () => ran.push("旧的"));
    scheduler.schedule("r1", T0 + 15 * MIN, () => ran.push("新的"));
    scheduler.schedule("r2", T0 + 5 * MIN, () => ran.push("取消了的"));
    scheduler.cancel("r2");
    clock.advanceTo(T0 + 60 * MIN);
    expect(ran).toEqual(["新的"]);
    scheduler.stop();
  });

  test("执行时又登记了更晚的（重复的事）：同一次拨动里到点的也会执行", () => {
    const clock = new ManualClock(T0);
    const scheduler = createScheduler({ clock });
    const ran: number[] = [];
    const every10 = () => {
      ran.push((clock.now() - T0) / MIN);
      scheduler.schedule("tick", clock.now() + 10 * MIN, every10);
    };
    scheduler.schedule("tick", T0 + 10 * MIN, every10);
    clock.advanceTo(T0 + 35 * MIN);
    expect(ran).toEqual([10, 20, 30]);
    scheduler.stop();
  });

  test("登记时已经过了点的，尽快执行一次；执行出错只记日志，不影响别的", async () => {
    const clock = new ManualClock(T0);
    const logs: string[] = [];
    const scheduler = createScheduler({ clock, log: (line) => logs.push(line) });
    const ran: string[] = [];
    scheduler.schedule("late", T0 - 5 * MIN, () => ran.push("晚了的"));
    scheduler.schedule("bad", T0 - 1 * MIN, () => {
      throw new Error("坏了");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran).toEqual(["晚了的"]);
    expect(logs.join("\n")).toMatch(/bad[\s\S]*坏了/);
    scheduler.stop();
  });
});
