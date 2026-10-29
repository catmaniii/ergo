// 主切面：手机上的二狗 App 读本机（299 号票）。真的守护进程走组合根和插件清单（"手机"插件在清单里），App 交来的用假的
// （照网页经 POST /api/data-sources/<id>/push 交的样子），示例联系人、日程都是编的：
// - 通讯录选人：App 交来两个人（一个档案里还没有的王小明，一个已有档案的妈妈）→ 当场一张候选核对卡（建档、电话逐位核对、生日带每年
//   提醒的勾、住址），逐条确认后写进档案（留痕：从手机通讯录挑的、你确认的）；数据源页写明最近交来的是谁；不进记忆素材；
// - 手机日历：没连着时不收；点了"连上"交来三条日程 → 日历插件按天显示（标出来自手机、哪个日历，跨天的每天一次）；再交一次改一条、
//   删一条 → 增量对；授权被撤回 → 数据源页写明原因；断开并连已导入的一起删 → 日历里没了、条数归零；
// - 断开"通讯录选人"并连已导入的一起删：还没处理的候选和卡上的值一起删，已经写进档案的不动；
// - 插件运行中停用：交来回 400"手机插件没启用"；日历插件停用时"手机 · 日历"写明看不到。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type HttpErrorBody,
  isDeletedEventPayload,
  nowIso,
  PHONE_CALENDAR_SOURCE,
  PHONE_CONTACTS_SOURCE,
  PHONE_LOCATION_SOURCE,
  PHONE_PHOTOS_SOURCE,
  type PhoneCalendarEvent,
  type PhoneContactsReply,
  phoneCalendarWindow,
  type DataSourcePushResult,
  type PersonalFilesView,
  type PersonalFileSuggestCardPayload,
  type PersonalFileView,
  PURGED_TEXT,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { PHONE_CALENDAR_EVENT, PHONE_CHANNEL, PHONE_CONTACT_PICKED } from "../../src/phone/events.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { calendarApi, dataSourcesApi, pluginsApi, requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { cards: CARDS, inbox: INBOX, board: BOARD } = CHANNELS;

let n = 0;
const key = () => `phone-${++n}`;
const push = (url: string, id: string, data: unknown, idempotencyKey = key()) =>
  requestJson<DataSourcePushResult & HttpErrorBody>(url, HTTP_PATHS.dataSourcePush(id), { method: "POST", body: { data, idempotencyKey } });
const filesApi = {
  list: (url: string) => requestJson<PersonalFilesView & HttpErrorBody>(url, HTTP_PATHS.personalFiles),
  get: (url: string, id: string) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFile(id)),
  add: (url: string, body: unknown) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFiles, { method: "POST", body }),
};
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const latestCard = (frontend: TestFrontend, id: string): Card => cardsOf(frontend).filter((c) => c.id === id).at(-1)!;
const fieldOf = (file: PersonalFileView, field: string) => file.fields.find((f) => f.field === field)!;

/** 编的两个联系人：号码是明显的假号码，地址是编的 */
const XIAOMING = { name: "王小明", phones: ["138 0000 1111", "010-1234 5678"], birthday: "1990-03-02", addresses: ["杭州市西湖区某某路 1 号"] };
const MOM = { name: "妈妈", phones: ["139-0000-2222"], addresses: ["上海市某某区某某路 2 号"] };

/** 这个月某天某时（本地时间）的协议时间 */
const thisMonth = (day: number, hh = 0, mm = 0) => {
  const now = new Date();
  return nowIso(new Date(now.getFullYear(), now.getMonth(), day, hh, mm));
};
const monthKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};
const dayKey = (day: number) => `${monthKey()}-${String(day).padStart(2, "0")}`;
const windowOf = () => {
  const w = phoneCalendarWindow(new Date());
  return { from: nowIso(w.from), to: nowIso(w.to) };
};

const DENTIST: PhoneCalendarEvent = { key: "11@1", title: "看牙医", start: thisMonth(10, 9), end: thisMonth(10, 10), allDay: false, location: "某某口腔", calendar: "我的日历" };
const BIRTHDAY: PhoneCalendarEvent = { key: "12@1", title: "妈妈生日", start: thisMonth(12), end: thisMonth(13), allDay: true, calendar: "生日" };
const TRIP: PhoneCalendarEvent = { key: "13@1", title: "出差", start: thisMonth(20), end: thisMonth(23), allDay: true, calendar: "工作" };

