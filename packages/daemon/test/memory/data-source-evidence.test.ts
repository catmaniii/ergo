// 数据源素材读成证据（303 号票，模块层）：素材库是真的（materials.db、素材区），数据源的素材用 dataSourceMaterial 写，
// MaterialsEvidenceSource 读成 @ergo/memory 的 EvidenceDraft。覆盖：
// - 三种素材的证据性质（来源等级、说或做、证据种类）；场景一行（时间段、地点、和谁）和场景标签（插件给的、按日子补的、从原文推的）；
// - 敏感类别：出处里写的有一类没打开整条不读；位置没打开时不带地点（也不拿地点推场景）；健康按原文认出来的照旧挡；
// - 每晚整理的预算：同一个数据源、同一种、同一天超过 3 条合成一条（出处 digest:…），当天的先不读，最多 N 条（按时间先后），
//   已经读进来的按背后的素材跳过（合成的那条被忘掉时别的素材放回来）；
// - 顺口问那条路（evidenceDraftOf）一条一条读、不看是不是当天。
import { EVENT_TYPES, type MemoryCommandEventPayload } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { SENSITIVE_CATEGORIES, type SensitiveCategory } from "../../src/config/config.ts";
import type { DataSource } from "../../src/data-sources/api.ts";
import { dataSourceMaterial, type DataSourceRecordMaterial } from "../../src/data-sources/material.ts";
import type { MaterialSource } from "../../src/materials/capture.ts";
import { MATERIALS_CHANNEL } from "../../src/materials/commands.ts";
import { DIGEST_OVER, digestRef, ingestedMaterialIds, materialIdsOfRef } from "../../src/memory/data-source-evidence.ts";
import { evidenceDraftOf, MaterialsEvidenceSource } from "../../src/memory/evidence-source.ts";
import { materialsSetup, postMessage, text } from "../materials/helpers.ts";

type Setup = ReturnType<typeof materialsSetup>;

/** 测试自己的一类事件：负载里给数据源（id、登记的敏感类别）和一条记录 */
const RECORD_EVENT = "test-data-source-record" as never;
const recordSource: MaterialSource = {
  name: "test-data-source-record",
  eventType: RECORD_EVENT,
  capture: (event) => {
    const p = event.payload as { source: Pick<DataSource, "id" | "sensitive">; record: DataSourceRecordMaterial };
    return [dataSourceMaterial(p.source, p.record)];
  },
};

const CAMERA: Pick<DataSource, "id" | "sensitive"> = { id: "camera", sensitive: ["location"] };
const MAIL: Pick<DataSource, "id" | "sensitive"> = { id: "mail", sensitive: [] };

function setup() {
  const t = materialsSetup({ sources: [recordSource] });
  const source = (options: { allowed?: readonly SensitiveCategory[]; skip?: ReadonlySet<string>; limit?: number } = {}) =>
    new MaterialsEvidenceSource({
      materials: t.materials,
      clock: t.clock,
      inferableSensitiveCategories: options.allowed ?? SENSITIVE_CATEGORIES,
      ...(options.skip === undefined ? {} : { skip: options.skip }),
      ...(options.limit === undefined ? {} : { dataSourceLimit: options.limit }),
    });
  return { t, source };
}

/** 追加一条数据源的记录（默认相机的、没写敏感类别就是不涉及） */
function record(t: Setup, rec: DataSourceRecordMaterial, source = CAMERA) {
  t.store.append({ channel: "test-data-source", type: RECORD_EVENT, payload: { source, record: { sensitive: [], ...rec } } });
  return t.materials.list().at(-1)!;
}

/** 相机在某天记的 n 条（09:00 起每小时一条） */
const day = (t: Setup, date: string, n: number, kind: DataSourceRecordMaterial["kind"] = "observed_behavior", from = CAMERA) =>
  Array.from({ length: n }, (_, i) => record(t, { kind, text: `第 ${i + 1} 件事`, time: `${date}T${String(9 + i).padStart(2, "0")}:00:00.000+08:00` }, from));

