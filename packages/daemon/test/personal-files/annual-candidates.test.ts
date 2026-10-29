// 个人档案和记忆、提醒联动的服务这一层（283 号票）：生日、纪念日的每年提醒（建、跟着改、跟着删、农历、提醒插件不在、看板上取消了）；
// 记忆管理员攒的候选和候选核对卡（提到够三次才提议建档、一天一张往里加、逐条确认、没勾的不再提、出处被删了作废）；
// 给记忆这一侧的档案摘要、不进整理提示的值、字段换了新值的通知。跑真的事件存储和卡片（临时目录），提醒插件是假的（只在内存里）。
// 示例数据全是编的。
import path from "node:path";
import { type Card, nowIso, PURGED_TEXT, type PersonalFileSuggestCardPayload, type ReminderSchedule, SELF_PERSON_ID, type UserNameResult } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { cardPurge, createCardService } from "../../src/cards/cards.ts";
import { CardTypeRegistry } from "../../src/cards/registry.ts";
import { cardsView } from "../../src/cards/views.ts";
import { createEphemeralBus } from "../../src/events/ephemeral.ts";
import { openEventStore } from "../../src/events/event-store.ts";
import { createInboxService } from "../../src/inbox/inbox.ts";
import { inboxView } from "../../src/inbox/views.ts";
import { PurgeRewriters } from "../../src/memory/index.ts";
import { type AnnualReminderPort, createPersonalFilesService, type FieldReplaced, NEW_PERSON_MIN_MENTIONS, PERSONAL_FILE_EVENT, PERSONAL_FILES_CHANNEL, personalFilePurge, personalFilesView } from "../../src/personal-files/index.ts";
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

/** 只在内存里的提醒插件 */
function fakeReminders() {
  const items = new Map<string, { status: string; text: string; schedule: ReminderSchedule }>();
  let next = 1;
  const port: AnnualReminderPort = {
    create(input) {
      const id = `r-${next++}`;
      items.set(id, { status: "pending", ...input });
      return { id };
    },
    update(id, input) {
      items.set(id, { ...items.get(id)!, ...input });
    },
    remove(id) {
      items.set(id, { ...items.get(id)!, status: "deleted" });
    },
    get: (id) => items.get(id),
  };
  return { port, items, live: () => [...items.entries()].filter(([, r]) => r.status === "pending") };
}

function setup(options: { remindersOn?: boolean } = {}) {
  const dir = makeTempDir("ergo-test-", true);
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [cardsView, inboxView, personalFilesView] });
  onTestFinished(() => {
    store.close();
    removeDir(dir);
  });
  const registry = new CardTypeRegistry();
  const cards = createCardService({ store, registry, now: nowIso });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: nowIso });
  const rewriters = new PurgeRewriters();
  rewriters.register(personalFilePurge, cardPurge(cards));
  const reminders = fakeReminders();
  let remindersOn = options.remindersOn ?? true;
  let now = "2026-10-26T10:00:00+08:00";
  const files = createPersonalFilesService({
    store,
    cards,
    inbox,
    userName: fakeUserName(),
    deletion: { store, cards, rewriters, materials: { list: () => [] } },
    today: () => now.slice(0, 10),
    now: () => now,
    annual: () => (remindersOn ? reminders.port : undefined),
    log: () => {},
  });
  registry.register(files.suggestCardType());
  let key = 0;
  const act = (card: Card, action: "confirm" | "reject", input?: unknown) => cards.act({ cardId: card.id, action, expectedVersion: card.version, idempotencyKey: `k-${++key}`, ...(input === undefined ? {} : { input }) });
  return {
    store,
    cards,
    inbox,
    files,
    reminders,
    act,
    setNow: (at: string) => {
      now = at;
    },
    setRemindersOn: (on: boolean) => {
      remindersOn = on;
    },
  };
}

const birthday = (files: ReturnType<typeof setup>["files"], personId: string) => files.file(personId)!.fields.find((f) => f.field === "birthday")!;

