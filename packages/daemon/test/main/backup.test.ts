// 主切面：备份、校验与临时区清理（规格第 13、18 节）。调度器的时钟换成手动拨的（ManualClock），到点不靠真等。
// 同步目录一律是测试建的临时目录，绝不碰真实的同步目录。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, type InboxItemEventPayload, nowIso } from "@ergou/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { nodeSnapshotFiles, type SnapshotFiles } from "../../src/backup/files.ts";
import { restoreSnapshot } from "../../src/backup/restore.ts";
import { listSnapshotDates, readSnapshot, snapshotEntries, verifySnapshot } from "../../src/backup/snapshot.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { openDatabase, openReadonlyDatabase } from "../../src/storage/sqlite.ts";
import { type BackupDaemonOptions, put, restartBackupDaemon, startBackupDaemon, touch } from "../helpers/backup.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { isReadOnly, listTree, makeWritable, poolFiles, sameStorage, snapshotEvents, snapshotFile, snapshotIntegrity, snapshotRels } from "../helpers/snapshots.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 7, 21, 0);

type SetupOptions = Partial<BackupDaemonOptions>;

/** 起一个守护进程（时钟默认停在 10-07 21:00），同步目录是一个临时目录 */
const setup = (options: SetupOptions = {}) => startBackupDaemon({ start: START, ...options });
const restart = restartBackupDaemon;
const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const inboxIds = (dbFile: string) => snapshotEvents(dbFile, CHANNELS.inbox).map((e) => (e.payload as { item: { id: string } }).item.id);

