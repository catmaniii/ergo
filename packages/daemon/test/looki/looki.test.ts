// Looki 插件（296 号票）在假内核里（startPluginKernel：真的插件宿主、数据源那一层、设置 · 插件那一层），接口地址指向本机的假 Looki
// （helpers/fake-looki.ts，照官方文档的返回格式；不连真的 Looki、不联网）。查：
// - 设置 · 数据源里的样子：名字、两种用法默认开着、每天 02:30 定期导入、敏感类别（位置、情绪、健康）、能填设置；
// - 填设置、测试连接：区域不对、没填 Key、Key 只发给所选区域的地址（直接调 /me 一步判断）、Key 不认、填对了（账号打码带区域）；
//   连着时再测一次沿用存着的 Key；
//   新填的不对还在用原来的（连着、写原因）；
// - 同步：拉到昨天为止（第一次 7 天，以后从上次同步那天往前两天），时刻和日记各成一条记录（字段整理好、照片链接不存），按 id 去重；
// - 限速：同步时等一会儿再试、等的时候状态写明；一直限速时同步出错、状态写明，按需查不等直接回"过一分钟再查"；
// - Key 失效：同步出错（原因写明）、状态是出错（要重新填）、不能同步；重新填好恢复；
// - 按需查：按日期加时间段、按关键词、几天、参数不对、没连、一整天时顺带日记；结果里没有照片链接、没有 Key；
// - 断开（留着已导入的）、插件停用、移除并连数据删（记录、密钥区里的 Key）。
import fs from "node:fs";
import path from "node:path";
import { isDeletedEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_MOMENT, LOOKI_PLUGIN, LOOKI_QUERY_TOOL, LOOKI_SOURCE_ID, type LookiJournalPayload, type LookiMomentPayload } from "../../src/looki/api.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createLookiPlugin } from "../../src/looki/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { SECRETARY_TARGET } from "../../src/secretary/secretary.ts";
import { type FakeLooki, fakeMoment, fakePhoto, LOOKI_TEST_KEY, startFakeLooki } from "../helpers/fake-looki.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 假内核的"现在"：2026-10-25（周日）上午 */
const AT = new Date("2026-10-25T10:00:00+08:00");

let seq = 0;
const key = () => `lk-${++seq}`;

/** 两个区域各一个假 Looki：中国区的是 fake，海外的是 abroad */
async function setup() {
  const fake = await startFakeLooki();
  const abroad = await startFakeLooki();
  // 存一份到本地（307 号票）的默认位置换成临时目录：测试不往真的用户目录里写
  const home = path.join(makeTempDir("ergo-looki-home-"), "Looki");
  const plugin = createLookiPlugin({ endpoints: { cn: fake.base, global: abroad.base }, rateLimitWaitMs: 10, archive: { defaultFolder: home } });
  const k = await startPluginKernel({ plugins: [plugin], at: AT, services: [extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir))] });
  return { fake, abroad, k, home };
}

