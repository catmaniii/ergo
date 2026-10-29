// 主切面：数据源素材的种类和证据性质（303 号票，issue 25 第 2 节）。真的守护进程走组合根和插件清单，假数据源插件
// （helpers/fake-data-source.ts）经 extraPlugins 接上，记忆插件开着、整理模型是假的（不联网、不调真模型），时钟手动拨：
// - 三类素材各进一条（观察到的本人行为、别人写给你的、本人写的）：素材信封带种类、来源数据源、场景、敏感类别；别人写给你的
//   只留摘要（正文只进检索、不进切段、没有原文副本）；
// - 03:00 整理时读成证据：行为是本人做的（observed，能撑结论）、别人写的是别人转述的（只当背景）、本人写的是本人说的；
//   场景带进证据（原文后面一行"［场景］"给整理模型读、场景标签按日子和插件给的标签）；
// - 敏感类别：默认都不用于推断——落在健康里的那条不进推理库，位置没打开时证据里不带地点；
// - 重启时打开健康、位置：启动对一遍，带了地点会变样的那条从推理库撤掉，下一夜带着地点重新读进来，健康那条也进来。
import fs from "node:fs";
import path from "node:path";
import { assertionFor, canSupportUserClaims, type ChatRequest, type Evidence, FakeChatModel } from "@ergo/memory";
import { nowIso } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { Material } from "../../src/materials/types.ts";
import { MEMORY_NIGHTLY_EVENT, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { FAKE_CHANNEL, FAKE_KEY, FAKE_SOURCE_ID, fakeDataSourcePlugin, fakeRemote, resetFakeRemote } from "../helpers/fake-data-source.ts";
import { dataSourcesApi } from "../helpers/http.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const iso = (m: number, d: number, hh: number, mm = 0) => nowIso(at(m, d, hh, mm));

/** 假整理模型：抽事实那一步给每条证据一条事实，别的步骤回空；记下每个请求（看场景有没有带给模型） */
function memoryModel(requests: ChatRequest[]) {
  return () =>
    new FakeChatModel((request) => {
      requests.push(request);
      if (request.purpose !== "extract") return {};
      const ids = [...request.user.matchAll(/"evidence_id":"(ev-\d+)"/g)].map((m) => m[1]!);
      return { facts: ids.map((id) => ({ evidence_id: id, predicate: "participated_in", object: { name: `一件事（${id}）`, type: "activity" }, negated: false, context: [], statement: `用户做了一件事（${id}）`, span: "一件事" })) };
    });
}

interface EvidenceRow {
  source_level: Evidence["sourceLevel"];
  mode: Evidence["mode"];
  kind: Evidence["kind"];
  text: string;
  context: string;
  status: Evidence["status"];
  source_ref: string | null;
}

/** 推理库里的证据，按出处（素材 id）找 */
function evidenceByMaterial(td: TestDaemon): Map<string, EvidenceRow> {
  const rg = openDatabase(td.daemon.layout.rgDb);
  try {
    const rows = rg.all<EvidenceRow>("SELECT source_level, mode, kind, text, context, status, source_ref FROM evidence");
    return new Map(rows.filter((r) => r.source_ref !== null).map((r) => [r.source_ref!, r]));
  } finally {
    rg.close();
  }
}

const nightlyRecords = (td: TestDaemon) => td.daemon.store.read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT).map((e) => e.payload as MemoryNightlyRecord);
const fakeMaterials = (td: TestDaemon): Material[] => td.daemon.materials.list().filter((m) => m.ref.event.channel === FAKE_CHANNEL);

