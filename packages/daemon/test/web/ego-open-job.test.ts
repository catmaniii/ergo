// 466 返修（"甲"）：二狗替 agent 打开的 ego lite 要像用户自己打开的一样——不在二狗的 Job 里，二狗停了、崩了也带不走它。
// 打开的办法是 openLikeUser（web/ego-open.ts）：`explorer.exe "<程序>"`，新起的 explorer 把它转给桌面外壳、自己退出。
// 这里核对的就是这一点，用假程序、不碰 ego lite：
//   建一个和二狗一样的 Job（KILL_ON_JOB_CLOSE、不许脱离）→ 在 Job 里起一个"闸门"进程 → 闸门在 Job 里调 openLikeUser 打开一个假程序
//   （一个 .cmd，跑一段睡着的 node 脚本，把自己的进程号写下来）→ 假程序不在 Job 里 → 关掉 Job，闸门没了、假程序还活着 → 测完杀掉。
// 只在 Windows、而且同一个会话里有桌面外壳时跑（没有桌面的测试机上跳过）：假程序会在桌面上弹一个控制台窗口，一两秒后被收掉。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { isProcessAlive, waitUntil } from "../helpers/process.ts";

const windows = process.platform === "win32";

/** 同一个会话里有没有桌面外壳（没有的话 explorer.exe 自己会成外壳、留在 Job 里，这条测不了） */
async function shellHere(): Promise<boolean> {
  if (!windows) return false;
  const { desktopShellRunning } = await import("../../src/web/ego-open.ts");
  return desktopShellRunning();
}

describe.runIf(windows)("替用户打开的程序不在二狗的 Job 里", () => {
  it("在 KILL_ON_JOB_CLOSE 的 Job 里交给桌面外壳打开的假程序：不在 Job 里，关掉 Job 之后还活着", async (ctx) => {
    if (!(await shellHere())) ctx.skip();
    const { createJobObject } = await import("../../src/process/job-object.ts");
    // 路径里带空格（真的在 C:\Program Files\Citro Labs\ego lite\Application 下）
    const dir = path.join(makeTempDir("ergo-ego-job-"), "Citro Labs", "ego lite");
    fs.mkdirSync(dir, { recursive: true });
    const pidFile = path.join(dir, "pid.json");
    // 假程序：睡着的 node 脚本（最多活 60 秒，测试中途崩了也不会一直留着），把自己的进程号写下来；不读标准输入
    fs.writeFileSync(path.join(dir, "sleeper.cjs"), `require("fs").writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid }));\nsetTimeout(() => {}, 60000);\n`);
    const fakeApp = path.join(dir, "fake-ego.cmd");
    fs.writeFileSync(fakeApp, `@echo off\r\n"${process.execPath}" "%~dp0sleeper.cjs"\r\n`);

    const job = createJobObject();
    let sleeper: number | undefined;
    try {
      expect(job.limits()).toEqual({ killOnClose: true, breakawayAllowed: false });
      // 闸门：先放进 Job，再从 stdin 收到"开"才调 openLikeUser（它之后起的一切本来都该在 Job 里）
      const egoOpen = pathToFileURL(path.join(import.meta.dirname, "..", "..", "src", "web", "ego-open.ts")).href;
      const gateScript = `process.stdin.once("data", async () => { const m = await import(${JSON.stringify(egoOpen)}); await m.openLikeUser(${JSON.stringify(fakeApp)}); process.stdout.write("opened\\n"); setTimeout(() => {}, 120000); });`;
      const gate = spawn(process.execPath, ["--input-type=module", "-e", gateScript], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
      job.assign(gate.pid!);
      expect(job.contains(gate.pid!)).toBe(true);
      gate.stdin.write("open\n");
      await waitUntil(() => fs.existsSync(pidFile), { timeoutMs: 20_000, describe: () => "假程序没起来" });
      sleeper = (JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid: number }).pid;
      expect(job.contains(sleeper)).toBe(false);
      expect(job.processIds()).not.toContain(sleeper);

      job.close();
      await waitUntil(() => !isProcessAlive(gate.pid!), { timeoutMs: 10_000, describe: () => "关掉 Job 之后闸门还活着" });
      // 再等一会儿：Job 里的都结束了，假程序照旧活着
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(isProcessAlive(sleeper)).toBe(true);
    } finally {
      job.close();
      if (sleeper !== undefined && isProcessAlive(sleeper)) process.kill(sleeper);
    }
    await waitUntil(() => !isProcessAlive(sleeper!), { timeoutMs: 10_000, describe: () => `假程序 ${sleeper} 没收掉` });
  }, 60_000);
});
