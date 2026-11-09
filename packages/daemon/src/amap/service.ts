// 高德这一家（432，455 从地图插件挪出来）：把 Key 和安全密钥代理（amap.ts）、Web 服务的查询（amap-lookup.ts）、用量（amap-usage.ts）、
// 静态地图（amap-static.ts）接成插槽的一家（map/api.ts 的 MapProvider），再给数据源"高德地图"几个函数。
// - 编号 amap；底图国内国外都管（国外是高德的世界地图，要提工单开通，没开时可能很空：用户可以在地图切换里改用别家），
//   国内优先级 100、国外 30（国外先谷歌 50）；查询只管大陆（lookupRegions）；查来的只画在它自己的底图上（高德协议 4.12.4）；
// - 底图要 Web 端 Key 和安全密钥（basemap 交 Web 端 Key；安全密钥不进页面，网关的 /_AMapService 转发口拼上：proxy）；
// - 查询要 Web 服务 Key、按需查开着、高德没说 Key 不对；查不了时交回给模型的原因，插槽退回别家、说一句；
// - 用量（usage）：地图插件替它在体检"地图"那一块登记 amap-usage；静态地图（staticMap，451）：聊天卡片的预览图，计进 lbs。
import { AMAP_SERVICE_PREFIX, type AmapSourcePanel, t } from "@ergo/protocol";
import type { DataSourceLiveAnswer, DataSourceSecrets, DataSourceStatus } from "../data-sources/api.ts";
import type { MapProvider } from "../map/api.ts";
import { AMAP_PROVIDER } from "./api.ts";
import { AMAP_SECRET, type AmapHosts, createAmap } from "./amap.ts";
import { createAmapLookup } from "./amap-lookup.ts";
import { createAmapStatic } from "./amap-static.ts";
import { openAmapUsage, usageFinding } from "./amap-usage.ts";
import { tryLookup } from "./try-lookup.ts";

/** "自动"时的优先级：国内最先（高于谷歌 50、OpenStreetMap 0） */
export const AMAP_PRIORITY = 100;
/** 国外的优先级（451）：国外先谷歌（50）、再高德、最后 OpenStreetMap（0） */
export const AMAP_ABROAD_PRIORITY = 30;

/** 工具说明里讲它的半句（给模型看的） */
const TOOL_NOTE = "中国大陆里的用高德（开车带实时路况，有公交；要用户填了高德的 Web 服务 Key，没填时国内改用别的地图服务）"; // @i18n-ignore model

export interface AmapServiceOptions {
  /** 高德的地址（测试换成本机的假高德） */
  hosts?: Partial<AmapHosts>;
  timeoutMs?: number;
  /** 密钥区里高德那一格（现取） */
  secrets: () => DataSourceSecrets;
  /** 用量文件（数据目录的 amap/usage.json；455 迁移过的） */
  usageFile: string;
  now: () => number;
  /** 高德的按需查开没开（设置 · 数据源 · 高德地图里的开关，现取；不给当开着） */
  queryOn?: () => boolean;
  log: (line: string) => void;
}

export interface AmapService {
  /** 登记进地图服务插槽的那一家 */
  readonly provider: MapProvider;
  status(secrets: DataSourceSecrets): DataSourceStatus;
  configure(values: Readonly<Record<string, string>>, secrets: DataSourceSecrets): Promise<DataSourceStatus>;
  recheck(secrets: DataSourceSecrets, signal: AbortSignal): Promise<void>;
  reset(): void;
  /** 设置 · 数据源 · 高德地图的"试查一下"（数据源的 live）：拿 Web 服务 Key 搜一个固定的地点 */
  tryLookup(signal: AbortSignal): Promise<DataSourceLiveAnswer>;
}

export function createAmapService(options: AmapServiceOptions): AmapService {
  const amap = createAmap({
    ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    secrets: options.secrets,
    log: options.log,
  });
  const usage = openAmapUsage({ file: options.usageFile, now: options.now, log: options.log });
  const lookup = createAmapLookup({
    ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    secrets: options.secrets,
    usage,
    onReply: (body, status) => amap.serviceReply(body, status),
    log: options.log,
  });
  // 聊天卡片的预览图（451）：Web 服务 Key 取高德的静态地图，计进 lbs；高德说 Key 不对时 amap.ts 记下
  const amapStatic = createAmapStatic({
    ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    secrets: options.secrets,
    usage,
    onReply: (body, status) => amap.serviceReply(body, status),
    keyProblem: () => amap.serviceProblem(),
    log: options.log,
  });
  // 能查：填了 Web 服务 Key、按需查开着、高德没说 Key 不对；不能查时插槽退回别家
  const usable = () => options.queryOn?.() !== false && lookup.hasKey() && amap.serviceProblem() === undefined;
  /** 高德为什么查不了（给模型看的） */
  const why = (): string =>
    options.queryOn?.() === false
      ? "用户在 设置 · 数据源 · 高德地图 里关了按需查" // @i18n-ignore model
      : !lookup.hasKey()
        ? "没填高德的 Web 服务 Key" // @i18n-ignore model
        : "高德说 Web 服务 Key 不对，要重新填"; // @i18n-ignore model
  const provider: MapProvider = {
    id: AMAP_PROVIDER,
    get title() {
      return t("amap.provider");
    },
    modelName: "高德地图", // @i18n-ignore model
    // 底图国内国外都管（国外是高德的世界地图）；查询只管大陆
    regions: ["mainland", "abroad"],
    manualRegions: ["mainland", "abroad"],
    lookupRegions: ["mainland"],
    priority: AMAP_PRIORITY,
    regionPriority: { abroad: AMAP_ABROAD_PRIORITY },
    ownBasemapOnly: true,
    basemap: () => {
      const key = amap.mapKey();
      if (key !== undefined) return { ready: true, key };
      const problem = amap.mapProblem();
      return problem === undefined ? { ready: false } : { ready: false, problem };
    },
    lookup: () => (usable() ? { ready: true, provider: lookup } : { ready: false, why: why() }),
    toolNote: TOOL_NOTE,
    usage: { title: "amap.doctor.usage.title", run: () => usageFinding(usage.view(), lookup.hasKey()) },
    staticMap: amapStatic,
    // 高德 JS API 的安全密钥代理：页面设 serviceHost 指向 /_AMapService，这里拼上安全密钥转给高德
    proxy: { prefix: AMAP_SERVICE_PREFIX, serve: (path, search, signal, userAgent) => amap.proxy(path, search, signal, userAgent) },
  };
  /** 设置 · 数据源 · 高德地图那一块要的：Web 服务 Key 填了没有、这个月的用量 */
  const panel = (secrets: DataSourceSecrets): AmapSourcePanel => ({ kind: "amap", lookup: secrets.has(AMAP_SECRET.serviceKey), usage: usage.view() });
  return {
    provider,
    status: (secrets) => {
      const status = amap.status(secrets);
      return status.connection === "not_connected" ? status : { ...status, panel: panel(secrets) };
    },
    configure: (values, secrets) => amap.configure(values, secrets),
    recheck: (secrets, signal) => amap.recheck(secrets, signal),
    reset: () => amap.reset(),
    tryLookup: (signal) => tryLookup(lookup, usage, signal),
  };
}
