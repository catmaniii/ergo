// 数据源详情里看数据：已获取的（stored）、现在能查到的（live）在假内核里（startPluginKernel：真的插件宿主、数据源那一层、素材库），
// 上游全是假的（假 fetch 的日历、本机假 IMAP、本机假 Looki），不连外网：
// - 内核的规矩：不进素材的由数据源自己列（插件没在运行写明）、进素材的按素材的出处列（点开跳素材详情，插件停了也列得出）、都没有的回不能看；
//   现查：插件没在运行、没连上、出错的不叫上游，写明；出错的原因里密钥换成 ***；不能现查的回不能现查；
// - 真插件：Google · 日历、Gmail、Looki 各走一遍现查（断言没有新事件、没有新素材；Gmail 只取信头、点开才取正文、不标已读、没有写操作，
//   财务、健康的按 gmail-sensitive.ts 的规则标小签；上游出错时有原因）；Google · 联系人、手机通讯录、手机日历列已获取的，手机来的没有现查。
// 主切面（真的 HTTP、素材按数据源过滤）在 test/main/data-sources.test.ts。
import { PHONE_CALENDAR_SOURCE, PHONE_CONTACTS_SOURCE, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { DataSource } from "../../src/data-sources/api.ts";
import { createGooglePlugin } from "../../src/google/plugin.ts";
import { LOOKI_SOURCE_ID } from "../../src/looki/api.ts";
import { createLookiPlugin } from "../../src/looki/plugin.ts";
import { phonePlugin } from "../../src/phone/plugin.ts";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { FAKE_BILLS_ID, FAKE_CHANNEL, FAKE_KEY, FAKE_SOURCE_ID, FAKE_SOURCE_PLUGIN, fakeDataSourcePlugin, fakeRemote, resetFakeRemote } from "../helpers/fake-data-source.ts";
import { fakeCalendarFetch, googleAddress, icsOf, myCalendar, PRIVATE_TOKEN } from "../helpers/fake-ical.ts";
import { type FakeImapServer, startFakeImapServer } from "../helpers/fake-imap.ts";
import { fakeMoment, LOOKI_TEST_KEY, startFakeLooki } from "../helpers/fake-looki.ts";
import { APP_PASSWORD, mail, ME, ticketMail, word } from "../helpers/fake-mail.ts";
import { fakePersonalFiles } from "../helpers/fake-personal-files.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { waitUntil } from "../helpers/process.ts";

let seq = 0;
const key = () => `browse-${++seq}`;
/** 查之前记下事件、素材的数量，查完断言一条没多 */
function untouched(k: PluginKernel) {
  const events = k.store.lastGlobalSeq();
  const materials = k.materials.list().length;
  return () => {
    expect(k.store.lastGlobalSeq()).toBe(events);
    expect(k.materials.list().length).toBe(materials);
  };
}
const sourceOf = (k: PluginKernel, id: string) => k.dataSources.view().sources.find((s) => s.id === id)!;
const disable = (k: PluginKernel, plugin: string) => k.settings.act(plugin, { action: "disable", idempotencyKey: key() });

afterEach(() => resetFakeRemote());

describe("内核的规矩", () => {
  /** 会自己列、会现查的假数据源（secrets 里的 Key 会出现在上游的出错原因里） */
  const browsable = (live: DataSource["live"], stored?: DataSource["stored"]): PluginDefinition => ({
    name: "browsable",
    title: "可看的",
    contracts: (ctx) =>
      ctx.dataSources.register({
        id: "browsable",
        title: "可看的",
        usages: { import: { default: true } },
        files: [{ title: "x", extensions: [".x"], import: () => Promise.resolve({ added: 0 }) }],
        status: (c) => (c.secrets.has("key") ? { connection: "connected" } : { connection: "not_connected" }),
        configure: (values, c) => {
          c.secrets.set("key", values.key!);
          return Promise.resolve({ connection: "connected" });
        },
        ...(live ? { live } : {}),
        ...(stored ? { stored } : {}),
      }),
    setup() {},
  });
  const connect = (k: PluginKernel, id = "browsable") => k.dataSources.act(id, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: key() });

  it("页面上写明有哪两个标签：会列或者进素材的有已获取的，会现查的有现在能查到的", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin, browsable(() => Promise.resolve({ items: [] }), () => ({ total: 0, items: [] }))] });
    expect(sourceOf(k, "browsable")).toMatchObject({ hasStored: true, hasLive: true });
    const fake = sourceOf(k, FAKE_SOURCE_ID);
    expect(fake.hasStored).toBe(true);
    expect(fake.hasLive).toBeUndefined();
  });

  it("不进素材的由数据源自己列（要哪一页交给它）；插件没在运行写明，列不出来写原因（Key 换掉）；不认得的回 not_found", async () => {
    const asked: Array<{ offset: number; limit: number }> = [];
    let broken = false;
    const k = await startPluginKernel({
      plugins: [
        browsable(undefined, (query, c) => {
          asked.push(query);
          if (broken) throw new Error(`读不出来 ${c.secrets.get("key")}`);
          return { total: 42, items: [{ id: "a", title: "一条" }] };
        }),
      ],
    });
    expect(k.dataSources.stored("browsable", { offset: 30, limit: 10 })).toEqual({ total: 42, items: [{ id: "a", title: "一条" }] });
    expect(k.dataSources.stored("browsable", {}).total).toBe(42);
    expect(asked).toEqual([
      { offset: 30, limit: 10 },
      { offset: 0, limit: 30 },
    ]);
    expect(() => k.dataSources.stored("没有这个", {})).toThrow(/没有数据源/);
    await connect(k);
    broken = true;
    expect(k.dataSources.stored("browsable", {})).toEqual({ total: 0, items: [], problem: "读不出来 ***" });
    expect(k.logs.some((l) => l.includes(FAKE_KEY))).toBe(false);
    await disable(k, "browsable");
    expect(k.dataSources.stored("browsable", {})).toEqual({ total: 0, items: [], problem: "可看的插件没启用" });
  });

  it("进素材的按素材的出处列（新的在前、分页、点开跳素材详情，别的数据源的不混进来）；插件停了也列得出；都没有的回不能看", async () => {
    const k = await startPluginKernel({ plugins: [fakeDataSourcePlugin, browsable(undefined)] });
    await connect(k, FAKE_SOURCE_ID);
    fakeRemote.next = [
      { text: "早上跑了 5 公里", at: "2026-10-23T07:00:00.000+08:00" },
      { text: "下午在公司开会", at: "2026-10-24T14:00:00.000+08:00" },
      { text: "晚上看书", at: "2026-10-22T21:00:00.000+08:00" },
    ];
    await k.dataSources.act(FAKE_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    k.store.append({ channel: FAKE_CHANNEL, type: "fake_bill", payload: { id: "b-1", text: "午饭 30", at: "2026-10-24T12:00:00.000+08:00", from: "bills.csv" } });
    await waitUntil(() => k.materials.list().filter((m) => m.origin !== undefined).length === 4, { timeoutMs: 10_000, describe: () => `素材 ${k.materials.list().length}` });

    const page = k.dataSources.stored(FAKE_SOURCE_ID, {});
    expect(page.total).toBe(3);
    expect(page.items.map((i) => i.title)).toEqual(["下午在公司开会", "早上跑了 5 公里", "晚上看书"]);
    expect(page.items[0]).toMatchObject({ time: "2026-10-24T14:00:00.000+08:00", materialId: page.items[0]!.id, subtitle: expect.any(String) });
    expect(k.dataSources.stored(FAKE_SOURCE_ID, { offset: 2, limit: 1 }).items.map((i) => i.title)).toEqual(["晚上看书"]);
    expect(k.dataSources.stored(FAKE_BILLS_ID, {}).items.map((i) => i.title)).toEqual(["午饭 30"]);

    await disable(k, FAKE_SOURCE_PLUGIN);
    expect(k.dataSources.stored(FAKE_SOURCE_ID, {}).total).toBe(3);
    // 不进素材、自己也不会列的
    expect(sourceOf(k, "browsable").hasStored).toBeUndefined();
    expect(() => k.dataSources.stored("browsable", {})).toThrow("可看的没有已获取的可看");
  });

  it("现查：没连上、插件没在运行不叫上游，写明；查不到写原因（密钥换成 ***，不进事件）；不能现查的回不能现查；开关管不着", async () => {
    let calls = 0;
    const k = await startPluginKernel({
      plugins: [
        fakeDataSourcePlugin,
        browsable((query, c) => {
          calls += 1;
          if (query.open === "boom") throw new Error(`上游不认 ${c.secrets.get("key")}`);
          return Promise.resolve({ scope: "最近的", total: 9, notes: [`有一个没拉到（${c.secrets.get("key")}）`], items: [{ id: "x", title: "现查到的" }] });
        }),
      ],
    });
    expect(await k.dataSources.live("browsable", {})).toMatchObject({ state: "not_connected", items: [], problem: "可看的还没连上" });
    expect(calls).toBe(0);
    await connect(k);
    const check = untouched(k);
    const found = await k.dataSources.live("browsable", {});
    expect(found).toMatchObject({ state: "ok", scope: "最近的", total: 9, items: [{ id: "x", title: "现查到的" }] });
    expect(found.notes).toEqual(["有一个没拉到（***）"]);
    const failed = await k.dataSources.live("browsable", { open: "boom" });
    expect(failed).toMatchObject({ state: "error", items: [], problem: "上游不认 ***" });
    expect(k.logs.some((l) => l.includes(FAKE_KEY))).toBe(false);
    check();
    await disable(k, "browsable");
    const off = await k.dataSources.live("browsable", {});
    expect(off).toMatchObject({ state: "plugin_off", problem: "可看的插件没启用" });
    expect(calls).toBe(2);
    await expect(k.dataSources.live(FAKE_SOURCE_ID, {})).rejects.toThrow("假数据源不能现查");
    await expect(k.dataSources.live("没有这个", {})).rejects.toThrow(/没有数据源/);
  });
});

