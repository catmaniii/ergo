// 个人档案的服务（281 号票）：派生视图、历史、撤销、自定义字段、按称呼和别名找、本人的姓名就是"我的名字"、忘掉和彻底删除、
// 重放后一样。跑真的事件存储（临时目录），只经档案页那条路写（秘书那条路在主切面 test/main/personal-files.test.ts）。
// 示例数据全是编的。
import path from "node:path";
import { PURGED_TEXT, SELF_PERSON_ID, type UserNameResult } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import type { CardService } from "../../src/cards/cards.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { PurgeRewriters } from "../../src/memory/index.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { createPersonalFilesService, PERSONAL_FILE_EVENT, PERSONAL_FILES_CHANNEL, personalFilePurge, personalFilesView } from "../../src/personal-files/index.ts";
import type { UserNameService } from "../../src/user-name/index.ts";
import { makeTempDir, removeDir } from "../helpers/temp-dir.ts";

/** 只在内存里的"我的名字" */
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

function setup() {
  // 库开着时删不掉目录（Windows）：先关库再删
  const dir = makeTempDir("ergo-test-", true);
  const file = path.join(dir, "ergo.db");
  const store = openEventStore({ file, views: [personalFilesView] });
  onTestFinished(() => {
    try {
      store.close();
    } catch {
      // 用例里已经关了
    }
    removeDir(dir);
  });
  const rewriters = new PurgeRewriters();
  rewriters.register(personalFilePurge);
  const cards = { get: () => undefined, registry: { get: () => undefined }, purged: (c: unknown) => c } as unknown as CardService;
  const userName = fakeUserName();
  const files = createPersonalFilesService({
    store,
    cards,
    userName,
    inbox: { buildAdd: () => ({ item: {}, event: { channel: "inbox", type: "inbox_item", payload: {} } }) } as never,
    deletion: { store, cards, rewriters, materials: { list: () => [] } },
    today: () => "2026-10-25",
    now: () => "2026-10-25T10:00:00+08:00",
    log: () => {},
  });
  return { store, files, userName, file };
}

