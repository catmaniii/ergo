// 生日、纪念日以前随手写的旧值，守护进程起来时一次性统一成存的样子（personal-files/annual-tidy.ts，经 PersonalFilesService.start）：
// 认得出的改写（照常的 field_set，留痕 via tidy、不带原话旧值）、认不出的和已经规范的不动、以前的值和删过的不动、
// 会变成农历又开着每年提醒的不动；第二次起来一条不写（用户撤销了那一条也不再改回去）；公历的每年提醒原样留着；日志只记数；
// 彻底删除这个字段时连这条一起改写；
// 统一写法不算"换了新值"（记忆这一侧不让旧事实到期），以后再改时连统一之前的写法一起。
// 跑真的事件存储（临时目录），提醒插件是假的（只在内存里）。以前的值直接往事件库里追加（绕过 449 的规范化，就是 449 以前存的样子）。
// 示例数据全是编的。
import path from "node:path";
import { PURGED_TEXT, type ReminderSchedule, SELF_PERSON_ID, type UserNameResult } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import type { CardService } from "../../src/cards/cards.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { PurgeRewriters } from "../../src/memory/index.ts";
import {
  type AnnualReminderPort,
  createPersonalFilesService,
  type FieldReplaced,
  PERSONAL_FILE_EVENT,
  PERSONAL_FILES_CHANNEL,
  type PersonalFileChange,
  personalFileEvent,
  personalFilePurge,
  personalFilesView,
} from "../../src/personal-files/index.ts";
import type { UserNameService } from "../../src/user-name/index.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";

function fakeUserName(): UserNameService {
  let name: string | undefined;
  return {
    current: () => name,
    view: () => (name === undefined ? {} : { name }),
    change(raw): UserNameResult {
      name = raw === null || raw.trim() === "" ? undefined : raw.trim();
      return { ...(name === undefined ? {} : { name }), changed: true };
    },
    onChange: () => () => {},
    start() {},
    stop() {},
  };
}

/** 只在内存里的提醒插件，记着建、改、删了几次 */
function fakeReminders() {
  const items = new Map<string, { status: string; text: string; schedule: ReminderSchedule }>();
  const calls = { create: 0, update: 0, remove: 0 };
  let next = 1;
  const port: AnnualReminderPort = {
    create(input) {
      calls.create++;
      const id = `r-${next++}`;
      items.set(id, { status: "pending", ...input });
      return { id };
    },
    update(id, input) {
      calls.update++;
      items.set(id, { ...items.get(id)!, ...input });
    },
    remove(id) {
      calls.remove++;
      items.set(id, { ...items.get(id)!, status: "deleted" });
    },
    get: (id) => items.get(id),
  };
  return { port, items, calls, snapshot: () => structuredClone([...items.entries()]) };
}

function setup() {
  const dir = makeTempDir("ergo-test-", true);
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [personalFilesView] });
  onTestFinished(() => {
    store.close();
    removeDir(dir);
  });
  const rewriters = new PurgeRewriters();
  rewriters.register(personalFilePurge);
  const cards = { get: () => undefined, registry: { get: () => undefined }, purged: (c: unknown) => c } as unknown as CardService;
  const reminders = fakeReminders();
  const userName = fakeUserName();
  const logs: string[] = [];
  /** 一个守护进程的个人档案（同一个事件库上再建一个就是重启） */
  const service = () =>
    createPersonalFilesService({
      store,
      cards,
      userName,
      inbox: { buildAdd: () => ({ item: {}, event: { channel: "inbox", type: "inbox_item", payload: {} } }) } as never,
      deletion: { store, cards, rewriters, materials: { list: () => [] } },
      today: () => "2026-11-10",
      now: () => "2026-11-10T08:00:00+08:00",
      annual: () => reminders.port,
      log: (line) => void logs.push(line),
    });
  return { store, files: service(), service, reminders, logs };
}

type Setup = ReturnType<typeof setup>;

/** 449 以前随手存的值：直接追加（不经规范化） */
const oldValue = (store: Setup["store"], personId: string, field: string, value: string) =>
  store.append(personalFileEvent({ change: "field_set", personId, field, value, trail: { via: "page" } }));

/** 档案事件（personal_file） */
const changes = (store: Setup["store"]) => store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT).map((e) => e.payload as PersonalFileChange);

/**
 * 449 以前的档案：
 * - 本人：生日 "1990/3/2"（开着提醒）；工作 "3月2号入职"（不是日子的字段）；女儿生日 "6月1号" 后来彻底删除了；
 * - 妈妈：生日先 "3月1号" 后 "3月2号"（开着提醒）；结婚纪念日 "每年 12 月 31 日"（开着提醒）；外婆生日 "八月十五"，设置里开着提醒
 *   （以前是认得出的公历日子时开的，后来改成了"八月十五"：提醒删了、设置留着）；
 * - 爸爸：生日 "八月十五"（没开提醒）；相识纪念日 "大学开学那天"（认不出）；
 * - 女儿：生日 449 以后经档案页写的，已经是存的样子。
 */
