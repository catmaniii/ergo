// 离线回放脚本（224 号票）的测试：摘要数得准（素材数、证据数、来源级别、场景分布、没读的为什么）；
// 真库走"复制一份到临时目录再读"那条路，原来的库一个字节都不动；假素材在没有真实数据时也跑得通。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ManualClock } from "../helpers/clock.ts";
import { materialsSetup, postMessage, text } from "../materials/helpers.ts";
import { fakeMaterials, replayMaterialsDb, replaySource, summarizeMaterials, summaryLine } from "./replay-materials.ts";

const NOW = new Date("2026-10-08T09:00:00+08:00");
const hashOf = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("离线回放", () => {
  test("假素材上跑通：素材数、证据数、来源级别、场景分布、没读的都对得上", () => {
    const summary = summarizeMaterials({ list: fakeMaterials }, new ManualClock(NOW));
    expect(summary.materials).toBe(3);
    expect(summary.evidence).toBe(2);
    expect(summary.bySourceLevel).toEqual({ self: 1, agent: 0, untrusted: 0, system: 1 });
    // 第一条说"周六和朋友聚餐"、没有管线以外的场景标签 → 从原文推成周末 + 社交；第二条只有管线标签 tool:bash → 空场景
    expect(summary.scenes).toEqual({ weekend: 1, social: 1 });
    expect(summary.noScene).toBe(1);
    // 标了别推断的那条不读
    expect(summary.skipped).toEqual({ noInfer: 1, emptyText: 0 });

    const line = summaryLine(summary);
    expect(line).toContain("素材 3 条");
    expect(line).toContain("证据 2 条");
    expect(line).toContain("self 1、system 1");
    expect(line).toContain("别推断 1");
    expect(line).not.toContain("\n");
  });

  test("把 materials.db 复制一份到临时目录再读：摘要和原库对得上，原来的库一个字节不动", async () => {
    const t = materialsSetup();
    postMessage(t.store, [text("周末和朋友吃饭")]);
    postMessage(t.store, [text("下个月要搬家了")]);
    const db = path.join(t.dbDir, "materials.db");
    const before = hashOf(db);
    const ids = t.materials.list().map((m) => m.id);
    const events = t.store.lastGlobalSeq();

    const summary = await replayMaterialsDb({ source: db, clock: t.clock });

    expect(summary.materials).toBe(2);
    expect(summary.evidence).toBe(2);
    expect(summary.bySourceLevel).toEqual({ self: 2, agent: 0, untrusted: 0, system: 0 });
    expect(summary.scenes.weekend).toBe(1);
    // 原库：素材一条没少、事件一条没多、文件没被动过
    expect(t.materials.list().map((m) => m.id)).toEqual(ids);
    expect(t.store.lastGlobalSeq()).toBe(events);
    expect(hashOf(db)).toBe(before);
  });

  test("拿不到真实数据时用假素材跑（脚本的降级路径），照样打印一行摘要", async () => {
    const t = materialsSetup();
    const summary = await replaySource({ source: path.join(t.dbDir, "没有这个库.db"), clock: t.clock });
    expect(summary.materials).toBe(3);
    expect(summary.evidence).toBe(2);
    expect(summaryLine(summary)).toContain("素材 3 条");
  });
});