describe("手机：通讯录选人进档案候选", () => {
  it("App 交来两个人 → 当场一张候选核对卡（电话逐位核对、生日带每年提醒）→ 逐条确认写进档案；断开并删时还没处理的候选跟着删", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({ plugins: ["reminders", "calendar", "phone"] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CARDS]: 0, [INBOX]: 0, [BOARD]: 0 });
    const mom = (await filesApi.add(td.url, { name: "妈妈", relation: "母亲" })).body;

    // 数据源页：通讯录选人是手动的、只有导入
    const first = (await dataSourcesApi.view(td.url)).body.sources;
    expect(first.filter((s) => s.plugin === "phone").map((s) => [s.id, s.title, s.connection, s.usages])).toEqual([
      [PHONE_CONTACTS_SOURCE, "手机 · 通讯录选人", "manual", [{ usage: "import", on: true }]],
      [PHONE_CALENDAR_SOURCE, "手机 · 日历", "not_connected", [{ usage: "import", on: true }]],
      [PHONE_PHOTOS_SOURCE, "手机 · 照片的时间地点", "not_connected", [{ usage: "import", on: true }]],
      [PHONE_LOCATION_SOURCE, "手机 · 位置", "not_connected", [{ usage: "import", on: true }]],
    ]);

    // App 交来两个人
    const picked = await push(td.url, PHONE_CONTACTS_SOURCE, { device: "HUAWEI Pura 90", contacts: [XIAOMING, MOM] });
    expect(picked.status).toBe(200);
    expect(picked.body).toMatchObject({ added: 2, summary: "2 位联系人：王小明和妈妈" });
    const reply = picked.body.reply as PhoneContactsReply;
    expect(reply.names).toEqual(["王小明", "妈妈"]);
    const source = picked.body.view.sources.find((s) => s.id === PHONE_CONTACTS_SOURCE)!;
    expect(source).toMatchObject({ count: 2, lastSync: { trigger: "device", added: 2, summary: "2 位联系人：王小明和妈妈" } });

    // 当场一张候选核对卡（进待办）：王小明建档、电话（号码，逐位）、生日（带每年提醒）、住址；妈妈的电话、住址
    await waitUntil(() => cardsOf(frontend).some((c) => c.id === reply.cardId), { describe: () => "等候选核对卡" });
    const card = latestCard(frontend, reply.cardId!);
    const payload = card.payload as PersonalFileSuggestCardPayload;
    expect(payload.items).toMatchObject([
      { kind: "create", person: { name: "王小明", isNew: true }, origin: "contacts", heard: [] },
      { kind: "field", person: { name: "王小明" }, field: "phone", value: "13800001111", number: true, origin: "contacts" },
      { kind: "field", person: { name: "王小明" }, field: "birthday", value: "1990-03-02", remind: { month: 3, day: 2, daysBefore: 3 } },
      { kind: "field", person: { name: "王小明" }, field: "address", value: "杭州市西湖区某某路 1 号" },
      { kind: "field", person: { id: mom.id, name: "妈妈", isNew: false }, field: "phone", value: "13900002222", number: true },
      { kind: "field", person: { id: mom.id }, field: "address", value: "上海市某某区某某路 2 号" },
    ]);
    expect(card.text).toContain("建档：王小明（从手机通讯录挑的）");
    const inboxItem = frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as { item: { cardId?: string; source?: string } }).item).find((i) => i.cardId === card.id);
    expect(inboxItem?.source).toBe("手机通讯录");
    // 不进记忆素材（记忆插件开着也不会：没有登记素材来源）、事件日志里没有交来的原样请求
    expect(td.daemon.materials.list().some((m) => m.ref.event.channel === PHONE_CHANNEL)).toBe(false);

    // 逐条确认：妈妈的住址不勾
    const momAddress = payload.items.find((i) => i.person.id === mom.id && i.field === "address")!;
    await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { accept: payload.items.filter((i) => i.id !== momAddress.id).map((i) => i.id), remind: [] } });
    await waitUntil(() => latestCard(frontend, card.id).status === "handled", { describe: () => "等候选核对卡处理完" });
    const xiaoming = (await filesApi.list(td.url)).body.files.find((f) => f.name === "王小明")!;
    const file = (await filesApi.get(td.url, xiaoming.id)).body;
    expect(fieldOf(file, "phone").current).toMatchObject({ value: "13800001111", source: { via: "curator", basis: "confirmed", origin: "contacts" } });
    expect(fieldOf(file, "birthday").current?.value).toBe("1990-03-02");
    expect(fieldOf(file, "address").current?.value).toBe("杭州市西湖区某某路 1 号");
    const momFile = (await filesApi.get(td.url, mom.id)).body;
    expect(fieldOf(momFile, "phone").current?.value).toBe("13900002222");
    expect(fieldOf(momFile, "address").current).toBeUndefined();

    // 再挑一个人、先不处理：断开并连已导入的一起删 → 记录换成标记、还没处理的候选作废、卡上的值删掉、卡作废；已经写进档案的不动
    const again = await push(td.url, PHONE_CONTACTS_SOURCE, { contacts: [{ name: "李阿姨", phones: ["137 0000 3333"], addresses: [] }] });
    const second = (again.body.reply as PhoneContactsReply).cardId!;
    expect(second).not.toBe(card.id);
    await waitUntil(() => cardsOf(frontend).some((c) => c.id === second), { describe: () => "等第二张卡" });
    const purged = await dataSourcesApi.act(td.url, PHONE_CONTACTS_SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.status).toBe(200);
    expect(purged.body.purged).toMatchObject({ events: 5 });
    expect(td.daemon.store.read(PHONE_CHANNEL, 0, PHONE_CONTACT_PICKED).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    await waitUntil(() => latestCard(frontend, second).status === "expired", { describe: () => `第二张卡：${latestCard(frontend, second).status}` });
    const gone = latestCard(frontend, second).payload as PersonalFileSuggestCardPayload;
    expect(gone.items.every((i) => i.person.name === PURGED_TEXT && (i.value === undefined || i.value === PURGED_TEXT))).toBe(true);
    expect(JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).map((e) => e.payload))).not.toContain("13700003333");
    expect(fieldOf((await filesApi.get(td.url, xiaoming.id)).body, "phone").current?.value).toBe("13800001111");
    expect((await filesApi.list(td.url)).body.files.some((f) => f.name === "李阿姨")).toBe(false);
  });
});

