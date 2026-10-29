// Looki 回包的宽松读法和采集规则（296 号票）：官方文档没写清的几处（成功时外面包不包一层、时间的写法、地点在时刻上还是文件上、
// 媒体是列表还是计数、日记怎么分组）各种写法都读得出；采集规则把时刻写成观察到的本人行为、AI 日记写成别人写给你的（只进检索）。
import { PURGED_TEXT } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../src/events/event-store.ts";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_MOMENT, LOOKI_SOURCE_ID, type LookiJournalPayload, type LookiMomentPayload } from "../../src/looki/api.ts";
import { dataOf, listOf } from "../../src/looki/client.ts";
import { journalMaterialSource, journalPurge, momentMaterialSource, momentPurge } from "../../src/looki/materials.ts";
import { addDays, daysBetween, journalRecords, lookiTime, momentRecord, zoneOffset } from "../../src/looki/records.ts";
import { maskedAccount } from "../../src/looki/service.ts";

const SOURCE = { id: LOOKI_SOURCE_ID, sensitive: ["location", "emotion", "health"] as const };
const event = (type: string, payload: unknown): StoredEvent => ({ globalSeq: 1, channel: LOOKI_CHANNEL, seq: 1, type, time: "2026-10-25T02:30:00.000+08:00", payload }) as StoredEvent;

describe("回包外面那一层、列表在哪", () => {
  it("{ data: … } 取 data；没有就是它自己；列表认数组、items / moments / data 里的", () => {
    expect(dataOf({ data: [1] })).toEqual([1]);
    expect(dataOf({ status: "ok" })).toEqual({ status: "ok" });
    expect(listOf([1, 2])).toEqual([1, 2]);
    expect(listOf({ items: [1], next_cursor: null })).toEqual([1]);
    expect(listOf({ moments: [3] })).toEqual([3]);
    expect(listOf({ data: { items: [4] } })).toEqual([4]);
    expect(listOf({ total: 0 })).toEqual([]);
    expect(listOf("x")).toEqual([]);
  });
});

describe("时间", () => {
  it("带偏移的 ISO、Z、不带偏移的日期时间、只有钟点、epoch 秒和毫秒：按 tz 写成带偏移的 ISO", () => {
    const tz = "Asia/Shanghai";
    expect(lookiTime("2026-10-24T14:00:00+08:00", undefined, tz)).toBe("2026-10-24T14:00:00.000+08:00");
    expect(lookiTime("2026-10-24T06:00:00Z", undefined, tz)).toBe("2026-10-24T14:00:00.000+08:00");
    expect(lookiTime("2026-10-24T14:00:00+0800", undefined, tz)).toBe("2026-10-24T14:00:00.000+08:00");
    expect(lookiTime("2026-10-24 14:00:00", undefined, tz)).toBe("2026-10-24T14:00:00.000+08:00");
    expect(lookiTime("14:05", "2026-10-24", tz)).toBe("2026-10-24T14:05:00.000+08:00");
    const ms = Date.parse("2026-10-24T14:00:00+08:00");
    expect(lookiTime(ms, undefined, tz)).toBe("2026-10-24T14:00:00.000+08:00");
    expect(lookiTime(ms / 1000, undefined, tz)).toBe("2026-10-24T14:00:00.000+08:00");
    expect(lookiTime(String(ms / 1000), undefined, "+08:00")).toBe("2026-10-24T14:00:00.000+08:00");
    // 别的时区照它的偏移写
    expect(lookiTime("2026-10-24 09:00:00", undefined, "America/Toronto")).toBe("2026-10-24T09:00:00.000-04:00");
    expect(lookiTime("下午两点", "2026-10-24", tz)).toBeUndefined();
    expect(lookiTime("14:05", undefined, tz)).toBeUndefined();
  });

  it("时区：IANA 名字、+08:00、UTC+8、UTC；认不出是 undefined", () => {
    const ms = Date.parse("2026-07-01T00:00:00Z");
    expect(zoneOffset("Asia/Shanghai", ms)).toBe(480);
    expect(zoneOffset("+08:00", ms)).toBe(480);
    expect(zoneOffset("UTC+8", ms)).toBe(480);
    expect(zoneOffset("-0530", ms)).toBe(-330);
    expect(zoneOffset("UTC", ms)).toBe(0);
    expect(zoneOffset("Mars/Base", ms)).toBeUndefined();
  });

  it("日期加减、一段日子", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-23", "2026-10-25")).toEqual(["2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(daysBetween("2026-10-26", "2026-10-25")).toEqual([]);
  });
});