describe("生日、纪念日的每年提醒", () => {
  it("开了就建一条每年的提醒（往前数几天、09:00）；改日子、改天数跟着改；值改成农历就删、改回来再建；关了就删", () => {
    const { files, reminders } = setup();
    const mom = files.addPerson({ name: "妈妈" });
    files.change(mom.id, { kind: "set_field", field: "birthday", value: "3月2日" });
    // 只是写了生日：没开就不建
    expect(reminders.live()).toEqual([]);
    expect(birthday(files, mom.id).annual).toEqual({ monthDay: { month: 3, day: 2 } });

    files.change(mom.id, { kind: "set_reminder", field: "birthday", daysBefore: 3 });
    expect(reminders.live()).toEqual([["r-1", { status: "pending", text: "3 月 2 日是妈妈的生日（还有 3 天）", schedule: { kind: "yearly", time: "09:00", month: 2, day: 27 } }]]);
    expect(birthday(files, mom.id).annual).toMatchObject({ monthDay: { month: 3, day: 2 }, daysBefore: 3 });

    // 当天提醒
    files.change(mom.id, { kind: "set_reminder", field: "birthday", daysBefore: 0 });
    expect(reminders.items.get("r-1")).toMatchObject({ text: "今天是妈妈的生日（3 月 2 日）", schedule: { month: 3, day: 2 } });

    // 农历：认不出日子，那条删掉，设置留着；改回认得出的日子再建（新的一条）
    files.change(mom.id, { kind: "set_field", field: "birthday", value: "农历八月十五" });
    expect(reminders.live()).toEqual([]);
    expect(birthday(files, mom.id).annual).toEqual({ daysBefore: 0, blocked: "not_gregorian" });
    expect(() => files.change(mom.id, { kind: "set_reminder", field: "birthday", daysBefore: 3 })).toThrow(/认不出公历的日子/);
    files.change(mom.id, { kind: "set_field", field: "birthday", value: "1965年3月5日" });
    expect(reminders.live().map(([id, r]) => [id, r.schedule])).toEqual([["r-2", { kind: "yearly", time: "09:00", month: 3, day: 5 }]]);

    // 关掉：删提醒、设置清掉
    files.change(mom.id, { kind: "set_reminder", field: "birthday", daysBefore: null });
    expect(reminders.live()).toEqual([]);
    expect(birthday(files, mom.id).annual).toEqual({ monthDay: { month: 3, day: 5 } });
  });

  it("撤销到没有值、删字段、删整个人：提醒跟着删；看板上取消了的当用户关掉了，对一遍时清掉设置、不再重建", () => {
    const { files, reminders } = setup();
    const mom = files.addPerson({ name: "妈妈" });
    files.change(mom.id, { kind: "set_field", field: "birthday", value: "3月2日" });
    files.change(mom.id, { kind: "set_reminder", field: "birthday", daysBefore: 3 });
    files.change(mom.id, { kind: "undo_field", field: "birthday" });
    expect(reminders.live()).toEqual([]);
    expect(birthday(files, mom.id).annual).toEqual({});

    const dad = files.addPerson({ name: "爸爸" });
    files.change(dad.id, { kind: "set_field", field: "birthday", value: "6月1日" });
    files.change(dad.id, { kind: "set_reminder", field: "birthday", daysBefore: 3 });
    files.remove(dad.id, { target: { kind: "person" }, mode: "forget" });
    expect(reminders.live()).toEqual([]);

    const me = SELF_PERSON_ID;
    files.change(me, { kind: "set_field", field: "custom:结婚纪念日", value: "2018年10月1日" });
    files.change(me, { kind: "set_reminder", field: "custom:结婚纪念日", daysBefore: 7 });
    expect(reminders.live().map(([, r]) => r.text)).toEqual(["10 月 1 日是你的结婚纪念日（还有 7 天）"]);
    // 看板上取消了：对一遍时清掉设置
    const [id] = reminders.live()[0]!;
    reminders.items.set(id, { ...reminders.items.get(id)!, status: "cancelled" });
    files.start()();
    expect(files.file(me)!.fields.find((f) => f.field === "custom:结婚纪念日")!.annual).toEqual({ monthDay: { month: 10, day: 1 } });
    expect(reminders.live()).toEqual([]);
  });

  it("提醒插件没启用：开不了（写明原因），档案页写'提醒插件没启用'；插件回来以后对一遍补建", () => {
    const { files, reminders, store, setRemindersOn } = setup();
    const mom = files.addPerson({ name: "妈妈" });
    files.change(mom.id, { kind: "set_field", field: "birthday", value: "3月2日" });
    setRemindersOn(false);
    expect(() => files.change(mom.id, { kind: "set_reminder", field: "birthday", daysBefore: 3 })).toThrow(/提醒插件没启用/);
    expect(birthday(files, mom.id).annual).toEqual({ monthDay: { month: 3, day: 2 }, blocked: "reminders_off" });
    // 卡上勾着的时候插件正好停了：设置记着（档案页写没启用），插件回来以后对一遍补建
    const prepared = files.prepareWrite({ person: { id: mom.id }, fields: [], reminders: [{ field: "birthday", daysBefore: 3 }], trail: { via: "page" } });
    store.appendBatch(prepared.events);
    prepared.afterCommit?.();
    expect(reminders.live()).toEqual([]);
    expect(birthday(files, mom.id).annual).toEqual({ monthDay: { month: 3, day: 2 }, daysBefore: 3, blocked: "reminders_off" });
    setRemindersOn(true);
    files.start()();
    expect(reminders.live().map(([, r]) => r.schedule)).toEqual([{ kind: "yearly", time: "09:00", month: 2, day: 27 }]);
  });
});