describe("Google · 日历", () => {
  const MINE = googleAddress("calendar-test@example.com");
  const OTHER = googleAddress("other-test@example.com", "private-fedcba9876543210fedcba9876543210");
  async function start() {
    const remote = fakeCalendarFetch();
    remote.routes.set(MINE, { status: 200, body: myCalendar({ name: "我的" }) });
    const k = await startPluginKernel({
      plugins: [createGooglePlugin({ fetch: remote.fetch })],
      at: new Date("2026-10-24T09:00:00+08:00"),
      services: [extraService(KERNEL.personalFiles, () => fakePersonalFiles().service)],
    });
    return { k, remote };
  }
  const SOURCE = "google-calendar";
  const add = (k: PluginKernel, address: string) => k.dataSources.act(SOURCE, { action: "configure", values: { add: address }, idempotencyKey: key() });

  it("已获取的：同步来的事件（新的在前，重复的标出来，说明带着），分页；现在能查到的：现拉未来的日程，一条事件都不写", async () => {
    const { k, remote } = await start();
    expect(sourceOf(k, SOURCE)).toMatchObject({ hasStored: true, hasLive: true });
    expect(await k.dataSources.live(SOURCE, {})).toMatchObject({ state: "not_connected" });
    await add(k, MINE);
    const page = k.dataSources.stored(SOURCE, { limit: 3 });
    expect(page.total).toBe(6);
    expect(page.items.map((i) => i.title)).toEqual(["站会（改到下午）", "出差", "看牙"]);
    expect(page.items.find((i) => i.title === "看牙")).toMatchObject({ body: "带上医保卡", subtitle: "我的" });
    expect(page.items.find((i) => i.title === "出差")).toMatchObject({ allDay: true });
    expect(k.dataSources.stored(SOURCE, { offset: 3, limit: 3 }).items.map((i) => i.labels)).toContainEqual(["重复"]);

    // 上游多了一条：现查看得到、同步来的还没有，也没写进去
    remote.routes.set(MINE, { status: 200, body: myCalendar({ name: "我的", extra: [["UID:new@google.com", "DTSTART;TZID=Asia/Singapore:20261030T100000", "DTEND;TZID=Asia/Singapore:20261030T110000", "SUMMARY:刚加的会", "LOCATION:三楼"]] }) });
    const check = untouched(k);
    const fetched = remote.fetched.length;
    const live = await k.dataSources.live(SOURCE, {});
    expect(remote.fetched.length).toBe(fetched + 1);
    expect(live.state).toBe("ok");
    expect(live.scope).toBe("未来 30 天的日程");
    const titles = live.items.map((i) => i.title);
    expect(titles).toContain("刚加的会");
    expect(live.items.find((i) => i.title === "刚加的会")).toMatchObject({ subtitle: "我的 · 三楼", time: expect.stringMatching(/^2026-10-30T/), end: expect.stringMatching(/^2026-10-30T/) });
    expect(live.items.map((i) => i.time)).toEqual(live.items.map((i) => i.time).toSorted((a, b) => Date.parse(a!) - Date.parse(b!)));
    expect(k.dataSources.stored(SOURCE, { limit: 100 }).items.map((i) => i.title)).not.toContain("刚加的会");
    check();
  });

  it("上游出错：一个都没拉到写原因，私密地址不出现；几个里有一个没拉到的，拉到的照列、写明哪个没拉到，同步来的不混进来", async () => {
    const { k, remote } = await start();
    await add(k, MINE);
    remote.routes.set(OTHER, { status: 200, body: icsOf({ name: "家里", events: [["UID:family@google.com", "DTSTART;TZID=Asia/Singapore:20261026T190000", "SUMMARY:家庭聚餐"]] }) });
    await add(k, OTHER);

    remote.routes.set(MINE, { status: 404, body: "gone" });
    const check = untouched(k);
    const partly = await k.dataSources.live(SOURCE, {});
    expect(partly.state).toBe("ok");
    expect(partly.items.map((i) => i.title)).toEqual(["家庭聚餐"]);
    expect(partly.notes).toHaveLength(1);
    expect(partly.notes![0]).toContain("我的");

    remote.routes.set(OTHER, { status: 500, body: "boom" });
    const none = await k.dataSources.live(SOURCE, {});
    expect(none).toMatchObject({ state: "error", items: [] });
    expect(none.problem).toContain("我的");
    expect(JSON.stringify(none)).not.toContain(PRIVATE_TOKEN);
    check();
  });
});