describe("每晚的备份", () => {
  it("到 03:30 调度器做一份快照：本机备份区多出当天的日期目录，ergou.db 和 memory.db 用 VACUUM INTO 生成、能通过完整性检查，其余文件已复制", async () => {
    const { daemon, dataDir, layout, syncDir, advanceTo } = await setup();
    const item = daemon.inbox.add({ kind: "notice", notice: "missed_reminder", title: "快照之前的事项", source: "测试", urgency: "non_blocking" });
    put(dataDir, "sessions/maintainer-demo/s1.jsonl", '{"type":"session","id":"s1"}\n{"type":"message","n":1}\n');
    put(dataDir, "projects/p-demo/charter.md", "# 立项书\n");
    // 素材库（08 号票建的 memory.db，守护进程开着）：另开一个连接写一张探针表，WAL 里还有没合并回主文件的内容
    const memory = openDatabase(path.join(layout.db, "memory.db"));
    onTestFinished(() => memory.close());
    memory.exec("CREATE TABLE backup_probe (id TEXT PRIMARY KEY, text TEXT)");
    memory.run("INSERT INTO backup_probe VALUES (?, ?)", "mat-1", "我说过的一句话");

    await advanceTo(at(10, 8, 3, 29));
    expect(fs.existsSync(path.join(layout.backups, "2026-10-08"))).toBe(false);
    await advanceTo(at(10, 8, 3, 30));

    const snapshot = path.join(layout.backups, "2026-10-08");
    const files = listTree(snapshot);
    expect(files).toEqual(
      expect.arrayContaining(["data/config/ergou.json", "data/db/ergou.db", "data/db/memory.db", "data/sessions/maintainer-demo/s1.jsonl", "data/projects/p-demo/charter.md"]),
    );
    expect(files.filter((f) => f.startsWith("data/db/"))).toEqual(["data/db/ergou.db", "data/db/memory.db"]);
    expect(fs.readFileSync(path.join(snapshot, "data/projects/p-demo/charter.md"), "utf8")).toBe("# 立项书\n");
    for (const db of ["ergou.db", "memory.db"]) expect(await snapshotIntegrity(path.join(snapshot, "data/db", db))).toEqual([]);
    expect(inboxIds(path.join(snapshot, "data/db/ergou.db"))).toEqual([item.id]);
    const copy = openReadonlyDatabase(path.join(snapshot, "data/db/memory.db"));
    expect(copy.all("SELECT id, text FROM backup_probe")).toEqual([{ id: "mat-1", text: "我说过的一句话" }]);
    copy.close();
    // 本机备份区里的快照文件都是只读的：一份存储可能属于好几天的快照，不能被就地改写
    for (const f of files) expect(isReadOnly(path.join(snapshot, f))).toBe(true);

    // 再复制到同步目录：同样这些文件，数据库照样通过完整性检查
    expect(snapshotRels(syncDir, "2026-10-08")).toEqual(snapshotRels(layout.backups, "2026-10-08"));
    for (const db of ["db/ergou.db", "db/memory.db"]) expect(await snapshotIntegrity(snapshotFile(syncDir, "2026-10-08", db))).toEqual([]);
    expect(fs.readFileSync(snapshotFile(syncDir, "2026-10-08", "projects/p-demo/charter.md"), "utf8")).toBe("# 立项书\n");
  });

  it("同一备份也能通过\"立即备份\"手动触发：当天已经有快照时换成新的，本机和同步目录都是", async () => {
    const { daemon, dataDir, layout, syncDir, advanceTo } = await setup();
    put(dataDir, "projects/p-demo/progress.md", "第一版\n");
    await advanceTo(at(10, 8, 3, 30));
    put(dataDir, "projects/p-demo/progress.md", "第二版：白天又改了\n");
    const later = daemon.inbox.add({ kind: "notice", notice: "missed_reminder", title: "白天放进来的事项", source: "测试", urgency: "non_blocking" });

    await advanceTo(at(10, 8, 15, 0));
    expect(await daemon.backup.backupNow()).toEqual({ date: "2026-10-08", local: "replaced", sync: "replaced" });
    for (const root of [layout.backups, syncDir]) {
      expect(listSnapshotDates(root)).toEqual(["2026-10-08"]);
      expect(fs.readFileSync(snapshotFile(root, "2026-10-08", "projects/p-demo/progress.md"), "utf8")).toBe("第二版：白天又改了\n");
      expect(inboxIds(snapshotFile(root, "2026-10-08", "db/ergou.db"))).toEqual([later.id]);
    }
  });

  it("快照进行中守护进程照常追加事件、不报错；快照里的数据库包含快照开始前已提交的全部事件", async () => {
    // 复制其余文件时停住（数据库已经做完），等测试追加完事件再放行
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let copying!: () => void;
    const copyStarted = new Promise<void>((resolve) => (copying = resolve));
    const files: SnapshotFiles = {
      ...nodeSnapshotFiles,
      async copy(src, dest, length) {
        copying();
        await gate;
        return nodeSnapshotFiles.copy(src, dest, length);
      },
    };
    const { daemon, dataDir, layout } = await setup({ backupFiles: () => files });
    put(dataDir, "projects/p-demo/charter.md", "# 立项书\n");
    const notice = (title: string) => daemon.inbox.add({ kind: "notice", notice: "missed_reminder", title, source: "测试", urgency: "non_blocking" });
    const before = ["之前 1", "之前 2", "之前 3"].map(notice);

    const backup = daemon.backup.backupNow();
    await copyStarted;
    const during = ["进行中 1", "进行中 2"].map(notice);
    release();
    expect(await backup).toMatchObject({ local: "created", sync: "copied" });

    expect(inboxIds(path.join(layout.backups, "2026-10-07/data/db/ergou.db"))).toEqual(before.map((i) => i.id));
    expect(daemon.inbox.list().map((i) => i.id)).toEqual([...before, ...during].map((i) => i.id));
  });

  it("pi 会话 JSONL 的最后一行只写了一半：备份不失败，快照里的会话文件到最后一个完整的行为止", async () => {
    const { dataDir, layout, syncDir, advanceTo } = await setup();
    const complete = '{"type":"session","id":"s1"}\n{"type":"message","n":1}\n';
    put(dataDir, "sessions/maintainer-demo/s1.jsonl", `${complete}{"type":"message","n":2,"te`);
    await advanceTo(at(10, 8, 3, 30));
    for (const root of [layout.backups, syncDir]) {
      expect(fs.readFileSync(snapshotFile(root, "2026-10-08", "sessions/maintainer-demo/s1.jsonl"), "utf8")).toBe(complete);
    }
  });

  it("快照里没有密钥区、临时区的文件，没有外部工作目录里的文件（项目绑定了外部路径也一样），也不包含本机备份区自己", async () => {
    const { dataDir, layout, syncDir, advanceTo } = await setup();
    put(dataDir, "secrets/deepseek-api-key.txt", "sk-不该进备份");
    put(dataDir, "tmp/scratch/draft.md", "草稿区里的文件");
    put(dataDir, "tmp/upload-1.part", "上传到一半");
    put(dataDir, "backups/README.txt", "本机备份区里别的东西");
    // 项目绑定了外部工作目录：项目档案里记着路径，项目目录下还有一个指过去的目录联接
    const external = makeTempDir("ergou-external-work-");
    put(external, "src/main.ts", "外部工作目录里的代码");
    put(dataDir, "projects/p-blog/project.json", JSON.stringify({ workdir: external }));
    fs.symlinkSync(external, path.join(dataDir, "projects/p-blog/workdir"), "junction");

    await advanceTo(at(10, 8, 3, 30));
    await advanceTo(at(10, 9, 3, 30));
    expect(fs.readdirSync(layout.backups)).toEqual(["2026-10-08", "2026-10-09", "README.txt"]);
    expect(listSnapshotDates(syncDir)).toEqual(["2026-10-08", "2026-10-09"]);
    for (const root of [layout.backups, syncDir]) {
      for (const date of ["2026-10-08", "2026-10-09"]) {
        const rels = snapshotRels(root, date);
        expect(rels).toContain("projects/p-blog/project.json");
        const stored = listTree(path.join(root, date));
        for (const list of [rels, stored]) expect(list.filter((f) => /secrets|tmp|backups|workdir|main\.ts|README|\.db-(wal|shm)$|daemon\.pid/.test(f))).toEqual([]);
        expect(stored.every((f) => f === "manifest.json" || f.startsWith("data/"))).toBe(true);
      }
    }
  });
});

