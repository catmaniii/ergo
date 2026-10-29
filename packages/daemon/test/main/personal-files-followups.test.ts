// 主切面：个人档案小尾巴（302 号票，用户 2026-10-25 "其他都照你说的来"）。真的守护进程（秘书是 faux，时钟手动拨）：
// - 原话里明说、直接写进档案的生日：直接按默认提前 3 天建每年提醒，回执写明"已建每年提醒（提前 3 天），档案页可改可关"，
//   不再跟一张问提醒的小卡；档案页能关；
// - 内置字段"纪念日"：本人和重要的人都有，能有几个、各带名字（"结婚纪念日"）；直接写的照样直接建每年提醒，档案页加的能开；
//   283 认"名字带纪念日的自定义字段"的规矩照旧（已有的自定义字段接着往里写，不另起一个）；
// - 彻底删除个人档案核对卡（personal_file）上确认过的生日：卡上每年提醒那一勾带着的月日一起抹掉（每个版本）；
// - 彻底删除档案里的生日（连出处）：由它建过的每年提醒（关掉又开的两条都算）在提醒插件事件记录里的内容、时间，连同提醒卡、
//   核对卡、回执、原话一起改写，全局事件里查不到"妈妈的生日""3 月 2 日"。
// 示例数据全是编的。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type HttpErrorBody,
  type MessageEventPayload,
  nowIso,
  type PersonalFileCardPayload,
  type PersonalFileDeleteResult,
  type PersonalFilesView,
  type PersonalFileView,
  type QuickActionCardPayload,
  type ReminderEventPayload,
  SELF_PERSON_ID,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemonHandle } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX, board: BOARD } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [BOARD]: 0 };

/** 本地时间 y 年 m 月 d 日 hh:mm */
const at = (m: number, d: number, hh: number, mm = 0, y = 2026) => new Date(y, m - 1, d, hh, mm);

const propose = (params: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "personal_file", params } as never }] });
const OK: FauxStep = { kind: "reply", text: "好的。" };

const filesApi = {
  get: (url: string, id: string) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFile(id)),
  add: (url: string, body: unknown) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFiles, { method: "POST", body }),
  change: (url: string, id: string, body: unknown) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFile(id), { method: "POST", body }),
  remove: (url: string, id: string, body: unknown) => requestJson<PersonalFileDeleteResult & HttpErrorBody>(url, HTTP_PATHS.personalFileDelete(id), { method: "POST", body }),
};

const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;

async function tell(frontend: TestFrontend, text: string) {
  const before = turnEnds(frontend);
  const sent = await frontend.sendText(text);
  await waitUntil(() => turnEnds(frontend) > before, { timeoutMs: 30_000, describe: () => `等秘书处理完「${text.slice(0, 12)}」` });
  return sent;
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const latestCard = (frontend: TestFrontend, id: string): Card => cardsOf(frontend).filter((c) => c.id === id).at(-1)!;
const remindersOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => f.payload as ReminderEventPayload);
const fieldOf = (file: PersonalFileView, field: string) => file.fields.find((f) => f.field === field);
/** 事件库里负载含这段文字的事件（彻底删除后应该一条都没有） */
const eventsContaining = (daemon: TestDaemonHandle, text: string) =>
  daemon.store.reader.all<{ channel: string; type: string }>("SELECT channel, type FROM events WHERE instr(payload, ?) > 0", text).map((r) => `${r.channel}/${r.type}`);

