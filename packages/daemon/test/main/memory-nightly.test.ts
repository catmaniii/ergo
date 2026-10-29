// 主切面：记忆插件的每晚整理（225 号票）。走真实的装配路径：守护进程起来就建好推理库，03:00 的内部作业到点整理一次，
// 整理记录落进事件日志和派生视图；运行中停用记忆插件后作业撤掉、下一夜不再跑，推理库和素材都留着。
// 236 号票起抽事实默认走模型版：假模型交回的一批事实落进 rg.db（manifest 记 model:<名>），不联网、不调真模型。
// 模型是假的（memoryModel），不联网、不调真模型；时钟是手动拨的。
import fs from "node:fs";
import { type ChatRequest, FakeChatModel } from "@ergo/memory";
import { CHANNELS, EVENT_TYPES } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { MEMORY_NIGHTLY_EVENT } from "../../src/memory/nightly-record.ts";
import { INTERNAL_CHANNEL } from "../../src/scheduler/internal-jobs.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";

const { secretary: SECRETARY } = CHANNELS;

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

/** 假模型的回复：抽事实那一步给这一批每条证据一条事实，别的步骤回空 */
function fakeMemoryModel(request: ChatRequest): unknown {
  if (request.purpose !== "extract") return {};
  const ids = [...request.user.matchAll(/"evidence_id":"(ev-\d+)"/g)].map((m) => m[1]!);
  return {
    facts: ids.map((id) => ({
      evidence_id: id,
      predicate: "prefers",
      object: { name: `周末自己安排时间（${id}）`, type: "activity" },
      negated: false,
      context: ["weekend"],
      statement: `用户想自己安排周末（${id}）`,
      span: "周末想好好休息",
    })),
  };
}

describe("记忆插件的每晚整理", () => {
  it("守护进程起来就建好 rg.db；03:00 到点整理、写整理记录；运行中停用后作业撤掉、下一夜不再跑、库和素材都留着", { timeout: 60_000 }, async () => {
    const clock = new ManualClock(at(10, 7, 2, 0));
    const td = await startTestDaemon({
      clock,
      // 265 号票：给了 clock 时底座默认停掉记忆插件；这里测的就是它 03:00 的整理，打开
      memoryPlugin: true,
      // 假模型（和后台的 faux 秘书一样，测试里永远不连真的 DeepSeek）
      memoryModel: () => new FakeChatModel(fakeMemoryModel),
      secretary: [{ kind: "reply", text: "好。" }],
    });
    const rgDb = td.daemon.layout.rgDb;
    expect(fs.existsSync(rgDb)).toBe(true);
    expect(td.daemon.internalJobs.state("memory-nightly")).toMatchObject({ job: "memory-nightly" });

    // 用户说一句话（采成素材），02:00 还没到点
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("这周六的聚会我就不去了，最近周末想好好休息。");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const records = (): MemoryNightlyRecord[] => td.daemon.store.read(INTERNAL_CHANNEL, 0, MEMORY_NIGHTLY_EVENT).map((event) => event.payload as MemoryNightlyRecord);

    clock.advanceTo(at(10, 7, 2, 59));
    await td.daemon.internalJobs.whenIdle();
    expect(records()).toEqual([]);

    // 03:00 到点：整理一次，事件日志和整理记录视图里都有
    clock.advanceTo(at(10, 7, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    const nightly = records();
    expect(nightly).toHaveLength(1);
    expect(nightly[0]).toMatchObject({ state: "ran", night: "2026-10-07", trigger: "scheduled", budgetExhausted: false, pendingEvidence: 0 });
    expect(nightly[0]!.processedEvidence).toBeGreaterThan(0);
    const row = td.daemon.store.reader.get<{ record: string }>("SELECT record FROM memory_nightly WHERE night = ?", "2026-10-07");
    expect(row).toBeDefined();
    expect(JSON.parse(row!.record)).toEqual(nightly[0]);
    expect(td.daemon.inbox.list().filter((item) => item.kind === "notice" && item.notice === "memory_nightly_failed")).toEqual([]);
    // 抽事实走的是模型版（manifest 记 model:<名>，事实的 extracted_by 也是它）
    const rg = openDatabase(rgDb);
    try {
      const manifest = Object.fromEntries(rg.all<{ key: string; value: string }>("SELECT key, value FROM rg_manifest").map((r) => [r.key, r.value]));
      expect(manifest.extractor).toBe("model:fake-llm");
      const extracted = rg.all<{ extracted_by: string }>("SELECT DISTINCT extracted_by FROM facts");
      expect(extracted.map((f) => f.extracted_by)).toEqual(["model:fake-llm"]);
    } finally {
      rg.close();
    }

    // 运行中停用：作业撤掉，下一夜 03:00 不再跑；rg.db 和素材一条不少
    const materials = td.daemon.materials.list().map((material) => material.id);
    expect(materials.length).toBeGreaterThan(0);
    expect(await td.daemon.plugins.disable("memory")).toContain("memory");
    expect(td.daemon.plugins.report().disabled).toContain("memory");
    const before = records().length;
    clock.advanceTo(at(10, 8, 3, 0));
    await td.daemon.internalJobs.whenIdle();
    expect(records()).toHaveLength(before);
    expect(fs.existsSync(rgDb)).toBe(true);
    expect(td.daemon.materials.list().map((material) => material.id)).toEqual(materials);

    // 移除时写明的：rg.db 保留、不删原文
    const removal = td.daemon.plugins.removalOf("memory");
    expect(removal).toBeDefined();
    expect(removal!.keeps.join("\n")).toContain("rg.db");
    expect(removal!.keeps.join("\n")).toContain("素材");
  });
});
