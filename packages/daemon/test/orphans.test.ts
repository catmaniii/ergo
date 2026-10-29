// 孤儿进程回收的判定（agent-manager/orphans.ts，12 号票；178 号票补了两条）：
// - 从活着的 agent 子进程顺着 Windows 父进程号走不到的是孤儿候选（findOrphans）；
// - 还在跑的工具调用期间起的进程这一轮不杀（reapable）：Git Bash 里管道各段、`bash 脚本` 的 Windows 父进程交接完就退了，
//   bash 其实还在等它们，按父进程号判会误杀（178 号票的根因）；
// - agent-browser 的守护进程（和它下面的 Chrome）跟着开它的 agent 走（用户 2026-10-19 定）：认得出的才留，认不准的照旧回收。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findOrphans,
  isAgentBrowserExe,
  ORPHAN_CREATION_MARGIN_MS,
  readBrowserDaemonPids,
  reapable,
  recognizedBrowserDaemons,
} from "../src/agent-manager/orphans.ts";
import { processCreationTimes, processSnapshot } from "../src/process/process-list.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

describe("findOrphans：从活着的 agent 子进程顺着父进程号走不到的", () => {
  // 100 是 agent 子进程；101 启动器 bash → 102 bash → 103 tail；
  // 201 是 Windows 父进程（200）已退的 bash（MSYS 交接后的样子），202、203 挂在它下面；300 的父进程不在 Job 里
  const parentOf = new Map([
    [100, 1],
    [101, 100],
    [102, 101],
    [103, 102],
    [201, 200],
    [202, 201],
    [203, 202],
    [300, 9999],
  ]);
  const job = [100, 101, 102, 103, 201, 202, 203, 300];

  it("走得到的不是孤儿；父进程已退的连同它下面整棵树都是", () => {
    expect(findOrphans(job, parentOf, new Set([100])).toSorted()).toEqual([201, 202, 203, 300]);
  });

  it("多给的根（认得出的 agent-browser 守护进程）连同它下面的都不算孤儿", () => {
    expect(findOrphans(job, parentOf, new Set([100, 201])).toSorted()).toEqual([300]);
  });
});

describe("reapable：还在跑的工具调用期间起的进程这一轮不杀（178 号票）", () => {
  const busySince = 1_000_000;
  const created = new Map([
    [1, busySince - ORPHAN_CREATION_MARGIN_MS - 1], // 早于最早那个调用开始（减去余量）：留下的孤儿，杀
    [2, busySince - ORPHAN_CREATION_MARGIN_MS + 1], // 在余量里：可能是那个调用起的，不杀
    [3, busySince + 5000], // 调用开始之后起的：不杀
  ]);

  it("没有在跑的调用：全都杀", () => {
    expect(reapable([1, 2, 3, 4], created, undefined)).toEqual([1, 2, 3, 4]);
  });

  it("有在跑的调用：只杀早于它开始（留 1 秒余量）起的；取不到创建时间的不杀", () => {
    expect(ORPHAN_CREATION_MARGIN_MS).toBe(1000);
    expect(reapable([1, 2, 3, 4], created, busySince)).toEqual([1]);
  });
});

describe("agent-browser 的守护进程：认得出的才留（用户 2026-10-19 定）", () => {
  it("可执行文件名按 agent-browser 开头认（不分大小写）", () => {
    for (const name of ["agent-browser-win32-x64.exe", "Agent-Browser.exe", "agent-browser"]) expect(isAgentBrowserExe(name)).toBe(true);
    for (const name of ["node.exe", "chrome.exe", "my-agent-browser.exe", ""]) expect(isAgentBrowserExe(name)).toBe(false);
  });

  it("pid 文件里写的、在 Job 里、可执行文件是 agent-browser 的才算；pid 被别的程序复用了、不在 Job 里的不算", () => {
    const exeOf = new Map([
      [10, "agent-browser-win32-x64.exe"],
      [11, "node.exe"],
      [12, "agent-browser-win32-x64.exe"],
      [13, "agent-browser-win32-x64.exe"],
    ]);
    // 10：认得出；11：pid 复用成了 node；12：不在 Job 里；13：在 Job 里但没有 pid 文件指着它（别处起的）
    expect(recognizedBrowserDaemons([10, 11, 12], [10, 11, 13], exeOf)).toEqual([10]);
  });

  it("从 socket 目录读 <会话>.pid：只认整数，别的文件、坏内容跳过；目录不在是空的", () => {
    const dir = makeTempDir("ergo-ab-sock-");
    fs.writeFileSync(path.join(dir, "default.pid"), "4242");
    fs.writeFileSync(path.join(dir, "work.pid"), "  777\r\n");
    fs.writeFileSync(path.join(dir, "bad.pid"), "abc");
    fs.writeFileSync(path.join(dir, "default.port"), "58729");
    fs.writeFileSync(path.join(dir, "default.target"), "{}");
    expect(readBrowserDaemonPids(dir).toSorted((a, b) => a - b)).toEqual([777, 4242]);
    expect(readBrowserDaemonPids(path.join(dir, "不在"))).toEqual([]);
  });
});

describe.runIf(process.platform === "win32")("进程快照和创建时间（Windows）", () => {
  it("快照里有父进程号和可执行文件名；创建时间按毫秒（和 Date.now 同一个钟）；不存在的进程取不到", () => {
    const self = processSnapshot().get(process.pid);
    expect(self?.parent).toBe(process.ppid);
    expect(self?.exe.toLowerCase()).toBe(path.basename(process.execPath).toLowerCase());
    const started = Date.now() - process.uptime() * 1000;
    const times = processCreationTimes([process.pid, 0x7ffffff0]);
    expect(Math.abs(times.get(process.pid)! - started)).toBeLessThan(2000);
    expect(times.has(0x7ffffff0)).toBe(false);
  });
});