describe("原话里明说的生日直接建每年提醒", () => {
  it("说\"我妈生日是3月2日\"：档案写入、每年 2 月 27 日的提醒直接建好、回执写明，没有多出的小卡；档案页能关", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 26, 10));
    const { url, daemon } = await startTestDaemon({ clock, secretary: [propose({ person: "妈妈", fields: [{ field: "生日", value: "3月2日" }] }), OK] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);
    // 妈妈的档案已经有了（新建一个人总出核对卡，那条路见 283 的主切面）
    const mom = (await filesApi.add(url, { name: "妈妈", relation: "母亲" })).body;

    await tell(frontend, "我妈生日是3月2日");
    // 聊天里只有一张"已执行"的回执：没有问每年提醒的小卡，也没有核对卡（另一张是提醒插件给新提醒的提醒卡，在看板上）
    const cards = cardsOf(frontend);
    expect([...new Set(cards.map((c) => c.type))].toSorted()).toEqual(["quick_action", "reminder"]);
    const receipt = cards.find((c) => c.type === "quick_action")!;
    expect(receipt).toMatchObject({ status: "handled", payload: { action: { type: "personal_file" }, explicit: true } });
    expect((receipt.payload as QuickActionCardPayload).result).toBe("已记进档案：妈妈 · 生日。已建每年提醒（提前 3 天），档案页可改可关");
    expect(receipt.text).toContain("已建每年提醒（提前 3 天），档案页可改可关");
    const inChat = frontend
      .events({ channel: SECRETARY, type: EVENT_TYPES.message })
      .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
      .flatMap((p) => (p.type === "card_ref" ? [p.cardId] : []));
    expect(inChat).toEqual([receipt.id]);
    expect(frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem })).toEqual([]);

    // 档案里有了生日，提醒插件里一条每年 2 月 27 日 09:00 的提醒
    await waitUntil(() => remindersOf(frontend).length === 1, { describe: () => "等每年提醒建好" });
    const created = remindersOf(frontend)[0]!;
    expect(created).toMatchObject({ change: "created", reminder: { schedule: { kind: "yearly", month: 2, day: 27, time: "09:00" }, status: "pending" } });
    expect(created.reminder.text).toBe("3 月 2 日是妈妈的生日（还有 3 天）");
    const birthday = fieldOf((await filesApi.get(url, mom.id)).body, "birthday")!;
    expect(birthday.current).toMatchObject({ value: "3月2日", source: { via: "secretary", basis: "explicit" } });
    expect(birthday.annual).toEqual({ monthDay: { month: 3, day: 2 }, daysBefore: 3, nextAt: nowIso(at(2, 27, 9, 0, 2027)) });

    // 档案页可改可关：关了提醒跟着删
    const off = await filesApi.change(url, mom.id, { kind: "set_reminder", field: "birthday", daysBefore: null });
    expect(off.status).toBe(200);
    expect(fieldOf(off.body, "birthday")!.annual).toEqual({ monthDay: { month: 3, day: 2 } });
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "deleted", reminder: { id: created.reminder.id } });

    // 再开（提前 7 天）：另建一条
    const on = await filesApi.change(url, mom.id, { kind: "set_reminder", field: "birthday", daysBefore: 7 });
    expect(fieldOf(on.body, "birthday")!.annual?.daysBefore).toBe(7);
    const again = remindersOf(frontend).at(-1)!;
    expect(again).toMatchObject({ change: "created", reminder: { schedule: { month: 2, day: 23 } } });
    expect(again.reminder.id).not.toBe(created.reminder.id);
    expect(eventsContaining(daemon, "妈妈的生日")).toEqual(expect.arrayContaining(["board/reminder", "cards/card"]));

    // 彻底删除生日（连出处那句话）：两条提醒在事件记录里的内容、时间都改写（还开着的那条跟着删掉），提醒卡每个版本、
    // 回执、提议的调用、原话一起；全局事件里查不到"妈妈的生日""3 月 2 日"
    const purged = await filesApi.remove(url, mom.id, { target: { kind: "field", field: "birthday" }, mode: "purge", withSources: true });
    expect(purged).toMatchObject({ status: 200, body: { sources: 1 } });
    for (const text of ["妈妈的生日", "3 月 2 日", "3月2日", "03-02", "2 月 27 日", "2 月 23 日"]) expect({ text, events: eventsContaining(daemon, text) }).toEqual({ text, events: [] });
    // 提醒都删了（看板上没有）：事件记录里每个版本留着编号、状态、建和改的时刻，内容换成删除标记、时间去掉；
    // 开着的页面换到改写后的提醒卡（还开着的那条删掉时追加的也是改写后的样子）
    const stored = daemon.store.read(BOARD, 0, EVENT_TYPES.reminder).map((e) => (e.payload as ReminderEventPayload).reminder);
    expect(new Set(stored.map((r) => r.id))).toEqual(new Set([created.reminder.id, again.reminder.id]));
    for (const r of stored) {
      expect(r.text).toBe("（这条内容已彻底删除）");
      expect(r).not.toHaveProperty("schedule");
      expect(r).not.toHaveProperty("nextAt");
    }
    expect(stored.filter((r) => r.id === again.reminder.id).at(-1)!.status).toBe("deleted");
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "deleted", reminder: { id: again.reminder.id, text: "（这条内容已彻底删除）" } });
    for (const cardId of new Set(stored.map((r) => r.cardId))) expect(latestCard(frontend, cardId).text).not.toContain("妈妈");
    // 档案里别的照旧，称呼还在
    expect(fieldOf((await filesApi.get(url, mom.id)).body, "name")?.current?.value).toBe("妈妈");
  });
});

