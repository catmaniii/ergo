// 体检后台盯着（416，src/doctor/watch.ts）：用真的体检（createDoctor + 登记表）、真的待我处理和事件库、手动拨的时钟，
// 盯着的几项按测试给的结果出（备份那一项用 411 真的判法 backupFinding），看：
// - 防抖：连着 3 轮不正常才放；一次抖动不放；没查出来不算好也不算坏；连着两轮、隔了 15 分钟以上也算；刚启动的 5 分钟不查；
// - 去重：同一件事只放一条（归档了、删了都不再放；重启后也认得没处理的那条）；别的模块已经说着同一件事时不放；
// - 修好了自动收：变回正常、不适用、插件停用（这一项没了）就把那条记成"已经好了"并归档，再坏放新的一条；
// - 不再提醒：点了记进 doctor-watch.json（重启后还在），体检页上恢复后再坏照常放；
// - 只跑盯着的几项、只跑 passive / local 两档：原来的八项、别的登记项一项都不查；
// - 事项的文字：哪件事、事实、从什么时候起、怎么修，没有"秘书""待我处理"；中英都有。
// 全是临时目录、假时钟，不碰真的数据目录、端口和模型。
import fs from "node:fs";
import path from "node:path";
import {
  activeLocale,
  activeLocaleFrom,
  type BackupRunRecord,
  DOCTOR_CHECKS,
  DOCTOR_CORE_GROUP,
  DOCTOR_MUTE_ACTION,
  DOCTOR_OPEN_ACTION,
  DOCTOR_WATCH_FIXED,
  type DoctorCheckId,
  type InboxItem,
  type NoticeInboxItem,
  setActiveLocale,
} from "@ergo/protocol";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { BackupDoctorFacts } from "../../src/backup/backup.ts";
import { createDoctorChecks, type DoctorCost, type DoctorFinding } from "../../src/doctor/checks.ts";
import { createDoctor, type DoctorProbes } from "../../src/doctor/doctor.ts";
import { housekeepingChecks } from "../../src/doctor/housekeeping.ts";
import { createDoctorWatch, DOCTOR_PROBLEM_NOTICE, DOCTOR_WATCHED, type DoctorWatchOptions, WATCH_INTERVAL_MS, WATCH_STARTUP_GRACE_MS } from "../../src/doctor/watch.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { MEMORY_NIGHTLY_FAILED_NOTICE, MEMORY_NIGHTLY_REBUILD_NOTICE } from "../../src/memory/nightly-job.ts";
import { ManualClock } from "../helpers/clock.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const START = Date.parse("2026-11-07T15:00:00+08:00");
const MINUTE = 60_000;
const EBUSY = "EBUSY: resource busy or locked, open 'C:\\Users\\demo\\.ergo\\outputs\\t-47\\Cookies'";

const before = activeLocale();
afterEach(() => setActiveLocale(before));

const OK: DoctorFinding = { level: "ok", fact: { key: "doctor.web.fine" } };
const WARN: DoctorFinding = { level: "warn", fact: { key: "doctor.web.fine" } };
const BROKEN: DoctorFinding = { level: "error", fact: { key: "doctor.web.missing", params: { path: "C:\\demo\\index.html" } }, fix: { key: "doctor.fix.web" } };

/** 测试里登记的几项：盯着的五项（备份另用真的判法），加几项不盯的（不该被查） */
const CONTROLLED: Array<{ group?: string; id: string; title: string; cost: DoctorCost }> = [
  { id: "model-calls", title: "doctor.check.modelCalls.title", cost: "passive" },
  { id: "context", title: "doctor.check.context.title", cost: "passive" },
  { group: "memory", id: "nightly", title: "memory.doctor.nightly.title", cost: "passive" },
  { group: "voice", id: "speech", title: "voice.doctor.speech.title", cost: "local" },
  { group: "voice", id: "recognizer", title: "voice.doctor.recognizer.title", cost: "local" },
  // 不盯的
  { id: "services", title: "doctor.check.services.title", cost: "local" },
  { id: "web", title: "doctor.check.web.title", cost: "passive" },
  { group: "memory", id: "brief", title: "memory.doctor.brief.title", cost: "passive" },
  { group: "voice", id: "gpu", title: "voice.doctor.gpu.title", cost: "local" },
];

const keyOf = (group: string | undefined, id: string) => `${group ?? DOCTOR_CORE_GROUP}/${id}`;

