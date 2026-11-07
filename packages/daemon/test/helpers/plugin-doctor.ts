// 测插件的体检项（414）用：照组合根那样把体检接到假内核上（登记表、插件宿主的 info()、数据源的 doctorFacts、运行时登记表），
// 八项一律给好的（插件的测试只看插件那一块）；查的时刻可以另给（不用拨假内核的时钟，免得途中到点的定期导入跑起来）。
import { DOCTOR_CHECKS, type DoctorCheckDataById, type DoctorCheckId, type DoctorGroupView, type DoctorItemView, type DoctorView } from "@ergo/protocol";
import { createDoctor, type DoctorProbes, type DoctorService } from "../../src/doctor/doctor.ts";
import type { PluginKernel } from "./plugin-kernel.ts";

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

/** 假内核上的体检；now 不给是假内核的时钟 */
export function kernelDoctor(kernel: PluginKernel, options: { now?: () => number } = {}): DoctorService {
  return createDoctor({
    probes,
    checks: kernel.doctorChecks,
    plugins: () => kernel.host.info(),
    dataSources: () => kernel.dataSources.doctorFacts(),
    runtimes: () => kernel.runtimes.view().runtimes,
    now: options.now ?? (() => kernel.clock.now()),
  });
}

/** 某个插件那一块（没有是 undefined） */
export const blockOf = (view: DoctorView, plugin: string): DoctorGroupView | undefined => view.groups.find((g) => g.id === plugin);

/** 某个插件那一块里的某一项（没有是 undefined） */
export const itemOf = (view: DoctorView, plugin: string, id: string): DoctorItemView | undefined => blockOf(view, plugin)?.items.find((i) => i.id === id);