// 底座的"现在"是 2026-10-08（周四）09:00 +08:00；10-03、10-04 是周末
describe("三种素材的证据性质和场景", () => {
  test("观察到的本人行为 → 本人做的；别人写给你的 → 别人转述的（原文是摘要）；本人写的 → 本人说的", () => {
    const { t, source } = setup();
    const did = record(t, { kind: "observed_behavior", text: "开了两个会", time: "2026-10-07T14:00:00.000+08:00", scene: { end: "2026-10-07T17:00:00.000+08:00", place: "望京的公司", people: ["张三", "李四"], tags: ["work"] } });
    const told = record(t, { kind: "received_writing", text: "张三：周五的会改到下午", indexText: "正文：周五的会改到下午 3 点", time: "2026-10-07T15:00:00.000+08:00" }, MAIL);
    const wrote = record(t, { kind: "own_writing", text: "好的\n周五下午见", time: "2026-10-07T15:30:00.000+08:00", scene: { people: ["张三"] } }, MAIL);
    expect([did, told, wrote].map((m) => [m.kind, m.mode, m.source])).toEqual([
      ["observed_behavior", "do", "self"],
      ["received_writing", "say", "external_untrusted"],
      ["own_writing", "say", "self"],
    ]);

    const drafts = source().read();
    expect(drafts.map((d) => [d.sourceRef, d.sourceLevel, d.mode, d.kind])).toEqual([
      [did.id, "self", "do", "action"],
      [told.id, "untrusted", "say", "utterance"],
      [wrote.id, "self", "say", "utterance"],
    ]);
    expect(drafts.map((d) => d.text)).toEqual(["开了两个会\n［场景］时间 14:00–17:00 · 地点 望京的公司 · 和 张三、李四", "张三：周五的会改到下午\n［场景］时间 15:00", "好的\n周五下午见\n［场景］时间 15:30 · 和 张三"]);
    // 场景标签：插件给的 + 那天是工作日；别人写的那条从原文推不出方面
    expect(drafts.map((d) => d.context)).toEqual([["work", "workday"], ["workday"], ["workday"]]);
    expect(drafts.map((d) => [d.eventTime, d.observedAt])).toEqual([did, told, wrote].map((m) => [m.time, m.time]));
  });

  test("场景标签：不认得的丢掉；插件给了周末 / 工作日就不再按日子补；没给方面的从原文按关键词推（带地点时连地点）", () => {
    const { t, source } = setup();
    record(t, { kind: "observed_behavior", text: "在外面待了一下午", time: "2026-10-04T14:00:00.000+08:00", scene: { tags: ["not-a-scene", "holiday"] } });
    record(t, { kind: "observed_behavior", text: "和朋友聚餐", time: "2026-10-04T19:00:00.000+08:00" });
    record(t, { kind: "observed_behavior", text: "待了三个小时", time: "2026-10-05T09:00:00.000+08:00", scene: { place: "公司" } });
    expect(source().read().map((d) => d.context)).toEqual([["holiday"], ["weekend", "social"], ["workday", "work"]]);
    // 位置没打开：地点不进原文，也不拿它推场景
    expect(source({ allowed: [] }).read().map((d) => d.context)).toEqual([["holiday"], ["weekend", "social"], ["workday"]]);
  });

  test("结束在第二天的写上月日", () => {
    const { t, source } = setup();
    record(t, { kind: "observed_behavior", text: "通宵赶工", time: "2026-10-06T22:00:00.000+08:00", scene: { end: "2026-10-07T02:30:00.000+08:00" } });
    expect(source().read()[0]!.text).toBe("通宵赶工\n［场景］时间 22:00–10-07 02:30");
  });
});

describe("敏感类别", () => {
  test("出处里写的类别有一类没打开就整条不读；不写是数据源登记的全部", () => {
    const { t, source } = setup();
    const run = record(t, { kind: "observed_behavior", text: "晚上去了趟医院", time: "2026-10-07T20:00:00.000+08:00", sensitive: ["health"] });
    // 没写敏感类别：带上相机登记的"位置"
    const t2 = t.store.append({ channel: "test-data-source", type: RECORD_EVENT, payload: { source: CAMERA, record: { kind: "observed_behavior", text: "去了三个地方", time: "2026-10-07T21:00:00.000+08:00" } } });
    const where = t.materials.list().find((m) => m.ref.event.seq === t2.event.seq)!;
    expect(where.origin?.sensitive).toEqual(["location"]);

    expect(source({ allowed: [] }).read()).toEqual([]);
    expect(source({ allowed: ["health"] }).read().map((d) => d.sourceRef)).toEqual([run.id]);
    expect(source({ allowed: ["health", "location"] }).read().map((d) => d.sourceRef)).toEqual([run.id, where.id]);
  });

  test("位置没打开：证据里不带地点，别的照读", () => {
    const { t, source } = setup();
    record(t, { kind: "observed_behavior", text: "开了两个会", time: "2026-10-07T14:00:00.000+08:00", scene: { place: "望京的公司", people: ["张三"] } });
    expect(source({ allowed: [] }).read()[0]!.text).toBe("开了两个会\n［场景］时间 14:00 · 和 张三");
  });

  test("原文落在健康里（按关键词认出来的）照旧挡", () => {
    const { t, source } = setup();
    record(t, { kind: "own_writing", text: "明天去体检", time: "2026-10-07T20:00:00.000+08:00" }, MAIL);
    expect(source({ allowed: [] }).read()).toEqual([]);
    expect(source({ allowed: ["health"] }).read()[0]!.context).toEqual(["workday", "health"]);
  });

  test("标了别推断的不读", () => {
    const { t, source } = setup();
    const m = record(t, { kind: "observed_behavior", text: "开了两个会", time: "2026-10-07T14:00:00.000+08:00" });
    const payload = { commandId: "cmd-303", command: "no_infer", materialIds: [m.id], from: { kind: "project_deletion", projectId: "p-1" } } as MemoryCommandEventPayload;
    t.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload });
    expect(source().read()).toEqual([]);
  });
});

