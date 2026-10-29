// 设置里的"备份"（335 号票）：同步目录、最近一次、最新的快照、下一次（或者交给外部定时器）、正在做的，"立即备份"做完怎么说。
// 守护进程的回答按协议的 schema 构造；界面文字里不出现"秘书""待我处理"。
import { BackupStatusView as StatusSchema, schemaChecker } from "@ergo/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { activeLocaleFrom, type BackupRunRecord, type BackupStatusView, backupDoneText, backupText, DEFAULT_LANGUAGE, setActiveLocale } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const checkView = schemaChecker(StatusSchema);

function view(overrides: Partial<BackupStatusView> = {}): BackupStatusView {
  const v: BackupStatusView = {
    schedule: "internal",
    time: "03:30",
    next: "2026-10-29T03:30:00.000+08:00",
    syncDir: { kind: "ready", dir: "C:\\家庭存储\\二狗备份" },
    latestLocal: "2026-10-28",
    latestSync: "2026-10-28",
    last: record(),
    queued: false,
    ...overrides,
  };
  const problem = checkView.firstError(v);
  if (problem) throw new Error(`构造的回答不合 schema：${problem}`);
  return v;
}

function record(overrides: Partial<BackupRunRecord> = {}): BackupRunRecord {
  return { by: "daemon", mode: "auto", startedAt: "2026-10-28T03:30:00.000+08:00", finishedAt: "2026-10-28T03:31:12.000+08:00", date: "2026-10-28", local: "created", sync: "copied", ...overrides };
}

const FORBIDDEN = /秘书|待我处理/;

describe("设置里的备份", () => {
  test("守护进程每天到点做：同步目录、最近一次、最新的快照、下一次；没在做，能点立即备份", () => {
    const text = backupText(view());
    expect(text).toEqual({
      syncDir: "同步目录：C:\\家庭存储\\二狗备份",
      last: "最近一次：10-28 03:31 · 本机和同步目录都写好了",
      lastFailed: false,
      latest: "最新的快照：本机 2026-10-28，同步目录 2026-10-28",
      next: "每天 03:30 自动备份，下次 10-29 03:30",
      busy: undefined,
      canRun: true,
    });
  });

  test("交给外部定时器：写清楚谁来调；命令行做的注明；还没快照、还没备份过、没配同步目录各有说法", () => {
    const external = backupText(view({ schedule: "external", last: record({ by: "script", mode: "manual" }) }));
    expect(external.next).toBe("交给外部定时器每天调 npm run backup（守护进程不自己定时；连着两天没跑会提醒）");
    expect(external.last).toBe("最近一次：10-28 03:31（命令行） · 本机和同步目录都写好了");

    const fresh = view({ syncDir: { kind: "none" } });
    delete fresh.next;
    delete fresh.last;
    delete fresh.latestLocal;
    delete fresh.latestSync;
    expect(backupText(fresh)).toMatchObject({ syncDir: "没配同步目录（backup.syncDir），只备份在本机", last: "还没备份过", latest: "还没有快照", next: "每天 03:30 自动备份" });
    expect(backupText(view({ syncDir: { kind: "none" }, latestSync: undefined } as Partial<BackupStatusView>)).latest).toBe("最新的快照：本机 2026-10-28");
  });

  test("没做成的标红、写原因；同步目录用不了写原因", () => {
    const syncFailed = backupText(
      view({ syncDir: { kind: "unusable", dir: "C:\\家庭存储\\二狗备份", reason: "同步目录 C:\\家庭存储\\二狗备份 不存在" }, last: record({ sync: "failed", error: "同步目录 C:\\家庭存储\\二狗备份 不存在" }) }),
    );
    expect(syncFailed.syncDir).toBe("同步目录用不了：同步目录 C:\\家庭存储\\二狗备份 不存在");
    expect(syncFailed.last).toBe("最近一次：10-28 03:31 · 本机做好了，没写进同步目录：同步目录 C:\\家庭存储\\二狗备份 不存在");
    expect(syncFailed.lastFailed).toBe(true);
    expect(backupText(view({ last: record({ local: "failed", sync: "skipped", error: "空间不够" }) })).last).toBe("最近一次：10-28 03:31 · 没做成：空间不够");
    expect(backupText(view({ last: record({ local: "kept", sync: "kept" }) })).last).toBe("最近一次：10-28 03:31 · 当天的快照都已经有了，没重做");
    expect(backupText(view({ last: record({ sync: "not_configured" }) })).last).toBe("最近一次：10-28 03:31 · 只在本机（没配同步目录）");
  });

  test("正在做：谁、从几点起；守护进程排着一次时按钮点不了", () => {
    const running = backupText(view({ running: { by: "script", pid: 4242, since: "2026-10-28T15:02:09.000+08:00" } }));
    expect(running).toMatchObject({ busy: "命令行正在备份（从 10-28 15:02 起）", canRun: true });
    const queued = backupText(view({ queued: true, running: { by: "daemon", pid: 1, since: "2026-10-28T15:02:09.000+08:00" } }));
    expect(queued).toMatchObject({ busy: "守护进程正在备份（从 10-28 15:02 起）", canRun: false });
    expect(backupText(view({ queued: true })).busy).toBe("排着一次，等前一份做完");
  });

  test("立即备份做完的提示：成了写日期，没成写原因", () => {
    expect(backupDoneText(record({ by: "daemon", mode: "manual" }))).toBe("备份完成：2026-10-28，本机和同步目录都写好了");
    expect(backupDoneText(record({ sync: "failed", error: "空间不够" }))).toBe("备份：本机做好了，没写进同步目录：空间不够");
  });

  test("界面文字里没有“秘书”“待我处理”这两个字面词", () => {
    const all = [
      backupText(view()),
      backupText(view({ schedule: "external", queued: true, running: { by: "script", pid: 1, since: "2026-10-28T15:02:09.000+08:00" } })),
      backupText(view({ syncDir: { kind: "none" }, last: record({ local: "failed", sync: "skipped", error: "x" }) })),
    ].flatMap((t) => [t.syncDir, t.last, t.latest, t.next, t.busy ?? ""]);
    for (const s of all) expect(s).not.toMatch(FORBIDDEN);
  });
});

describe("英文", () => {
  beforeAll(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en")));
  afterAll(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

  test("全是英文，没有中文", () => {
    const text = backupText(view({ syncDir: { kind: "ready", dir: "D:\\backup" }, schedule: "external", running: { by: "script", pid: 1, since: "2026-10-28T15:02:09.000+08:00" } }));
    expect(text).toMatchObject({
      syncDir: "Sync folder: D:\\backup",
      last: "Last backup: 10-28 03:31 · saved on this computer and in the sync folder",
      latest: "Latest snapshot: 2026-10-28 on this computer, 2026-10-28 in the sync folder",
      busy: "The command line is backing up (since 10-28 15:02)",
    });
    expect(text.next).toMatch(/^Left to an external timer that runs npm run backup every day/);
    expect(backupDoneText(record())).toBe("Backup done for 2026-10-28: saved on this computer and in the sync folder");
    for (const s of [text.syncDir, text.last, text.latest, text.next, text.busy ?? ""]) expect(s).not.toMatch(/[　-〿㐀-䶿一-鿿豈-﫿！-｠]/);
  });
});
