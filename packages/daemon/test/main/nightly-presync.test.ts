// 主切面：每晚整理之前先把数据源同步一遍。真的守护进程走组合根和插件清单，假数据源插件（helpers/fake-data-source.ts）经
// extraPlugins 接上，记忆插件开着、整理模型是假的（不联网、不调真模型），时钟手动拨。一个守护进程过三夜：
// 1. 远端有前一天的两条、还没同步（定期导入是 04:00）：03:00 整理之前被同步了一次（记成定期的那种），这两条这一夜就读成证据；
//    整理记录和记忆页的概览写着"同步了假数据源、新增 2 条"，只有它一个——手机这类设备交来的、只靠导入文件夹的（假账单）、
//    没连的 Google、Looki 都不在里面；
// 2. 02:55 刚点过"立即同步"：03:00 不再同步，记"刚同步过"；
// 3. 同步卡住了：等到上限（3 分钟）就不等，整理照常跑完，记录里写"没同步上"；卡住的那次放行后照常记下。
import { type ChatRequest, FakeChatModel } from "@ergo/memory";
import { nowIso } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { Material } from "../../src/materials/types.ts";
import { MEMORY_NIGHTLY_EVENT, type MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { NIGHTLY_SYNC_WAIT_MS } from "../../src/memory/nightly-sync.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { FAKE_CHANNEL, FAKE_KEY, FAKE_SOURCE_ID, fakeDataSourcePlugin, fakeRemote, resetFakeRemote } from "../helpers/fake-data-source.ts";
import { dataSourcesApi, memoryApi } from "../helpers/http.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm:ss */
const at = (m: number, d: number, hh: number, mm = 0, ss = 0) => new Date(2026, m - 1, d, hh, mm, ss);
const iso = (m: number, d: number, hh: number, mm = 0) => nowIso(at(m, d, hh, mm));

/** 假整理模型：抽事实那一步给每条证据一条事实，别的步骤回空 */
function memoryModel() {
  return () =>
    new FakeChatModel((request: ChatRequest) => {
      if (request.purpose !== "extract") return {};
      const ids = [...request.user.matchAll(/"evidence_id":"(ev-\d+)"/g)].map((m) => m[1]!);
      return { facts: ids.map((id) => ({ evidence_id: id, predicate: "participated_in", object: { name: `一件事（${id}）`, type: "activity" }, negated: false, context: [], statement: `用户做了一件事（${id}）`, span: "一件事" })) };
    });
}

/** 推理库里的证据的出处（素材 id） */
function evidenceRefs(td: TestDaemon): Set<string> {
  const rg = openDatabase(td.daemon.layout.rgDb);
  try {
    return new Set(rg.all<{ source_ref: string | null }>("SELECT source_ref FROM evidence").flatMap((r) => (r.source_ref === null ? [] : [r.source_ref])));
  } finally {
    rg.close();
  }
}

/** 某一夜最后记下的那条整理记录 */
const recordOf = (td: TestDaemon, night: string): MemoryNightlyRecord | undefined =>
  td.daemon.store
    .read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT)
    .map((e) => e.payload as MemoryNightlyRecord)
    .filter((r) => r.night === night)
    .at(-1);
const fakeMaterials = (td: TestDaemon): Material[] => td.daemon.materials.list().filter((m) => m.ref.event.channel === FAKE_CHANNEL);