describe("Google · Gmail", () => {
  const SOURCE = "google-gmail";
  let server: FakeImapServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  async function start() {
    server = await startFakeImapServer({ user: ME, password: APP_PASSWORD.replace(/\s+/g, "") });
    const k = await startPluginKernel({
      plugins: [createGooglePlugin({ imap: server.endpoint, imapTimeoutMs: 5_000 })],
      at: new Date("2026-10-25T09:00:00+08:00"),
      services: [extraService(KERNEL.personalFiles, () => fakePersonalFiles().service)],
    });
    return { k, imap: server };
  }
  const connect = (k: PluginKernel) => k.dataSources.act(SOURCE, { action: "configure", values: { address: ME, password: APP_PASSWORD }, idempotencyKey: key() });
  const invoice = () =>
    mail(
      [
        ["From", `${word("财务")} <billing@example.com>`],
        ["To", ME],
        ["Subject", word("十月的发票")],
        ["Date", "Sun, 25 Oct 2026 08:00:00 +0800"],
        ["Message-ID", "<invoice-1@example.com>"],
      ],
      "See the attached file.",
    );

  it("列表只有发件人、主题、时间（只取信头）；点开才取正文和附件；不标已读、没有写操作、没有新事件和素材；财务的按规则标小签", async () => {
    const { k, imap } = await start();
    await connect(k);
    expect(sourceOf(k, SOURCE)).toMatchObject({ hasLive: true, hasStored: true, toMaterials: true });
    const ticket = imap.add(ticketMail(), ["INBOX", "all"]);
    imap.add(invoice(), ["INBOX", "all"]);
    const check = untouched(k);

    const list = await k.dataSources.live(SOURCE, {});
    expect(list.state).toBe("ok");
    expect(list.total).toBe(2);
    expect(list.items.map((i) => i.title)).toEqual(["十月的发票", "机票行程单：10 月 30 日 北京-上海"]);
    expect(list.items[0]).toMatchObject({ subtitle: "财务 <billing@example.com>", openable: true, labels: ["财务"], time: expect.stringMatching(/^2026-10-25T08:00/) });
    expect(list.items[1]!.labels).toBeUndefined();
    for (const item of list.items) expect(item.body).toBeUndefined();
    // 只取了信头：正文没下来过（假服务记下了 BODY.PEEK[] 就是取正文）
    const opened = await k.dataSources.live(SOURCE, { open: list.items[1]!.id });
    expect(opened.state).toBe("ok");
    expect(opened.items).toHaveLength(1);
    expect(opened.items[0]!.body).toContain("尊敬的旅客");
    expect(opened.items[0]!.body).toContain("行程单.pdf");
    expect(opened.items[0]!.subtitle).toContain("noreply@air.example.com");
    expect(imap.writes).toEqual([]);
    expect(imap.flags("all", ticket.all!)).toEqual([]);
    await waitUntil(() => imap.active === 0, { timeoutMs: 5_000, describe: () => `还开着 ${imap.active} 个连接` });
    check();
  });

  it("没连上写明；登录不再通过：写原因、小签要授权、密码不出现；编号不对写原因", async () => {
    const { k, imap } = await start();
    expect(await k.dataSources.live(SOURCE, {})).toMatchObject({ state: "not_connected", problem: "Google · Gmail还没连上" });
    await connect(k);
    expect((await k.dataSources.live(SOURCE, { open: "不是编号" })).problem).toContain("邮件编号不对");
    const check = untouched(k);
    imap.alert = "Application-specific password required: https://support.google.com/accounts/answer/185833";
    const failed = await k.dataSources.live(SOURCE, {});
    expect(failed.state).toBe("error");
    expect(failed.problem).toContain("应用专用密码");
    expect(JSON.stringify(failed)).not.toContain(APP_PASSWORD.replace(/\s+/g, ""));
    expect(sourceOf(k, SOURCE)).toMatchObject({ connection: "error", needsAuth: true });
    // 记着出错的：不再去连上游，写原因
    const connections = imap.connections;
    expect(await k.dataSources.live(SOURCE, {})).toMatchObject({ state: "error", problem: failed.problem });
    expect(imap.connections).toBe(connections);
    check();
  });
});