describe("手机：手机日历进二狗的日历", () => {
  it("没连着不收；连上后三条日程按天显示（标出来自手机）；改一条删一条增量对；授权撤回写明原因；断开并删后日历里没了", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({ plugins: ["reminders", "calendar", "phone"] });
    const w = windowOf();

    // 没连着、不是"连上"的那一下：不收
    const refused = await push(td.url, PHONE_CALENDAR_SOURCE, { state: "granted", ...w, events: [DENTIST] });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("手机日历还没连上");

    // 点了"连上手机日历"、授权了：交来三条
    const linked = await push(td.url, PHONE_CALENDAR_SOURCE, { device: "HUAWEI Pura 90", state: "granted", link: true, ...w, events: [DENTIST, BIRTHDAY, TRIP] });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ added: 3, summary: "3 条日程（新 3、改 0、删 0）" });
    expect(linked.body.view.sources.find((s) => s.id === PHONE_CALENDAR_SOURCE)).toMatchObject({ connection: "connected", account: "HUAWEI Pura 90", count: 3, lastSync: { trigger: "device", added: 3 } });

    // 日历插件按天显示：标出来自手机和哪个日历；跨天的（出差 20–22 日）每天一次
    const month = (await calendarApi.month(td.url, monthKey())).body;
    const day = (d: number) => month.days.find((x) => x.date === dayKey(d))!;
    expect(day(10).external).toEqual([
      { source: PHONE_CALENDAR_SOURCE, sourceTitle: "手机 · 日历", id: "11@1", title: "看牙医", at: DENTIST.start, end: DENTIST.end, allDay: false, location: "某某口腔", calendar: "我的日历" },
    ]);
    expect(day(12).external?.map((e) => [e.title, e.allDay])).toEqual([["妈妈生日", true]]);
    expect(day(13).external).toBeUndefined();
    expect([20, 21, 22, 23].map((d) => day(d).external?.map((e) => e.title) ?? [])).toEqual([["出差"], ["出差"], ["出差"], []]);
    // 不进记忆素材
    expect(td.daemon.materials.list().some((m) => m.ref.event.channel === PHONE_CHANNEL)).toBe(false);

    // 再交一次：看牙医改到 11 点、出差删了 → 改 1 删 1；同一个幂等键重发不再收
    const moved = { ...DENTIST, start: thisMonth(10, 11), end: thisMonth(10, 12) };
    const k = key();
    const synced = await push(td.url, PHONE_CALENDAR_SOURCE, { device: "HUAWEI Pura 90", state: "granted", ...w, events: [moved, BIRTHDAY] }, k);
    expect(synced.body).toMatchObject({ added: 1, summary: "2 条日程（新 0、改 1、删 1）" });
    const replay = await push(td.url, PHONE_CALENDAR_SOURCE, { device: "HUAWEI Pura 90", state: "granted", ...w, events: [] }, k);
    expect(replay.body).toMatchObject({ added: 1, summary: "2 条日程（新 0、改 1、删 1）" });
    const after = (await calendarApi.month(td.url, monthKey())).body;
    expect(after.days.find((x) => x.date === dayKey(10))!.external?.map((e) => e.at)).toEqual([moved.start]);
    expect(after.days.find((x) => x.date === dayKey(21))!.external).toBeUndefined();
    expect((await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === PHONE_CALENDAR_SOURCE)).toMatchObject({ count: 2 });

    // 日历插件停用：写明看不到，照常收；再启用
    expect((await pluginsApi.act(td.url, "calendar", { action: "disable", idempotencyKey: key() })).status).toBe(200);
    expect((await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === PHONE_CALENDAR_SOURCE)).toMatchObject({ connection: "error", problem: "日历插件没启用：同步来的日程暂时看不到" });
    expect((await pluginsApi.act(td.url, "calendar", { action: "enable", idempotencyKey: key() })).status).toBe(200);

    // 授权被撤回：App 交来状况和原因 → 数据源页写明
    const revoked = await push(td.url, PHONE_CALENDAR_SOURCE, { state: "revoked", reason: "系统设置里关掉了日历权限" });
    expect(revoked.body).toMatchObject({ added: 0, summary: "授权被撤回了，没有同步" });
    expect(revoked.body.view.sources.find((s) => s.id === PHONE_CALENDAR_SOURCE)).toMatchObject({
      connection: "error",
      problem: "读手机日历的授权被撤回了（系统设置里关掉了日历权限）：在手机上的二狗 App 里点「现在同步」再允许一次，或者在手机的设置里给二狗打开日历权限，才能接着同步",
    });

    // 断开并连已导入的一起删：日历里没了、条数归零、之后不连上不收
    const purged = await dataSourcesApi.act(td.url, PHONE_CALENDAR_SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.body.view.sources.find((s) => s.id === PHONE_CALENDAR_SOURCE)).toMatchObject({ connection: "not_connected", count: 0 });
    expect(td.daemon.store.read(PHONE_CHANNEL, 0, PHONE_CALENDAR_EVENT).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect((await calendarApi.month(td.url, monthKey())).body.days.some((d) => d.external !== undefined)).toBe(false);
    expect((await push(td.url, PHONE_CALENDAR_SOURCE, { state: "granted", ...w, events: [DENTIST] })).status).toBe(400);
  });

  it("插件运行中停用：交来回 400\"手机插件没启用\"；交来的不合 schema 回 400、导入关着回 400", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({ plugins: ["calendar", "phone"] });
    const bad = await push(td.url, PHONE_CONTACTS_SOURCE, { contacts: [{ name: "王小明" }] });
    expect(bad.status).toBe(400);
    expect((await dataSourcesApi.act(td.url, PHONE_CONTACTS_SOURCE, { action: "usage", usage: "import", on: false, idempotencyKey: key() })).status).toBe(200);
    const off = await push(td.url, PHONE_CONTACTS_SOURCE, { contacts: [XIAOMING] });
    expect(off.status).toBe(400);
    expect(off.body.message).toBe("手机 · 通讯录选人的导入关着");
    expect((await pluginsApi.act(td.url, "phone", { action: "disable", idempotencyKey: key() })).status).toBe(200);
    const disabled = await push(td.url, PHONE_CALENDAR_SOURCE, { state: "granted", link: true, ...windowOf(), events: [] });
    expect(disabled.status).toBe(400);
    expect(disabled.body.message).toBe("手机插件没启用");
    expect((await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === PHONE_CALENDAR_SOURCE)).toMatchObject({ available: false, unavailable: "手机插件没启用" });
    expect((await push(td.url, "nobody", {})).status).toBe(404);
  });
});
