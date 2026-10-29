// 数据源的素材写法（303 号票，模块层）：dataSourceMaterial 把插件的一条记录写成素材草稿；素材库是真的（materials.db、素材区）。
// 覆盖：三种素材各自的来源等级、说或做、切段（别人写给你的只留摘要、正文只进检索）；出处（数据源、场景整理成确定的样子、
// 敏感类别不写是数据源登记的全部）；出处存进 materials.db、本人的进原文副本（删了 materials.db 重建照样在）；地点、和谁检索得到；
// 旧版本的 materials.db（没有 origin 这一列）打开时补上。
import { describe, expect, test } from "vitest";
import type { DataSource } from "../../src/data-sources/api.ts";
import { dataSourceMaterial, type DataSourceRecordMaterial } from "../../src/data-sources/material.ts";
import type { MaterialSource } from "../../src/materials/capture.ts";
import { sha256Hex } from "../../src/materials/segments.ts";
import { materialsSetup } from "../materials/helpers.ts";

const CAMERA: Pick<DataSource, "id" | "sensitive"> = { id: "camera", sensitive: ["location", "health"] };
const RECORD_EVENT = "test-data-source-record" as never;
const recordSource: MaterialSource = { name: "test-data-source-record", eventType: RECORD_EVENT, capture: (event) => [dataSourceMaterial(CAMERA, event.payload as DataSourceRecordMaterial)] };

describe("dataSourceMaterial：一条记录写成素材草稿", () => {
  test("三种素材：来源等级和切段跟着种类走", () => {
    const did = dataSourceMaterial(CAMERA, { kind: "observed_behavior", text: "开了两个会", recordId: "r-1" });
    expect(did).toMatchObject({ kind: "observed_behavior", source: "self", ref: { recordId: "r-1" } });
    expect(did.segments).toEqual([{ form: "text", source: "self", notes: [], locator: { field: "text" }, text: "开了两个会", sha256: sha256Hex("开了两个会") }]);

    const told = dataSourceMaterial(CAMERA, { kind: "received_writing", text: "张三：周五的会改到下午", indexText: "邮件正文", field: "subject" });
    expect(told).toMatchObject({ kind: "received_writing", source: "external_untrusted", indexText: "邮件正文" });
    // 别人写的：一段引用块，只留摘要当说明和正文的哈希，没有原文
    expect(told.segments).toEqual([{ form: "quote", source: "external_untrusted", notes: [], locator: { field: "subject" }, label: "张三：周五的会改到下午", sha256: sha256Hex("邮件正文") }]);

    const wrote = dataSourceMaterial(CAMERA, { kind: "own_writing", text: "好的，周五下午见" });
    expect(wrote).toMatchObject({ kind: "own_writing", source: "self" });
    expect(wrote.segments.map((s) => [s.form, s.source, s.text])).toEqual([["typed", "self", "好的，周五下午见"]]);
  });

  test("出处：数据源 id；场景去掉空白的、重复的，空的项不写；敏感类别不写是登记的全部，写了照写的", () => {
    const draft = dataSourceMaterial(CAMERA, { kind: "observed_behavior", text: "散步", time: "2026-10-07T07:00:00.000+08:00", scene: { place: "  ", people: ["妈妈", " 妈妈 ", ""], tags: ["leisure", "leisure"] } });
    expect(draft.time).toBe("2026-10-07T07:00:00.000+08:00");
    expect(draft.origin).toEqual({ dataSource: "camera", scene: { people: ["妈妈"], tags: ["leisure"] }, sensitive: ["location", "health"] });
    expect(dataSourceMaterial(CAMERA, { kind: "observed_behavior", text: "开会", sensitive: [] }).origin?.sensitive).toEqual([]);
    expect(dataSourceMaterial({ id: "notes" }, { kind: "own_writing", text: "日记" }).origin).toEqual({ dataSource: "notes", scene: {}, sensitive: [] });
  });
});

describe("素材库里的数据源素材", () => {
  test("出处存进 materials.db，本人的进原文副本；删了 materials.db 重建照样在；地点、和谁、外部正文检索得到", async () => {
    const t = materialsSetup({ sources: [recordSource] });
    t.store.append({ channel: "test-data-source", type: RECORD_EVENT, payload: { kind: "observed_behavior", text: "开了两个会", scene: { place: "望京的公司", people: ["张三丰"] }, sensitive: [] } satisfies DataSourceRecordMaterial });
    t.store.append({ channel: "test-data-source", type: RECORD_EVENT, payload: { kind: "received_writing", text: "李四：周报收到了", indexText: "周报收到了，下周一再对一下数字" } satisfies DataSourceRecordMaterial });
    const [did, told] = t.materials.list();
    expect(did!.origin).toEqual({ dataSource: "camera", scene: { place: "望京的公司", people: ["张三丰"] }, sensitive: [] });
    expect(did!.original).not.toBeNull();
    expect(told!.original).toBeNull();
    expect(t.materials.readOriginal(did!)?.origin).toEqual(did!.origin);
    expect(t.materials.searchKeyword("望京的公司").map((m) => m.id)).toEqual([did!.id]);
    expect(t.materials.searchKeyword("张三丰").map((m) => m.id)).toEqual([did!.id]);
    expect(t.materials.searchKeyword("对一下数字").map((m) => m.id)).toEqual([told!.id]);

    await t.reopen({ deleteMaterialsDb: true });
    expect(t.materials.list().map((m) => [m.id, m.origin])).toEqual([
      [did!.id, did!.origin],
      [told!.id, told!.origin],
    ]);
  });

  test("旧版本的 materials.db（没有 origin 这一列）打开时补上，已有的素材没有出处、新来的有", async () => {
    const t = materialsSetup({ sources: [recordSource] });
    t.store.append({ channel: "test-data-source", type: RECORD_EVENT, payload: { kind: "own_writing", text: "第一条" } satisfies DataSourceRecordMaterial });
    await t.reopen({ materialsDbSql: ["ALTER TABLE materials DROP COLUMN origin", "PRAGMA user_version = 2"] });
    t.store.append({ channel: "test-data-source", type: RECORD_EVENT, payload: { kind: "own_writing", text: "第二条" } satisfies DataSourceRecordMaterial });
    const [old, fresh] = t.materials.list();
    expect(old!.origin).toBeUndefined();
    expect(fresh!.origin).toMatchObject({ dataSource: "camera" });
  });
});