describe("Looki", () => {
  const AT = new Date("2026-10-25T10:00:00+08:00");
  async function start() {
    const fake = await startFakeLooki();
    const abroad = await startFakeLooki();
    const plugin = createLookiPlugin({ endpoints: { cn: fake.base, global: abroad.base }, rateLimitWaitMs: 10, archive: { defaultFolder: makeTempDir("ergo-looki-browse-") } });
    const k = await startPluginKernel({ plugins: [plugin], at: AT, services: [extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir))] });
    return { fake, k };
  }
  const connect = (k: PluginKernel) => k.dataSources.act(LOOKI_SOURCE_ID, { action: "configure", values: { region: "cn", key: LOOKI_TEST_KEY }, idempotencyKey: key() });

  it("现查最近几天的时刻（含今天，新的在前），描述点开看，一条事件、素材都不写；已获取的按素材的出处列", async () => {
    const { fake, k } = await start();
    expect(await k.dataSources.live(LOOKI_SOURCE_ID, {})).toMatchObject({ state: "not_connected" });
    await connect(k);
    fake.moments.set("2026-10-25", [fakeMoment({ id: "m-today", date: "2026-10-25", start: "08:00", end: "08:30", title: "吃早饭", description: "楼下的包子铺", media: ["IMAGE"] })]);
    fake.moments.set("2026-10-24", [fakeMoment({ id: "m-1", date: "2026-10-24", start: "14:00", end: "16:30", title: "在望京开会", description: "讨论下季度计划", location: "望京 SOHO" })]);
    fake.moments.set("2026-10-20", [fakeMoment({ id: "m-old", date: "2026-10-20", start: "12:00", end: "12:50", title: "太早的", description: "不在最近三天里" })]);
    const check = untouched(k);
    const live = await k.dataSources.live(LOOKI_SOURCE_ID, {});
    expect(live.state).toBe("ok");
    expect(live.scope).toBe("最近 3 天的时刻（含今天）");
    expect(live.items.map((i) => i.title)).toEqual(["吃早饭", "在望京开会"]);
    expect(live.items[0]).toMatchObject({ id: "m-today", body: "楼下的包子铺", labels: ["照片"] });
    expect(live.items[1]).toMatchObject({ subtitle: "望京 SOHO" });
    check();

    await k.dataSources.act(LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    await waitUntil(() => k.dataSources.stored(LOOKI_SOURCE_ID, {}).total === 2, { timeoutMs: 10_000, describe: () => `已获取 ${k.dataSources.stored(LOOKI_SOURCE_ID, {}).total}` });
    const stored = k.dataSources.stored(LOOKI_SOURCE_ID, {});
    expect(stored.items[0]!.materialId).toBe(stored.items[0]!.id);
  });

  it("上游出错写原因；限速写过一会儿再查；Key 不认的小签要授权；Key 不出现", async () => {
    const { fake, k } = await start();
    await connect(k);
    const check = untouched(k);
    fake.mode = "down";
    const down = await k.dataSources.live(LOOKI_SOURCE_ID, {});
    expect(down).toMatchObject({ state: "error", items: [] });
    expect(down.problem).toContain("500");
    fake.mode = "rate_limited";
    expect((await k.dataSources.live(LOOKI_SOURCE_ID, {})).problem).toMatch(/限速|一分钟/);
    fake.rateLimitNext = 0;
    fake.mode = "ok";
    await new Promise((resolve) => setTimeout(resolve, 0));
    check();
    expect(JSON.stringify(k.logs)).not.toContain(LOOKI_TEST_KEY);
  });
});