describe("时刻", () => {
  const base = { id: "m-9", title: "开会", description: "讨论方案", date: "2026-10-24", tz: "Asia/Shanghai", start_time: "14:00", end_time: "15:00" };

  it("地点：时刻上的（字符串或对象）优先，没有取封面文件上的；光是经纬度的不要", () => {
    expect(momentRecord({ ...base, location: "望京 SOHO" })?.place).toBe("望京 SOHO");
    expect(momentRecord({ ...base, location: { name: "公司", latitude: 39.9, longitude: 116.4 } })?.place).toBe("公司");
    expect(momentRecord({ ...base, cover_file: { location: "家附近的公园", temporary_url: "https://x/y.jpg" } })?.place).toBe("家附近的公园");
    expect(momentRecord({ ...base, location: "39.99,116.48" })?.place).toBeUndefined();
    expect(momentRecord({ ...base, location: { latitude: 39.9, longitude: 116.4 } })?.place).toBeUndefined();
  });

  it("媒体：列表、计数、一个字符串都认；不认得的丢掉", () => {
    expect(momentRecord({ ...base, media_types: ["VIDEO", "IMAGE", "IMAGE"] })?.media).toEqual(["photo", "video"]);
    expect(momentRecord({ ...base, media_types: { IMAGE: 3, VIDEO: 0, AUDIO: 1 } })?.media).toEqual(["photo", "audio"]);
    expect(momentRecord({ ...base, media_types: "VIDEO" })?.media).toEqual(["video"]);
    expect(momentRecord({ ...base, media_types: ["HOLOGRAM"] })?.media).toBeUndefined();
  });

  it("钟点拼上日期；结束早于开始的不要结束；只有描述也行；没有 id、没有开始时间、一个字都没有的不要；数字 id 认", () => {
    expect(momentRecord(base)).toEqual({ momentId: "m-9", date: "2026-10-24", start: "2026-10-24T14:00:00.000+08:00", end: "2026-10-24T15:00:00.000+08:00", title: "开会", description: "讨论方案", text: "开会\n讨论方案" });
    expect(momentRecord({ ...base, end_time: "13:00" })?.end).toBeUndefined();
    expect(momentRecord({ ...base, title: "" })?.text).toBe("讨论方案");
    expect(momentRecord({ ...base, id: undefined })).toBeUndefined();
    expect(momentRecord({ ...base, start_time: undefined })).toBeUndefined();
    expect(momentRecord({ ...base, title: " ", description: "" })).toBeUndefined();
    expect(momentRecord({ ...base, id: 42 })?.momentId).toBe("42");
    expect(momentRecord("x")).toBeUndefined();
  });
});

