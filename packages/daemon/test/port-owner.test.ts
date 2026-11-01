// 端口被谁占着（process/port-owner.ts）：守护进程起动前查两个端口，被占时说清是谁（Windows 上查得到进程名和 PID）。
// netstat 靠不住时也要认得出谁在听：假输出和服务管家的 packages/supervisor/tests/netstat.test.mjs 同构。
// 端口都是系统挑的临时端口，不碰 8810 / 8811。
import net from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { type ListenerLookup, type ListenRow, listeningPids, ownersText, parseNetstat, portOccupied, portProblem, systemListenRows } from "../src/process/port-owner.ts";
import { freePort } from "./helpers/ports.ts";

async function hold(port: number, host: string): Promise<void> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

describe("端口被谁占着", () => {
  it("空着的端口没问题；被占着的说是被占着", async () => {
    const port = await freePort();
    expect(await portProblem(port)).toBeUndefined();
    await hold(port, "127.0.0.1");
    expect((await portProblem(port))?.kind).toBe("in_use");
  });

  it.skipIf(process.platform !== "win32")("Windows 上带上占着它的进程（这里是跑测试的 node.exe 自己）", async () => {
    const port = await freePort();
    await hold(port, "127.0.0.1");
    const problem = await portProblem(port);
    expect(problem?.owners).toEqual([{ pid: process.pid, name: "node.exe" }]);
    expect(ownersText(problem!.owners)).toBe(`node.exe（PID ${process.pid}）`);
  });

  it.skipIf(process.platform !== "win32")("别的程序听在 0.0.0.0 上也算被占着（netstat 看得出来）", async () => {
    const port = await freePort();
    await hold(port, "0.0.0.0");
    expect(await portProblem(port)).toMatchObject({ kind: "in_use", owners: [{ pid: process.pid }] });
  });

  it("占着它的进程写成给人看的：查不到名字的只写 PID，一个都查不到是 undefined", () => {
    expect(ownersText([])).toBeUndefined();
    expect(ownersText([{ pid: 12, name: "a.exe" }, { pid: 34 }])).toBe("a.exe（PID 12）、PID 34");
  });
});

// 和那天的真输出同构：监听 socket 被报成 CLOSED / FIN_WAIT_1，外部地址仍是通配。表头是 GBK 被当 UTF-8 读出来的乱码
const NETSTAT = [
  "",
  "������",
  "",
  "  ����  �������          ����        ���           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1200",
  "  TCP    127.0.0.1:7420         0.0.0.0:0              CLOSED          6304",
  "  TCP    127.0.0.1:47890        0.0.0.0:0              FIN_WAIT_1      18924",
  "  TCP    [::]:3389              [::]:0                 CLOSED          7256",
  "  TCP    0.0.0.0:6000           *:*                    CLOSED          900",
  "  TCP    127.0.0.1:47890        127.0.0.1:50648        ESTABLISHED     18924",
  "  TCP    127.0.0.1:50648        127.0.0.1:47890        ESTABLISHED     6304",
  "  TCP    127.0.0.1:50582        127.0.0.1:47823        TIME_WAIT       0",
  // 2026-11-01 实测：外部地址 127.0.0.1:0、PID 0 的 LISTENING（看样子是结束了的连接被乱报），不是有人在听
  "  TCP    127.0.0.1:47823        127.0.0.1:0            LISTENING       0",
].join("\r\n");

const listening = (port: number, pid: number) => `  TCP    127.0.0.1:${port}      0.0.0.0:0      LISTENING     ${pid}`;
const misreported = (port: number, pid: number, state = "CLOSED") => `  TCP    127.0.0.1:${port}      0.0.0.0:0      ${state}     ${pid}`;

/** 假的 netstat：一眼一份输出，看完了一直给最后一份；数着看了几眼 */
function fakeNetstat(...outputs: string[]) {
  let count = 0;
  return {
    look: () => outputs[Math.min(count++, outputs.length - 1)] ?? "",
    looks: () => count,
  };
}

describe("解析 netstat（判定和服务管家一致）", () => {
  it("LISTENING 照常算；外部地址是通配、状态报错的算可疑的监听行；真连接和 PID 0 的不算；不看表头", () => {
    expect(parseNetstat(NETSTAT)).toEqual([
      { port: 135, addr: "0.0.0.0", pid: 1200, suspect: false },
      { port: 7420, addr: "127.0.0.1", pid: 6304, suspect: true },
      { port: 47890, addr: "127.0.0.1", pid: 18924, suspect: true },
      { port: 3389, addr: "[::]", pid: 7256, suspect: true },
      { port: 6000, addr: "0.0.0.0", pid: 900, suspect: true },
    ]);
  });

  it("命令没输出、全是表头：一行也没有", () => {
    expect(parseNetstat("")).toEqual([]);
    expect(parseNetstat("��\r\n  ��  PID\r\n")).toEqual([]);
  });
});