describe("每晚整理的预算：多的合成一条、当天的先不读、每晚有上限", () => {
  test(`同一个数据源、同一种、同一天超过 ${DIGEST_OVER} 条合成一条；不超过的一条一条；用户说的话照读`, () => {
    const { t, source } = setup();
    postMessage(t.store, [text("最近周末想好好休息")]);
    const many = day(t, "2026-10-05", DIGEST_OVER + 2);
    const few = day(t, "2026-10-06", DIGEST_OVER);
    // 同一天、同一个数据源的另一种不并进来
    const wrote = record(t, { kind: "own_writing", text: "周报发了", time: "2026-10-05T18:00:00.000+08:00" });

    const drafts = source().read();
    const user = t.materials.list().find((m) => m.origin === undefined)!;
    expect(drafts.map((d) => d.sourceRef)).toEqual([user.id, digestRef(many.map((m) => m.id)), wrote.id, ...few.map((m) => m.id)]);
    const digest = drafts[1]!;
    expect(digest).toMatchObject({ sourceLevel: "self", mode: "do", kind: "action", eventTime: many[0]!.time, observedAt: many.at(-1)!.time, context: ["workday"] });
    expect(digest.text).toBe(["［数据源 camera · 2026-10-05 · 5 条］", "- 第 1 件事（时间 09:00）", "- 第 2 件事（时间 10:00）", "- 第 3 件事（时间 11:00）", "- 第 4 件事（时间 12:00）", "- 第 5 件事（时间 13:00）"].join("\n"));
    expect(materialIdsOfRef(digest.sourceRef)).toEqual(many.map((m) => m.id));
  });

  test("当天的先不读（等这一天过完再合）；顺口问那条路照样一条一条读", () => {
    const { t, source } = setup();
    const today = day(t, "2026-10-08", 2);
    expect(source().read()).toEqual([]);
    expect(evidenceDraftOf(today[0]!, SENSITIVE_CATEGORIES)?.sourceRef).toBe(today[0]!.id);
    t.clock.advance(24 * 60 * 60 * 1000);
    expect(source().read().map((d) => d.sourceRef)).toEqual(today.map((m) => m.id));
  });

  test("每晚最多读进 N 条（合成的算一条），按时间先后，多的留到下一夜；读过的按背后的素材跳过", () => {
    const { t, source } = setup();
    const first = day(t, "2026-10-03", DIGEST_OVER + 1);
    const second = day(t, "2026-10-04", 1);
    const third = day(t, "2026-10-05", 1);
    const tonight = source({ limit: 2 }).read();
    expect(tonight.map((d) => d.sourceRef)).toEqual([digestRef(first.map((m) => m.id)), second[0]!.id]);
    const ingested = ingestedMaterialIds(tonight.map((d) => ({ sourceRef: d.sourceRef ?? null, status: "active" as const })));
    expect(source({ limit: 2, skip: ingested }).read().map((d) => d.sourceRef)).toEqual([third[0]!.id]);
  });

  test("合成的那条被忘掉（其中一条素材忘掉了）：别的素材放回来，下一夜重新合；一条一条的不受影响", () => {
    const ids = ["mat-a", "mat-b", "mat-c", "mat-d"];
    const evidence = [
      { sourceRef: digestRef(ids), status: "forgotten" as const },
      { sourceRef: "mat-e", status: "forgotten" as const },
      { sourceRef: digestRef(["mat-f", "mat-g", "mat-h", "mat-i"]), status: "active" as const },
      { sourceRef: "verdict:cl-1", status: "active" as const },
    ];
    expect([...ingestedMaterialIds(evidence)].toSorted()).toEqual(["mat-e", "mat-f", "mat-g", "mat-h", "mat-i"]);
    expect(materialIdsOfRef("verdict:cl-1")).toEqual([]);
    expect(materialIdsOfRef(null)).toEqual([]);
    expect(materialIdsOfRef("mat-e")).toEqual(["mat-e"]);
  });

  test("合成的每一条压成一行、太长截断", () => {
    const { t, source } = setup();
    const long = "很长的一段话".repeat(50);
    for (let i = 0; i <= DIGEST_OVER; i++) record(t, { kind: "own_writing", text: i === 0 ? `${long}\n第二行` : `第 ${i} 封`, time: `2026-10-05T1${i}:00:00.000+08:00` }, MAIL);
    const [digest] = source().read();
    const lines = digest!.text.split("\n");
    expect(lines).toHaveLength(DIGEST_OVER + 2);
    expect(lines[1]!.startsWith(`- ${long.slice(0, 200)}…（时间 10:00）`)).toBe(true);
  });
});