const looki = (k: PluginKernel) => k.dataSources.view().sources.find((s) => s.id === LOOKI_SOURCE_ID)!;
const configure = (k: PluginKernel, values: Record<string, string>) => k.dataSources.act(LOOKI_SOURCE_ID, { action: "configure", values, idempotencyKey: key() });
const sync = (k: PluginKernel) => k.dataSources.act(LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
const moments = (k: PluginKernel) => k.store.read(LOOKI_CHANNEL, 0, LOOKI_MOMENT).filter((e) => !isDeletedEventPayload(e.payload)).map((e) => e.payload as LookiMomentPayload);
const journals = (k: PluginKernel) => k.store.read(LOOKI_CHANNEL, 0, LOOKI_JOURNAL).filter((e) => !isDeletedEventPayload(e.payload)).map((e) => e.payload as LookiJournalPayload);
const secretFile = (k: PluginKernel) => path.join(k.layout.dataSourceSecrets, `${LOOKI_SOURCE_ID}.json`);
const tool = (k: PluginKernel) => k.agent.toolsFor(SECRETARY_TARGET).find((t) => t.spec.name === LOOKI_QUERY_TOOL);
const ask = async (k: PluginKernel, args: Record<string, unknown>) => tool(k)!.run(args as never, { toolCallId: `c-${++seq}` });
/** 等存一份到本地（在后台排队做的）做完：那一块上没有"正在存" */
async function waitArchived(k: PluginKernel) {
  for (let i = 0; i < 400; i += 1) {
    const panel = looki(k).panel as { working?: unknown } | undefined;
    if (panel && panel.working === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("存一份到本地一直没做完");
}
const daysAsked = (fake: FakeLooki) => fake.keyed().filter((r) => r.path === "/api/v1/moments").map((r) => r.query.on_date);

function script(fake: FakeLooki) {
  fake.moments.set("2026-10-24", [
    fakeMoment({ id: "m-1", date: "2026-10-24", start: "14:00", end: "16:30", title: "在望京开会", description: "和同事讨论下季度计划", location: "望京 SOHO", media: ["IMAGE", "VIDEO"] }),
    fakeMoment({ id: "m-2", date: "2026-10-24", start: "19:10", end: "19:40", title: "散步回家", description: "沿着河边走回家" }),
  ]);
  fake.moments.set("2026-10-20", [fakeMoment({ id: "m-0", date: "2026-10-20", start: "12:00", end: "12:50", title: "吃火锅", description: "中午和朋友吃火锅", location: "海底捞（望京店）" })]);
  // 今天的：同步不拉
  fake.moments.set("2026-10-25", [fakeMoment({ id: "m-today", date: "2026-10-25", start: "08:00", end: "08:30", title: "吃早饭", description: "楼下的包子铺" })]);
  fake.journals.push({ id: "j-1", type: "DIARY", title: "忙碌又平静的周六", description: "下午开会，晚上散步", content: "今天下午开了个长会，有点累；晚上散步，心情放松了。", recorded_at: "2026-10-24T22:00:00+08:00" });
}

describe("设置 · 数据源里的 Looki", () => {
  it("没连、两种用法默认开着、每天 02:30 定期导入、敏感类别、能填设置", async () => {
    const { k } = await setup();
    expect(looki(k)).toMatchObject({
      title: "Looki",
      summary: expect.stringContaining("时刻"),
      plugin: LOOKI_PLUGIN,
      connection: "not_connected",
      usages: [
        { usage: "query", on: true },
        { usage: "import", on: true },
      ],
      sensitive: [
        { id: "location", title: "位置", inferable: false },
        { id: "emotion", title: "情绪", inferable: false },
        { id: "health", title: "健康", inferable: false },
      ],
      count: 0,
      canSync: false,
      schedule: expect.stringContaining("02:30"),
      files: [],
      configurable: true,
    });
    // 306：按需查开着也要连上才给秘书"查 Looki"
    expect(tool(k)).toBeUndefined();
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    expect(tool(k)?.descriptor).toMatchObject({ title: "查 Looki", readOnlyOrIdempotent: true, nature: "look" });
  });
});

describe("填设置、测试连接", () => {
  it("区域不对、没填 Key、Key 里有空格：不连接口就回出错", async () => {
    const { fake, k } = await setup();
    await configure(k, { key: LOOKI_TEST_KEY, region: "moon" });
    expect(looki(k)).toMatchObject({ connection: "error", problem: "区域只能选中国区或海外" });
    await configure(k, { key: "  ", region: "cn" });
    expect(looki(k).problem).toContain("先填 API Key");
    await configure(k, { key: "lk-abc def", region: "cn" });
    expect(looki(k).problem).toContain("空格");
    expect(fake.requests).toEqual([]);
  });

  it("Key 只发给所选区域的地址：直接拿 Key 调那个区域的 /me（不先去别处做不带 Key 的检查）", async () => {
    const { fake, abroad, k } = await setup();
    await configure(k, { key: LOOKI_TEST_KEY, region: "global" });
    expect(looki(k)).toMatchObject({ connection: "connected", account: "d***@example.com（海外）" });
    expect(abroad.requests).toEqual([{ path: "/api/v1/me", query: {}, key: LOOKI_TEST_KEY }]);
    expect(fake.requests).toEqual([]);
    await configure(k, { region: "cn" });
    expect(fake.requests).toEqual([{ path: "/api/v1/me", query: {}, key: LOOKI_TEST_KEY }]);
    expect(abroad.requests).toHaveLength(1);
    expect(looki(k).account).toBe("d***@example.com（中国区）");
  });

  it("Key 不认：出错写明；填对：连着、账号打码带区域，Key、区域、账号进密钥区", async () => {
    const { fake, k } = await setup();
    await configure(k, { key: "lk-wrong-key-000000", region: "cn" });
    expect(looki(k)).toMatchObject({ connection: "error", problem: expect.stringContaining("Looki 不认这个 Key") });
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    expect(looki(k)).toMatchObject({ connection: "connected", account: "d***@example.com（中国区）", canSync: true });
    expect(looki(k).problem).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(secretFile(k), "utf8"))).toEqual({ format: 1, values: { key: LOOKI_TEST_KEY, region: "cn", account: "d***@example.com" } });
    // Key 只发给认得的地址、只在请求头里
    expect(fake.keyed().every((r) => r.path === "/api/v1/me" && !JSON.stringify(r.query).includes("lk-"))).toBe(true);
    expect(k.logs.some((line) => line.includes(LOOKI_TEST_KEY))).toBe(false);
  });

  it("连着时：不填 Key 再测一次沿用存着的；换区域照样沿用；新填的不对还在用原来的（连着、写原因）", async () => {
    const { fake, k } = await setup();
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    await configure(k, {});
    expect(looki(k)).toMatchObject({ connection: "connected", account: "d***@example.com（中国区）" });
    expect(fake.keyed().at(-1)).toMatchObject({ path: "/api/v1/me", key: LOOKI_TEST_KEY });
    await configure(k, { key: "", region: "global" });
    expect(looki(k)).toMatchObject({ connection: "connected", account: "d***@example.com（海外）" });
    await configure(k, { key: "lk-typo-0000000000" });
    expect(looki(k)).toMatchObject({ connection: "connected", problem: expect.stringMatching(/新填的没通过.*还在用原来的 Key/) });
    expect(JSON.parse(fs.readFileSync(secretFile(k), "utf8")).values.key).toBe(LOOKI_TEST_KEY);
    // 再填对：原因清掉
    await configure(k, { key: LOOKI_TEST_KEY });
    expect(looki(k).problem).toBeUndefined();
  });
});

describe("同步", () => {
  it("第一次拉最近 7 天到昨天为止：时刻、日记各成一条记录（字段整理好、照片链接不存）；再同步从上次那天往前两天拉起、不重复", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    const first = await sync(k);
    expect(first).toMatchObject({ added: 4 });
    expect(daysAsked(fake)).toEqual(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
    expect(fake.keyed().find((r) => r.path === "/api/v1/journals")?.query).toEqual({ cursor_date: "2026-10-24", max_days: "7", sort_order: "desc" });
    expect(moments(k)).toEqual([
      { momentId: "m-0", date: "2026-10-20", start: "2026-10-20T12:00:00.000+08:00", end: "2026-10-20T12:50:00.000+08:00", title: "吃火锅", description: "中午和朋友吃火锅", place: "海底捞（望京店）", media: ["photo"], text: "吃火锅\n中午和朋友吃火锅" },
      { momentId: "m-1", date: "2026-10-24", start: "2026-10-24T14:00:00.000+08:00", end: "2026-10-24T16:30:00.000+08:00", title: "在望京开会", description: "和同事讨论下季度计划", place: "望京 SOHO", media: ["photo", "video"], text: "在望京开会\n和同事讨论下季度计划" },
      { momentId: "m-2", date: "2026-10-24", start: "2026-10-24T19:10:00.000+08:00", end: "2026-10-24T19:40:00.000+08:00", title: "散步回家", description: "沿着河边走回家", media: ["photo"], text: "散步回家\n沿着河边走回家" },
    ]);
    expect(journals(k)).toEqual([
      {
        journalId: "j-1",
        date: "2026-10-24",
        time: "2026-10-24T22:00:00.000+08:00",
        kind: "DIARY",
        title: "忙碌又平静的周六",
        summary: "下午开会，晚上散步",
        content: "今天下午开了个长会，有点累；晚上散步，心情放松了。",
        text: "Looki · 忙碌又平静的周六\n下午开会，晚上散步",
      },
    ]);
    expect(JSON.stringify(k.store.read(LOOKI_CHANNEL))).not.toMatch(/temporary_url|X-Amz-Signature|cover_file/);
    expect(looki(k)).toMatchObject({ count: 4, lastSync: { trigger: "manual", added: 4 } });

    // 晚到的一个（上传晚了）：下一次同步补上；已经有的不重复
    fake.moments.get("2026-10-24")!.push(fakeMoment({ id: "m-3", date: "2026-10-24", start: "21:00", end: "21:30", title: "看书", description: "睡前看了会儿书" }));
    const asked = daysAsked(fake).length;
    expect(await sync(k)).toMatchObject({ added: 1 });
    expect(daysAsked(fake).slice(asked)).toEqual(["2026-10-23", "2026-10-24"]);
    expect(moments(k).map((m) => m.momentId)).toEqual(["m-0", "m-1", "m-2", "m-3"]);
  });

  it("定期导入：连着时每天 02:30 同步一次", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    k.clock.advanceTo(new Date("2026-10-26T02:30:00+08:00"));
    await k.internalJobs.whenIdle();
    await k.dataSources.whenIdle();
    expect(looki(k)).toMatchObject({ lastSync: { trigger: "scheduled", added: 5 } });
    // 26 号凌晨：昨天是 25 号，今天的早饭也进来了
    expect(moments(k).map((m) => m.momentId)).toContain("m-today");
  });

  it("限速：等一会儿再试（等的时候状态写明），过了照常；一直限速时同步出错、状态写明，按需查不等直接回", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    fake.rateLimitNext = 1;
    expect(await sync(k)).toMatchObject({ added: 4 });
    expect(looki(k).problem).toBeUndefined();
    expect(k.logs.some((line) => line.includes("限速了"))).toBe(true);

    fake.mode = "rate_limited";
    const limited = await sync(k);
    expect(limited.error).toContain("Looki 限速了");
    expect(looki(k)).toMatchObject({ connection: "connected", problem: expect.stringContaining("限速"), lastSync: { error: expect.stringContaining("限速") } });
    const before = fake.requests.length;
    const answer = await ask(k, { date: "2026-10-24" });
    expect(answer).toMatchObject({ isError: true, text: expect.stringContaining("限速") });
    expect(fake.requests.length).toBe(before);
  });

  it("Key 失效：同步出错写明原因、状态是出错、不能同步；每小时自动再试，Key 又能用了自己回来（306）；重新填好也恢复", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    const running = tool(k)!;
    fake.mode = "revoked";
    const failed = await sync(k);
    expect(failed.error).toContain("Looki 不认这个 API Key");
    expect(looki(k)).toMatchObject({ connection: "error", problem: expect.stringContaining("重新建一个"), canSync: false });
    // 306：出错了不再给秘书"查 Looki"；正在跑的一轮里再调回出错了和原因（不调接口）
    expect(tool(k)).toBeUndefined();
    const before = fake.requests.length;
    expect(await running.run({ date: "2026-10-24" }, { toolCallId: "c-revoked" })).toMatchObject({ isError: true, text: expect.stringMatching(/Looki出错了（.*重新建一个/) });
    expect(fake.requests.length).toBe(before);
    // 页面写明每小时自动再试；一小时到点拿存着的 Key 再调一次 /me，还不认照旧出错
    expect(looki(k)).toMatchObject({ autoRetry: true });
    const failedAt = k.clock.now();
    k.clock.advanceTo(failedAt + 60 * 60_000);
    await k.dataSources.whenIdle();
    expect(fake.requests.length).toBe(before + 1);
    expect(looki(k)).toMatchObject({ connection: "error" });
    // Key 在 Looki 那边又能用了（没重填）：再过一小时自己回到连着，秘书又有"查 Looki"
    fake.mode = "ok";
    k.clock.advanceTo(failedAt + 120 * 60_000);
    await k.dataSources.whenIdle();
    expect(looki(k)).toMatchObject({ connection: "connected", canSync: true });
    expect(looki(k).autoRetry).toBeUndefined();
    expect(tool(k)).toBeDefined();
    // 重新填好也行（照旧）
    fake.mode = "revoked";
    await sync(k);
    expect(looki(k).connection).toBe("error");
    fake.mode = "ok";
    await configure(k, { key: LOOKI_TEST_KEY });
    expect(looki(k)).toMatchObject({ connection: "connected", canSync: true });
    expect(tool(k)).toBeDefined();
    expect(looki(k).problem).toBeUndefined();
  });

  it("日记回的不对（参数和文档对不上）：不耽误时刻，日志里写明；按需查一整天也照样列时刻", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    fake.journalsRejected = true;
    expect(await sync(k)).toMatchObject({ added: 3 });
    expect(journals(k)).toEqual([]);
    expect(k.logs.some((line) => line.includes("日记没拉成"))).toBe(true);
    const day = await ask(k, { date: "2026-10-24" });
    expect(day.isError).toBeUndefined();
    expect(day.text).toContain("（2 个）");
  });

  it("那边出错、连不上：同步出错写明，状态照旧连着", async () => {
    const { fake, k } = await setup();
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    fake.mode = "down";
    expect((await sync(k)).error).toContain("Looki 那边出错了（HTTP 500）");
    expect(looki(k).connection).toBe("connected");
  });
});

