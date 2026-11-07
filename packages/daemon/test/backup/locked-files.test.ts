// 备份碰上临时目录和被占着的文件：任务的 .ergo-tmp 不进快照；被别的程序占着、读不了的文件短间隔重试，还不行就跳过、记下来，
// 这次照样算做成了；数据库、配置这类关键文件读不了整份失败；同步目录里 .partial 改名被占着时隔一会儿再试。
// 直接调 backupWithLock（不起守护进程）：数据目录、同步目录都是测试建的临时目录，绝不碰真的 ~/.ergo 和真的同步目录。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type BackupFailure, backupWithLock, SKIPPED_LIST_MAX } from "../../src/backup/backup.ts";
import { nodeSnapshotFiles, type SnapshotFiles } from "../../src/backup/files.ts";
import { readBackupRecord } from "../../src/backup/record.ts";
import { listSnapshotDates, readSnapshot, type SnapshotRetry, verifySnapshot } from "../../src/backup/snapshot.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { put } from "../helpers/backup.ts";
import { ManualClock } from "../helpers/clock.ts";
import { listTree, snapshotFile, snapshotRels } from "../helpers/snapshots.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** libuv 的 UV_FS_O_EXLOCK（Windows）：独占打开，别人再打开读会 EBUSY——就像浏览器开着它的 Cookies */
const UV_FS_O_EXLOCK = 0x10000000;
const DATE = "2026-11-07";
/** 测试里不真等：重试隔 10 毫秒 */
const FAST: SnapshotRetry = { read: { retries: 2, delayMs: 10 }, rename: { retries: 4, delayMs: 10 } };

/** 独占打开一个文件，返回放开的函数 */
function lockExclusively(file: string): () => void {
  const fd = fs.openSync(file, fs.constants.O_RDWR | UV_FS_O_EXLOCK);
  return () => fs.closeSync(fd);
}

/** 读 src 时出 code 错（像 Node 打开被占着的源文件时那样，path 是源文件）；when 决定哪一次出错 */
function failingReads(code: string, when: (src: string, attempt: number) => boolean): SnapshotFiles & { attempts: Map<string, number> } {
  const attempts = new Map<string, number>();
  return {
    ...nodeSnapshotFiles,
    attempts,
    async copy(src, dest, length) {
      const n = (attempts.get(src) ?? 0) + 1;
      attempts.set(src, n);
      if (when(src, n)) throw Object.assign(new Error(`${code}: resource busy or locked, open '${src}'`), { code, syscall: "open", path: src });
      return nodeSnapshotFiles.copy(src, dest, length);
    },
  };
}

function setup() {
  const dataDir = makeTempDir("ergo-data-");
  const syncDir = makeTempDir("ergo-sync-");
  const layout = dataDirLayout(dataDir);
  put(dataDir, "config/ergo.json", "{}\n");
  put(dataDir, "projects/p-demo/charter.md", "# 立项书\n");
  put(dataDir, "outputs/t-47/report.md", "任务的产出\n");
  const lines: string[] = [];
  const failures: BackupFailure[] = [];
  const clock = new ManualClock(new Date(2026, 10, 7, 3, 30));
  const backup = (options: { files?: SnapshotFiles; mode?: "auto" | "manual"; retry?: Partial<SnapshotRetry> } = {}) =>
    backupWithLock({
      layout,
      config: { time: "03:30", schedule: "internal", syncDir },
      clock,
      files: options.files ?? nodeSnapshotFiles,
      mode: options.mode ?? "manual",
      signal: new AbortController().signal,
      log: (line) => lines.push(line),
      report: (failure) => failures.push(failure),
      by: "script",
      retry: options.retry ?? FAST,
    });
  return { dataDir, syncDir, layout, lines, failures, clock, backup };
}

describe("任务的临时目录不进备份", () => {
  it("任何一层名叫 .ergo-tmp 的目录（任务产出区、项目工作目录里的）都不进快照，同级的产出照常进；本机和同步目录都是", async () => {
    const { dataDir, syncDir, layout, backup } = setup();
    put(dataDir, "outputs/t-47/.ergo-tmp/sgac-profile/Default/Network/Cookies", "浏览器的 Cookie");
    put(dataDir, "outputs/t-47/.ergo-tmp/download.part", "下了一半");
    put(dataDir, "projects/p-demo/work/.ergo-tmp/cand.txt", "候选");
    put(dataDir, "projects/p-demo/work/notes.md", "工作目录里的笔记\n");

    expect(await backup()).toEqual({ date: DATE, local: "created", sync: "copied" });
    for (const root of [layout.backups, syncDir]) {
      const rels = snapshotRels(root, DATE);
      expect(rels).toEqual(expect.arrayContaining(["outputs/t-47/report.md", "projects/p-demo/work/notes.md", "projects/p-demo/charter.md"]));
      expect(rels.filter((r) => r.includes(".ergo-tmp"))).toEqual([]);
      expect(listTree(path.join(root, DATE)).filter((f) => f.includes(".ergo-tmp"))).toEqual([]);
    }
  });
});

