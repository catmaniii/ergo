// 插件登记体检项（409）：真的插件宿主（假内核，test/helpers/plugin-kernel.ts）装一个在 setup 里 ctx.doctor.register 的插件，
// 体检照组合根那样接（登记表、宿主的 info()、数据源的 doctorFacts、运行时登记表）——
// - 装上：体检页上多出它那一块（插件本身 + 它登记的项）；
// - 停用：它登记的撤掉，那一块没了，只在"停用的插件"里列名字；启用：新的一次 setup，那一块回来；移除同停用；
// - 停用了以后再经旧的 ctx 登记报错（迟到的登记不会悄悄漏掉）。
import { DOCTOR_CORE_GROUP, DOCTOR_CHECKS, type DoctorCheckDataById, type DoctorCheckId, type DoctorView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createDoctor, type DoctorProbes } from "../../src/doctor/doctor.ts";
import type { PluginContext, PluginDefinition } from "../../src/plugins/host.ts";
import { startPluginKernel } from "../helpers/plugin-kernel.ts";

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
/** 体检页上探针插件那一块 */
const blockOf = (view: DoctorView) => view.groups.find((g) => g.id === "probe");
const probes = Object.fromEntries(DOCTOR_CHECKS.map((id) => [id, () => GOOD[id]])) as DoctorProbes;

describe("插件登记体检项", () => {
  it("装上有它那一块；停用后那一块消失、只列名字；启用后回来；移除同停用；停了以后经旧的 ctx 再登记报错", async () => {
    let saved: PluginContext | undefined;
    let pulses = 0;
    const probe: PluginDefinition = {
      name: "probe",
      title: "探针",
      setup(ctx) {
        saved = ctx;
        ctx.doctor.register({
          id: "pulse",
          title: "doctor.plugin.title",
          cost: "passive",
          run: () => {
            pulses += 1;
            return { level: "warn", fact: { key: "doctor.source.never" } };
          },
        });
      },
    };
    const kernel = await startPluginKernel({ plugins: [probe] });
    const doctor = createDoctor({
      probes,
      checks: kernel.doctorChecks,
      plugins: () => kernel.host.info(),
      dataSources: () => kernel.dataSources.doctorFacts(),
      runtimes: () => kernel.runtimes.view().runtimes,
    });

    const on = await doctor.view();
    expect(on.groups.map((g) => g.id)).toEqual([DOCTOR_CORE_GROUP, "probe"]);
    expect(blockOf(on)).toMatchObject({ kind: "plugin", title: "探针", level: "warn" });
    expect(blockOf(on)!.items.map((i) => [i.id, i.level])).toEqual([
      ["plugin", "ok"],
      ["pulse", "warn"],
    ]);
    expect(on.off).toEqual([]);
    expect(pulses).toBe(1);

    // 停用：登记的撤了，那一块没了
    await kernel.host.disable("probe");
    expect(kernel.doctorChecks.list()).toEqual([]);
    const off = await doctor.view();
    expect(blockOf(off)).toBeUndefined();
    expect(off.off).toEqual([{ plugin: "probe", title: "探针", state: "disabled" }]);
    expect(pulses).toBe(1);
    expect(() => saved!.doctor.register({ id: "late", title: "doctor.plugin.title", cost: "passive", run: () => ({ level: "ok", fact: { key: "doctor.plugin.running" } }) })).toThrow(/已经停了/);

    // 启用：新的一次 setup，那一块回来
    await kernel.host.enable("probe");
    const back = await doctor.view();
    expect(blockOf(back)!.items.map((i) => i.id)).toEqual(["plugin", "pulse"]);
    expect(back.off).toEqual([]);
    expect(kernel.doctorChecks.list().map((c) => `${c.plugin}:${c.id}`)).toEqual(["probe:pulse"]);

    // 移除：同停用，列成移除了
    await kernel.host.remove("probe");
    const removed = await doctor.view();
    expect(blockOf(removed)).toBeUndefined();
    expect(removed.off).toEqual([{ plugin: "probe", title: "探针", state: "removed" }]);
  });
});