describe("按需查（秘书的\"查 Looki\"）", () => {
  it("按日期加时间段：只列那段时间里的，带时间段、地点、有没有照片视频；没有照片链接、没有 Key", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    const result = await ask(k, { date: "2026-10-24", from: "13:00", to: "18:00" });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Looki 里 2026-10-24 13:00–18:00 的时刻（1 个）");
    expect(result.text).toContain("- 14:00–16:30 · 望京 SOHO · 在望京开会：和同事讨论下季度计划（有照片、视频）");
    expect(result.text).not.toContain("散步回家");
    expect(result.text).not.toMatch(/https?:\/\/|X-Amz|lk-/);
    expect(fake.keyed().filter((r) => r.path === "/api/v1/journals")).toEqual([]);
  });

  it("一整天：顺带那天的日记；不给日期是今天；几天的带日期", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    const day = await ask(k, { date: "2026-10-24" });
    expect(day.text).toContain("（2 个）");
    expect(day.text).toContain("那天 Looki 的 AI 替用户写的日记《忙碌又平静的周六》：下午开会，晚上散步");
    expect((await ask(k, {})).text).toContain("吃早饭");
    const span = await ask(k, { date: "2026-10-20", end_date: "2026-10-24" });
    expect(span.text).toContain("10-20（周二） 12:00–12:50 · 海底捞（望京店） · 吃火锅");
    expect(span.text).toContain("10-24（周六） 14:00–16:30");
  });

  it("按关键词：交给 Looki 的语义搜索（可限定日期范围）", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    const found = await ask(k, { keyword: "火锅" });
    expect(found.text).toContain("Looki 里和「火锅」有关的时刻（1 个）");
    expect(found.text).toContain("吃火锅");
    expect(fake.keyed().at(-1)).toMatchObject({ path: "/api/v1/moments/search", query: { query: "火锅" } });
    await ask(k, { keyword: "开会", date: "2026-10-24" });
    expect(fake.keyed().at(-1)).toMatchObject({ path: "/api/v1/moments/search", query: { query: "开会", start_date: "2026-10-24", end_date: "2026-10-24" } });
    expect((await ask(k, { keyword: "潜水" })).text).toContain("一个都没有");
  });

  it("参数不对、没连：回一句给模型的，不调接口", async () => {
    const { fake, k } = await setup();
    // 没连：306 起秘书没有这个工具
    expect(tool(k)).toBeUndefined();
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    const before = fake.requests.length;
    expect(await ask(k, { date: "10/24" })).toMatchObject({ isError: true, text: expect.stringContaining("YYYY-MM-DD") });
    expect((await ask(k, { date: "2026-02-30" })).text).toContain("不是日历上有的日子");
    expect((await ask(k, { from: "25:00" })).text).toContain("HH:mm");
    expect((await ask(k, { date: "2026-10-01", end_date: "2026-10-24" })).text).toContain("最多 7 天");
    expect((await ask(k, { end_date: "2026-10-24" })).text).toContain("给了 end_date 就要给 date");
    expect((await ask(k, { keyword: "火".repeat(101) })).text).toContain("最多 100 个字");
    expect(fake.requests.length).toBe(before);
  });
});