describe("被别的程序占着的文件", () => {
  it.runIf(process.platform === "win32")("独占打开着的文件：重试几次还读不了就跳过，结果和最近一次的记录里写着跳过了哪个、为什么，这次照样算做成了；两处快照都完整、能通过校验", async () => {
    const { dataDir, syncDir, layout, lines, failures, backup } = setup();
    const cookies = put(dataDir, "outputs/t-9/browser/Network/Cookies", "x".repeat(100));
    const release = lockExclusively(cookies);
    let result;
    try {
      result = await backup();
    } finally {
      release();
    }

    expect(result).toEqual({ date: DATE, local: "created", sync: "copied", skipped: { count: 1, files: [{ path: "outputs/t-9/browser/Network/Cookies", reason: expect.stringMatching(/^EBUSY/) }] } });
    expect(readBackupRecord(layout)).toMatchObject({ by: "script", mode: "manual", local: "created", sync: "copied", skipped: result.skipped });
    expect(failures).toEqual([]);
    expect(lines.some((l) => l.includes("1 个文件被别的程序占着") && l.includes("outputs/t-9/browser/Network/Cookies"))).toBe(true);
    for (const root of [layout.backups, syncDir]) {
      const rels = snapshotRels(root, DATE);
      expect(rels).not.toContain("outputs/t-9/browser/Network/Cookies");
      expect(rels).toEqual(expect.arrayContaining(["config/ergo.json", "outputs/t-47/report.md", "projects/p-demo/charter.md"]));
      expect(listTree(path.join(root, DATE)).some((f) => f.endsWith("/Cookies"))).toBe(false);
      expect(await verifySnapshot(path.join(root, DATE))).toEqual([]);
    }

    // 放开之后下一次照常收进去，不再有跳过
    expect(await backup()).toEqual({ date: DATE, local: "replaced", sync: "replaced" });
    expect(fs.readFileSync(snapshotFile(layout.backups, DATE, "outputs/t-9/browser/Network/Cookies"), "utf8")).toBe("x".repeat(100));
    expect(readBackupRecord(layout)?.skipped).toBeUndefined();
  });

  it("只被占着一会儿：重试中放开了就照常收进去，不算跳过", async () => {
    const { dataDir, layout, backup } = setup();
    const busy = put(dataDir, "outputs/t-9/browser/Cookies", "饼干");
    const files = failingReads("EBUSY", (src, n) => src === busy && n <= 2);
    expect(await backup({ files })).toEqual({ date: DATE, local: "created", sync: "copied" });
    expect(files.attempts.get(busy)).toBe(3);
    expect(fs.readFileSync(snapshotFile(layout.backups, DATE, "outputs/t-9/browser/Cookies"), "utf8")).toBe("饼干");
  });

  it("EPERM、EACCES 读不了的也一样跳过；跳过的多了，结果和记录里只列前若干个、另记总数", async () => {
    const { dataDir, layout, backup } = setup();
    const locked = Array.from({ length: SKIPPED_LIST_MAX + 5 }, (_, i) => put(dataDir, `outputs/t-${String(i).padStart(2, "0")}/locked.bin`, `第 ${i} 个`));
    const files = failingReads("EPERM", (src) => locked.includes(src));
    const result = await backup({ files, retry: { read: { retries: 0, delayMs: 0 } } });
    expect(result).toMatchObject({ local: "created", sync: "copied", skipped: { count: SKIPPED_LIST_MAX + 5 } });
    expect(result.skipped?.files).toHaveLength(SKIPPED_LIST_MAX);
    expect(result.skipped?.files[0]).toEqual({ path: "outputs/t-00/locked.bin", reason: expect.stringMatching(/^EPERM/) });
    expect(readBackupRecord(layout)?.skipped).toEqual(result.skipped);

    // 和上一份里一样（大小、修改时间都没变）的文件直接硬链接、不读源文件，被占着也无妨；新的、改过的才读
    const fresh = put(dataDir, "outputs/t-48/new.md", "新产出");
    const eacces = failingReads("EACCES", (src) => src === fresh);
    expect((await backup({ files: eacces, retry: { read: { retries: 0, delayMs: 0 } } })).skipped).toEqual({ count: 1, files: [{ path: "outputs/t-48/new.md", reason: expect.stringMatching(/^EACCES/) }] });
  });

  it.runIf(process.platform === "win32")("关键文件被占着：推理库 rg.db 独占打开着，整份算失败，原因写明是哪个文件；本机、同步目录都不留半成品", async () => {
    const { dataDir, syncDir, layout, failures, backup } = setup();
    const rg = put(dataDir, "memory/subtext/rg.db", "不是真的库，只看读不读得了");
    const release = lockExclusively(rg);
    let result;
    try {
      result = await backup();
    } finally {
      release();
    }
    expect(result).toEqual({ date: DATE, local: "failed", sync: "skipped", error: expect.stringContaining("memory/subtext/rg.db") });
    expect(result.error).toContain("关键文件不能跳过");
    expect(failures).toMatchObject([{ title: "备份失败：本机快照没做成", body: expect.stringContaining("memory/subtext/rg.db"), data: { stage: "local" } }]);
    expect(readBackupRecord(layout)).toMatchObject({ local: "failed", error: result.error });
    expect(listSnapshotDates(layout.backups)).toEqual([]);
    expect(fs.readdirSync(layout.backups).filter((n) => n.endsWith(".partial"))).toEqual([]);
    expect(fs.readdirSync(syncDir)).toEqual([]);
  });

  it("关键文件抛 EBUSY（配置、数据库的 -wal）：重试完整份失败，不跳过", async () => {
    for (const rel of ["config/ergo.json", "memory/subtext/rg.db-wal"]) {
      const { dataDir, layout, backup } = setup();
      const file = put(dataDir, rel, "关键");
      const files = failingReads("EBUSY", (src) => src === file);
      const result = await backup({ files });
      expect(result).toMatchObject({ local: "failed", sync: "skipped", error: expect.stringContaining(rel) });
      expect(result.skipped).toBeUndefined();
      expect(files.attempts.get(file)).toBe(FAST.read.retries + 1);
      expect(listSnapshotDates(layout.backups)).toEqual([]);
    }
  });

  it("往备份区写的那一头出的 EPERM（不是源文件被占着）：不跳过，照旧整份失败", async () => {
    const { layout, backup } = setup();
    const files: SnapshotFiles = {
      ...nodeSnapshotFiles,
      async copy(src, dest, length) {
        if (src.endsWith("report.md")) throw Object.assign(new Error(`EPERM: operation not permitted, open '${dest}'`), { code: "EPERM", syscall: "open", path: dest });
        return nodeSnapshotFiles.copy(src, dest, length);
      },
    };
    expect(await backup({ files })).toMatchObject({ local: "failed", sync: "skipped", error: expect.stringContaining("没有写入权限") });
    expect(listSnapshotDates(layout.backups)).toEqual([]);
  });
});