/** 往 under 下面写文件时出这个错（其余照常） */
function failingWrites(under: string, code: string): SnapshotFiles {
  const inside = (p: string) => !path.relative(under, p).startsWith("..");
  const fail = (p: string) => {
    if (inside(p)) throw Object.assign(new Error(`${code}: 模拟的写入错误, ${p}`), { code });
  };
  return {
    ...nodeSnapshotFiles,
    copy: async (src, dest, length) => (fail(dest), nodeSnapshotFiles.copy(src, dest, length)),
    link: async (existing, dest) => (fail(dest), nodeSnapshotFiles.link(existing, dest)),
    writeFile: async (file, data) => (fail(file), nodeSnapshotFiles.writeFile(file, data)),
  };
}

describe("备份失败", () => {
  const cases: Array<{ name: string; options: (tmp: string) => SetupOptions; reason: RegExp }> = [
    { name: "同步目录不存在", options: (tmp) => ({ syncDir: path.join(tmp, "同步盘没挂上", "ergou") }), reason: /同步目录 .*ergou 不存在/ },
    { name: "同步目录还是示例配置里的占位符", options: () => ({ syncDir: "<同步目录的绝对路径>" }), reason: /同步目录还是示例里的占位符/ },
    { name: "同步目录空间不够", options: () => ({ backupFiles: (sync) => failingWrites(sync, "ENOSPC") }), reason: /空间不够/ },
    { name: "往同步目录复制出错", options: () => ({ backupFiles: (sync) => failingWrites(sync, "EIO") }), reason: /复制出错/ },
  ];
  for (const { name, options, reason } of cases) {
    it(`${name}：待我处理里出现一条"备份失败"（不卡任务），本机快照照样留着，同步目录里没有半成品`, async () => {
      const { url, layout, syncDir, advanceTo } = await setup(options(makeTempDir("ergou-sync-parent-")));
      const frontend = await TestFrontend.connect(url);
      await frontend.subscribe({ [CHANNELS.inbox]: 0 });
      await advanceTo(at(10, 8, 3, 30));

      const item = ((await frontend.next(CHANNELS.inbox, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
      expect(item).toMatchObject({ kind: "notice", notice: "backup_failed", title: "备份失败：没写进同步目录", urgency: "non_blocking", source: "备份", pinned: false, actions: ["重试", "知道了"] });
      expect(item.kind === "notice" && item.body).toMatch(reason);
      expect(item.kind === "notice" && item.body).toContain("本机快照已经做好");
      expect(await verifySnapshot(path.join(layout.backups, "2026-10-08"))).toEqual([]);
      expect(listSnapshotDates(syncDir)).toEqual([]);
      expect(poolFiles(syncDir)).toEqual([]);
    });
  }

  it("本机备份区空间不够：待我处理里一条\"备份失败：本机快照没做成\"，同步目录也不动", async () => {
    const reuse = { dataDir: makeTempDir("ergou-data-"), homeDir: makeTempDir("ergou-home-") };
    const { daemon, layout, syncDir, advanceTo } = await setup({ reuse, backupFiles: () => failingWrites(dataDirLayout(reuse.dataDir).backups, "ENOSPC") });
    await advanceTo(at(10, 8, 3, 30));
    expect(daemon.inbox.list()).toMatchObject([{ notice: "backup_failed", title: "备份失败：本机快照没做成", urgency: "non_blocking", body: expect.stringMatching(/空间不够/) }]);
    expect(fs.readdirSync(layout.backups)).toEqual([]);
    expect(fs.readdirSync(syncDir)).toEqual([]);
  });

  it("在\"备份失败\"上点\"重试\"：马上再备份一次（立即备份），这回写进了同步目录；点\"知道了\"不重试", async () => {
    const syncDir = path.join(makeTempDir("ergou-sync-parent-"), "sync");
    const { daemon, url, advanceTo } = await setup({ syncDir });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CHANNELS.inbox]: 0 });
    await advanceTo(at(10, 8, 3, 30));
    await advanceTo(at(10, 8, 4, 30));
    const [first, second] = daemon.inbox.list();
    expect(daemon.inbox.list().map((i) => i.title)).toEqual(["备份失败：没写进同步目录"]);
    expect(second).toBeUndefined();

    // 同步目录挂上了，点"重试"
    fs.mkdirSync(syncDir);
    await advanceTo(at(10, 8, 9, 0));
    expect(await frontend.inboxAction({ itemIds: [first!.id], action: "handle", choice: "重试" })).toMatchObject({ ok: true });
    await waitUntil(() => fs.existsSync(path.join(syncDir, "2026-10-08/manifest.json")), { timeoutMs: 5_000 });
    expect(readSnapshot(path.join(syncDir, "2026-10-08"))?.manifest.createdAt).toBe(nowIso(at(10, 8, 9, 0)));

    // 再失败一次，这回点"知道了"：不重试
    fs.rmSync(syncDir, { recursive: true });
    await advanceTo(at(10, 9, 3, 30));
    const again = daemon.inbox.list().find((i) => i.id !== first!.id)!;
    expect(again.title).toBe("备份失败：没写进同步目录");
    fs.mkdirSync(syncDir);
    expect(await frontend.inboxAction({ itemIds: [again.id], action: "handle", choice: "知道了" })).toMatchObject({ ok: true });
    await advanceTo(at(10, 9, 3, 40));
    expect(fs.readdirSync(syncDir)).toEqual([]);
  });
});