describe("档案页那条路：建人、写字段、历史、撤销", () => {
  it("建一个人：称呼和关系各一个字段；列表里本人在最前", () => {
    const { files } = setup();
    const mom = files.addPerson({ name: " 妈妈 ", relation: "母亲" });
    expect(mom).toMatchObject({ kind: "person", name: "妈妈" });
    // 283 号票起"二狗了解到的"另外取（GET /api/personal-files/<编号>/learned），档案本身不带；302 号票起默认字段多一个"纪念日"
    expect(mom).not.toHaveProperty("learned");
    expect(mom.fields.map((f) => f.field)).toEqual(["name", "aliases", "relation", "birthday", "anniversary", "phone", "address", "work", "health"]);
    expect(files.list().files).toEqual([
      { id: SELF_PERSON_ID, kind: "self", filled: 0, notes: 0 },
      // 285：没选分组，按关系猜成家人
      { id: mom.id, kind: "person", name: "妈妈", relation: "母亲", group: "family", groupGuessed: true, filled: 2, notes: 0 },
    ]);
    // 同名的不能再建
    expect(() => files.addPerson({ name: "妈妈" })).toThrow(/已经有「妈妈」的档案了/);
  });

  it("同一字段来了新值，旧值记成历史；撤销回到上一个值，撤销的那个不进历史；值没变不写", () => {
    const { files, store } = setup();
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "address", value: "文三路 18 号" });
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "address", value: "漕溪北路 9 号" });
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "address", value: "漕溪北路 9 号" });
    let address = files.file(SELF_PERSON_ID)!.fields.find((f) => f.field === "address")!;
    expect(address.current).toMatchObject({ value: "漕溪北路 9 号", source: { via: "page" } });
    expect(address.history).toMatchObject([{ value: "文三路 18 号", until: expect.any(String) }]);
    expect(store.read(PERSONAL_FILES_CHANNEL, 0).length).toBe(2);

    files.change(SELF_PERSON_ID, { kind: "undo_field", field: "address" });
    address = files.file(SELF_PERSON_ID)!.fields.find((f) => f.field === "address")!;
    expect(address.current?.value).toBe("文三路 18 号");
    expect(address.history).toEqual([]);
    files.change(SELF_PERSON_ID, { kind: "undo_field", field: "address" });
    expect(files.file(SELF_PERSON_ID)!.fields.find((f) => f.field === "address")!.current).toBeUndefined();
    expect(() => files.change(SELF_PERSON_ID, { kind: "undo_field", field: "address" })).toThrow(/没有可以撤销/);
  });

  it("自定义字段排在默认字段后面；号码类按值判断；不合规的值说明原因", () => {
    const { files } = setup();
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "custom:社保卡号", value: "1234567890" });
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "车牌号", value: "浙A12345" });
    const fields = files.file(SELF_PERSON_ID)!.fields;
    expect(fields.slice(-2).map((f) => [f.field, f.label, f.custom, f.number])).toEqual([
      ["custom:社保卡号", "社保卡号", true, true],
      ["custom:车牌号", "车牌号", true, false],
    ]);
    expect(() => files.change(SELF_PERSON_ID, { kind: "set_field", field: "phone", value: "  " })).toThrow(/手机：值不能是空的/);
  });

  it("按称呼、别名、编号找；\"我\"是本人", () => {
    const { files } = setup();
    const zhang = files.addPerson({ name: "小张", relation: "表弟" });
    files.change(zhang.id, { kind: "set_field", field: "aliases", value: "张三、阿张" });
    expect(files.find("我")).toMatchObject({ id: SELF_PERSON_ID, kind: "self" });
    expect(files.find("小张")?.id).toBe(zhang.id);
    expect(files.find("阿张")?.id).toBe(zhang.id);
    expect(files.find(zhang.id)?.id).toBe(zhang.id);
    expect(files.find("小李")).toBeUndefined();
  });

  it("记下的事按日期新的在前，不写日期是今天", () => {
    const { files } = setup();
    const mom = files.addPerson({ name: "妈妈" });
    files.change(mom.id, { kind: "add_note", text: "腿脚不好", date: "2026-09-01" });
    files.change(mom.id, { kind: "add_note", text: "喜欢喝普洱" });
    expect(files.file(mom.id)!.notes.map((n) => [n.date, n.text])).toEqual([
      ["2026-10-25", "喜欢喝普洱"],
      ["2026-09-01", "腿脚不好"],
    ]);
  });
});

describe("本人的姓名就是\"我的名字\"", () => {
  it("档案里改姓名改的是我的名字，没有历史；不合规照我的名字的规矩拒；删了就是清除", () => {
    const { files, userName, store } = setup();
    userName.change("文翰");
    expect(files.file(SELF_PERSON_ID)!.fields[0]).toMatchObject({ field: "name", linked: "user_name", current: { value: "文翰" }, history: [] });
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "姓名", value: "小明" });
    expect(userName.current()).toBe("小明");
    // 事件里只留痕，不另存一份名字
    expect(JSON.stringify(store.read(PERSONAL_FILES_CHANNEL, 0).map((e) => e.payload))).not.toContain("小明");
    expect(() => files.change(SELF_PERSON_ID, { kind: "set_field", field: "name", value: "一二三四五六七八九" })).toThrow(/最多 8 个字/);
    files.remove(SELF_PERSON_ID, { target: { kind: "field", field: "name" }, mode: "forget" });
    expect(userName.current()).toBeUndefined();
  });
});

