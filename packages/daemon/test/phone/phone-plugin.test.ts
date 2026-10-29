// "手机"插件（299 号票）在假内核里（startPluginKernel：真的插件宿主、数据源那一层、设置 · 插件那一层），个人档案换成记下调用的假的：
// - 数据契约登记四个数据源（插件停用也列出、写明没启用）；
// - 通讯录选人：电话去掉空白横线、生日去掉没有年份的前缀、空的去掉，交给档案候选（origin contacts、数据源 phone-contacts），
//   合成候选核对卡，交回卡的编号；
// - 手机日历：增量（新、改、范围里没了的删、范围外的不动）、状况（撤回、拒了、读不了，同样的不重复记）、条数、给日历的 [from, to)；
//   断开时记下没连着；日历插件不在时写明；
// - 停用、启用（记录还在、接着用），移除并连数据删（phone 频道整条换成标记）；
// - 300 号票的照片、位置：没授权、撤回写明原因（同样的不重复记），没有读照片位置的授权时不带地点，拍摄时间在明天以后的不收，
//   整理之后又交来那天的补一条；位置精度太差的点不用、零星几个点写明没待够；原始数据按天清掉，停用时不列、清不了；
//   移除并连数据删时插件自己的存储整个删掉。
import fs from "node:fs";
import path from "node:path";
import { isDeletedEventPayload, nowIso, PHONE_CALENDAR_SOURCE, PHONE_CONTACTS_SOURCE, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE, type PhoneCalendarEvent } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { CandidateInput } from "../../src/personal-files/index.ts";
import { PHONE_CALENDAR_STATUS, PHONE_CHANNEL, PHONE_LOCATION_DAY, PHONE_PHOTOS_DAY, PHONE_PHOTOS_STATUS, type PhoneDaySummaryPayload } from "../../src/phone/events.ts";
import { phonePlugin } from "../../src/phone/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

let seq = 0;
const key = () => `p-${++seq}`;

/** 假的个人档案：记下交来的候选，合成的卡编号是 card-1、card-2…… */
function fakeFiles() {
  const calls: Array<{ origin: string; inputs: readonly CandidateInput[] }> = [];
  let cards = 0;
  return {
    calls,
    service: {
      people: () => [],
      background: () => "",
      withheld: () => [],
      onFieldReplaced: () => () => {},
      replacedValues: () => [],
      addCandidates: (origin: "nightly" | "interview" | "contacts", inputs: readonly CandidateInput[]) => {
        calls.push({ origin, inputs });
        return inputs.length;
      },
      composeCandidates: () => `card-${++cards}`,
    },
  };
}

async function start(at?: Date) {
  const files = fakeFiles();
  const k = await startPluginKernel({
    plugins: [phonePlugin],
    services: [extraService(KERNEL.personalFiles, () => files.service), extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir))],
    ...(at === undefined ? {} : { at }),
  });
  return { k, files };
}

const sourceOf = (k: PluginKernel, id: string) => k.dataSources.view().sources.find((s) => s.id === id)!;
const pushTo = (k: PluginKernel, id: string, data: unknown) => k.dataSources.push(id, { data, idempotencyKey: key() });
const at = (day: number, hh = 0) => new Date(2026, 9, day, hh).toISOString();
const WINDOW = { from: new Date(2026, 8, 1).toISOString(), to: new Date(2027, 4, 1).toISOString() };
const ev = (k: string, day: number, title = k, extra: Partial<PhoneCalendarEvent> = {}): PhoneCalendarEvent => ({ key: k, title, start: at(day, 9), end: at(day, 10), allDay: false, ...extra });