describe("数据源素材的种类和证据性质（假数据源插件走真实装配路径）", () => {
  it("三类素材各进一条：证据性质对、场景带过去；敏感类别关着时不进推断，打开后重启补上", { timeout: 120_000 }, async () => {
    resetFakeRemote();
    const requests: ChatRequest[] = [];
    const clock = new ManualClock(at(10, 7, 18, 0));
    const td = await startTestDaemon({ clock, memoryPlugin: true, memoryModel: memoryModel(requests), extraPlugins: [fakeDataSourcePlugin] });
    expect((await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: "303-key" })).status).toBe(200);

    // 一次同步拉回四条：观察到的本人行为（带结束时间、地点、和谁、场景标签）、别人写给你的、本人写的、落在健康里的一条行为
    fakeRemote.next = [
      { kind: "observed_behavior", text: "开了两个会", at: iso(10, 7, 14, 0), end: iso(10, 7, 17, 0), place: "望京的公司", people: ["张三"], tags: ["work", "not-a-scene"], sensitive: [] },
      { kind: "received_writing", text: "张三：周五的会改到下午 3 点", body: "周五的会改到下午 3 点，还在老地方，记得带上周报。", at: iso(10, 7, 15, 0), people: ["张三"], sensitive: [] },
      { kind: "own_writing", text: "好的，周五下午见", at: iso(10, 7, 15, 30), people: ["张三"], sensitive: [] },
      { kind: "observed_behavior", text: "晚上跑了 5 公里", at: iso(10, 7, 20, 0), sensitive: ["health"] },
    ];
    const synced = await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "sync", idempotencyKey: "303-sync" });
    expect(synced.body).toMatchObject({ added: 4 });
    await expect.poll(() => fakeMaterials(td).length, { timeout: 15_000 }).toBe(4);

    // 素材信封：种类、说或做、来源等级；出处是哪个数据源、场景、敏感类别
    const [met, mail, reply, run] = fakeMaterials(td).toSorted((a, b) => a.time.localeCompare(b.time));
    expect([met, mail, reply, run].map((m) => [m!.kind, m!.mode, m!.source])).toEqual([
      ["observed_behavior", "do", "self"],
      ["received_writing", "say", "external_untrusted"],
      ["own_writing", "say", "self"],
      ["observed_behavior", "do", "self"],
    ]);
    expect(met!.origin).toEqual({ dataSource: FAKE_SOURCE_ID, scene: { end: iso(10, 7, 17, 0), place: "望京的公司", people: ["张三"], tags: ["work", "not-a-scene"] }, sensitive: [] });
    expect(run!.origin).toMatchObject({ dataSource: FAKE_SOURCE_ID, sensitive: ["health"] });
    // 别人写给你的：只留摘要当引用的说明，正文不进切段、没有原文副本，但检索得到
    expect(mail!.segments).toEqual([expect.objectContaining({ form: "quote", source: "external_untrusted", label: "张三：周五的会改到下午 3 点" })]);
    expect(mail!.segments[0]!.text).toBeUndefined();
    expect(mail!.original).toBeNull();
    expect(td.daemon.materials.searchKeyword("记得带上周报").map((m) => m.id)).toEqual([mail!.id]);
    // 本人的（行为、本人写的）照样留原文副本；地点、和谁也检索得到
    const layout = dataDirLayout(td.dataDir);
    expect([met, reply].every((m) => m!.original !== null && fs.existsSync(path.join(layout.materials, m!.original.path)))).toBe(true);
    expect(td.daemon.materials.searchKeyword("望京的公司").map((m) => m.id)).toEqual([met!.id]);

    // 次日 03:00 整理：读成证据
    clock.advanceTo(at(10, 8, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(nightlyRecords(td).at(-1)).toMatchObject({ state: "ran", night: "2026-10-08" });
    const first = evidenceByMaterial(td);

    // 观察到的本人行为：本人做的，能撑关于用户的结论；场景带过去（时间段、和谁；位置没打开推断，不带地点）
    const did = first.get(met!.id)!;
    expect([did.source_level, did.mode, did.kind]).toEqual(["self", "do", "action"]);
    expect(assertionFor({ sourceLevel: did.source_level, mode: did.mode })).toBe("observed");
    expect(canSupportUserClaims({ sourceLevel: did.source_level, status: did.status })).toBe(true);
    expect(did.text).toBe("开了两个会\n［场景］时间 14:00–17:00 · 和 张三");
    // 场景标签：插件给的场景维度标签（不认得的丢掉）加上那天是工作日
    expect(JSON.parse(did.context)).toEqual(["work", "workday"]);

    // 别人写给你的：别人转述的，只当背景、不撑结论；原文是摘要（正文不进推理库）
    const told = first.get(mail!.id)!;
    expect([told.source_level, told.mode, told.kind]).toEqual(["untrusted", "say", "utterance"]);
    expect(assertionFor({ sourceLevel: told.source_level, mode: told.mode })).toBe("third_party_reported");
    expect(canSupportUserClaims({ sourceLevel: told.source_level, status: told.status })).toBe(false);
    expect(told.text).toBe("张三：周五的会改到下午 3 点\n［场景］时间 15:00 · 和 张三");
    expect(told.text).not.toContain("周报");

    // 本人写的：本人说的
    const wrote = first.get(reply!.id)!;
    expect([wrote.source_level, wrote.mode, wrote.kind]).toEqual(["self", "say", "utterance"]);
    expect(assertionFor({ sourceLevel: wrote.source_level, mode: wrote.mode })).toBe("user_stated");
    expect(canSupportUserClaims({ sourceLevel: wrote.source_level, status: wrote.status })).toBe(true);

    // 落在健康里的那条：健康没打开推断，不进推理库
    expect(first.has(run!.id)).toBe(false);
    // 场景一行交给了抽事实的模型
    expect(requests.some((r) => r.purpose === "extract" && r.user.includes("［场景］时间 14:00–17:00 · 和 张三"))).toBe(true);
    expect(requests.every((r) => !r.user.includes("望京的公司"))).toBe(true);
    await td.daemon.stop();

    // 打开健康、位置以后重启：启动时对一遍，带了地点会变样的那条撤掉；下一夜带着地点重新读进来，健康那条也进来
    const clock2 = new ManualClock(at(10, 8, 10, 0));
    const again = await startTestDaemon({
      reuse: { dataDir: td.dataDir, homeDir: td.homeDir },
      clock: clock2,
      memoryPlugin: true,
      memoryModel: memoryModel(requests),
      extraPlugins: [fakeDataSourcePlugin],
      config: { memory: { sensitiveCategories: ["health", "location"] } },
    });
    const reconciled = evidenceByMaterial(again);
    expect(reconciled.has(met!.id)).toBe(false);
    expect(reconciled.get(mail!.id)?.status).toBe("active");
    expect(reconciled.get(reply!.id)?.status).toBe("active");
    clock2.advanceTo(at(10, 9, 3, 0));
    await again.daemon.internalJobs.whenIdle();
    expect(nightlyRecords(again).at(-1)).toMatchObject({ state: "ran", night: "2026-10-09" });
    const second = evidenceByMaterial(again);
    expect(second.get(met!.id)?.text).toBe("开了两个会\n［场景］时间 14:00–17:00 · 地点 望京的公司 · 和 张三");
    const ran = second.get(run!.id)!;
    expect([ran.source_level, ran.mode, ran.kind, ran.text]).toEqual(["self", "do", "action", "晚上跑了 5 公里\n［场景］时间 20:00"]);
    // 别人写的、本人写的那两条没变，不重读
    expect(second.get(mail!.id)).toEqual(reconciled.get(mail!.id));
  });
});