describe("日记", () => {
  const journal = { id: "j-2", type: "DIARY", title: "周末", description: "爬山", content: "上午去爬了香山。", recorded_at: "2026-10-25T01:00:00+08:00" };

  it("按天分组（{ date, journals }）、平铺的数组、{ items } 都读得出；日期取组上的（凌晨写的算前一天的日记）", () => {
    const grouped = journalRecords([{ date: "2026-10-24", journals: [journal] }]);
    expect(grouped).toEqual([{ journalId: "j-2", date: "2026-10-24", time: "2026-10-25T01:00:00.000+08:00", kind: "DIARY", title: "周末", summary: "爬山", content: "上午去爬了香山。", text: "Looki · 周末\n爬山" }]);
    expect(journalRecords([journal]).map((j) => j.date)).toEqual(["2026-10-25"]);
    expect(journalRecords([{ date: "2026-10-24", items: [journal, { ...journal, id: "j-3" }] }]).map((j) => j.journalId)).toEqual(["j-2", "j-3"]);
  });

  it("没有摘要用全文开头当说明；没有标题用日期；没有时间用组上的日期", () => {
    const [j] = journalRecords([{ date: "2026-10-24", journals: [{ id: "j-4", content: "一整天都在家。", tz: "Asia/Shanghai" }] }]);
    expect(j).toMatchObject({ date: "2026-10-24", time: "2026-10-24T00:00:00.000+08:00", text: "Looki · 2026-10-24\n一整天都在家。" });
  });
});

describe("采集规则和彻底删除", () => {
  const moment: LookiMomentPayload = { momentId: "m-1", date: "2026-10-24", start: "2026-10-24T14:00:00.000+08:00", end: "2026-10-24T16:30:00.000+08:00", title: "开会", description: "讨论方案", place: "望京 SOHO", media: ["photo"], text: "开会\n讨论方案" };
  const journal: LookiJournalPayload = { journalId: "j-1", date: "2026-10-24", time: "2026-10-24T22:00:00.000+08:00", kind: "DIARY", title: "周六", summary: "开会、散步", content: "下午开会有点累。", text: "Looki · 周六\n开会、散步" };

  it("时刻 → 观察到的本人行为：时间是开始，场景给结束时间和地点，敏感类别写空的（地点由位置开关管）", () => {
    const [draft] = momentMaterialSource(SOURCE).capture(event(LOOKI_MOMENT, moment));
    expect(draft).toMatchObject({ kind: "observed_behavior", time: moment.start, ref: { recordId: "m-1" }, origin: { dataSource: LOOKI_SOURCE_ID, scene: { end: moment.end, place: "望京 SOHO" }, sensitive: [] } });
    expect(draft!.segments.map((s) => s.text)).toEqual(["开会\n讨论方案"]);
  });

  it("AI 日记 → 别人写给你的：说明是摘要、全文只进检索，标情绪、健康", () => {
    const [draft] = journalMaterialSource(SOURCE).capture(event(LOOKI_JOURNAL, journal));
    expect(draft).toMatchObject({ kind: "received_writing", time: journal.time, indexText: "下午开会有点累。", origin: { dataSource: LOOKI_SOURCE_ID, scene: {}, sensitive: ["emotion", "health"] } });
  });

  it("彻底删除：标题、描述、地点、全文换掉，id 和时间留着；改写过的不再采成素材", () => {
    const purgedMoment = momentPurge.rewrite(event(LOOKI_MOMENT, moment), {} as never) as LookiMomentPayload;
    expect(purgedMoment).toEqual({ momentId: "m-1", date: "2026-10-24", start: moment.start, end: moment.end, title: PURGED_TEXT, description: PURGED_TEXT, text: PURGED_TEXT });
    expect(momentMaterialSource(SOURCE).capture(event(LOOKI_MOMENT, purgedMoment))).toEqual([]);
    const purgedJournal = journalPurge.rewrite(event(LOOKI_JOURNAL, journal), {} as never) as LookiJournalPayload;
    expect(JSON.stringify(purgedJournal)).not.toMatch(/开会|累/);
    expect(journalMaterialSource(SOURCE).capture(event(LOOKI_JOURNAL, purgedJournal))).toEqual([]);
  });
});

describe("账号打码", () => {
  it("邮箱留第一个字和域名；没有邮箱留名字的第一个字；都没有不写", () => {
    expect(maskedAccount({ email: "dongdong@example.com", name: "东东" })).toBe("d***@example.com");
    expect(maskedAccount({ name: "东东" })).toBe("东**");
    expect(maskedAccount({})).toBeUndefined();
    expect(maskedAccount(null)).toBeUndefined();
  });
});