describe("手机插件：数据源", () => {
  it("登记四个数据源：通讯录选人（手动的）、手机日历、照片的时间地点、位置（没连）；都只有导入", async () => {
    const { k } = await start();
    expect(k.dataSources.view().sources.map((s) => [s.id, s.plugin, s.connection, s.usages.map((u) => u.usage), s.canSync])).toEqual([
      [PHONE_CONTACTS_SOURCE, "phone", "manual", ["import"], false],
      [PHONE_CALENDAR_SOURCE, "phone", "not_connected", ["import"], false],
      [PHONE_PHOTOS_SOURCE, "phone", "not_connected", ["import"], false],
      [PHONE_LOCATION_SOURCE, "phone", "not_connected", ["import"], false],
    ]);
  });

  it("通讯录选人：规范化后交给档案候选、合成候选核对卡，交回卡的编号；同一个幂等键重发不再交", async () => {
    const { k, files } = await start();
    const contacts = [
      { name: " 王小明 ", phones: ["138 0000-1111", "(010) 1234 5678", "138 0000 1111"], birthday: "--03-02", addresses: [" 杭州市  某某路 1 号 ", " "] },
      { name: "李阿姨", phones: [], addresses: [] },
    ];
    const body = { data: { device: "HUAWEI Pura 90", contacts }, idempotencyKey: "same" };
    const result = await k.dataSources.push(PHONE_CONTACTS_SOURCE, body);
    expect(result).toMatchObject({ added: 2, summary: "2 位联系人：王小明和李阿姨", reply: { names: ["王小明", "李阿姨"], cardId: "card-1" } });
    expect(files.calls).toEqual([
      {
        origin: "contacts",
        inputs: [
          {
            name: "王小明",
            materialIds: [],
            heard: [],
            fields: [
              { field: "phone", value: "13800001111" },
              { field: "birthday", value: "03-02" },
              { field: "address", value: "杭州市 某某路 1 号" },
            ],
            dataSource: PHONE_CONTACTS_SOURCE,
          },
          { name: "李阿姨", materialIds: [], heard: [], fields: [], dataSource: PHONE_CONTACTS_SOURCE },
        ],
      },
    ]);
    expect(sourceOf(k, PHONE_CONTACTS_SOURCE)).toMatchObject({ count: 2, lastSync: { trigger: "device", added: 2 } });
    expect(await k.dataSources.push(PHONE_CONTACTS_SOURCE, body)).toMatchObject({ added: 2, reply: { cardId: "card-1" } });
    expect(files.calls).toHaveLength(1);
  });

  it("手机日历：连上 → 增量（新、改、删，范围外的不动）、条数、给日历的日程；状况同样的不重复记；断开记下没连着", async () => {
    const { k } = await start();
    await expect(pushTo(k, PHONE_CALENDAR_SOURCE, { state: "granted", ...WINDOW, events: [] })).rejects.toThrow("手机日历还没连上");
    await expect(pushTo(k, PHONE_CALENDAR_SOURCE, { state: "revoked" })).rejects.toThrow("手机日历还没连上");
    // 范围外的一条（去年的）先进来，之后的同步范围里没有它也不删
    const old: PhoneCalendarEvent = { key: "old", title: "去年的", start: new Date(2025, 0, 5, 9).toISOString(), allDay: false };
    expect(await pushTo(k, PHONE_CALENDAR_SOURCE, { state: "granted", link: true, from: new Date(2024, 11, 1).toISOString(), to: new Date(2025, 1, 1).toISOString(), events: [old] })).toMatchObject({ added: 1 });
    const first = await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", ...WINDOW, events: [ev("a", 10), ev("b", 12), ev("c", 14)] });
    expect(first).toMatchObject({ added: 3, summary: "3 条日程（新 3、改 0、删 0）" });
    // 日历插件不在（假内核没装）：连着，但写明看不到
    expect(sourceOf(k, PHONE_CALENDAR_SOURCE)).toMatchObject({ connection: "error", problem: "日历插件没启用：同步来的日程暂时看不到", account: "Pura 90", count: 4 });
    const second = await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", ...WINDOW, events: [ev("a", 10), ev("b", 12, "改了名字"), ev("d", 16)] });
    expect(second).toMatchObject({ added: 2, summary: "3 条日程（新 1、改 1、删 1）" });
    expect(sourceOf(k, PHONE_CALENDAR_SOURCE).count).toBe(4);
    const phone = k.dataSourceRegistry.get(PHONE_CALENDAR_SOURCE)!.source;
    const ctx = { secrets: undefined as never, log: () => {} };
    // [10 日 9:30, 13 日)：a（9–10 点，交叠）、b
    expect(phone.calendar!({ from: new Date(2026, 9, 10, 9, 30), to: new Date(2026, 9, 13) }, ctx).map((e) => [e.id, e.title])).toEqual([
      ["a", "a"],
      ["b", "改了名字"],
    ]);
    // 授权撤回：记一次状况；同样的再交一次不再记
    await pushTo(k, PHONE_CALENDAR_SOURCE, { state: "revoked", reason: "关掉了" });
    await pushTo(k, PHONE_CALENDAR_SOURCE, { state: "revoked", reason: "关掉了" });
    expect(k.store.read(PHONE_CHANNEL, 0, PHONE_CALENDAR_STATUS).map((e) => (e.payload as { state?: string }).state)).toEqual(["granted", "granted", "revoked"]);
    expect(sourceOf(k, PHONE_CALENDAR_SOURCE)).toMatchObject({ connection: "error", problem: "读手机日历的授权被撤回了（关掉了）：在手机上的二狗 App 里点「现在同步」再允许一次，或者在手机的设置里给二狗打开日历权限，才能接着同步", account: "Pura 90" });
    // 又给了：接着同步
    expect(await pushTo(k, PHONE_CALENDAR_SOURCE, { device: "Pura 90", state: "granted", ...WINDOW, events: [ev("a", 10)] })).toMatchObject({ added: 0, summary: "1 条日程（新 0、改 0、删 2）" });
    // 断开（留着已导入的）：没连着，日历里不给，记录还在
    await k.dataSources.act(PHONE_CALENDAR_SOURCE, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(sourceOf(k, PHONE_CALENDAR_SOURCE)).toMatchObject({ connection: "not_connected", count: 2 });
    expect(phone.calendar!({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) }, ctx)).toEqual([]);
  });

  it("停用：两个数据源都写明没启用、交来回没启用；启用后接着用；移除并连数据删：phone 频道整条换成标记", async () => {
    const { k } = await start();
    await pushTo(k, PHONE_CALENDAR_SOURCE, { state: "granted", link: true, ...WINDOW, events: [ev("a", 10)] });
    await pushTo(k, PHONE_CONTACTS_SOURCE, { contacts: [{ name: "王小明", phones: ["13800001111"], addresses: [] }] });
    await k.settings.act("phone", { action: "disable", idempotencyKey: key() });
    expect(k.dataSources.view().sources.map((s) => [s.id, s.available, s.unavailable])).toEqual([
      [PHONE_CONTACTS_SOURCE, false, "手机插件没启用"],
      [PHONE_CALENDAR_SOURCE, false, "手机插件没启用"],
      [PHONE_PHOTOS_SOURCE, false, "手机插件没启用"],
      [PHONE_LOCATION_SOURCE, false, "手机插件没启用"],
    ]);
    await expect(pushTo(k, PHONE_CONTACTS_SOURCE, { contacts: [{ name: "x", phones: [], addresses: [] }] })).rejects.toThrow("手机插件没启用");
    await k.settings.act("phone", { action: "enable", idempotencyKey: key() });
    expect(sourceOf(k, PHONE_CALENDAR_SOURCE)).toMatchObject({ available: true, count: 1 });
    expect(await pushTo(k, PHONE_CALENDAR_SOURCE, { state: "granted", ...WINDOW, events: [ev("a", 10), ev("b", 11)] })).toMatchObject({ added: 1 });
    await k.settings.act("phone", { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(k.store.read(PHONE_CHANNEL).length).toBeGreaterThan(0);
    expect(k.store.read(PHONE_CHANNEL).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
  });
});

/** 本地时间 2026 年 10 月 d 日（10-25 是周日） */
const day = (d: number, hh: number, mm = 0) => nowIso(new Date(2026, 9, d, hh, mm));
/** 照片、位置那一类摘要（按先后） */
const daysOf = (k: PluginKernel, type: string) => k.store.read(PHONE_CHANNEL, 0, type).map((e) => e.payload as PhoneDaySummaryPayload);

describe("手机插件：照片的时间地点、位置（300 号票）", () => {
  const WINDOW_PHOTOS = { from: day(19, 9), to: day(27, 9) };
  const NOW = new Date(2026, 9, 26, 9);

  it("照片：没连上不收状况；没有读照片位置的授权时不带地点、明天以后拍的不收；整理之后又交来那天的补一条；撤回写明原因、同样的不重复记；按天清掉", async () => {
    const { k } = await start(NOW);
    await expect(pushTo(k, PHONE_PHOTOS_SOURCE, { state: "denied" })).rejects.toThrow("相册还没连上");
    const linked = await pushTo(k, PHONE_PHOTOS_SOURCE, {
      device: "Pura 90",
      state: "granted",
      link: true,
      location: false,
      ...WINDOW_PHOTOS,
      photos: [
        { key: "a", takenAt: day(25, 9, 0) },
        { key: "b", takenAt: day(25, 9, 20) },
        { key: "future", takenAt: day(28, 9) },
      ],
    });
    expect(linked).toMatchObject({ added: 1, summary: "读到 3 张照片的时间地点，新的 2 张（没有读照片位置的授权，都不带地点）；整理出 10-25 的摘要" });
    expect(daysOf(k, PHONE_PHOTOS_DAY)).toEqual([
      { id: "pp-2026-10-25-1", date: "2026-10-25", part: 1, at: day(25, 9, 0), end: day(25, 9, 20), text: "2026-10-25（周日）拍了 2 张照片：上午 09:00–09:20 2 张。都没有地点。", count: 2, device: "Pura 90" },
    ]);
    // 后来又交来那天拍的一张（这回有读照片位置的授权）：补一条
    const later = await pushTo(k, PHONE_PHOTOS_SOURCE, {
      device: "Pura 90",
      state: "granted",
      location: true,
      ...WINDOW_PHOTOS,
      photos: [
        { key: "a", takenAt: day(25, 9, 0) },
        { key: "c", takenAt: day(25, 21, 0), lat: 31.2304, lon: 121.4737 },
      ],
    });
    expect(later).toMatchObject({ added: 1, summary: "读到 2 张照片的时间地点，新的 1 张；整理出 10-25 的摘要" });
    expect(daysOf(k, PHONE_PHOTOS_DAY)[1]).toMatchObject({ id: "pp-2026-10-25-2", part: 2, text: "2026-10-25（周日）补记：又读到那天拍的 1 张照片：晚上 21:00 1 张。", place: "晚上 北纬 31.23°、东经 121.47° 一带", count: 1 });
    expect(sourceOf(k, PHONE_PHOTOS_SOURCE)).toMatchObject({ connection: "connected", account: "Pura 90", count: 2, raw: { days: [{ date: "2026-10-25", count: 3, summarized: true }] } });
    // 撤回：写明原因；同样的再交一次不重复记
    expect(await pushTo(k, PHONE_PHOTOS_SOURCE, { state: "revoked", reason: "关掉了" })).toMatchObject({ added: 0, summary: "授权被撤回了，没有交来" });
    const statuses = k.store.read(PHONE_CHANNEL, 0, PHONE_PHOTOS_STATUS).length;
    await pushTo(k, PHONE_PHOTOS_SOURCE, { state: "revoked", reason: "关掉了" });
    expect(k.store.read(PHONE_CHANNEL, 0, PHONE_PHOTOS_STATUS)).toHaveLength(statuses);
    expect(sourceOf(k, PHONE_PHOTOS_SOURCE)).toMatchObject({ connection: "error", problem: "读相册的授权被撤回了（关掉了）：在手机的设置里给二狗打开照片权限，才能接着读", account: "Pura 90" });
    // 原始数据按天清掉（重复的、没有的日子不算）
    expect(await k.dataSources.act(PHONE_PHOTOS_SOURCE, { action: "clear_raw", dates: ["2026-10-25", "2026-10-25", "2026-10-01"], idempotencyKey: key() })).toMatchObject({ cleared: 3 });
    expect(sourceOf(k, PHONE_PHOTOS_SOURCE).raw).toEqual({ title: "原始的照片时间地点", days: [] });
    // 手机每次都把最近几天的照片读一遍：清掉的再交来不再收、也不多一份补记（304 号票在模拟器上碰到的）；
    // 今天清掉以后才拍的照收（清到哪一刻记在插件自己的存储里）
    const photosAgain = { device: "Pura 90", state: "granted", location: true, ...WINDOW_PHOTOS } as const;
    await pushTo(k, PHONE_PHOTOS_SOURCE, { ...photosAgain, photos: [{ key: "t1", takenAt: day(26, 8, 0) }] });
    expect(await k.dataSources.act(PHONE_PHOTOS_SOURCE, { action: "clear_raw", dates: ["2026-10-26"], idempotencyKey: key() })).toMatchObject({ cleared: 1 });
    const again = await pushTo(k, PHONE_PHOTOS_SOURCE, {
      ...photosAgain,
      photos: [
        { key: "a", takenAt: day(25, 9, 0) },
        { key: "b", takenAt: day(25, 9, 20) },
        { key: "c", takenAt: day(25, 21, 0), lat: 31.2304, lon: 121.4737 },
        { key: "t1", takenAt: day(26, 8, 0) },
        { key: "t2", takenAt: day(26, 9, 30) },
      ],
    });
    expect(again).toMatchObject({ added: 0, summary: "读到 5 张照片的时间地点，新的 1 张；今天的过完这一天再整理" });
    expect(daysOf(k, PHONE_PHOTOS_DAY)).toHaveLength(2);
    expect(sourceOf(k, PHONE_PHOTOS_SOURCE).raw).toEqual({ title: "原始的照片时间地点", days: [{ date: "2026-10-26", count: 1, summarized: false }] });
    await expect(k.dataSources.act(PHONE_CONTACTS_SOURCE, { action: "clear_raw", dates: ["2026-10-25"], idempotencyKey: key() })).rejects.toThrow("手机 · 通讯录选人没有原始数据可清");
  });

  it("位置：精度太差的点不用、零星几个点写明没待够和空档；后台也记写进账号；停用时原始数据不列、清不了；移除并连数据删时插件自己的存储整个删掉", async () => {
    const { k } = await start(NOW);
    const pushed = await pushTo(k, PHONE_LOCATION_SOURCE, {
      device: "Pura 90",
      state: "granted",
      link: true,
      background: true,
      points: [
        { at: day(25, 9, 0), lat: 31, lon: 121, accuracy: 3000 },
        { at: day(25, 9, 5), lat: 30.259, lon: 120.13, accuracy: 50 },
        { at: day(25, 13, 0), lat: 30.2741, lon: 120.1551 },
        { at: day(25, 20, 0), lat: 30.2905, lon: 120.0755, accuracy: 30 },
        { at: day(26, 8, 0), lat: 30.28, lon: 120.1 },
      ],
    });
    expect(pushed).toMatchObject({ added: 1, summary: "收到 5 个位置点，新的 5 个；整理出 10-25 的摘要；今天的过完这一天再整理" });
    expect(daysOf(k, PHONE_LOCATION_DAY)).toEqual([
      {
        id: "pl-2026-10-25-1",
        date: "2026-10-25",
        part: 1,
        at: day(25, 9, 5),
        end: day(25, 20, 0),
        text: "2026-10-25（周日）的位置：记到 3 个点（09:05–20:00），没有在哪儿待够 15 分钟：北纬 30.26°、东经 120.13° 一带 09:05；北纬 30.27°、东经 120.16° 一带 13:00；北纬 30.29°、东经 120.08° 一带 20:00。中间有 2 段一个半小时以上没记到。",
        place: "北纬 30.26°、东经 120.13° 一带；北纬 30.27°、东经 120.16° 一带；北纬 30.29°、东经 120.08° 一带",
        count: 4,
        device: "Pura 90",
      },
    ]);
    expect(sourceOf(k, PHONE_LOCATION_SOURCE)).toMatchObject({
      connection: "connected",
      account: "Pura 90 · 后台也记",
      raw: {
        title: "原始位置点",
        days: [
          { date: "2026-10-26", count: 1, summarized: false },
          { date: "2026-10-25", count: 4, summarized: true },
        ],
      },
    });
    expect(fs.existsSync(path.join(k.dir, "phone", "locations", "2026-10-25.json"))).toBe(true);
    // 停用：原始数据不列、清不了；再启用回来
    await k.settings.act("phone", { action: "disable", idempotencyKey: key() });
    expect(sourceOf(k, PHONE_LOCATION_SOURCE).raw).toBeUndefined();
    await expect(k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "clear_raw", dates: ["2026-10-25"], idempotencyKey: key() })).rejects.toThrow("手机插件没启用");
    await k.settings.act("phone", { action: "enable", idempotencyKey: key() });
    expect(sourceOf(k, PHONE_LOCATION_SOURCE).raw?.days).toHaveLength(2);
    // 移除并连数据删：摘要换成标记、插件自己的存储整个删掉
    await k.settings.act("phone", { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(k.store.read(PHONE_CHANNEL, 0, PHONE_LOCATION_DAY).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(fs.existsSync(path.join(k.dir, "phone"))).toBe(false);
  });

  it("308 号票 常去的地方：没连着也能起名；停用时那一块不画、填设置回没启用；断开留着已导入的时留着，连已导入的一起删时删掉；移除并连数据删时一起删", async () => {
    const { k } = await start(NOW);
    const places = () => (sourceOf(k, PHONE_LOCATION_SOURCE).panel as { places: Array<{ name: string }> } | undefined)?.places.map((p) => p.name);
    await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "家", lat: "30.28", lon: "120.1" }, idempotencyKey: key() });
    expect(places()).toEqual(["家"]);
    expect(sourceOf(k, PHONE_LOCATION_SOURCE)).toMatchObject({ connection: "not_connected", configurable: true });
    expect(sourceOf(k, PHONE_LOCATION_SOURCE).problem).toBeUndefined();
    // 认不出的、范围不对的不收，原因写在那一块里
    await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "公司", lat: "30.26", lon: "120.13", radius: "250" }, idempotencyKey: key() });
    expect(sourceOf(k, PHONE_LOCATION_SOURCE).panel).toMatchObject({ refused: "范围只能选 100、200、300、500、1000 米" });
    await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "move" }, idempotencyKey: key() });
    expect(sourceOf(k, PHONE_LOCATION_SOURCE).panel).toMatchObject({ refused: "认不出要做什么" });
    // 停用：那一块不画，填设置回没启用；启用回来还在
    await k.settings.act("phone", { action: "disable", idempotencyKey: key() });
    expect(sourceOf(k, PHONE_LOCATION_SOURCE).panel).toBeUndefined();
    await expect(k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "remove", id: "x" }, idempotencyKey: key() })).rejects.toThrow("手机插件没启用");
    await k.settings.act("phone", { action: "enable", idempotencyKey: key() });
    expect(places()).toEqual(["家"]);
    // 连上、断开留着已导入的：起了名的留着
    await pushTo(k, PHONE_LOCATION_SOURCE, { state: "granted", link: true, background: false, points: [{ at: day(26, 8, 0), lat: 30.28, lon: 120.1 }] });
    await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(places()).toEqual(["家"]);
    // 再连上、断开并连已导入的一起删：起了名的一起删
    await pushTo(k, PHONE_LOCATION_SOURCE, { state: "granted", link: true, background: false, points: [] });
    await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(places()).toEqual([]);
    expect(fs.existsSync(path.join(k.dir, "phone", "places.json"))).toBe(false);
    // 移除并连数据删：phone/ 整个删掉，起了名的也在里面
    await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "家", lat: "30.28", lon: "120.1" }, idempotencyKey: key() });
    expect(fs.existsSync(path.join(k.dir, "phone", "places.json"))).toBe(true);
    await k.settings.act("phone", { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(fs.existsSync(path.join(k.dir, "phone"))).toBe(false);
  });
});