function record(extra: Partial<BackupRunRecord> = {}): BackupRunRecord {
  return { by: "daemon", mode: "auto", startedAt: "2026-11-07T06:37:00.000Z", finishedAt: "2026-11-07T06:37:30.000Z", date: "2026-11-07", local: "created", sync: "copied", ...extra };
}

/** 备份好好的 / 今天的样子（最近一次本机快照 EBUSY 没做成） */
const BACKUP_FINE: BackupDoctorFacts = { schedule: "internal", running: false, last: record(), lastOkAt: "2026-11-07T06:37:30.000Z" };
const BACKUP_EBUSY: BackupDoctorFacts = { schedule: "internal", running: false, last: record({ local: "failed", sync: "skipped", error: EBUSY }), lastOkAt: "2026-11-05T19:31:00.000Z", latestLocal: "2026-11-06" };

function setup(options: { dir?: string; watch?: Partial<DoctorWatchOptions> } = {}) {
  const dir = options.dir ?? makeTempDir("ergo-watch-");
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [inboxView] });
  const clock = new ManualClock(START);
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: () => new Date(clock.now()).toISOString() });
  const registry = createDoctorChecks();
  /** 每一项这一轮查出来的（不给是正常）；抛错的写 "throw" */
  const results = new Map<string, DoctorFinding | "throw">();
  /** 查过哪几项（按先后） */
  const ran: string[] = [];
  const offs = new Map<string, () => void>();
  for (const c of CONTROLLED) {
    const key = keyOf(c.group, c.id);
    offs.set(
      key,
      registry.register({
        id: c.id,
        title: c.title,
        cost: c.cost,
        ...(c.group === undefined ? {} : { plugin: c.group }),
        run: () => {
          ran.push(key);
          const result = results.get(key) ?? OK;
          if (result === "throw") throw new Error("查的时候出错了");
          return result;
        },
      }),
    );
  }
  // 备份：411 真的判法（housekeepingChecks 交回的那一项），读的状态由测试改
  let backupFacts = BACKUP_FINE;
  for (const check of housekeepingChecks({ now: () => clock.now(), backup: () => backupFacts })) {
    registry.register({
      ...check,
      run: (signal) => {
        ran.push(keyOf(undefined, check.id));
        return check.run(signal);
      },
    });
  }
  // 原来的八项：后台盯着一项都不该查
  const legacy: DoctorCheckId[] = [];
  const probes = Object.fromEntries(
    DOCTOR_CHECKS.map((id) => [
      id,
      () => {
        legacy.push(id);
        throw new Error("后台盯着不该查这一项");
      },
    ]),
  ) as unknown as DoctorProbes;
  const doctor = createDoctor({ probes, checks: registry, now: () => clock.now() });
  const file = path.join(dir, "config", "doctor-watch.json");
  const logs: string[] = [];
  const watch = createDoctorWatch({ doctor, inbox, store, clock, file, log: (line) => logs.push(line), ...options.watch });
  watch.start();
  let closed = false;
  /** 停掉、关库（"重启"前调；用例结束时没关的这里关） */
  const close = () => {
    if (closed) return;
    closed = true;
    watch.stop();
    store.close();
  };
  onTestFinished(close);
  const problems = (): NoticeInboxItem[] => inbox.list().filter((item): item is NoticeInboxItem => item.kind === "notice" && item.notice === DOCTOR_PROBLEM_NOTICE);
  const openProblems = () => problems().filter((item) => item.handled === undefined && !item.archived);
  /** 拨一段，再查一轮（定时器在另外的测试里测；这里一轮一轮地数） */
  const round = async (ms = WATCH_INTERVAL_MS) => {
    clock.advance(ms);
    await watch.round();
  };
  let actNo = 0;
  const act = (item: InboxItem, action: "archive" | "delete" | "handle", choice?: string) => inbox.act({ itemIds: [item.id], action, ...(choice === undefined ? {} : { choice }), idempotencyKey: `k-${++actNo}` });
  return {
    dir,
    close,
    clock,
    inbox,
    watch,
    file,
    logs,
    results,
    ran,
    legacy,
    offs,
    problems,
    openProblems,
    round,
    act,
    setBackup: (facts: BackupDoctorFacts) => {
      backupFacts = facts;
    },
  };
}

const MODEL = keyOf(undefined, "model-calls");
const SPEECH = keyOf("voice", "speech");

