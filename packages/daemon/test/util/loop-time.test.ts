// 只数事件循环给了的时间的限时（437，src/util/loop-time.ts）：事件循环被卡住的那一大段只算一小下；到点了也先让这一轮把已经到了的
// I/O 收完；一直被卡着时墙上的时间过了限时的几倍照样到点。连接用系统挑的临时端口上的本机服务，不碰真的端口。
import net from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { afterLoopTime, LOOP_HARD_FACTOR, loopTimeoutSignal } from "../../src/util/loop-time.ts";
import { stall, startedInRequest } from "../helpers/event-loop.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 本机临时端口上听着的服务（用例结束时关掉） */
async function listening(): Promise<number> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

describe("afterLoopTime", () => {
  it("事件循环闲着时和 setTimeout 一样：到点叫一次；取消了就不叫", async () => {
    let fired = 0;
    const started = Date.now();
    afterLoopTime(60, () => (fired += 1), 20);
    await sleep(300);
    expect(fired).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);

    let cancelled = 0;
    const cancel = afterLoopTime(60, () => (cancelled += 1), 20);
    cancel();
    await sleep(150);
    expect(cancelled).toBe(0);
  });

  it("卡住的一大段只算一小下：限时 300 毫秒、刚开始就卡 1 秒，缓过来时还没到点，再过一会儿才到", async () => {
    let fired = false;
    afterLoopTime(300, () => (fired = true), 50);
    stall(1_000);
    await sleep(10);
    expect(fired).toBe(false);
    await sleep(800);
    expect(fired).toBe(true);
  });

  it("连接早就连上、只是还没轮到处理：在请求处理函数里起头、马上卡 800 毫秒——墙上的定时器先到点，只数事件循环给的照样是连接先到", async () => {
    const port = await listening();
    /** 连一下，限时 limit 毫秒：墙上的时间（setTimeout）或只数事件循环给的 */
    const race = (timer: "wall" | "loop", limit: number) =>
      new Promise<"connect" | "timeout">((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        let cancel: (() => void) | undefined;
        const done = (result: "connect" | "timeout") => {
          cancel?.();
          socket.destroy();
          resolve(result);
        };
        if (timer === "loop") cancel = afterLoopTime(limit, () => done("timeout"));
        else {
          const handle = setTimeout(() => done("timeout"), limit);
          cancel = () => clearTimeout(handle);
        }
        socket.once("connect", () => done("connect"));
        socket.once("error", () => done("timeout"));
      });
    // 对照：真机上"本机端口 8810：没人在听"就是这样来的
    expect(await startedInRequest(() => race("wall", 500), 800)).toBe("timeout");
    expect(await startedInRequest(() => race("loop", 500), 800)).toBe("connect");
    // 限时 100 毫秒：缓过来的头一眼就算到点了，也先收完已经到了的 I/O 再判
    expect(await startedInRequest(() => race("loop", 100), 800)).toBe("connect");
  });

  it("一直被卡着也有个头：墙上的时间过了限时的几倍照样到点", async () => {
    const seen = { fired: false };
    const started = Date.now();
    // 限时 100 毫秒、10 毫秒看一眼（一眼最多算 20 毫秒）：每一眼都被卡 150 毫秒的话，只数事件循环给的要 5 眼（750 毫秒）；
    // 墙上过了 400 毫秒（限时的 LOOP_HARD_FACTOR 倍）就到点
    afterLoopTime(100, () => (seen.fired = true), 10);
    while (!seen.fired && Date.now() - started < 5_000) {
      stall(150);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(seen.fired).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100 * LOOP_HARD_FACTOR);
    expect(Date.now() - started).toBeLessThan(5 * 150);
  });
});

describe("loopTimeoutSignal", () => {
  it("到点置位（TimeoutError）；clear 了就不置位", async () => {
    const timed = loopTimeoutSignal(50, 10);
    await sleep(300);
    expect(timed.signal.aborted).toBe(true);
    expect((timed.signal.reason as DOMException).name).toBe("TimeoutError");

    const cleared = loopTimeoutSignal(50, 10);
    cleared.clear();
    await sleep(200);
    expect(cleared.signal.aborted).toBe(false);
  });
});