describe("内置字段\"纪念日\"", () => {
  it("本人、重要的人都有；能有几个、各带名字；直接写的直接建每年提醒，档案页加的能开；名字带纪念日的自定义字段照旧", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 26, 10));
    const { url } = await startTestDaemon({
      clock,
      secretary: [propose({ person: "我", fields: [{ field: "结婚纪念日", value: "2018年10月1日" }] }), OK, propose({ person: "我", fields: [{ field: "相识纪念日", value: "2015年9月2日" }] }), OK],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);

    // 还没有纪念日：档案里列着一个空的"纪念日"（排在生日后面）；重要的人也有
    const empty = (await filesApi.get(url, SELF_PERSON_ID)).body;
    const order = empty.fields.map((f) => f.field);
    expect(order.indexOf("anniversary")).toBe(order.indexOf("birthday") + 1);
    expect(fieldOf(empty, "anniversary")).toMatchObject({ label: "纪念日", custom: false, history: [] });
    expect(fieldOf(empty, "anniversary")!.current).toBeUndefined();
    const dad = (await filesApi.add(url, { name: "爸爸" })).body;
    expect(fieldOf(dad, "anniversary")?.label).toBe("纪念日");

    // 原话里明说了的结婚纪念日：写进内置的纪念日（带名字），直接建每年提醒，回执写明
    await tell(frontend, "我们的结婚纪念日是2018年10月1日");
    const receipt = cardsOf(frontend).findLast((c) => c.type === "quick_action")!;
    expect((receipt.payload as QuickActionCardPayload).result).toBe("已记进档案：我 · 结婚纪念日。已建每年提醒（提前 3 天），档案页可改可关");
    expect(cardsOf(frontend).filter((c) => c.type === "personal_file_suggest")).toEqual([]);
    await waitUntil(() => remindersOf(frontend).length === 1, { describe: () => "等结婚纪念日的每年提醒" });
    expect(remindersOf(frontend)[0]!.reminder).toMatchObject({ schedule: { kind: "yearly", month: 9, day: 28 }, text: "10 月 1 日是你的结婚纪念日（还有 3 天）" });

    // 档案页再加一个"恋爱纪念日"，开每年提醒（提前 7 天）
    const added = await filesApi.change(url, SELF_PERSON_ID, { kind: "set_field", field: "anniversary:恋爱纪念日", value: "5月20日" });
    expect(added.status).toBe(200);
    const on = await filesApi.change(url, SELF_PERSON_ID, { kind: "set_reminder", field: "anniversary:恋爱纪念日", daysBefore: 7 });
    expect(on.status).toBe(200);
    expect(remindersOf(frontend).at(-1)!.reminder).toMatchObject({ schedule: { kind: "yearly", month: 5, day: 13 }, text: "5 月 20 日是你的恋爱纪念日（还有 7 天）" });
    // 两个纪念日按先后排在生日后面（空的"纪念日"不再列），名字就是字段名，都带每年提醒
    const fields = on.body.fields.map((f) => f.field);
    expect(fields.slice(fields.indexOf("birthday") + 1, fields.indexOf("birthday") + 3)).toEqual(["anniversary:结婚纪念日", "anniversary:恋爱纪念日"]);
    expect(fields).not.toContain("anniversary");
    expect(fieldOf(on.body, "anniversary:结婚纪念日")).toMatchObject({ label: "结婚纪念日", custom: false, number: false, current: { value: "2018年10月1日" }, annual: { daysBefore: 3 } });
    expect(fieldOf(on.body, "anniversary:恋爱纪念日")).toMatchObject({ label: "恋爱纪念日", annual: { monthDay: { month: 5, day: 20 }, daysBefore: 7 } });

    // 283 的规矩照旧：已有的自定义字段"相识纪念日"算每年的日子；秘书再写"相识纪念日"接着写进它（不另起一个内置的）
    const custom = await filesApi.change(url, SELF_PERSON_ID, { kind: "set_field", field: "custom:相识纪念日", value: "2015年9月1日" });
    expect(fieldOf(custom.body, "custom:相识纪念日")!.annual).toEqual({ monthDay: { month: 9, day: 1 } });
    await tell(frontend, "我记错了，相识纪念日是2015年9月2日");
    const after = (await filesApi.get(url, SELF_PERSON_ID)).body;
    expect(fieldOf(after, "anniversary:相识纪念日")).toBeUndefined();
    expect(fieldOf(after, "custom:相识纪念日")).toMatchObject({ current: { value: "2015年9月2日" }, history: [{ value: "2015年9月1日" }], annual: { daysBefore: 3 } });
    await waitUntil(() => remindersOf(frontend).length === 3, { describe: () => "等相识纪念日的每年提醒" });
    expect(remindersOf(frontend).at(-1)!.reminder).toMatchObject({ schedule: { month: 8, day: 30 }, text: "9 月 2 日是你的相识纪念日（还有 3 天）" });

    // 删一个纪念日：提醒跟着删，另一个不动；都删了"纪念日"又空着列出来
    expect((await filesApi.remove(url, SELF_PERSON_ID, { target: { kind: "field", field: "anniversary:恋爱纪念日" }, mode: "forget" })).status).toBe(200);
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "deleted", reminder: { schedule: { month: 5, day: 13 } } });
    const left = await filesApi.remove(url, SELF_PERSON_ID, { target: { kind: "field", field: "anniversary:结婚纪念日" }, mode: "forget" });
    expect(fieldOf(left.body.file!, "anniversary")).toMatchObject({ label: "纪念日" });
  });
});

