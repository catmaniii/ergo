// 孤儿进程回收的判定（agent-manager/orphans.ts，补了两条）：
// - 从活着的 agent 子进程顺着 Windows 父进程号走不到的是孤儿候选（findOrphans）；
// - 还在跑的工具调用期间起的进程这一轮不杀（reapable）：Git Bash 里管道各段、`bash 脚本` 的 Windows 父进程交接完就退了，
//   bash 其实还在等它们，按父进程号判会误杀（根因）；
// - 466：ego lite 的进程（用户自己的浏览器）一律不杀：可执行文件在 ego lite 的程序目录下的（取不到路径的按名字）连同它下面的进程
//   都不算孤儿；agent-browser 的守护进程不再特别认（466 起 agent 不用它了）。
import path from "node:path";
import { describe, expect, it } from "vitest";
import { egoProcesses, findOrphans, ORPHAN_CREATION_MARGIN_MS, reapable } from "../src/agent-manager/orphans.ts";
import { processCreationTimes, processImagePaths, processSnapshot } from "../src/process/process-list.ts";
import { egoProgramDirs, isUnderDirs } from "../src/web/index.ts";

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

  it("多给的根（认出来的 ego lite 进程）连同它下面的都不算孤儿", () => {
    expect(findOrphans(job, parentOf, new Set([100, 201])).toSorted()).toEqual([300]);
  });
});

describe("reapable：还在跑的工具调用期间起的进程这一轮不杀", () => {
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

describe("466：ego lite 的进程一律不杀", () => {
  const EGO_ROOT = "C:\\Program Files\\Citro Labs\\ego lite";
  const dirs = [EGO_ROOT, "C:\\Users\\u\\.local\\share\\ego"];
  it("孤儿里可执行文件在 ego lite 程序目录下的认出来（不分大小写）；取不到路径的按名字（ego.exe、ego-browser.exe）；别的照旧是孤儿", () => {
    const imageOf = new Map([
      [1, "C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe"],
      [2, "c:\\program files\\citro labs\\EGO LITE\\Application\\0.6.3.14\\ego-browser.exe"],
      [3, "C:\\Program Files\\Citro Labs\\ego lite2\\ego.exe"],
      [4, "D:\\tools\\node.exe"],
    ]);
    const exeOf = new Map([
      [1, "ego.exe"],
      [2, "ego-browser.exe"],
      [3, "ego.exe"],
      [4, "node.exe"],
      [5, "ego.exe"],
      [6, "chrome.exe"],
    ]);
    // 5：取不到路径、名字是 ego.exe → 留；6：取不到路径、名字不是 → 照旧回收；3：路径在别的目录（名字一样也不算）
    expect(egoProcesses([1, 2, 3, 4, 5, 6], imageOf, exeOf, dirs)).toEqual([1, 2, 5]);
  });

  it("认出来的 ego 进程当根：它下面的进程也留着", () => {
    // 10 是 agent；20 是 ego.exe（拉起它的 ego-browser 已经退了），21、22 是它的子进程；30 是别的孤儿
    const parentOf = new Map([
      [10, 1],
      [20, 19],
      [21, 20],
      [22, 21],
      [30, 29],
    ]);
    const job = [10, 20, 21, 22, 30];
    const orphans = findOrphans(job, parentOf, new Set([10]));
    expect(orphans.toSorted()).toEqual([20, 21, 22, 30]);
    const ego = egoProcesses(orphans, new Map([[20, `${EGO_ROOT}\\Application\\ego.exe`]]), new Map([[20, "ego.exe"], [21, "ego.exe"], [22, "crashpad.exe"], [30, "node.exe"]]), dirs);
    // 21 取不到路径、名字是 ego.exe；22 取不到路径但挂在 ego 下面
    expect(findOrphans(job, parentOf, new Set([10, ...ego]))).toEqual([30]);
  });

  it("程序目录：找到的 ego-browser 所在目录、解开链接后的版本目录和安装目录，加上固定的几处；目录前缀要整段对上", () => {
    const found = { path: "C:\\Users\\u\\.local\\share\\ego\\active_version_dir\\ego-browser.exe", dir: "C:\\Users\\u\\.local\\share\\ego\\active_version_dir", source: "default" as const };
    const got = egoProgramDirs({
      found,
      env: { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      homeDir: "C:\\Users\\u",
      platform: "win32",
      realpath: () => `${EGO_ROOT}\\Application\\0.6.3.14`,
    });
    expect(got).toEqual([
      found.dir,
      `${EGO_ROOT}\\Application\\0.6.3.14`,
      EGO_ROOT,
      "C:\\Program Files (x86)\\Citro Labs\\ego lite",
      "C:\\Users\\u\\AppData\\Local\\Citro Labs\\ego lite",
      "C:\\Users\\u\\.local\\share\\ego",
    ]);
    // 没找到：只有固定的几处
    expect(egoProgramDirs({ found: undefined, env: { ProgramFiles: "C:\\Program Files" }, homeDir: "C:\\Users\\u", platform: "win32" })).toEqual([EGO_ROOT, "C:\\Users\\u\\.local\\share\\ego"]);
    expect(isUnderDirs(`${EGO_ROOT}\\Application\\ego.exe`, [EGO_ROOT], "win32")).toBe(true);
    expect(isUnderDirs(`${EGO_ROOT} beta\\ego.exe`, [EGO_ROOT], "win32")).toBe(false);
    expect(isUnderDirs("/Applications/ego lite.app/Contents/MacOS/ego", ["/Applications/ego lite.app"], "darwin")).toBe(true);
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
    // 可执行文件的完整路径（466：认 ego lite 的进程用）
    const images = processImagePaths([process.pid, 0x7ffffff0]);
    expect(images.get(process.pid)?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(images.has(0x7ffffff0)).toBe(false);
  });
});
