// 235 号票：记忆插件在假宿主里的装配（真的插件、真的插件宿主，内核是临时目录里的真实现；不碰真实守护进程和用户数据）。
// 覆盖：插件开着时每晚整理作业排上、到点跑、停用后撤销（下一夜不再跑、rg.db 留着）；memory.enabled = false 时不排作业、
// 不建库但登记着手动整理的入口；手动整理一次走同一份作业、受同一夜一次的限制；整理关着时点了回原因、不跑。
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { isAsyncQuickAction } from "../../src/quick-actions/index.ts";
import { createMemoryPluginHost, nightlyRecords, silentChat } from "./plugin-host.ts";

/** 本地时间 2026 年 10 月 d 日 hh:mm */
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm);

/** 手动整理一次这个快速动作（假宿主里的登记） */
function nightlyAction(t: Awaited<ReturnType<typeof createMemoryPluginHost>>) {
  const executor = t.quickActions.get("memory_nightly");
  if (!executor) throw new Error("手动整理的入口应该登记着");
  if (!isAsyncQuickAction(executor)) throw new Error("手动整理应该是异步执行器（perform）");
  return executor;
}

const context = { actionId: "qa-1", cardId: "card-1", conversation: "secretary", basis: "confirmed" } as const;

describe("记忆插件在假宿主里（235 号票）", () => {
  it("开着：每晚整理的作业排上、到点跑一次；运行中停用后作业撤销、下一夜不再跑，rg.db 留着", async () => {
    // 不给模型：到点照旧跑，记一条"没配 key"的 skipped（不联网、不花钱）
    const t = await createMemoryPluginHost({ at: at(10, 9) });
    try {
      expect(t.internalJobs.state("memory-nightly")).toBeDefined();
      expect(fs.existsSync(t.layout.rgDb)).toBe(true);
      // 手动整理的入口和记忆命令都登记着（同一张快速动作登记表）
      expect(t.quickActions.get("memory_nightly")).toBeDefined();
      expect(t.quickActions.get("remember")).toBeDefined();

      t.clock.advanceTo(at(11, 3));
      await t.internalJobs.whenIdle();
      const ran = nightlyRecords(t.store);
      expect(ran).toHaveLength(1);
      expect(ran[0]).toMatchObject({ night: "2026-10-11", state: "skipped", trigger: "scheduled" });
      const stateBefore = t.internalJobs.state("memory-nightly");

      // 运行中停用：作业撤销（不再排下一次），rg.db 不删
      expect(await t.host.disable("memory")).toContain("memory");
      t.clock.advanceTo(at(12, 3));
      await t.internalJobs.whenIdle();
      expect(nightlyRecords(t.store)).toHaveLength(1);
      expect(t.internalJobs.state("memory-nightly")).toEqual(stateBefore);
      expect(fs.existsSync(t.layout.rgDb)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("memory.enabled = false：不排作业、不建 rg.db；手动整理的入口还登记着（点了回关着）", async () => {
    const t = await createMemoryPluginHost({ at: at(10, 9), config: { memory: { enabled: false } } });
    try {
      expect(t.config.memory.enabled).toBe(false);
      expect(t.internalJobs.state("memory-nightly")).toBeUndefined();
      expect(fs.existsSync(t.layout.rgDb)).toBe(false);
      const executor = nightlyAction(t);
      // 模型只能提议：总要用户核对后执行
      expect(executor.confirm).toBe("always");
      const out = await executor.perform({}, context);
      expect(out.ok).toBe(false);
      expect(out.summary).toContain("关掉了记忆整理");
    } finally {
      await t.close();
    }
  });

  it("手动整理一次：走同一份作业、记一条 manual 的记录；再点一次是便宜的增量；同一天 03:00 照常跑", async () => {
    // 01:00 起：内部作业排在当天 03:00，手动整理不会把它吃掉
    const t = await createMemoryPluginHost({ at: at(10, 1), chat: silentChat });
    try {
      const executor = nightlyAction(t);
      expect(executor.confirm).toBe("always");
      const out = await executor.perform({}, context);
      expect(out.ok).toBe(true);
      expect(out.summary).toContain("整理完了");
      const records = nightlyRecords(t.store);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ night: "2026-10-10", state: "ran", trigger: "manual" });
      // 整理记录的派生视图里也有一条（网页、验收从那里读）
      expect(t.store.reader.get<{ state: string }>("SELECT state FROM memory_nightly WHERE night = ?", "2026-10-10")?.state).toBe("ran");

      // 同一分钟再点：照样跑（不报"这一夜已经整理过"），没有新素材就是一次便宜的增量
      const again = await executor.perform({}, context);
      expect(again.ok).toBe(true);
      const second = nightlyRecords(t.store);
      expect(second).toHaveLength(2);
      expect(second[1]).toMatchObject({ trigger: "manual", processedEvidence: 0, pendingEvidence: 0, newClaims: 0, modelCalls: 0 });

      // 手动没吃掉那一夜的定时水位：同一天 03:00 的定时那次照常跑
      t.clock.advanceTo(at(10, 3));
      await t.internalJobs.whenIdle();
      const scheduled = nightlyRecords(t.store);
      expect(scheduled).toHaveLength(3);
      expect(scheduled[2]).toMatchObject({ night: "2026-10-10", state: "ran", trigger: "scheduled" });
    } finally {
      await t.close();
    }
  });
});