describe("防抖", () => {
  it("连着 3 轮不正常才放进待办；之前两轮不放", async () => {
    const s = setup();
    s.results.set(MODEL, BROKEN);
    await s.round();
    await s.round();
    expect(s.problems()).toEqual([]);
    await s.round();
    expect(s.problems()).toHaveLength(1);
    expect(s.problems()[0]!.data).toMatchObject({ group: DOCTOR_CORE_GROUP, id: "model-calls", level: "error" });
  });

  it("一次抖动不放：坏、好、坏、坏还不够；再坏一轮（连着 3 轮）才放", async () => {
    const s = setup();
    s.results.set(MODEL, WARN);
    await s.round();
    s.results.set(MODEL, OK);
    await s.round();
    s.results.set(MODEL, WARN);
    await s.round();
    await s.round();
    expect(s.problems()).toEqual([]);
    await s.round();
    expect(s.problems()).toHaveLength(1);
    expect(s.problems()[0]!.data).toMatchObject({ level: "warn" });
  });

  it("没查出来（抛错、超时）不算好也不算坏：坏、坏、没查出来、坏 → 第三次坏的时候放", async () => {
    const s = setup();
    s.results.set(SPEECH, BROKEN);
    await s.round();
    await s.round();
    s.results.set(SPEECH, "throw");
    await s.round();
    expect(s.problems()).toEqual([]);
    s.results.set(SPEECH, BROKEN);
    await s.round();
    expect(s.problems().map((item) => item.data)).toEqual([expect.objectContaining({ group: "voice", id: "speech", level: "error" })]);
  });

  it("持续超过一段时间也算：两轮都不正常、隔了 15 分钟以上（电脑睡了一觉）就放；隔 5 分钟的两轮不够", async () => {
    const s = setup();
    s.results.set(MODEL, BROKEN);
    await s.round();
    await s.round();
    expect(s.problems()).toEqual([]);

    const t = setup();
    t.results.set(MODEL, BROKEN);
    await t.round();
    await t.round(20 * MINUTE);
    expect(t.problems()).toHaveLength(1);
  });

  it("刚启动的 5 分钟不查；之后每 5 分钟一轮，到点了自己查（定时器）；坏了第三轮放进待办", async () => {
    const s = setup();
    s.results.set(MODEL, BROKEN);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    s.clock.advance(WATCH_STARTUP_GRACE_MS - MINUTE);
    await settle();
    expect(s.ran).toEqual([]);
    s.clock.advance(MINUTE);
    await settle();
    expect(s.ran).toContain(MODEL);
    const first = s.ran.length;
    s.clock.advance(WATCH_INTERVAL_MS - MINUTE);
    await settle();
    expect(s.ran).toHaveLength(first);
    s.clock.advance(MINUTE);
    await settle();
    expect(s.problems()).toEqual([]);
    s.clock.advance(WATCH_INTERVAL_MS);
    await settle();
    expect(s.problems()).toHaveLength(1);
    // 停了就不再查
    s.watch.stop();
    const count = s.ran.length;
    s.clock.advance(3 * WATCH_INTERVAL_MS);
    await settle();
    expect(s.ran).toHaveLength(count);
  });
});

describe("只查盯着的几项", () => {
  it("每一轮只跑盯着的（备份、每晚整理、语音合成和识别、模型近况、对话长度）：原来的八项、别的登记项一项都不查", async () => {
    const s = setup();
    await s.round();
    expect(s.legacy).toEqual([]);
    expect(s.ran.toSorted()).toEqual(DOCTOR_WATCHED.map((w) => `${w.group}/${w.id}`).toSorted());
    expect(s.ran).not.toContain(keyOf(undefined, "services"));
    expect(s.ran).not.toContain(keyOf("memory", "brief"));
  });

  it("盯的是方案里那几项；同一件事别的模块自己的通知种类对得上它们的常量", () => {
    expect(DOCTOR_WATCHED.map((w) => `${w.group}/${w.id}`)).toEqual(["ergo/backup", "memory/nightly", "voice/speech", "voice/recognizer", "ergo/model-calls", "ergo/context"]);
    expect(DOCTOR_WATCHED.find((w) => w.id === "nightly")!.related).toEqual([MEMORY_NIGHTLY_FAILED_NOTICE, MEMORY_NIGHTLY_REBUILD_NOTICE]);
  });
});