describe("每晚整理之前先把数据源同步一遍（假数据源插件走真实装配路径）", () => {
  it("整理前同步一次、新导入的这一夜就读进来；刚同步过的不再同步；卡住的等到上限就跳过", { timeout: 180_000 }, async () => {
    resetFakeRemote();
    const clock = new ManualClock(at(10, 7, 18, 0));
    const td = await startTestDaemon({ clock, memoryPlugin: true, memoryModel: memoryModel(), extraPlugins: [fakeDataSourcePlugin] });
    let release: (() => void) | undefined;
    try {
      expect((await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: "401-key" })).status).toBe(200);

      // ---- 第一夜：远端有前一天的两条，定期导入（04:00）还没到 ----
      fakeRemote.next = [
        { kind: "observed_behavior", text: "傍晚去游了泳", at: iso(10, 7, 19, 0), sensitive: [] },
        { kind: "own_writing", text: "明天的会我来主持", at: iso(10, 7, 21, 0), sensitive: [] },
      ];
      expect(fakeMaterials(td)).toEqual([]);
      clock.advanceTo(at(10, 8, 3, 0));
      await td.daemon.internalJobs.whenIdle();
      // 整理之前被同步了一次，记成定期的那种
      expect(fakeRemote.syncs).toEqual(["scheduled"]);
      const pulled = fakeMaterials(td);
      expect(pulled.map((m) => m.time).toSorted()).toEqual([iso(10, 7, 19, 0), iso(10, 7, 21, 0)]);
      // 这一夜就读成了证据
      const refs = evidenceRefs(td);
      expect(pulled.every((m) => refs.has(m.id))).toBe(true);
      const first = recordOf(td, "2026-10-08")!;
      expect(first.state).toBe("ran");
      // 只有假数据源：手机这类设备交来的、只靠导入文件夹的、没连的都不在里面
      expect(first.sourceSync).toEqual({ waitMinutes: NIGHTLY_SYNC_WAIT_MS / 60_000, sources: [{ id: FAKE_SOURCE_ID, title: "假数据源", state: "synced", added: 2 }] });
      // 记忆页的概览带着它
      const summary = await memoryApi.summary(td.url);
      expect(summary.body.lastNight?.sourceSync).toEqual(first.sourceSync);
      // 数据源页上"上次同步"是这一次
      expect((await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === FAKE_SOURCE_ID)?.lastSync).toMatchObject({ trigger: "scheduled", added: 2 });

      // ---- 第二夜：02:55 刚点过"立即同步"，03:00 不再同步 ----
      clock.advanceTo(at(10, 9, 2, 55));
      await td.daemon.internalJobs.whenIdle();
      fakeRemote.syncs = [];
      expect((await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "sync", idempotencyKey: "401-sync" })).status).toBe(200);
      clock.advanceTo(at(10, 9, 3, 0));
      await td.daemon.internalJobs.whenIdle();
      expect(fakeRemote.syncs).toEqual(["manual"]);
      expect(recordOf(td, "2026-10-09")).toMatchObject({ state: "ran", sourceSync: { sources: [{ id: FAKE_SOURCE_ID, state: "fresh" }] } });

      // ---- 第三夜：同步卡住了，等到上限就不等 ----
      clock.advanceTo(at(10, 9, 12, 0));
      await td.daemon.internalJobs.whenIdle();
      fakeRemote.gate = new Promise<void>((resolve) => (release = resolve));
      fakeRemote.next = ["夜里才传上来的一条"];
      fakeRemote.syncs = [];
      clock.advanceTo(at(10, 10, 3, 0));
      // 整理在等这一次同步（还没写记录）
      await expect.poll(() => fakeRemote.syncs, { timeout: 60_000 }).toEqual(["scheduled"]);
      expect(recordOf(td, "2026-10-10")).toBeUndefined();
      // 到了上限：不等了，整理照常跑完，记录里写明没同步上
      clock.advanceTo(at(10, 10, 3, 3, 1));
      await td.daemon.internalJobs.whenIdle();
      const third = recordOf(td, "2026-10-10")!;
      expect(third.state).toBe("ran");
      expect(third.sourceSync).toEqual({ waitMinutes: 3, sources: [{ id: FAKE_SOURCE_ID, title: "假数据源", state: "timeout" }] });
      expect(fakeMaterials(td).some((m) => m.time.startsWith("2026-10-10"))).toBe(false);
      // 卡住的那次放行后照常同步完、记下（导进来的下一次整理读）
      release?.();
      release = undefined;
      await expect.poll(async () => (await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === FAKE_SOURCE_ID)?.lastSync?.added, { timeout: 15_000 }).toBe(1);
    } finally {
      release?.();
    }
  });

  it("守护进程停着错过了 03:00：开机补跑的那一夜等数据源的服务起来，和开机补的那次同步是同一次，导进来的照样这一夜读", { timeout: 120_000 }, async () => {
    resetFakeRemote();
    const clock = new ManualClock(at(10, 7, 18, 0));
    const td = await startTestDaemon({ clock, memoryPlugin: true, memoryModel: memoryModel(), extraPlugins: [fakeDataSourcePlugin] });
    expect((await dataSourcesApi.act(td.url, FAKE_SOURCE_ID, { action: "configure", values: { key: FAKE_KEY }, idempotencyKey: "401-catchup-key" })).status).toBe(200);
    await td.daemon.stop();

    // 夜里关着机：远端多了前一天的一条；第二天 09:00 才开机，整理（03:00）和定期导入（04:00）都错过了
    fakeRemote.next = [{ kind: "observed_behavior", text: "晚上去看了场电影", at: iso(10, 7, 20, 0), sensitive: [] }];
    const morning = new ManualClock(at(10, 8, 9, 0));
    const again = await startTestDaemon({ reuse: { dataDir: td.dataDir, homeDir: td.homeDir }, clock: morning, memoryPlugin: true, memoryModel: memoryModel(), extraPlugins: [fakeDataSourcePlugin] });
    await expect.poll(() => recordOf(again, "2026-10-08")?.state, { timeout: 60_000 }).toBe("ran");
    await again.daemon.internalJobs.whenIdle();
    const record = recordOf(again, "2026-10-08")!;
    expect(record.trigger).toBe("catch_up");
    // 只同步了一次：开机补的那次定期导入和整理之前要的是同一次（整理问到时它还在跑就记同步完、新增 1 条，已经跑完了就记刚同步过）
    expect(fakeRemote.syncs).toEqual(["scheduled"]);
    expect(record.sourceSync?.sources).toHaveLength(1);
    const [only] = record.sourceSync!.sources;
    expect(only).toMatchObject({ id: FAKE_SOURCE_ID, title: "假数据源" });
    expect(only!.state === "fresh" || (only!.state === "synced" && only!.added === 1)).toBe(true);
    // 整理等到了数据源的服务起来、开机补的同步导完才读素材：这一条这一夜就读成了证据
    const [movie] = fakeMaterials(again);
    expect(movie?.time).toBe(iso(10, 7, 20, 0));
    expect(evidenceRefs(again).has(movie!.id)).toBe(true);
  });
});