describe("删", () => {
  it("忘掉一个字段：档案里没有了（连同历史），事件日志里原值还在", () => {
    const { files, store } = setup();
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "phone", value: "13800001111" });
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "phone", value: "13900002222" });
    const result = files.remove(SELF_PERSON_ID, { target: { kind: "field", field: "phone" }, mode: "forget" });
    expect(result.sources).toBe(0);
    expect(result.file!.fields.find((f) => f.field === "phone")).toMatchObject({ history: [] });
    expect(result.file!.fields.find((f) => f.field === "phone")!.current).toBeUndefined();
    expect(JSON.stringify(store.read(PERSONAL_FILES_CHANNEL, 0).map((e) => e.payload))).toContain("13800001111");
  });

  it("彻底删除一个人：整份档案没了，带原值的事件换成删除标记（编号、字段名、留痕原样）；别人的不动", () => {
    const { files, store } = setup();
    const mom = files.addPerson({ name: "妈妈", relation: "母亲" });
    files.change(mom.id, { kind: "set_field", field: "birthday", value: "3月2日" });
    files.change(mom.id, { kind: "add_note", text: "腿脚不好" });
    const dad = files.addPerson({ name: "爸爸" });
    files.change(dad.id, { kind: "set_field", field: "birthday", value: "5月1日" });
    const result = files.remove(mom.id, { target: { kind: "person" }, mode: "purge" });
    expect(result).toEqual({ sources: 0 });
    expect(files.file(mom.id)).toBeUndefined();
    const payloads = JSON.stringify(store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT).map((e) => e.payload));
    for (const text of ["妈妈", "母亲", "3月2日", "腿脚不好"]) expect(payloads).not.toContain(text);
    expect(payloads).toContain(PURGED_TEXT);
    expect(payloads).toContain("5月1日");
    expect(files.file(dad.id)!.fields.find((f) => f.field === "birthday")!.current?.value).toBe("5月1日");
    // 本人那份删不掉
    expect(() => files.remove(SELF_PERSON_ID, { target: { kind: "person" }, mode: "purge" })).toThrow(/删不掉/);
  });

  it("彻底删除一件事：只改那一件", () => {
    const { files, store } = setup();
    const mom = files.addPerson({ name: "妈妈" });
    const noted = files.change(mom.id, { kind: "add_note", text: "腿脚不好", date: "2026-09-01" });
    files.change(mom.id, { kind: "add_note", text: "喜欢喝普洱", date: "2026-09-02" });
    files.remove(mom.id, { target: { kind: "note", noteId: noted.notes[0]!.id }, mode: "purge" });
    expect(files.file(mom.id)!.notes.map((n) => n.text)).toEqual(["喜欢喝普洱"]);
    const payloads = JSON.stringify(store.read(PERSONAL_FILES_CHANNEL, 0).map((e) => e.payload));
    expect(payloads).not.toContain("腿脚不好");
    expect(payloads).toContain("喜欢喝普洱");
  });
});

describe("派生视图", () => {
  it("清空重放、关了再开（表在、从事件日志补）都和原来一样", () => {
    const { files, store, file, userName } = setup();
    const mom = files.addPerson({ name: "妈妈" });
    files.change(mom.id, { kind: "set_field", field: "birthday", value: "3月2日" });
    files.change(mom.id, { kind: "set_field", field: "birthday", value: "3月5日" });
    files.change(mom.id, { kind: "undo_field", field: "birthday" });
    files.change(mom.id, { kind: "add_note", text: "腿脚不好", date: "2026-09-01" });
    files.remove(mom.id, { target: { kind: "note", noteId: files.file(mom.id)!.notes[0]!.id }, mode: "forget" });
    const before = files.file(mom.id);
    store.rebuildViews();
    expect(files.file(mom.id)).toEqual(before);
    store.close();
    const reopened = openEventStore({ file, views: [personalFilesView] });
    const again = createPersonalFilesService({
      store: reopened,
      cards: { get: () => undefined } as unknown as CardService,
      userName,
      inbox: { buildAdd: () => ({ item: {}, event: { channel: "inbox", type: "inbox_item", payload: {} } }) } as never,
      deletion: { store: reopened, cards: {} as CardService, rewriters: new PurgeRewriters(), materials: { list: () => [] } },
      today: () => "2026-10-25",
      now: () => "2026-10-25T10:00:00+08:00",
      log: () => {},
    });
    expect(again.file(mom.id)).toEqual(before);
    reopened.close();
  });
});

