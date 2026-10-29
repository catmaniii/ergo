// 端口被谁占着（315 号票，process/port-owner.ts）：守护进程起动前查两个端口，被占时说清是谁（Windows 上查得到进程名和 PID）。
// 端口都是系统挑的临时端口，不碰 8810 / 8811。
import net from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { ownersText, portProblem } from "../src/process/port-owner.ts";
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
