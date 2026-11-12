// 体检"二狗占的内存"（439）：
// - 判：二狗自己占的不到 3 GB 正常、到了算注意（带修法）；事实里带 JS 堆、向量模型加载着没有、起来以后最多的、它拉起的程序；
// - 读：真读本进程（Windows 上是私有提交，读得到子进程）；拉起一个子进程，它在"它拉起的程序"里；
// - 进程快照里找子孙：父进程 id 被复用的（比父进程先创建）不算。
// 内核登记（给了 memory 才有这一项，排在网页文件后面）在 core-checks.test.ts。
import { spawn } from "node:child_process";
import { activeLocale, activeLocaleFrom, doctorItemText, setActiveLocale } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorFinding } from "../../src/doctor/checks.ts";
import { judgeMemoryUse, MEMORY_WARN_BYTES, type MemoryUse, readMemoryUse } from "../../src/doctor/memory-use.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { descendantsOf, type ProcessEntry, processMemory } from "../../src/process/process-list.ts";

const before = activeLocale();
afterEach(() => setActiveLocale(before));

const said = (finding: DoctorFinding) => doctorItemText({ title: { key: "x" }, fact: finding.fact, ...(finding.fix ? { fix: finding.fix } : {}) });
const MB = 1024 ** 2;
const GB = 1024 ** 3;

const use = (overrides: Partial<MemoryUse> = {}): MemoryUse => ({ used: 1.6 * GB, peak: 2.1 * GB, heapUsed: 118 * MB, children: [], ...overrides });

describe("判二狗占的内存", () => {
  it("平时的样子：不到 3 GB 正常；事实写现在占的、JS 堆、向量模型加载着、起来以后最多的、它拉起的程序（最多点名三个）", () => {
    const finding = judgeMemoryUse(
      use({
        embedderLoaded: true,
        children: [
          { exe: "python.exe", used: 3 * GB },
          { exe: "node.exe", used: 152 * MB },
          { exe: "chrome.exe", used: 90 * MB },
          { exe: "conhost.exe", used: 1 * MB },
        ],
      }),
    );
    expect(finding.level).toBe("ok");
    expect(finding.fix).toBeUndefined();
    expect(said(finding).fact).toBe(
      "现在占 1.6 GB（JS 堆 118 MB），向量模型加载着（闲 10 分钟会卸掉）；这次起来以后最多占过 2.1 GB。它拉起的程序另占 3.2 GB：python.exe 3 GB、node.exe 152 MB和chrome.exe 90 MB",
    );
  });

  it("向量模型没加载、没有拉起的程序：句子短一截；不知道向量模型的不提", () => {
    expect(said(judgeMemoryUse(use({ used: 300 * MB, peak: 400 * MB, heapUsed: 90 * MB, embedderLoaded: false }))).fact).toBe("现在占 300 MB（JS 堆 90 MB），向量模型没加载；这次起来以后最多占过 400 MB");
    expect(said(judgeMemoryUse(use({ used: 300 * MB, peak: 400 * MB, heapUsed: 90 * MB }))).fact).toBe("现在占 300 MB（JS 堆 90 MB）；这次起来以后最多占过 400 MB");
  });

  it("439 那次：占到 8.7 GB → 注意，写超过了多少，修法是过一会儿再查、下不来就重启；起来以后最多的高、现在下来了 → 正常", () => {
    const over = judgeMemoryUse(use({ used: 8.7 * GB, peak: 8.7 * GB, embedderLoaded: true }));
    expect(over.level).toBe("warn");
    const text = said(over);
    expect(text.fact).toBe("现在占 8.7 GB，超过了 3 GB（JS 堆 118 MB），向量模型加载着（闲 10 分钟会卸掉）；这次起来以后最多占过 8.7 GB");
    expect(text.fix).toContain("过 10 分钟再查一遍");
    expect(text.fix).toContain("重启二狗");
    expect(judgeMemoryUse(use({ used: MEMORY_WARN_BYTES - 1 })).level).toBe("ok");
    expect(judgeMemoryUse(use({ used: MEMORY_WARN_BYTES })).level).toBe("warn");
    expect(judgeMemoryUse(use({ used: 1 * GB, peak: 8.7 * GB })).level).toBe("ok");
  });

  it("英文也拼得通", () => {
    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    const text = said(judgeMemoryUse(use({ used: 8.7 * GB, peak: 9 * GB, embedderLoaded: false, children: [{ exe: "python.exe", used: 3 * GB }] })));
    expect(text.fact).toBe("Using 8.7 GB now, over 3 GB (JS heap 118 MB), the embedding model isn't loaded; at most 9 GB since it started. The programs it started use another 3 GB: python.exe 3 GB");
    expect(text.fix).toContain("restart ergo");
  });
});

describe("读本进程和子进程", () => {
  it("读得到自己占的、JS 堆、起来以后最多的；向量模型的状态现取", () => {
    const now = readMemoryUse(() => true);
    expect(now.used).toBeGreaterThan(10 * MB);
    expect(now.peak).toBeGreaterThanOrEqual(now.used);
    expect(now.heapUsed).toBeGreaterThan(MB);
    expect(now.embedderLoaded).toBe(true);
    expect(readMemoryUse(() => undefined).embedderLoaded).toBeUndefined();
    expect(readMemoryUse().embedderLoaded).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("Windows：自己的私有提交读得到；拉起的子进程在\"它拉起的程序\"里", async () => {
    const own = processMemory([process.pid]).get(process.pid)!;
    expect(own.private).toBeGreaterThan(10 * MB);
    expect(own.workingSet).toBeGreaterThan(MB);
    expect(own.peakPrivate).toBeGreaterThanOrEqual(own.private);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      const now = readMemoryUse();
      expect(now.children.some((c) => c.exe.toLowerCase() === "node.exe" && c.used > MB)).toBe(true);
    } finally {
      child.kill();
    }
  });
});

describe("进程快照里找子孙", () => {
  const snapshot = new Map<number, ProcessEntry>([
    [1, { parent: 0, exe: "ergo.exe" }],
    [2, { parent: 1, exe: "python.exe" }],
    [3, { parent: 2, exe: "conhost.exe" }],
    [4, { parent: 1, exe: "node.exe" }],
    [5, { parent: 9, exe: "other.exe" }],
    // 父进程 id 是 4，但比 4 先创建：4 是复用了它早已退出的父进程的 id
    [6, { parent: 4, exe: "stale.exe" }],
    [7, { parent: 7, exe: "self.exe" }],
  ]);

  it("按层次先后找全子孙，不含自己和别人的", () => {
    expect(descendantsOf(1, snapshot)).toEqual([2, 4, 3, 6]);
  });

  it("给了创建时间：比父进程先创建的不算（连它的子孙一起）", () => {
    const created = new Map([
      [1, 100],
      [2, 110],
      [3, 120],
      [4, 130],
      [6, 50],
    ]);
    expect(descendantsOf(1, snapshot, created)).toEqual([2, 4, 3]);
  });
});
