// 记忆插件的体检项跟着插件走（412）：真的记忆插件装在真的插件宿主里（假内核，test/memory/plugin-host.ts，临时目录、假时钟、
// 假向量、不给模型），体检照组合根那样接（登记表 + 宿主的 info()）——
// - 装上：体检页上有记忆那一块，插件本身 + 自己登记的六项（接了记忆插件槽才有"记忆系统"那一项）；
// - 读的是现成的状态：到点整理没配 Key 记一条 skipped → 每晚整理那一项坏了；假的记忆系统报的健康照写；
// - 停用：那一块消失、只列在"停用的插件"里；启用：回来。
// 不碰真的 ~/.ergo、不调模型、不起守护进程。
import { DOCTOR_CHECKS, type DoctorCheckDataById, type DoctorCheckId, type DoctorView, type MemoryHealth, type MemoryProviderInfo } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createDoctor, type DoctorProbes } from "../../src/doctor/doctor.ts";
import type { MemorySlot } from "../../src/plugins/kernel.ts";
import { createMemoryPluginHost } from "./plugin-host.ts";

const GOOD: { [Id in DoctorCheckId]: DoctorCheckDataById[Id] } = {
  ports: { local: 8810, external: 8811, localUp: true, externalUp: true },
  node: { running: "22.23.4", expected: "22" },
  pi: { version: "1.0.4" },
  supervisor: { running: true, port: 7420 },
  model: { configured: true },
  components: { missing: [] },
  disk: { freeGb: 120.5, totalGb: 476.8, path: "C:\\Users\\someone\\.ergo" },
  external: { configured: true, kind: "tailscale" },
};
const probes = Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, () => GOOD[id]])) as DoctorProbes;

/** 体检页上记忆那一块 */
const memoryBlock = (view: DoctorView) => view.groups.find((g) => g.id === "memory");

/** 本地时间 2026 年 10 月 d 日 hh:mm */
const at = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm);

/** 假的记忆系统（只回体检要的两样；简报、记一句不在这里测） */
function fakeSlot(health: MemoryHealth): MemorySlot {
  const info: MemoryProviderInfo = { api: 1, id: "subtext", name: { zh: "会意", en: "Subtext" }, version: "0.4.3", capabilities: { brief: true }, requirements: {} };
  return {
    remember: () => Promise.reject(new Error("测试里不记")),
    brief: () => Promise.resolve(undefined),
    info: () => info,
    health: () => Promise.resolve(health),
  };
}

describe("记忆插件的体检项", () => {
  it("装上：记忆那一块有插件本身和六项；读的是现成的状态；停用后那一块消失，启用后回来", async () => {
    const t = await createMemoryPluginHost({ at: at(10, 9), memorySlot: fakeSlot({ items: 42, problems: ["测试里的记忆系统报个问题"] }) });
    try {
      const doctor = createDoctor({ probes, checks: t.doctorChecks, plugins: () => t.host.info(), now: () => t.clock.now() });
      expect(t.doctorChecks.list().map((c) => `${c.plugin}:${c.id}:${c.cost}`)).toEqual([
        "memory:index:passive",
        "memory:graph:passive",
        "memory:system:passive",
        "memory:brief:passive",
        "memory:nightly:passive",
        "memory:presync:passive",
      ]);

      const first = memoryBlock(await doctor.view());
      expect(first).toBeDefined();
      const levels = Object.fromEntries(first!.items.map((item) => [item.id, item.level]));
      expect(levels).toEqual({
        plugin: "ok",
        // 假向量函数一直在、素材一条没有：都算好了
        index: "ok",
        // 整理开着：起来时建好了库、核过能打开
        graph: "ok",
        // 假的记忆系统报了问题：注意，原话照写
        system: "warn",
        // 还没问过
        brief: "ok",
        // 刚排上，还没到第一次
        nightly: "ok",
        // 还没有带同步结果的整理记录
        presync: "na",
      });
      const system = first!.items.find((item) => item.id === "system")!;
      expect(system.text.title).toBe("记忆系统");
      expect(system.text.fact).toContain("测试里的记忆系统报个问题");
      expect(first!.items.find((item) => item.id === "graph")!.text.fact).toContain("启动时核过能打开");

      // 到点整理：没配 Key（不给模型）记一条 skipped → 每晚整理那一项坏了，原因照写
      t.clock.advanceTo(at(11, 3));
      await t.internalJobs.whenIdle();
      const second = memoryBlock(await doctor.view())!;
      expect(second.level).toBe("error");
      const night = second.items.find((item) => item.id === "nightly")!;
      expect(night).toMatchObject({ level: "error", action: { kind: "open", route: "#/more/memory/curator" } });
      expect(night.text.fact).toContain("DeepSeek");
      // 块里照登记的先后（插件本身在前），不适用的挪到最后
      expect(second.items.map((item) => item.id)).toEqual(["plugin", "index", "graph", "system", "brief", "nightly", "presync"]);

      // 停用：登记的撤了，那一块没了，只列在"停用的插件"里
      await t.host.disable("memory");
      expect(t.doctorChecks.list()).toEqual([]);
      const off = await doctor.view();
      expect(memoryBlock(off)).toBeUndefined();
      expect(off.off.map((p) => p.plugin)).toEqual(["memory"]);

      // 启用：新的一次 setup，六项回来
      await t.host.enable("memory");
      const back = memoryBlock(await doctor.view());
      expect(back!.items.map((item) => item.id).toSorted()).toEqual(["brief", "graph", "index", "nightly", "plugin", "presync", "system"]);
    } finally {
      await t.close();
    }
  });

  it("没接记忆插件槽：不登记记忆系统那一项；memory.enabled 关着：每晚整理、整理前导入不适用，推理库没建也不适用", async () => {
    const t = await createMemoryPluginHost({ at: at(10, 9), config: { memory: { enabled: false } } });
    try {
      const doctor = createDoctor({ probes, checks: t.doctorChecks, plugins: () => t.host.info(), now: () => t.clock.now() });
      const block = memoryBlock(await doctor.view())!;
      expect(Object.fromEntries(block.items.map((item) => [item.id, item.level]))).toEqual({ plugin: "ok", index: "ok", graph: "na", brief: "ok", nightly: "na", presync: "na" });
      expect(block.level).toBe("ok");
    } finally {
      await t.close();
    }
  });
});