describe("手机和 Google · 联系人：不进素材的也能列，没有现查", () => {
  async function phone() {
    const k = await startPluginKernel({
      plugins: [phonePlugin],
      at: new Date("2026-10-25T09:00:00+08:00"),
      services: [extraService(KERNEL.personalFiles, () => fakePersonalFiles().service), extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir))],
    });
    return k;
  }
  const push = (k: PluginKernel, id: string, data: unknown) => k.dataSources.push(id, { data, idempotencyKey: key() });

  it("手机来的四个都没有现在能查到的（数据由手机交来）；通讯录、日历自己列，照片、位置按素材列；断开的授权写要授权", async () => {
    const k = await phone();
    for (const id of [PHONE_CONTACTS_SOURCE, PHONE_CALENDAR_SOURCE, PHONE_PHOTOS_SOURCE, PHONE_LOCATION_SOURCE]) {
      expect(sourceOf(k, id).hasLive).toBeUndefined();
      expect(sourceOf(k, id).hasStored).toBe(true);
      expect(sourceOf(k, id).fromDevice).toBe(true);
      await expect(k.dataSources.live(id, {})).rejects.toThrow("不能现查");
    }
    await push(k, PHONE_CONTACTS_SOURCE, { device: "Pura 90", contacts: [{ name: "王小明", phones: ["138 0000 1111"], addresses: [] }] });
    await push(k, PHONE_CONTACTS_SOURCE, { device: "Pura 90", contacts: [{ name: "妈妈", phones: ["139 2222 3333"], birthday: "--03-02", addresses: ["杭州市西湖区"] }] });
    const contacts = k.dataSources.stored(PHONE_CONTACTS_SOURCE, {});
    expect(contacts.total).toBe(2);
    expect(contacts.items.map((i) => [i.title, i.subtitle])).toEqual([
      ["妈妈", "13922223333 · 03-02 · 杭州市西湖区"],
      ["王小明", "13800001111"],
    ]);
    expect(contacts.items[0]!.materialId).toBeUndefined();

    const at = (day: number, hh: number) => new Date(2026, 9, day, hh).toISOString();
    const window = { from: new Date(2026, 8, 1).toISOString(), to: new Date(2027, 4, 1).toISOString() };
    await push(k, PHONE_CALENDAR_SOURCE, {
      device: "Pura 90",
      state: "granted",
      link: true,
      ...window,
      events: [
        { key: "a", title: "看牙医", start: at(10, 9), end: at(10, 10), allDay: false, calendar: "我的日历", location: "牙科诊所" },
        { key: "b", title: "放假", start: at(12, 0), allDay: true },
      ],
    });
    const calendar = k.dataSources.stored(PHONE_CALENDAR_SOURCE, { limit: 1 });
    expect(calendar.total).toBe(2);
    expect(calendar.items).toEqual([{ id: "b", title: "放假", time: at(12, 0), allDay: true }]);
    expect(k.dataSources.stored(PHONE_CALENDAR_SOURCE, { offset: 1 }).items[0]).toMatchObject({ title: "看牙医", subtitle: "我的日历 · 牙科诊所", end: at(10, 10) });

    // 授权被撤回：要授权；读不了不算
    await push(k, PHONE_CALENDAR_SOURCE, { state: "revoked", reason: "系统设置里关了" });
    expect(sourceOf(k, PHONE_CALENDAR_SOURCE)).toMatchObject({ connection: "error", needsAuth: true });
    await push(k, PHONE_CALENDAR_SOURCE, { state: "unavailable" });
    expect(sourceOf(k, PHONE_CALENDAR_SOURCE).needsAuth).toBeUndefined();

    await disable(k, "phone");
    expect(k.dataSources.stored(PHONE_CONTACTS_SOURCE, {})).toMatchObject({ total: 0, problem: "数据源-手机插件没启用" });
  });

  it("Google · 联系人：只靠导入文件夹、不进素材，列导入的人（同一个人导几次算一条）；没有现查", async () => {
    const k = await startPluginKernel({ plugins: [createGooglePlugin({ fetch: fakeCalendarFetch().fetch })], services: [extraService(KERNEL.personalFiles, () => fakePersonalFiles().service)] });
    const SOURCE = "google-contacts";
    expect(sourceOf(k, SOURCE)).toMatchObject({ hasStored: true, connection: "manual" });
    expect(sourceOf(k, SOURCE).hasLive).toBeUndefined();
    const contact = (id: string, name: string, value: string, at: string) => ({ channel: "google", type: "google_contact", payload: { id, at, file: "contacts.vcf", key: name, name, aliases: [], relation: name === "妈妈" ? "母亲" : undefined, fields: [{ field: "phone", value }] } });
    k.store.append(contact("c1", "妈妈", "13922223333", "2026-10-20T09:00:00.000+08:00"));
    k.store.append(contact("c2", "老王", "13800001111", "2026-10-20T09:00:00.000+08:00"));
    k.store.append(contact("c3", "妈妈", "13911112222", "2026-10-24T09:00:00.000+08:00"));
    const page = k.dataSources.stored(SOURCE, {});
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({ title: "老王", subtitle: "13800001111" });
    expect(page.items[1]).toMatchObject({ title: "妈妈", subtitle: "母亲 · 13922223333 · 13911112222", time: "2026-10-24T09:00:00.000+08:00" });
  });
});