/** 把一个数据库文件中间的几页写成乱码（大小不变）；快照文件是只读的，先去掉只读（就像有人硬改） */
function corrupt(dbFile: string): void {
  makeWritable(dbFile);
  const fd = fs.openSync(dbFile, "r+");
  try {
    fs.writeSync(fd, Buffer.alloc(3 * 4096, 0xab), 0, 3 * 4096, 4096);
  } finally {
    fs.closeSync(fd);
  }
}

describe("每周校验", () => {
  it("每周日 04:30 校验最新快照：通过时什么也不放；人为损坏最新快照后，待我处理里出现\"快照校验失败\"", async () => {
    const { daemon, url, layout, advanceTo } = await setup();
    // 10-11 是周日：03:30 备份，04:30 校验，都通过
    await advanceTo(at(10, 11, 5, 0));
    expect(fs.readdirSync(layout.backups)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(daemon.inbox.list()).toEqual([]);

    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CHANNELS.inbox]: 0 });
    // 下一个周日：备份做完之后、校验之前，本机最新那份坏了
    await advanceTo(at(10, 18, 3, 31));
    corrupt(path.join(layout.backups, "2026-10-18/data/db/ergou.db"));
    await advanceTo(at(10, 18, 4, 29));
    expect(daemon.inbox.list()).toEqual([]);
    await advanceTo(at(10, 18, 4, 30));

    const item = ((await frontend.next(CHANNELS.inbox, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
    expect(item).toMatchObject({ kind: "notice", notice: "snapshot_check_failed", title: "快照校验失败：本机备份区的 2026-10-18", urgency: "non_blocking", source: "备份" });
    expect(item.kind === "notice" && item.body).toMatch(/db\/ergou\.db：.*malformed/);
    // 同步目录里那份是好的：只有这一条
    expect(daemon.inbox.list()).toHaveLength(1);
  });
});

describe("错过的内部作业开机后补一次", () => {
  it("停机期间错过了好几晚的备份、一次每周校验和几次清理：启动后各补一次；补完再重启不会再补", async () => {
    const first = await setup();
    const stale = put(first.dataDir, "tmp/scratch/old-draft.md", "十天前的草稿");
    touch(stale, at(9, 27, 12));
    // 停了四天多：10-08 到 10-12 的 03:30 都错过了，10-11（周日）的校验也错过了
    const second = await restart(first, at(10, 12, 9, 0));
    const { daemon, layout, syncDir } = second;
    expect(fs.readdirSync(layout.backups)).toEqual(["2026-10-12"]);
    expect(listSnapshotDates(syncDir)).toEqual(["2026-10-12"]);
    expect(fs.existsSync(stale)).toBe(false);
    const ranAt = nowIso(at(10, 12, 9, 0));
    for (const job of ["backup", "verify_snapshot", "clean_tmp"]) expect(daemon.internalJobs.state(job)?.lastRunAt).toBe(ranAt);
    const createdAt = readSnapshot(path.join(layout.backups, "2026-10-12"))?.manifest.createdAt;

    // 补完再重启：不再补
    const third = await restart(second, at(10, 12, 10, 0));
    for (const job of ["backup", "verify_snapshot", "clean_tmp"]) expect(third.daemon.internalJobs.state(job)?.lastRunAt).toBe(ranAt);
    expect(readSnapshot(path.join(layout.backups, "2026-10-12"))?.manifest.createdAt).toBe(createdAt);
    // 之后照常：当晚 03:30 备份，04:00 清理
    await third.advanceTo(at(10, 13, 4, 0));
    expect(fs.readdirSync(layout.backups)).toEqual(["2026-10-12", "2026-10-13"]);
    expect(third.daemon.internalJobs.state("clean_tmp")?.lastRunAt).toBe(nowIso(at(10, 13, 4, 0)));
  });

  it("第一次启动（新的数据目录）不马上备份；当天的快照已经在了（比如刚从旧快照恢复）时补做不覆盖它", async () => {
    const first = await setup({ start: at(10, 8, 2, 0) });
    expect(listTree(first.layout.backups)).toEqual([]);
    expect(await first.daemon.backup.backupNow()).toMatchObject({ date: "2026-10-08", local: "created", sync: "copied" });
    const createdAt = nowIso(at(10, 8, 2, 0));
    // 停到第二天才起来：错过了 10-08 03:30，补做时当天的快照已经有了，不动它
    const second = await restart(first, at(10, 8, 11, 0));
    expect(second.daemon.internalJobs.state("backup")?.lastRunAt).toBe(nowIso(at(10, 8, 11, 0)));
    for (const root of [second.layout.backups, second.syncDir]) expect(readSnapshot(path.join(root, "2026-10-08"))?.manifest.createdAt).toBe(createdAt);
  });
});

describe("临时区清理", () => {
  it("每天 04:00 清理临时区里 7 天前的文件，7 天内的留着；媒体库里的文件（包括秘书从草稿区发进聊天的附件）不受影响", async () => {
    const { dataDir, advanceTo } = await setup();
    const oldDraft = put(dataDir, "tmp/scratch/old-draft.md", "九天前的草稿");
    touch(oldDraft, at(9, 29, 10));
    const recent = put(dataDir, "tmp/scratch/table.csv", "三天前算的表");
    touch(recent, at(10, 5, 10));
    const upload = put(dataDir, "tmp/uploads/u-1/part-0", "上传到一半就没了下文");
    touch(upload, at(9, 20, 10));
    touch(path.dirname(upload), at(9, 20, 10));
    // 秘书从草稿区发进聊天的附件：复制进了媒体库，草稿区里的原文件很旧
    const attachment = put(dataDir, "materials/media/sha-of-chart", "附件");
    touch(attachment, at(9, 1, 10));

    await advanceTo(at(10, 8, 3, 59));
    expect(fs.existsSync(oldDraft)).toBe(true);
    await advanceTo(at(10, 8, 4, 0));
    expect(fs.existsSync(oldDraft)).toBe(false);
    expect(fs.existsSync(upload)).toBe(false);
    expect(fs.existsSync(path.dirname(upload))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "tmp/uploads"))).toBe(true);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(attachment)).toBe(true);

    // 10-13 04:00：那张表也满 7 天了
    await advanceTo(at(10, 12, 4, 0));
    expect(fs.existsSync(recent)).toBe(true);
    await advanceTo(at(10, 13, 4, 0));
    expect(fs.existsSync(recent)).toBe(false);
    expect(fs.existsSync(attachment)).toBe(true);
  });
});