describe("放进待办的那一条", () => {
  it("备份（411 真的判法，今天的 EBUSY）：标题写哪件事，正文是事实、从什么时候起、怎么修；两个动作；不写秘书、待我处理", async () => {
    const s = setup();
    s.setBackup(BACKUP_EBUSY);
    await s.round();
    await s.round();
    await s.round();
    const [item] = s.problems();
    expect(item).toMatchObject({
      title: "备份有问题",
      source: "体检",
      urgency: "non_blocking",
      actions: [DOCTOR_OPEN_ACTION, DOCTOR_MUTE_ACTION],
      data: { group: DOCTOR_CORE_GROUP, id: "backup", level: "warn", title: { key: "doctor.check.backup.title" } },
    });
    const body = item!.body!;
    expect(body).toContain(EBUSY);
    // 备份那一项没给"从什么时候起"：用后台第一次看到它不正常的时刻
    expect(body).toContain("从 11/7 15:05 起");
    expect(body).toContain("怎么修：去设置 · 备份看最近一次失败的原因");
    expect(body).toContain("每 5 分钟");
    for (const text of [item!.title, body, item!.source]) {
      expect(text).not.toContain("秘书");
      expect(text).not.toContain("待我处理");
    }
  });

  it("坏了的写\"坏了\"，检查项自己给了从什么时候起就用它的；英文也拼得出来", async () => {
    const s = setup();
    s.results.set(SPEECH, { ...BROKEN, since: "2026-11-07T07:42:00.000Z" });
    await s.round();
    await s.round();
    await s.round();
    expect(s.problems()[0]).toMatchObject({ title: "语音合成坏了", data: { since: "2026-11-07T07:42:00.000Z" } });
    expect(s.problems()[0]!.body).toContain("从 11/7 15:42 起");

    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    const t = setup();
    t.setBackup(BACKUP_EBUSY);
    t.results.set(SPEECH, BROKEN);
    await t.round();
    await t.round();
    await t.round();
    const titles = t.problems().map((item) => item.title).toSorted();
    expect(titles).toEqual(["Backup has a problem", "Speech synthesis is broken"]);
    expect(t.problems().find((item) => item.title.startsWith("Backup"))!.body).toContain("How to fix:");
    expect(t.problems()[0]!.source).toBe("Checkup");
  });
});

describe("去重", () => {
  it("同一件事只放一条：一直坏着不再放；归档了、删了也不再放", async () => {
    const s = setup();
    s.results.set(MODEL, BROKEN);
    for (let i = 0; i < 5; i += 1) await s.round();
    expect(s.problems()).toHaveLength(1);

    s.act(s.problems()[0]!, "archive");
    for (let i = 0; i < 3; i += 1) await s.round();
    expect(s.problems()).toHaveLength(1);

    s.act(s.problems()[0]!, "delete");
    for (let i = 0; i < 3; i += 1) await s.round();
    expect(s.problems()).toEqual([]);
  });

  it("重启后（新的一份盯着）认得还没处理的那一条，不重复放", async () => {
    const dir = makeTempDir("ergo-watch-");
    const s = setup({ dir });
    s.results.set(MODEL, BROKEN);
    for (let i = 0; i < 3; i += 1) await s.round();
    expect(s.problems()).toHaveLength(1);
    s.close();

    const again = setup({ dir });
    again.results.set(MODEL, BROKEN);
    for (let i = 0; i < 4; i += 1) await again.round();
    expect(again.problems()).toHaveLength(1);
  });

  it("产生它的模块自己放的同一件事的通知还开着（备份失败），不再放体检的；那条处理了还是坏的，才放", async () => {
    const s = setup();
    const told = s.inbox.add({ kind: "notice", notice: "backup_failed", title: "昨晚的备份没做成", body: EBUSY, source: "系统", urgency: "non_blocking", actions: ["重试", "知道了"] });
    s.setBackup(BACKUP_EBUSY);
    for (let i = 0; i < 4; i += 1) await s.round();
    expect(s.problems()).toEqual([]);
    s.act(told, "handle", "知道了");
    await s.round();
    expect(s.problems()).toHaveLength(1);
  });
});

