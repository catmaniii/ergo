// Looki 回包的宽松读法和采集规则：官方文档没写清的几处（成功时外面包不包一层、时间的写法、地点在时刻上还是文件上、
// 媒体是列表还是计数、日记怎么分组）各种写法都读得出；采集规则把时刻写成观察到的本人行为、AI 日记写成别人写给你的（只进检索）。
import { PURGED_TEXT } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../src/events/event-store.ts";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_MOMENT, LOOKI_SOURCE_ID, type LookiJournalPayload, type LookiMomentPayload } from "../../src/looki/api.ts";
import { journalVlogs, remoteFile } from "../../src/looki/archive-remote.ts";
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

/** 官方文档的 FileModel：只有链接、种类、大小、时长（没有 id） */
const file = (url: string, mediaType: string) => ({ temporary_url: url, media_type: mediaType, size: 1024, metadata: { duration_ms: 30_000 } });

describe("存到本地读的文件、vlog（424：官方文档现在的写法）", () => {

  it("日记里的 vlog：DAILY_VLOG 的 media_items 里 source 是视频的那个（缩略图不算）；日期取条目的，没有取组上的；别的种类、只有图片的不要", () => {
    const groups = [
      {
        date: "2026-10-24",
        start_date: null,
        journals: [
          { id: "d-1", type: "DIARY", title: "周六", description: "开会", content: "……", media_items: [{ source: file("https://cdn.example/a.mp4", "VIDEO"), thumbnail: null }], date: "2026-10-24", tz: "+08:00", recorded_at: "2026-10-24T22:00:00+08:00" },
          {
            id: "v-1",
            type: "DAILY_VLOG",
            title: "忙碌的周六",
            description: "一天的高光",
            media_items: [{ source: file("https://cdn.example/processed/vlog/v1.mp4?x-looki-token=abc", "VIDEO"), thumbnail: file("https://cdn.example/processed/vlog/v1.jpg?x-looki-token=abc", "IMAGE") }],
            date: "2026-10-24",
            start_date: null,
            tz: "+08:00",
            recorded_at: "2026-10-24T21:00:00+08:00",
            created_at: "2026-10-25T01:00:00+08:00",
          },
          // 没有自己的 date：取组上的
          { id: "v-2", type: "DAILY_VLOG", title: "", description: "高光", media_items: [{ source: file("https://cdn.example/v2", "VIDEO"), thumbnail: null }], tz: "+08:00", recorded_at: "2026-10-25T00:30:00+08:00" },
          // 只有封面图、没有视频：不要
          { id: "v-3", type: "DAILY_VLOG", title: "x", description: "x", media_items: [{ source: file("https://cdn.example/v3.jpg", "IMAGE"), thumbnail: null }], date: "2026-10-24" },
        ],
      },
    ];
    const vlogs = journalVlogs(groups);
    expect(vlogs.map((v) => [v.id, v.date, v.title, v.file.kind, v.file.url])).toEqual([
      ["v-1", "2026-10-24", "忙碌的周六", "video", "https://cdn.example/processed/vlog/v1.mp4?x-looki-token=abc"],
      ["v-2", "2026-10-24", "", "video", "https://cdn.example/v2"],
    ]);
    expect(vlogs[0]!.time).toBe("2026-10-24T21:00:00.000+08:00");
    // 官方回包外面那一层 { items, next_cursor_id, has_more }、同一个 id 来两次只要一次
    expect(journalVlogs([{ items: groups }, groups[0]]).map((v) => v.id)).toEqual(["v-1", "v-2"]);
  });

  it("时刻的文件包在 file 里（{ id, file: FileModel, thumbnail, location, created_at, tz }）：id、拍摄时间取外面的，链接、种类取 file 里的；平铺的照旧", () => {
    expect(remoteFile({ id: "mf-1", file: file("https://cdn.example/p/1.jpg?sig=1", "IMAGE"), thumbnail: file("https://cdn.example/p/1-thumb.jpg", "IMAGE"), location: "望京", created_at: "2026-10-24T14:00:05", tz: "+08:00" })).toEqual({
      id: "mf-1",
      kind: "photo",
      url: "https://cdn.example/p/1.jpg?sig=1",
      taken: "2026-10-24T14:00:05.000+08:00",
    });
    expect(remoteFile({ id: "mf-2", media_type: "VIDEO", temporary_url: "https://cdn.example/c.mp4", created_at: "2026-10-24T14:10:00+08:00" })).toMatchObject({ id: "mf-2", kind: "video" });
    // 只有缩略图没有文件：不要
    expect(remoteFile({ id: "mf-3", thumbnail: file("https://cdn.example/t.jpg", "IMAGE") })).toBeUndefined();
    // FileModel 没有 id：拿链接路径（不含签名）算一个，换了签名还是同一个
    const a = remoteFile({ source: file("https://cdn.example/x.jpg?sig=1", "IMAGE") });
    const b = remoteFile({ source: file("https://cdn.example/x.jpg?sig=2", "IMAGE") });
    expect(a?.id).toMatch(/^u[0-9a-f]{16}$/);
    expect(a?.id).toBe(b?.id);
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
