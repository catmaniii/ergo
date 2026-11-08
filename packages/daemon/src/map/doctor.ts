// 地图插件的体检项（432，接 409 的插件体检项 ctx.doctor）：高德 Web 服务这个月的用量离个人认证档的免费量多远
// （amap-usage.ts 的 usageFinding：到了 80% 注意、到了 100% 坏了）。只读内存和用量文件，不联网（cost: passive）。
// 445：地图服务插槽里每一家写了用量（MapProvider.usage）的，都由地图插件替它登记一项"<编号>-usage"（高德就是 amap-usage），
// 那一家撤掉时这一项跟着撤（registerUsageDoctor 交回撤销函数）。
// 432 这一版的插件宿主还没有 ctx.doctor（409 在 main 上、432 从 429 拉的分支）：有就登记，没有什么都不做——
// 合进有 409 的 main 以后自动登记上，不用再改这里；到时可以把下面的按名字取改成直接 ctx.doctor.register。
import type { MapUsageCheck, MapUsageFinding } from "./api.ts";
import type { AmapUsageFinding } from "./amap-usage.ts";

/** 体检项的 id（插件块里唯一） */
export const AMAP_USAGE_CHECK = "amap-usage";

/** 一家地图服务的用量那一项的 id */
export const usageCheckId = (provider: string) => `${provider}-usage`;

/** 409 的体检项登记（和 doctor/checks.ts 的 DoctorCheck 同形，只用到这几样） */
interface DoctorRegistrar {
  register(check: { id: string; title: string; cost: "passive"; run(signal: AbortSignal): MapUsageFinding }): () => void;
}

/** 插件宿主有 ctx.doctor 就登记一家的用量（"<编号>-usage"），交回撤销函数；没有交回 undefined */
export function registerUsageDoctor(ctx: object, provider: string, check: MapUsageCheck): (() => void) | undefined {
  const doctor = (ctx as { doctor?: DoctorRegistrar }).doctor;
  if (doctor === undefined) return undefined;
  return doctor.register({ id: usageCheckId(provider), title: check.title, cost: "passive", run: () => check.run() });
}

/** 插件 setup 里叫：插件宿主有 ctx.doctor 就登记"高德的用量"，交回登记了没有 */
export function registerAmapDoctor(ctx: object, finding: () => AmapUsageFinding): boolean {
  return registerUsageDoctor(ctx, "amap", { title: "map.doctor.usage.title", run: finding }) !== undefined;
}