describe("谁在听这个端口（netstat 靠不住时）", () => {
  // 系统的连接表：测试里默认什么也没有，要用它的用例自己给
  const noTable = (): ListenRow[] => [];
  const options = (look: () => string, more: ListenerLookup = {}): ListenerLookup => ({ look, table: noTable, intervalMs: 0, known: true, ...more });

  it("状态是 LISTENING：这一眼就算，不用已知有人在听，也不多看", async () => {
    const netstat = fakeNetstat(listening(5000, 42));
    expect(await listeningPids(5000, options(netstat.look, { known: false }))).toEqual([42]);
    expect(netstat.looks()).toBe(1);
  });

  it("状态乱报：已知有人在听才认这一行；端口其实空着（残留的行）不认", async () => {
    for (const state of ["CLOSED", "FIN_WAIT_1"]) {
      const netstat = fakeNetstat(misreported(5000, 42, state));
      expect(await listeningPids(5000, options(netstat.look))).toEqual([42]);
      expect(netstat.looks()).toBe(1);
      expect(await listeningPids(5000, options(netstat.look, { known: false }))).toEqual([]);
    }
  });

  it("这一行这一眼缺失、下一眼才有：多看几眼，哪一眼找到就用哪一眼", async () => {
    const netstat = fakeNetstat("", NETSTAT, misreported(5000, 42), listening(5000, 99));
    expect(await listeningPids(5000, options(netstat.look))).toEqual([42]);
    expect(netstat.looks()).toBe(3);
  });

  it("一直没有：看到上限就停，不瞎认进程，交回空的", async () => {
    const netstat = fakeNetstat(NETSTAT);
    expect(await listeningPids(5000, options(netstat.look, { looks: 4 }))).toEqual([]);
    expect(netstat.looks()).toBe(4);
  });

  it("不知道有人在听：只看一眼，这一眼没有就是没有", async () => {
    const netstat = fakeNetstat("", listening(5000, 42));
    const table = () => [{ port: 5000, addr: "127.0.0.1", pid: 42, suspect: true }];
    expect(await listeningPids(5000, options(netstat.look, { known: false, table }))).toEqual([]);
    expect(netstat.looks()).toBe(1);
  });

  it("netstat 几眼都没有（2026-11-01 这台机器上次次如此）：问系统的连接表，同一个判定", async () => {
    const netstat = fakeNetstat("");
    const table = () => [
      { port: 5000, addr: "127.0.0.1", pid: 42, suspect: true },
      { port: 5000, addr: "192.168.8.4", pid: 77, suspect: true },
      { port: 5001, addr: "127.0.0.1", pid: 88, suspect: true },
    ];
    expect(await listeningPids(5000, options(netstat.look, { looks: 3, table }))).toEqual([42]);
    expect(netstat.looks()).toBe(3);
  });

  it("netstat 看到了就不问连接表", async () => {
    let asked = 0;
    const table = () => {
      asked++;
      return [{ port: 5000, addr: "127.0.0.1", pid: 77, suspect: true }];
    };
    expect(await listeningPids(5000, options(fakeNetstat(misreported(5000, 42)).look, { table }))).toEqual([42]);
    expect(asked).toBe(0);
  });

  it("默认只算 127.0.0.1 和 0.0.0.0（和二狗冲突的）；stop 钩子要所有地址", async () => {
    const out = ["  TCP    192.168.8.4:5000       0.0.0.0:0      LISTENING     7", listening(5000, 8)].join("\r\n");
    expect(await listeningPids(5000, options(fakeNetstat(out).look))).toEqual([8]);
    expect(await listeningPids(5000, options(fakeNetstat(out).look, { anyAddress: true }))).toEqual([7, 8]);
  });

  it("同一个进程好几行只算一次", async () => {
    const out = [listening(5000, 8), misreported(5000, 8), "  TCP    0.0.0.0:5000      0.0.0.0:0      LISTENING     8"].join("\r\n");
    expect(await listeningPids(5000, options(fakeNetstat(out).look))).toEqual([8]);
  });

  it.skipIf(process.platform !== "win32")("系统的连接表认得出真在听的端口（状态怎么报都算）：是跑测试的进程自己", async () => {
    const port = await freePort();
    await hold(port, "127.0.0.1");
    expect(systemListenRows().filter((r) => r.port === port)).toMatchObject([{ port, addr: "127.0.0.1", pid: process.pid }]);
  });
});

describe("端口占没占，以真绑、真连为准（netstat 说什么都不作数）", () => {
  const blind = { look: () => "", table: (): ListenRow[] => [], intervalMs: 0, looks: 2 };

  it("在听 127.0.0.1、0.0.0.0 都算占着；空着的不算", async () => {
    const port = await freePort();
    expect(await portOccupied(port)).toBe(false);
    await hold(port, "127.0.0.1");
    expect(await portOccupied(port)).toBe(true);
    const other = await freePort();
    await hold(other, "0.0.0.0");
    expect(await portOccupied(other)).toBe(true);
  });

  it("有人占着、怎么也查不到是谁：说被占着，不写是谁，不瞎认", async () => {
    for (const host of ["127.0.0.1", "0.0.0.0"]) {
      const port = await freePort();
      await hold(port, host);
      expect(await portProblem(port, blind)).toEqual({ kind: "in_use", owners: [] });
    }
  });

  it("端口其实空着、netstat 残留一行状态报错的：不算被占着", async () => {
    const port = await freePort();
    expect(await portProblem(port, { ...blind, look: () => misreported(port, 42) })).toBeUndefined();
  });

  it("状态报错的那一行也认得出是谁", async () => {
    const port = await freePort();
    await hold(port, "127.0.0.1");
    expect(await portProblem(port, { ...blind, look: () => misreported(port, process.pid) })).toMatchObject({ kind: "in_use", owners: [{ pid: process.pid }] });
  });
});