describe("修好了自动收", () => {
  it("变回正常：那一条记成\"已经好了\"、归档；再坏连着 3 轮放新的一条", async () => {
    const s = setup();
    s.results.set(MODEL, BROKEN);
    for (let i = 0; i < 3; i += 1) await s.round();
    const [first] = s.problems();
    s.results.set(MODEL, OK);
    await s.round();
    expect(s.inbox.get(first!.id)).toMatchObject({ archived: true, read: true, handled: DOCTOR_WATCH_FIXED });
    expect(s.openProblems()).toEqual([]);

    s.results.set(MODEL, BROKEN);
    await s.round();
    await s.round();
    expect(s.openProblems()).toEqual([]);
    await s.round();
    expect(s.openProblems()).toHaveLength(1);
    expect(s.openProblems()[0]!.id).not.toBe(first!.id);
  });

  it("用户归档了、后来好了：也记成已经好了；插件停用（这一项没了）、变成不适用都算好了", async () => {
    const s = setup();
    s.results.set(SPEECH, BROKEN);
    s.results.set(MODEL, BROKEN);
    for (let i = 0; i < 3; i += 1) await s.round();
    const speech = s.problems().find((item) => (item.data as { id: string }).id === "speech")!;
    const model = s.problems().find((item) => (item.data as { id: string }).id === "model-calls")!;
    s.act(model, "archive");

    // 语音插件停用：它登记的检查跟着撤了
    s.offs.get(SPEECH)!();
    s.results.set(MODEL, { level: "na", fact: { key: "doctor.web.fine" } });
    await s.round();
    expect(s.inbox.get(speech.id)).toMatchObject({ archived: true, handled: DOCTOR_WATCH_FIXED });
    expect(s.inbox.get(model.id)).toMatchObject({ archived: true, handled: DOCTOR_WATCH_FIXED });
  });
});

describe("不再提醒", () => {
  it("点了记进 doctor-watch.json：再坏不放；重启后还记得；体检页上恢复后再坏照常放", async () => {
    const dir = makeTempDir("ergo-watch-");
    const s = setup({ dir });
    s.results.set(MODEL, BROKEN);
    for (let i = 0; i < 3; i += 1) await s.round();
    const [item] = s.problems();
    s.act(item!, "handle", DOCTOR_MUTE_ACTION);
    expect(s.inbox.get(item!.id)).toMatchObject({ handled: DOCTOR_MUTE_ACTION });
    const saved = JSON.parse(fs.readFileSync(s.file, "utf8")) as { muted: unknown[] };
    expect(saved.muted).toEqual([{ group: DOCTOR_CORE_GROUP, id: "model-calls", title: { key: "doctor.check.modelCalls.title" }, at: expect.any(String) }]);
    expect(s.watch.view()).toEqual({ everyMinutes: 5, muted: [{ group: DOCTOR_CORE_GROUP, id: "model-calls", title: "模型近况", at: expect.any(String) }] });

    // 好了又坏：不放
    s.results.set(MODEL, OK);
    await s.round();
    s.results.set(MODEL, BROKEN);
    for (let i = 0; i < 4; i += 1) await s.round();
    expect(s.problems()).toHaveLength(1);
    s.close();

    // 重启：还记得
    const again = setup({ dir });
    again.results.set(MODEL, BROKEN);
    for (let i = 0; i < 4; i += 1) await again.round();
    expect(again.problems()).toHaveLength(1);
    expect(again.watch.view().muted).toHaveLength(1);

    // 体检页上"恢复提醒"：拿掉，下一轮还是坏的就放
    expect(again.watch.unmute({ group: DOCTOR_CORE_GROUP, id: "model-calls" })).toEqual({ everyMinutes: 5, muted: [] });
    expect(JSON.parse(fs.readFileSync(again.file, "utf8"))).toEqual({ muted: [] });
    await again.round();
    expect(again.openProblems()).toHaveLength(1);
    // 本来就没有的恢复一下照常回
    expect(again.watch.unmute({ group: "voice", id: "speech" }).muted).toEqual([]);
  });

  it("只记点了的那一项：别的照常放；文件坏了当没有，记一行日志", async () => {
    const dir = makeTempDir("ergo-watch-");
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "doctor-watch.json"), "{ 坏了");
    const s = setup({ dir });
    expect(s.watch.view().muted).toEqual([]);
    expect(s.logs.some((line) => line.includes("doctor-watch.json"))).toBe(true);
    s.results.set(MODEL, BROKEN);
    s.results.set(SPEECH, BROKEN);
    for (let i = 0; i < 3; i += 1) await s.round();
    s.act(s.problems().find((item) => (item.data as { id: string }).id === "model-calls")!, "handle", DOCTOR_MUTE_ACTION);
    s.results.set(MODEL, OK);
    s.results.set(SPEECH, OK);
    await s.round();
    s.results.set(MODEL, BROKEN);
    s.results.set(SPEECH, BROKEN);
    for (let i = 0; i < 3; i += 1) await s.round();
    expect(s.openProblems().map((item) => (item.data as { id: string }).id)).toEqual(["speech"]);
  });
});