describe("候选和候选核对卡", () => {
  const mention = (name: string, materialId: string, fields: Array<{ field: string; value: string }> = [], extra: { relation?: string; aliases?: string[] } = {}) => ({
    name,
    materialIds: [materialId],
    heard: ["2026-10-25"],
    fields,
    ...extra,
  });
  const suggestCards = (cards: ReturnType<typeof setup>["cards"], ids: readonly (string | undefined)[]) => ids.flatMap((id) => (id === undefined ? [] : [cards.get(id)!]));

  it(`还没档案的人提到 ${NEW_PERSON_MIN_MENTIONS} 次才提议建档；一天一张卡往里加；逐条确认：勾了的写（留痕经记忆管理员），没勾的不再提`, () => {
    const { files, cards, inbox, act } = setup();
    expect(files.candidates.add("nightly", [mention("小张", "m-1", [{ field: "work", value: "某公司" }], { relation: "表弟" })])).toBe(1);
    files.candidates.add("nightly", [mention("小张", "m-2")]);
    expect(files.candidates.compose()).toBeUndefined();
    files.candidates.add("nightly", [mention("小张", "m-3", [{ field: "生日", value: "3月2日" }])]);
    const cardId = files.candidates.compose({ date: "2026-10-26" })!;
    const [card] = suggestCards(cards, [cardId]);
    const payload = card!.payload as PersonalFileSuggestCardPayload;
    expect(payload).toMatchObject({ date: "2026-10-26", items: [{ kind: "create", person: { name: "小张", relation: "表弟", isNew: true }, mentions: 3 }, { kind: "field", field: "work", value: "某公司" }, { kind: "field", field: "birthday", value: "3月2日", remind: { month: 3, day: 2, daysBefore: 3 } }] });
    expect(inbox.itemsForCard(cardId)).toHaveLength(1);

    // 同一天又攒了一条（已有档案的人）：同一张卡出新版本，不另起一张
    files.candidates.add("nightly", [mention("我", "m-4", [{ field: "单位", value: "某研究所" }])]);
    expect(files.candidates.compose()).toBe(cardId);
    const v2 = cards.get(cardId)!;
    expect(v2.version).toBe(2);
    const items = (v2.payload as PersonalFileSuggestCardPayload).items;
    expect(items.map((i) => [i.kind, i.person.name, i.field ?? ""])).toEqual([
      ["create", "小张", ""],
      ["field", "小张", "work"],
      ["field", "小张", "birthday"],
      ["field", "我", "work"],
    ]);

    // 勾建档、单位、生日（提醒提前 7 天），不勾"我的单位"
    const accept = [items[0]!.id, items[1]!.id, items[2]!.id];
    act(v2, "confirm", { accept, remind: [{ item: items[2]!.id, daysBefore: 7 }] });
    const zhang = files.find("小张")!;
    const file = files.file(zhang.id)!;
    expect(file.fields.find((f) => f.field === "relation")!.current?.value).toBe("表弟");
    expect(file.fields.find((f) => f.field === "work")!.current).toMatchObject({ value: "某公司", source: { via: "curator", basis: "confirmed" } });
    expect(file.fields.find((f) => f.field === "birthday")!.annual?.daysBefore).toBe(7);
    expect(files.file(SELF_PERSON_ID)!.fields.find((f) => f.field === "work")!.current).toBeUndefined();
    expect(cards.get(cardId)).toMatchObject({ status: "handled", payload: { result: "写进档案 3 条" } });

    // 没勾的（我的单位：某研究所）再听到也不再提；新的值照样提
    files.candidates.add("nightly", [mention("我", "m-5", [{ field: "work", value: "某研究所" }])]);
    expect(files.candidates.compose()).toBeUndefined();
    files.candidates.add("nightly", [mention("我", "m-6", [{ field: "work", value: "另一家研究所" }])]);
    expect(files.candidates.compose()).not.toBe(cardId);
  });

  it("已有档案的人：值和档案里一样的不收；别名并进已有的；号码、住址不收；'都不用'全记成没写", () => {
    const { files, cards, act } = setup();
    const mom = files.addPerson({ name: "妈妈", relation: "母亲" });
    files.change(mom.id, { kind: "set_field", field: "aliases", value: "老妈" });
    files.change(mom.id, { kind: "set_field", field: "work", value: "退休" });
    const added = files.candidates.add("nightly", [
      mention("老妈", "m-1", [
        { field: "work", value: "退休" },
        { field: "aliases", value: "妈" },
        { field: "phone", value: "13800001111" },
        { field: "address", value: "文三路 18 号" },
      ]),
    ]);
    expect(added).toBe(1);
    const cardId = files.candidates.compose()!;
    const card = cards.get(cardId)!;
    expect((card.payload as PersonalFileSuggestCardPayload).items).toMatchObject([{ kind: "field", person: { id: mom.id, name: "妈妈" }, field: "aliases", value: "老妈、妈", previous: "老妈" }]);
    act(card, "reject");
    expect(cards.get(cardId)).toMatchObject({ status: "handled", payload: { result: "都没写", items: [{ decision: "rejected" }] } });
    expect(files.file(mom.id)!.fields.find((f) => f.field === "aliases")!.current?.value).toBe("老妈");
  });

  it("299：从手机通讯录挑的人——不用提到几次就上卡、电话住址也收（号码规范化、逐位核对）、拒过建档和拒过的值再挑照样上卡；留痕写明从通讯录来", () => {
    const { files, cards, inbox, act } = setup();
    // 先在每晚整理里拒过建档"王小明"、拒过妈妈的一个单位
    const mom = files.addPerson({ name: "妈妈" });
    files.candidates.add("nightly", [mention("王小明", "m-1"), mention("王小明", "m-2"), mention("王小明", "m-3")]);
    act(cards.get(files.candidates.compose()!)!, "reject");
    const picked = { materialIds: [], heard: [], dataSource: "phone-contacts" };
    files.candidates.add("contacts", [
      { name: "王小明", fields: [{ field: "phone", value: "138 0000 1111" }, { field: "birthday", value: "1990-03-02" }, { field: "address", value: "某某路 1 号" }, { field: "work", value: "不收" }], ...picked },
      { name: "妈妈", fields: [{ field: "phone", value: "13900002222" }], ...picked },
    ]);
    const cardId = files.candidates.compose()!;
    const card = cards.get(cardId)!;
    const items = (card.payload as PersonalFileSuggestCardPayload).items;
    expect(items.map((i) => [i.kind, i.person.name, i.field ?? "", i.value ?? "", i.number ?? false, i.origin])).toEqual([
      ["create", "王小明", "", "", false, "contacts"],
      ["field", "王小明", "phone", "13800001111", true, "contacts"],
      ["field", "王小明", "birthday", "1990-03-02", false, "contacts"],
      ["field", "王小明", "address", "某某路 1 号", false, "contacts"],
      ["field", "妈妈", "phone", "13900002222", true, "contacts"],
    ]);
    expect(card.text).toContain("建档：王小明（从手机通讯录挑的）");
    expect(inbox.itemsForCard(cardId)[0]).toMatchObject({ source: "手机通讯录" });
    act(card, "confirm", { accept: items.map((i) => i.id), remind: [] });
    const xiaoming = files.find("王小明")!;
    expect(files.file(xiaoming.id)!.fields.find((f) => f.field === "phone")!.current).toMatchObject({ value: "13800001111", source: { via: "curator", basis: "confirmed", origin: "contacts" } });
    expect(files.file(mom.id)!.fields.find((f) => f.field === "phone")!.current?.value).toBe("13900002222");
    // 同样的再挑一次：和档案里一样，不再上卡
    files.candidates.add("contacts", [{ name: "王小明", fields: [{ field: "phone", value: "13800001111" }], ...picked }]);
    expect(files.candidates.compose()).toBeUndefined();
  });

  it("301：导入的通讯录 vCard——不用提到几次、关系别名纪念日也收；几个电话里有档案里那个就不提；拒过的建档和值不再提；留痕写明从导入的通讯录来", () => {
    const { files, cards, inbox, act } = setup();
    const mom = files.addPerson({ name: "妈妈" });
    files.change(mom.id, { kind: "set_field", field: "phone", value: "13900002222" });
    const imported = { materialIds: [], heard: [], dataSource: "google-contacts" };
    files.candidates.add("vcard", [
      {
        name: "张丽",
        relation: "母亲的同事",
        fields: [
          { field: "birthday", value: "03-02" },
          { field: "anniversary:相识纪念日", value: "2015-06-30" },
          { field: "phone", value: "139 0000 0003", also: ["0571-88000003"] },
          { field: "work", value: "不收" },
        ],
        ...imported,
      },
      // 妈妈：通讯录里第二个电话就是档案里那个，不提电话；关系、别名照收
      { name: "妈妈", aliases: ["老妈"], relation: "母亲", fields: [{ field: "phone", value: "0571-88000004", also: ["139 0000 2222"] }, { field: "address", value: "某某路 4 号" }], ...imported },
    ]);
    const cardId = files.candidates.compose()!;
    const card = cards.get(cardId)!;
    const items = (card.payload as PersonalFileSuggestCardPayload).items;
    expect(items.map((i) => [i.kind, i.person.name, i.person.relation ?? "", i.field ?? "", i.value ?? "", i.origin])).toEqual([
      ["create", "张丽", "母亲的同事", "", "", "vcard"],
      ["field", "张丽", "母亲的同事", "birthday", "03-02", "vcard"],
      ["field", "张丽", "母亲的同事", "anniversary:相识纪念日", "2015-06-30", "vcard"],
      ["field", "张丽", "母亲的同事", "phone", "13900000003", "vcard"],
      ["field", "妈妈", "", "address", "某某路 4 号", "vcard"],
      ["field", "妈妈", "", "relation", "母亲", "vcard"],
      ["field", "妈妈", "", "aliases", "老妈", "vcard"],
    ]);
    expect(card.text).toContain("建档：张丽（母亲的同事，从导入的通讯录来的）");
    expect(inbox.itemsForCard(cardId)[0]).toMatchObject({ source: "导入的通讯录" });
    // 不建张丽、妈妈的别名不要
    const skip = new Set([items[0]!.id, items[6]!.id]);
    act(card, "confirm", { accept: items.filter((i) => !skip.has(i.id)).map((i) => i.id), remind: [] });
    expect(files.find("张丽")).toBeUndefined();
    const file = files.file(mom.id)!;
    expect(file.fields.find((f) => f.field === "relation")!.current).toMatchObject({ value: "母亲", source: { via: "curator", basis: "confirmed", origin: "vcard" } });
    expect(file.fields.find((f) => f.field === "phone")!.current?.value).toBe("13900002222");
    // 再导一次同样的：拒过的建档、别名不再提，写进去的和档案里一样
    files.candidates.add("vcard", [
      { name: "张丽", fields: [{ field: "birthday", value: "03-02" }], ...imported },
      { name: "妈妈", aliases: ["老妈"], relation: "母亲", fields: [{ field: "address", value: "某某路 4 号" }], ...imported },
    ]);
    expect(files.candidates.compose()).toBeUndefined();
  });

  it("出处的话被忘掉：只靠它的候选作废、卡上去掉；彻底删除：连候选里的值、卡的每个版本一起改写", async () => {
    const { files, cards, store } = setup();
    const mom = files.addPerson({ name: "妈妈" });
    files.candidates.add("nightly", [mention("妈妈", "m-1", [{ field: "work", value: "某小学" }]), mention("妈妈", "m-2", [{ field: "health", value: "青霉素过敏" }])]);
    const cardId = files.candidates.compose()!;
    expect((cards.get(cardId)!.payload as PersonalFileSuggestCardPayload).items.map((i) => i.value)).toEqual(["某小学", "青霉素过敏"]);
    files.candidates.onMaterialsDeleted(["m-1"], "forget");
    expect((cards.get(cardId)!.payload as PersonalFileSuggestCardPayload).items.map((i) => i.value)).toEqual(["青霉素过敏"]);
    files.candidates.onMaterialsDeleted(["m-2"], "purge");
    const values = store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT).flatMap((e) => {
      const change = e.payload as { change: string; value?: string };
      return change.change === "candidate_added" && change.value !== undefined ? [change.value] : [];
    });
    expect(values).toEqual(["某小学", PURGED_TEXT]);
    const versions = store.reader.all<{ payload: string }>("SELECT payload FROM events WHERE instr(payload, ?) > 0", "青霉素过敏");
    expect(versions).toEqual([]);
    expect(mom.id).toBeDefined();
  });

  it("302：彻底删除候选核对卡上的生日，每年提醒那一勾带着的月日一起抹掉（卡的每个版本）", () => {
    const { files, cards, store } = setup();
    files.addPerson({ name: "妈妈" });
    files.candidates.add("nightly", [mention("妈妈", "m-1", [{ field: "生日", value: "3月2日" }])]);
    const cardId = files.candidates.compose()!;
    expect((cards.get(cardId)!.payload as PersonalFileSuggestCardPayload).items[0]!.remind).toEqual({ month: 3, day: 2, daysBefore: 3 });
    files.candidates.onMaterialsDeleted(["m-1"], "purge");
    const versions = store.reader
      .all<{ payload: string }>("SELECT payload FROM events WHERE channel = 'cards' AND type = 'card'")
      .map((r) => JSON.parse(r.payload) as { card: Card })
      .filter((p) => p.card.id === cardId);
    expect(versions.length).toBeGreaterThan(0);
    for (const { card } of versions) {
      const [item] = (card.payload as PersonalFileSuggestCardPayload).items;
      expect(item).toMatchObject({ field: "birthday", value: PURGED_TEXT });
      expect(item!.remind).toBeUndefined();
    }
  });
});