function seed({ store, files }: Setup) {
  oldValue(store, SELF_PERSON_ID, "birthday", "1990/3/2");
  oldValue(store, SELF_PERSON_ID, "work", "3月2号入职");
  oldValue(store, SELF_PERSON_ID, "custom:女儿生日", "6月1号");
  files.remove(SELF_PERSON_ID, { target: { kind: "field", field: "custom:女儿生日" }, mode: "purge" });
  files.change(SELF_PERSON_ID, { kind: "set_reminder", field: "birthday", daysBefore: 3 });

  const mom = files.addPerson({ name: "妈妈", relation: "母亲" }).id;
  oldValue(store, mom, "birthday", "3月1号");
  oldValue(store, mom, "birthday", "3月2号");
  oldValue(store, mom, "anniversary:结婚纪念日", "每年 12 月 31 日");
  oldValue(store, mom, "custom:外婆生日", "八月十五");
  files.change(mom, { kind: "set_reminder", field: "birthday", daysBefore: 3 });
  files.change(mom, { kind: "set_reminder", field: "anniversary:结婚纪念日", daysBefore: 0 });
  store.append(personalFileEvent({ change: "reminder_set", personId: mom, field: "custom:外婆生日", daysBefore: 3, trail: { via: "page" } }));

  const dad = files.addPerson({ name: "爸爸", relation: "父亲" }).id;
  oldValue(store, dad, "birthday", "八月十五");
  oldValue(store, dad, "anniversary:相识纪念日", "大学开学那天");

  const daughter = files.addPerson({ name: "女儿", relation: "女儿" }).id;
  files.change(daughter, { kind: "set_field", field: "birthday", value: "5月20号" });
  return { mom, dad, daughter };
}

const fieldOf = (files: Setup["files"], personId: string, field: string) => files.file(personId)!.fields.find((f) => f.field === field)!;