describe("断开、停用、移除", () => {
  it("断开留着已导入的：记录还在、Key 没了、没连", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    await sync(k);
    await k.dataSources.act(LOOKI_SOURCE_ID, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(looki(k)).toMatchObject({ connection: "not_connected", count: 4 });
    expect(fs.existsSync(secretFile(k))).toBe(false);
  });

  it("插件停用：写明没启用、不能同步、秘书没有\"查 Looki\"；再启用接着用存着的 Key", async () => {
    const { fake, k } = await setup();
    script(fake);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    await k.settings.act(LOOKI_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(looki(k)).toMatchObject({ available: false, unavailable: "Looki插件没启用", canSync: false, connection: "connected" });
    expect(tool(k)).toBeUndefined();
    await k.settings.act(LOOKI_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(await sync(k)).toMatchObject({ added: 4 });
  });

  it("移除并连数据删：导入的记录换成\"已删除\"标记、密钥区里的 Key 删掉、存一份到本地的索引删掉（存下的文件不删）；确认框写明删什么、删不掉什么", async () => {
    const { fake, k, home } = await setup();
    script(fake);
    fake.files.set("m-1", [fakePhoto("f-1", "2026-10-24T14:00:05+08:00")]);
    await configure(k, { key: LOOKI_TEST_KEY, region: "cn" });
    await sync(k);
    await waitArchived(k);
    const photo = path.join(home, "2026-10", "2026-10-24", "14.00 在望京开会", "14.00.05-f1.jpg");
    expect(fs.existsSync(photo)).toBe(true);
    expect(fs.existsSync(path.join(k.dir, "looki-archive"))).toBe(true);
    const info = k.host.info().find((p) => p.name === LOOKI_PLUGIN)!;
    expect(info.removal?.deletes.join("\n")).toContain("API Key");
    expect(info.removal?.keeps.join("\n")).toContain("素材属于内核");
    expect(info.removal?.keeps.join("\n")).toContain("存到本地的照片、日记、vlog");
    expect(info.brings).toEqual({ tools: ["查 Looki"], cards: [], jobs: [] });
    const result = await k.settings.act(LOOKI_PLUGIN, { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(result.purged).toMatchObject({ events: 4, files: 2 });
    expect(k.store.read(LOOKI_CHANNEL).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(fs.existsSync(secretFile(k))).toBe(false);
    expect(fs.existsSync(path.join(k.dir, "looki-archive"))).toBe(false);
    expect(fs.existsSync(photo)).toBe(true);
  });
});