describe("给记忆这一侧的", () => {
  it("档案摘要：号码、住址不列值（最近换过写一句），列别的字段和记下的事；不进提示的值连以前的一起", () => {
    const { files, setNow } = setup();
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "id_card", value: "110101199003071234" });
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "address", value: "杭州市西湖区文三路 18 号" });
    setNow("2026-10-26T11:00:00+08:00");
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "address", value: "上海市徐汇区漕溪北路 9 号" });
    files.change(SELF_PERSON_ID, { kind: "set_field", field: "work", value: "某研究所 工程师" });
    const girl = files.addPerson({ name: "女儿", relation: "女儿" });
    files.change(girl.id, { kind: "set_field", field: "birthday", value: "2020-03-02" });
    files.change(girl.id, { kind: "add_note", text: "对花生过敏", date: "2026-10-01" });
    const text = files.forMemory.background();
    expect(text).toContain("【个人档案摘要】");
    expect(text).toMatch(/- 我（用户本人）：住址\d{4}-\d{2}-\d{2} 换过；单位和职位 某研究所 工程师/);
    expect(text).toContain("- 女儿（女儿）：生日 2020-03-02；记下的事：对花生过敏");
    expect(text).not.toContain("110101199003071234");
    expect(text).not.toContain("文三路");
    expect(text).not.toContain("漕溪北路");
    expect(files.forMemory.withheld().map((w) => [w.value, w.placeholder])).toEqual(
      expect.arrayContaining([
        ["110101199003071234", "［号码已略去］"],
        ["杭州市西湖区文三路 18 号", "［住址已略去］"],
        ["上海市徐汇区漕溪北路 9 号", "［住址已略去］"],
      ]),
    );
    expect(files.forMemory.people()).toEqual([
      { id: SELF_PERSON_ID, kind: "self", aliases: [] },
      { id: girl.id, kind: "person", name: "女儿", aliases: [], relation: "女儿" },
    ]);
  });

  it("字段换了新值落盘之后通知（旧值、叫法、到哪一刻）；第一次填的不算；以前换过的都列得出", () => {
    const { files } = setup();
    const heard: FieldReplaced[] = [];
    const off = files.forMemory.onFieldReplaced((change) => heard.push(change));
    const mom = files.addPerson({ name: "妈妈" });
    files.change(mom.id, { kind: "set_field", field: "aliases", value: "老妈" });
    files.change(mom.id, { kind: "set_field", field: "work", value: "某小学" });
    expect(heard).toEqual([]);
    files.change(mom.id, { kind: "set_field", field: "work", value: "退休" });
    expect(heard).toEqual([{ personId: mom.id, kind: "person", names: ["妈妈", "老妈"], field: "work", label: "单位或学校", oldValue: "某小学", at: "2026-10-26T10:00:00+08:00" }]);
    off();
    files.change(mom.id, { kind: "set_field", field: "work", value: "返聘" });
    expect(heard).toHaveLength(1);
    expect(files.forMemory.replacedValues().map((r) => r.oldValue)).toEqual(expect.arrayContaining(["某小学", "退休"]));
  });
});