describe("分组（285 号票）：建人时选、能改，没选的按关系猜", () => {
  it("建人时选了分组就是它；没选的按关系猜（家人 / 其他人），猜不成重要的人；本人那份没有分组", () => {
    const { files } = setup();
    const zhang = files.addPerson({ name: "小张", relation: "同事", group: "important" });
    const mom = files.addPerson({ name: "妈妈", relation: "母亲" });
    const wang = files.addPerson({ name: "王师傅" });
    expect(zhang).toMatchObject({ group: "important" });
    expect(zhang).not.toHaveProperty("groupGuessed");
    expect(mom).toMatchObject({ group: "family", groupGuessed: true });
    expect(wang).toMatchObject({ group: "others", groupGuessed: true });
    const self = files.file(SELF_PERSON_ID)!;
    expect(self).not.toHaveProperty("group");
    expect(files.list().files.map((f) => [f.name ?? f.id, f.group, f.groupGuessed])).toEqual([
      [SELF_PERSON_ID, undefined, undefined],
      ["小张", "important", undefined],
      ["妈妈", "family", true],
      ["王师傅", "others", true],
    ]);
  });

  it("改分组：选了以后不再按关系猜（改了关系也不跟着变）；本人那份改不了；不认得的分组拒", () => {
    const { files } = setup();
    const mom = files.addPerson({ name: "妈妈", relation: "母亲" });
    expect(files.change(mom.id, { kind: "set_group", group: "important" })).toMatchObject({ group: "important" });
    files.change(mom.id, { kind: "set_field", field: "relation", value: "同事" });
    expect(files.file(mom.id)).toMatchObject({ group: "important" });
    expect(files.file(mom.id)).not.toHaveProperty("groupGuessed");
    // 没选过分组的人改了关系，猜的跟着变
    const li = files.addPerson({ name: "小李", relation: "朋友" });
    expect(li).toMatchObject({ group: "others", groupGuessed: true });
    expect(files.change(li.id, { kind: "set_field", field: "relation", value: "妹妹" })).toMatchObject({ group: "family", groupGuessed: true });
    expect(() => files.change(SELF_PERSON_ID, { kind: "set_group", group: "family" })).toThrow(/本人/);
    expect(() => files.change(mom.id, { kind: "set_group", group: "nope" as never })).toThrow(/不认得这个分组/);
  });

  it("秘书、记忆管理员提议建的人（283 的提议建档、284 的访谈）没选分组：按关系猜，猜不出归其他人", () => {
    const { files, store } = setup();
    const trail = { via: "curator", basis: "confirmed", cardId: "c-1", origin: "nightly" } as const;
    const a = files.prepareWrite({ person: { newName: "老周", relation: "同事" }, fields: [], trail });
    store.appendBatch(a.events);
    const b = files.prepareWrite({ person: { newName: "大姐", relation: "姐姐" }, fields: [], trail });
    store.appendBatch(b.events);
    expect(files.file(a.personId)).toMatchObject({ group: "others", groupGuessed: true });
    expect(files.file(b.personId)).toMatchObject({ group: "family", groupGuessed: true });
  });

  it("删了人连分组一起没了；清空重放、旧库没有分组的表（升级）从事件日志补回来", () => {
    const { files, store, file, userName } = setup();
    const zhang = files.addPerson({ name: "小张", group: "important" });
    const mom = files.addPerson({ name: "妈妈", relation: "母亲" });
    files.change(mom.id, { kind: "set_group", group: "others" });
    files.remove(zhang.id, { target: { kind: "person" }, mode: "purge" });
    // 同名重建的是新的一份：不带原来的分组
    expect(files.addPerson({ name: "小张" })).toMatchObject({ group: "others", groupGuessed: true });
    const before = files.list();
    store.rebuildViews();
    expect(files.list()).toEqual(before);
    store.close();
    // 升级：旧库里没有分组的表（281–302 号票时建的库）
    const raw = openDatabase(file);
    raw.exec("DROP TABLE IF EXISTS personal_groups");
    raw.close();
    const reopened = openEventStore({ file, views: [personalFilesView] });
    const again = createPersonalFilesService({
      store: reopened,
      cards: { get: () => undefined } as unknown as CardService,
      userName,
      inbox: { buildAdd: () => ({ item: {}, event: { channel: "inbox", type: "inbox_item", payload: {} } }) } as never,
      deletion: { store: reopened, cards: {} as CardService, rewriters: new PurgeRewriters(), materials: { list: () => [] } },
      today: () => "2026-10-25",
      now: () => "2026-10-25T10:00:00+08:00",
      log: () => {},
    });
    expect(again.list()).toEqual(before);
    expect(again.file(mom.id)).toMatchObject({ group: "others" });
    reopened.close();
  });
});