/** 把同步目录里 .<日期>.partial 改成日期目录时出 EPERM（同步客户端正占着）：前 times 次 */
function busyRename(syncDir: string, times: number): SnapshotFiles & { tries: () => number } {
  let tries = 0;
  return {
    ...nodeSnapshotFiles,
    tries: () => tries,
    async rename(from, to) {
      if (from === path.join(syncDir, `.${DATE}.partial`) && to === path.join(syncDir, DATE)) {
        tries++;
        if (tries <= times) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: "EPERM", syscall: "rename", path: from, dest: to });
      }
      return nodeSnapshotFiles.rename(from, to);
    },
  };
}

describe("同步目录里 .partial 改名被占着", () => {
  it("先失败两次再成功：这次算写进了同步目录，日志里写着在等", async () => {
    const { syncDir, lines, failures, backup } = setup();
    const files = busyRename(syncDir, 2);
    expect(await backup({ files })).toEqual({ date: DATE, local: "created", sync: "copied" });
    expect(files.tries()).toBe(3);
    expect(readSnapshot(path.join(syncDir, DATE))).toBeDefined();
    expect(fs.readdirSync(syncDir).filter((n) => n.startsWith("."))).toEqual([]);
    expect(lines.filter((l) => l.includes("被占着（EPERM）"))).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it("一直被占着：试完几次算失败，放一条\"备份失败\"；同步目录里当天原来那份还在，没有半成品", async () => {
    const { dataDir, syncDir, failures, clock, backup } = setup();
    expect(await backup()).toMatchObject({ sync: "copied" });
    const before = readSnapshot(path.join(syncDir, DATE))!.manifest.createdAt;
    put(dataDir, "outputs/t-47/report.md", "白天又改了\n");
    clock.advanceTo(new Date(2026, 10, 7, 15, 0));

    const files = busyRename(syncDir, Number.POSITIVE_INFINITY);
    const result = await backup({ files });
    expect(result).toMatchObject({ local: "replaced", sync: "failed", error: expect.stringContaining("EPERM") });
    expect(files.tries()).toBe(FAST.rename.retries + 1);
    expect(failures).toMatchObject([{ title: "备份失败：没写进同步目录", data: { stage: "sync" } }]);
    // 原来那份挪回来了：还是上一次的内容
    expect(readSnapshot(path.join(syncDir, DATE))?.manifest.createdAt).toBe(before);
    expect(fs.readFileSync(snapshotFile(syncDir, DATE, "outputs/t-47/report.md"), "utf8")).toBe("任务的产出\n");
    expect(fs.readdirSync(syncDir).filter((n) => n.startsWith("."))).toEqual([]);
  });
});