describe("增量复制与保留", () => {
  it("其他文件增量复制，媒体按内容哈希只存一份：本机靠硬链接，同步目录靠公共池（不用硬链接），连续两天、换了位置的都只占一份", async () => {
    const { dataDir, layout, syncDir, advanceTo } = await setup();
    const photo = crypto.randomBytes(300 * 1024);
    const sha = sha256(photo);
    put(dataDir, `materials/media/${sha}`, photo);
    put(dataDir, "projects/p-demo/progress.md", "第一天\n");
    await advanceTo(at(10, 8, 3, 30));
    // 白天：秘书把同一张图作为产出放进了任务产出区；进展改了
    put(dataDir, "outputs/t-1/chart.png", photo);
    put(dataDir, "projects/p-demo/progress.md", "第二天，进展多了一行\n");
    await advanceTo(at(10, 9, 3, 30));

    // 本机备份区：没变的硬链接到上一份，内容一样换了位置的也是
    const day1 = path.join(layout.backups, "2026-10-08/data");
    const day2 = path.join(layout.backups, "2026-10-09/data");
    expect(sameStorage(path.join(day1, "materials/media", sha), path.join(day2, "materials/media", sha))).toBe(true);
    expect(sameStorage(path.join(day2, "outputs/t-1/chart.png"), path.join(day2, "materials/media", sha))).toBe(true);
    expect(fs.readFileSync(path.join(day2, "outputs/t-1/chart.png")).equals(photo)).toBe(true);
    // 变了的文件各是各的；数据库每天都是新做的
    expect(sameStorage(path.join(day1, "projects/p-demo/progress.md"), path.join(day2, "projects/p-demo/progress.md"))).toBe(false);
    expect(sameStorage(path.join(day1, "db/ergou.db"), path.join(day2, "db/ergou.db"))).toBe(false);

    // 同步目录：同步客户端不认硬链接，所以不用硬链接；较大的文件按内容放进公共池，两天、两个位置共用池里的一份
    const pooled = snapshotFile(syncDir, "2026-10-08", `materials/media/${sha}`);
    expect(pooled).toBe(path.join(syncDir, "pool", sha));
    expect(snapshotFile(syncDir, "2026-10-09", `materials/media/${sha}`)).toBe(pooled);
    expect(snapshotFile(syncDir, "2026-10-09", "outputs/t-1/chart.png")).toBe(pooled);
    expect(fs.readFileSync(pooled).equals(photo)).toBe(true);
    for (const date of ["2026-10-08", "2026-10-09"]) expect(listTree(path.join(syncDir, date)).filter((f) => f.includes(sha) || f.includes("chart.png"))).toEqual([]);
    for (const f of listTree(syncDir)) expect(fs.statSync(path.join(syncDir, f)).nlink).toBe(1);
    // 小文件在日期目录里，各天各一份
    expect(fs.readFileSync(path.join(syncDir, "2026-10-08/data/projects/p-demo/progress.md"), "utf8")).toBe("第一天\n");
    expect(fs.readFileSync(path.join(syncDir, "2026-10-09/data/projects/p-demo/progress.md"), "utf8")).toBe("第二天，进展多了一行\n");
  });

  it("硬链接做不了（比如跨盘）时整份复制，记一条日志；快照照样完整、只读", async () => {
    const lines: string[] = [];
    const files: SnapshotFiles = {
      ...nodeSnapshotFiles,
      async link(existing, dest) {
        await fs.promises.copyFile(existing, dest);
        return { linked: false, reason: "EXDEV：模拟的跨盘" };
      },
    };
    const { dataDir, layout, advanceTo } = await setup({ backupFiles: () => files, log: (line) => lines.push(line) });
    put(dataDir, "projects/p-demo/charter.md", "# 立项书\n");
    await advanceTo(at(10, 8, 3, 30));
    await advanceTo(at(10, 9, 3, 30));
    expect(lines.filter((l) => l.includes("没能硬链接"))).toEqual([expect.stringMatching(/^备份：2026-10-09 的快照里有 \d+ 个文件没能硬链接，整份复制了（EXDEV：模拟的跨盘）$/)]);
    const charter = (date: string) => path.join(layout.backups, date, "data/projects/p-demo/charter.md");
    expect(sameStorage(charter("2026-10-08"), charter("2026-10-09"))).toBe(false);
    expect(isReadOnly(charter("2026-10-09"))).toBe(true);
    expect(await verifySnapshot(path.join(layout.backups, "2026-10-09"))).toEqual([]);
  });

  it("保留期内任一日期的快照都能单独完整恢复，更早的快照被清掉后也一样", async () => {
    const { daemon, dataDir, layout, syncDir, advanceTo } = await setup();
    const photo = crypto.randomBytes(200 * 1024);
    put(dataDir, "materials/media/photo-1", photo);
    put(dataDir, "projects/p-demo/progress.md", "10 月 7 日\n");
    const first = daemon.inbox.add({ kind: "notice", notice: "missed_reminder", title: "第一天的事项", source: "测试", urgency: "non_blocking" });
    for (let day = 8; day <= 16; day++) {
      await advanceTo(at(10, day, 3, 30));
      put(dataDir, "projects/p-demo/progress.md", `10 月 ${day} 日\n`);
    }
    // 本机只剩最近 7 份；10-08、10-09 被清掉了，媒体最早是在那两份里复制的
    expect(fs.readdirSync(layout.backups)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(listSnapshotDates(syncDir)).toContain("2026-10-10");
    await daemon.stop();

    for (const from of ["local", "sync"] as const) {
      await restoreSnapshot({ config: daemon.config, layout, date: "2026-10-10", from });
      expect(fs.readFileSync(path.join(dataDir, "materials/media/photo-1")).equals(photo)).toBe(true);
      expect(fs.readFileSync(path.join(dataDir, "projects/p-demo/progress.md"), "utf8")).toBe("10 月 9 日\n");
      expect(inboxIds(path.join(dataDir, "db/ergou.db"))).toEqual([first.id]);
    }
  });

  it("连续跑六周：本机只剩最近 7 份；同步目录只剩每日 7 份加每周 4 份，每周留下的都是周日的快照，公共池里没人用的回收；写进同步目录就算成功", async () => {
    const { daemon, dataDir, layout, syncDir, advanceTo } = await setup();
    // 一个较大的文件：头两天是 early，之后换成 later。early 只在早就清掉的快照里，公共池里的那份要回收
    const [early, later] = [crypto.randomBytes(100 * 1024), crypto.randomBytes(100 * 1024)];
    /** 一天天跑到 last 那天的 03:30 */
    const runDays = async (first: Date, last: Date, cover: Buffer) => {
      for (let day = first; day <= last; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 3, 30)) {
        put(dataDir, "projects/p-demo/progress.md", `${day.getMonth() + 1} 月 ${day.getDate()} 日\n`);
        put(dataDir, "materials/media/cover", cover);
        await advanceTo(day);
      }
    };
    await runDays(at(10, 8, 3, 30), at(10, 9, 3, 30), early);
    expect(poolFiles(syncDir)).toContain(sha256(early));
    await runDays(at(10, 10, 3, 30), at(11, 19, 3, 30), later);
    const daily = ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"];
    expect(fs.readdirSync(layout.backups)).toEqual(daily);
    // 2026-11-13 之前的四个周日
    expect(listSnapshotDates(syncDir)).toEqual(["2026-10-18", "2026-10-25", "2026-11-01", "2026-11-08", ...daily]);
    expect(fs.readdirSync(syncDir)).toEqual([...listSnapshotDates(syncDir), "pool"]);
    expect(fs.readFileSync(snapshotFile(syncDir, "2026-10-18", "projects/p-demo/progress.md"), "utf8")).toBe("10 月 18 日\n");
    // 公共池里只剩留下的快照用得到的：early 回收了，later 只有一份
    const used = new Set(
      listSnapshotDates(syncDir).flatMap((date) => snapshotEntries(readSnapshot(path.join(syncDir, date))!.manifest).flatMap(([, e]) => (e.pooled && e.sha256 ? [e.sha256] : []))),
    );
    expect(poolFiles(syncDir)).toEqual([...used].toSorted());
    expect(readSnapshot(path.join(layout.backups, daily[0]!))?.manifest.files["materials/media/cover"]?.sha256).toBe(sha256(later));
    expect(poolFiles(syncDir)).not.toContain(sha256(early));
    expect(poolFiles(syncDir)).toContain(sha256(later));
    expect(daemon.inbox.list()).toEqual([]);
  });

  it("周日那份当时没写进同步目录（同步目录不在）：之后同步目录能用了，从本机补写最近缺的那个周日快照，也能从它恢复", async () => {
    const syncDir = path.join(makeTempDir("ergou-sync-parent-"), "sync");
    fs.mkdirSync(syncDir);
    const { daemon, dataDir, layout, advanceTo } = await setup({ syncDir });
    put(dataDir, "projects/p-demo/progress.md", "周六\n");
    await advanceTo(at(10, 10, 3, 30));
    // 周六白天同步目录掉了（同步客户端没挂上）：周日 03:30 那份没写进去
    fs.renameSync(syncDir, `${syncDir}-offline`);
    put(dataDir, "projects/p-demo/progress.md", "周日\n");
    await advanceTo(at(10, 11, 3, 30));
    expect(daemon.inbox.list().map((i) => i.title)).toEqual(["备份失败：没写进同步目录"]);
    // 周一同步目录回来了：当晚的写进去，周日那份也从本机补上
    fs.renameSync(`${syncDir}-offline`, syncDir);
    put(dataDir, "projects/p-demo/progress.md", "周一\n");
    await advanceTo(at(10, 12, 3, 30));
    expect(listSnapshotDates(syncDir)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(fs.readFileSync(snapshotFile(syncDir, "2026-10-11", "projects/p-demo/progress.md"), "utf8")).toBe("周日\n");
    expect(daemon.inbox.list()).toHaveLength(1);

    // 本机那份没了，从同步目录补上的这份恢复
    await daemon.stop();
    fs.rmSync(path.join(layout.backups, "2026-10-11"), { recursive: true });
    await restoreSnapshot({ config: daemon.config, layout, date: "2026-10-11" });
    expect(fs.readFileSync(path.join(dataDir, "projects/p-demo/progress.md"), "utf8")).toBe("周日\n");
  });
});