describe("起来时统一以前随手写的生日、纪念日", () => {
  it("认得出的改写成存的样子（留痕 tidy，不带原话旧值）；认不出的、已规范的、以前的值、删过的、不是日子的字段、会变农历又开着提醒的不动", () => {
    const t = setup();
    const { mom, dad, daughter } = seed(t);
    const { store, files } = t;
    const before = changes(store).length;
    files.start();
    const added = changes(store).slice(before);
    expect(added).toEqual([
      { change: "field_set", personId: SELF_PERSON_ID, field: "birthday", value: "1990-03-02", trail: { via: "tidy" } },
      { change: "field_set", personId: mom, field: "anniversary:结婚纪念日", value: "--12-31", trail: { via: "tidy" } },
      { change: "field_set", personId: mom, field: "birthday", value: "--03-02", trail: { via: "tidy" } },
      { change: "field_set", personId: dad, field: "birthday", value: "lunar:--08-15", trail: { via: "tidy" } },
    ]);

    // 现在的值是存的样子，出处是二狗统一了写法（没有原话）；原来的写法在以前的值里，以前的以前照旧
    const momBirthday = fieldOf(files, mom, "birthday");
    expect(momBirthday.current).toEqual({ value: "--03-02", since: expect.any(String), source: { via: "tidy", at: expect.any(String) } });
    expect(momBirthday.history.map((h) => [h.value, h.source?.via])).toEqual([
      ["3月2号", "page"],
      ["3月1号", "page"],
    ]);
    expect(fieldOf(files, SELF_PERSON_ID, "birthday").current?.value).toBe("1990-03-02");
    expect(fieldOf(files, mom, "anniversary:结婚纪念日").current?.value).toBe("--12-31");
    expect(fieldOf(files, dad, "birthday").current?.value).toBe("lunar:--08-15");
    // 不动的
    expect(fieldOf(files, mom, "custom:外婆生日")).toMatchObject({ current: { value: "八月十五" }, history: [], annual: { daysBefore: 3, blocked: "not_gregorian" } });
    expect(fieldOf(files, dad, "anniversary:相识纪念日")).toMatchObject({ current: { value: "大学开学那天" }, history: [] });
    expect(fieldOf(files, daughter, "birthday")).toMatchObject({ current: { value: "--05-20", source: { via: "page" } }, history: [] });
    expect(fieldOf(files, SELF_PERSON_ID, "work").current?.value).toBe("3月2号入职");
    expect(files.file(SELF_PERSON_ID)!.fields.some((f) => f.field === "custom:女儿生日")).toBe(false);

    // 日志只记数，不记值
    const line = t.logs.find((l) => l.includes("统一写法"));
    expect(line).toBe("个人档案：生日、纪念日统一写法，改了 4 条，认不出没动 1 条，开着每年提醒、会变成农历的没动 1 条");
  });

  it("再起来一次一条不写；公历的每年提醒原样留着（日子、内容不变，不删不建不改）", () => {
    const t = setup();
    const { mom } = seed(t);
    const { store, reminders } = t;
    const remindersBefore = reminders.snapshot();
    expect(remindersBefore.filter(([, r]) => r.status === "pending")).toHaveLength(3);
    const calls = { ...reminders.calls };
    t.files.start();
    const afterFirst = changes(store).length;
    expect(reminders.snapshot()).toEqual(remindersBefore);
    expect(reminders.calls).toEqual(calls);
    expect(fieldOf(t.files, mom, "birthday").annual).toMatchObject({ monthDay: { month: 3, day: 2 }, daysBefore: 3 });
    expect(fieldOf(t.files, mom, "anniversary:结婚纪念日").annual).toMatchObject({ monthDay: { month: 12, day: 31 }, daysBefore: 0 });
    expect(fieldOf(t.files, SELF_PERSON_ID, "birthday").annual).toMatchObject({ monthDay: { month: 3, day: 2 }, daysBefore: 3 });

    // 重启：同一个事件库上新起一份
    const again = t.service();
    again.start();
    expect(changes(store).length).toBe(afterFirst);
    expect(reminders.snapshot()).toEqual(remindersBefore);
    expect(reminders.calls).toEqual(calls);
    expect(t.logs.filter((l) => l.includes("统一写法")).at(-1)).toBe("个人档案：生日、纪念日统一写法，改了 0 条，认不出没动 1 条，开着每年提醒、会变成农历的没动 1 条");
  });

  it("用户撤销了统一写法的那一条（回到原来的写法）：下次起来不再改回去", () => {
    const t = setup();
    const { mom } = seed(t);
    t.files.start();
    t.files.change(mom, { kind: "undo_field", field: "birthday" });
    expect(fieldOf(t.files, mom, "birthday").current?.value).toBe("3月2号");
    const before = changes(t.store).length;
    t.service().start();
    expect(changes(t.store).length).toBe(before);
    expect(fieldOf(t.files, mom, "birthday").current?.value).toBe("3月2号");
  });

  it("彻底删除这个字段：统一写法写的那条和以前的写法一起改写", () => {
    const t = setup();
    const { mom } = seed(t);
    t.files.start();
    t.files.remove(mom, { target: { kind: "field", field: "birthday" }, mode: "purge" });
    const payloads = JSON.stringify(changes(t.store).filter((c) => "personId" in c && c.personId === mom));
    for (const text of ["--03-02", "3月2号", "3月1号"]) expect(payloads).not.toContain(text);
    const tidied = changes(t.store).filter((c) => c.change === "field_set" && c.personId === mom && c.field === "birthday" && c.trail.via === "tidy");
    expect(tidied).toEqual([{ change: "field_set", personId: mom, field: "birthday", value: PURGED_TEXT, trail: { via: "tidy" } }]);
    // 别的字段的照旧
    expect(fieldOf(t.files, mom, "anniversary:结婚纪念日").current?.value).toBe("--12-31");
  });

  it("统一写法不算换了新值：不通知记忆插件、以前换过的值里不列；以后再改这个值，连统一之前的写法一起", () => {
    const t = setup();
    const { mom } = seed(t);
    const heard: FieldReplaced[] = [];
    t.files.forMemory.onFieldReplaced((change) => void heard.push(change));
    t.files.start();
    expect(heard).toEqual([]);
    // 只有用户自己换掉的那次（"3月1号" 换成 "3月2号"）
    expect(t.files.forMemory.replacedValues().map((r) => [r.personId, r.field, r.oldValue])).toEqual([[mom, "birthday", "3月1号"]]);

    t.files.change(mom, { kind: "set_field", field: "结婚纪念日", value: "1月1日" });
    expect(heard.map((r) => [r.field, r.oldValue])).toEqual([
      ["anniversary:结婚纪念日", "--12-31"],
      ["anniversary:结婚纪念日", "每年 12 月 31 日"],
    ]);
    const replaced = t.files.forMemory.replacedValues().filter((r) => r.field === "anniversary:结婚纪念日");
    expect(replaced.map((r) => r.oldValue)).toEqual(["--12-31", "每年 12 月 31 日"]);
    expect(new Set(replaced.map((r) => r.at)).size).toBe(1);
  });

  it("彻底删除改写过、却还是现在的值的（不该有，防着）：不动，也不算认不出", () => {
    const t = setup();
    oldValue(t.store, SELF_PERSON_ID, "birthday", PURGED_TEXT);
    const before = changes(t.store).length;
    t.files.start();
    expect(changes(t.store).length).toBe(before);
    expect(t.logs.some((l) => l.includes("统一写法"))).toBe(false);
  });
});