describe("彻底删除核对卡上确认过的生日", () => {
  it("核对卡确认爸爸生日带每年提醒 → 彻底删除生日：卡的每个版本上每年提醒那一勾的月日都抹掉，提醒跟着删", { timeout: 90_000 }, async () => {
    const clock = new ManualClock(at(10, 26, 10));
    const { url, daemon } = await startTestDaemon({ clock, secretary: [propose({ person: "爸爸", relation: "父亲", fields: [{ field: "生日", value: "1962年6月18日" }] }), OK] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);

    // 新建一个人出核对卡：勾照旧默认勾着
    await tell(frontend, "我爸生日是1962年6月18日");
    const card = cardsOf(frontend).find((c) => c.type === "personal_file")!;
    expect((card.payload as PersonalFileCardPayload).remind).toEqual([{ field: "birthday", label: "生日", month: 6, day: 18, daysBefore: 3 }]);
    await frontend.cardAction({ cardId: card.id, action: "execute", expectedVersion: card.version });
    await waitUntil(() => remindersOf(frontend).length === 1, { describe: () => "等每年提醒建好" });
    const handled = latestCard(frontend, card.id);
    expect(handled.status).toBe("handled");
    expect((handled.payload as PersonalFileCardPayload).result).toBe("已记进档案：爸爸 · 生日。已建每年提醒（提前 3 天），档案页可改可关");

    const dadId = (await requestJson<PersonalFilesView & HttpErrorBody>(url, HTTP_PATHS.personalFiles)).body.files.find((f) => f.name === "爸爸")!.id;
    const removed = await filesApi.remove(url, dadId, { target: { kind: "field", field: "birthday" }, mode: "purge" });
    expect(removed.status).toBe(200);
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "deleted" });

    // 开着的页面换到的新版本：值换成删除标记，每年提醒的勾整个去掉（不留 6 月 18 日）；纯文本里也没有
    const purged = latestCard(frontend, card.id);
    const payload = purged.payload as PersonalFileCardPayload;
    expect(payload.fields[0]).toMatchObject({ field: "birthday", label: "生日" });
    expect(payload.fields[0]!.value).not.toContain("6月18日");
    expect(payload.remind).toBeUndefined();
    expect(purged.text).not.toMatch(/6\s*月|18/);
    // 事件库里这张卡的每个版本（改写过的旧版本、追加的新版本）都不带月日
    const versions = daemon.store.reader
      .all<{ payload: string }>("SELECT payload FROM events WHERE channel = ? AND type = ?", CARDS, EVENT_TYPES.card)
      .map((r) => JSON.parse(r.payload) as CardEventPayload)
      .filter((p) => p.card.id === card.id);
    expect(versions.length).toBeGreaterThanOrEqual(3);
    for (const version of versions) {
      expect((version.card.payload as PersonalFileCardPayload).remind).toBeUndefined();
      expect(JSON.stringify(version.card)).not.toContain("1962");
    }
    // 它建的每年提醒在事件记录里的内容、时间也改写了（没连出处：用户自己那句"我爸生日是……"还在，那是另一回事）
    for (const text of ["爸爸的生日", "6 月 18 日", "6 月 15 日"]) expect({ text, events: eventsContaining(daemon, text) }).toEqual({ text, events: [] });

    // 档案页再填一个生日、开每年提醒，然后彻底删除整个人：这条提醒也一样
    await filesApi.change(url, dadId, { kind: "set_field", field: "birthday", value: "7月1日" });
    await filesApi.change(url, dadId, { kind: "set_reminder", field: "birthday", daysBefore: 3 });
    expect(remindersOf(frontend).at(-1)!.reminder.text).toBe("7 月 1 日是爸爸的生日（还有 3 天）");
    expect((await filesApi.remove(url, dadId, { target: { kind: "person" }, mode: "purge" })).status).toBe(200);
    expect(remindersOf(frontend).at(-1)).toMatchObject({ change: "deleted", reminder: { text: "（这条内容已彻底删除）" } });
    for (const text of ["爸爸的生日", "7 月 1 日", "6 月 28 日"]) expect({ text, events: eventsContaining(daemon, text) }).toEqual({ text, events: [] });
  });
});
