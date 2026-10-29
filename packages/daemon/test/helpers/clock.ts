// 手动拨的时钟：主切面和调度器测试用，到点不靠真等。
// 交给 startTestDaemon({ clock })；拨到某个时刻时，途中到点的计时器按时间先后依次触发，
// 触发时 now() 正好是那个计时器的时刻（所以重复的提醒在一次拨动里能响好几次）。
import type { Clock } from "../../src/scheduler/clock.ts";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

export class ManualClock implements Clock {
  private current: number;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(start: Date | number) {
    this.current = typeof start === "number" ? start : start.getTime();
  }

  now(): number {
    return this.current;
  }

  setTimer(at: number, fn: () => void): () => void {
    const timer: Timer = { id: this.nextId++, at, fn };
    // 已经过了点的：尽快（下一轮事件循环）触发，和真的 setTimeout(…, 0) 一样不在登记的同一段代码里执行
    if (at <= this.current) {
      const handle = setTimeout(() => this.fire(timer), 0);
      return () => clearTimeout(handle);
    }
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /** 拨到某个时刻（只能往后拨） */
  advanceTo(target: Date | number): void {
    const to = typeof target === "number" ? target : target.getTime();
    if (to < this.current) throw new Error("时钟只能往后拨");
    for (;;) {
      const due = this.timers.filter((t) => t.at <= to).toSorted((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
    }
    this.current = to;
  }

  /** 往后拨一段（毫秒） */
  advance(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  /**
   * 跳到某个时刻，像电脑睡着又醒来：途中到点的计时器不在各自的时刻触发，而是醒来时按先后一起触发，
   * 触发时 now() 都是醒来的时刻（测"晚了才到点"）。
   */
  jumpTo(target: Date | number): void {
    const to = typeof target === "number" ? target : target.getTime();
    if (to < this.current) throw new Error("时钟只能往后拨");
    this.current = to;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= to).toSorted((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      due.fn();
    }
  }

  private fire(timer: Timer): void {
    timer.fn();
  }
}
