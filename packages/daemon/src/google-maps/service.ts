// 谷歌地图插件的服务（446）：把两个 Key（keys.ts）、调谷歌的那一层（client.ts）、查询（lookup.ts）、用量（usage.ts）接成一家
// "地图服务"（445 的插槽，map/api.ts 的 MapProvider），再给数据源"谷歌地图"几个函数。
// 这一家：编号 google；"自动"时管大陆以外，优先级 50（高于 OpenStreetMap 的 0）；手动选它时大陆也能用（它自己转 GCJ-02）；
// 查来的只画在它自己的底图上（谷歌条款：Google Maps 的内容不和非谷歌的地图一起用）。
// - 底图（basemap）：填了浏览器用的 Key、谷歌没拒过、这个月的地图加载没超免费量（或者放开了）才交 Key；
// - 查询（lookup）：按需查开着、填了服务端 Key、谷歌没说它不对、查询的几项没超免费量（或者放开了）才能查；
//   查不了时交回给模型的原因，秘书的工具自动退回 OpenStreetMap、说一句（445 的插槽管）；
// - 用量（usage）：地图插件替它在体检"地图"那一块登记 google-usage；
// - 地图页报来的（basemapEvent）：loaded 数一次地图加载，auth_failed 记下浏览器用的 Key 被拒了；
// - 静态地图（staticMap，451）：聊天卡片的预览图，服务端 Key 调 Maps Static API（static-map.ts），超了免费量、没放开时不取。
import { type GoogleMapsSourcePanel, GOOGLE_MAP_PROVIDER, t } from "@ergo/protocol";
import type { DataSourceSecrets, DataSourceStatus } from "../data-sources/api.ts";
import type { MapProvider } from "../map/api.ts";
import { createGoogleClient, type GoogleHosts } from "./client.ts";
import { ALLOW_OVERAGE_FIELD, createGoogleMapsKeys, GOOGLE_MAPS_SECRET } from "./keys.ts";
import { createGoogleLookup } from "./lookup.ts";
import { createGoogleStatic } from "./static-map.ts";
import { LOOKUP_SKUS, openGoogleMapsUsage, skuTitle, usageFinding } from "./usage.ts";

/** "自动"时同一个区域里的先后：大陆以外高于 OpenStreetMap（0），低于高德（100，高德只管大陆） */
export const GOOGLE_PRIORITY = 50;

/** 工具说明里讲它的半句（给模型看的） */
const TOOL_NOTE = "大陆以外优先用谷歌地图（有公交、开车带实时路况；要用户填了谷歌的服务端 Key，没填、超了免费量时照旧 OpenStreetMap；地图上选了谷歌时大陆里也用它）"; // @i18n-ignore model

export interface GoogleMapsServiceOptions {
  hosts?: Partial<GoogleHosts>;
  timeoutMs?: number;
  now: () => number;
  /** 密钥区里谷歌地图那一格（现取） */
  secrets: () => DataSourceSecrets;
  /** 插件自己的存储（数据目录的 google-maps/：用量、放没放开） */
  dir: string;
  /** 按需查开没开（设置 · 数据源 · 谷歌地图里的开关，现取；不给当开着） */
  queryOn?: () => boolean;
  log: (line: string) => void;
}

export interface GoogleMapsService {
  /** 登记进地图服务插槽的那一家 */
  readonly provider: MapProvider;
  status(secrets: DataSourceSecrets): DataSourceStatus;
  configure(values: Readonly<Record<string, string>>, secrets: DataSourceSecrets): Promise<DataSourceStatus>;
  recheck(secrets: DataSourceSecrets, signal: AbortSignal): Promise<void>;
  reset(): void;
}

export function createGoogleMapsService(options: GoogleMapsServiceOptions): GoogleMapsService {
  const usage = openGoogleMapsUsage({ dir: options.dir, now: options.now, log: options.log });
  // keys 要 client、client 的回应要交给 keys：先建 client，回应经这个变量转过去
  let keysRef: ReturnType<typeof createGoogleMapsKeys> | undefined;
  const client = createGoogleClient({
    ...(options.hosts === undefined ? {} : { hosts: options.hosts }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    count: (sku) => usage.count(sku),
    onReply: (reply) => keysRef?.serverReply(reply),
    log: options.log,
  });
  const keys = createGoogleMapsKeys({ client, log: options.log });
  keysRef = keys;
  const lookup = createGoogleLookup({ client, key: () => keys.serverKey(options.secrets()) });

  /** 这个月超了免费量、又没放开的几项 */
  const blocked = () => (usage.allowOverage() ? [] : usage.over());
  const staticMap = createGoogleStatic({
    client,
    key: () => keys.serverKey(options.secrets()),
    over: () => blocked().includes("staticMaps"),
    noted: (state) => keys.staticNoted(state),
    log: options.log,
  });
  /** 为什么查不了（给模型看的）；能查是 undefined */
  const lookupWhy = (): string | undefined => {
    const secrets = options.secrets();
    if (options.queryOn?.() === false) return "用户在 设置 · 数据源 · 谷歌地图 里关了按需查"; // @i18n-ignore model
    if (!secrets.has(GOOGLE_MAPS_SECRET.serverKey)) return "没填谷歌的服务端 Key"; // @i18n-ignore model
    if (keys.serverProblem(secrets) !== undefined) return "谷歌说服务端 Key 不对或没权限，要用户重新填"; // @i18n-ignore model
    const over = blocked().filter((s) => LOOKUP_SKUS.includes(s));
    if (over.length > 0) return `这个月谷歌的免费量用完了（${over.map(skuTitle).join("、")}），先停用谷歌、退回 OpenStreetMap；用户可以在 设置 · 数据源 · 谷歌地图 里放开（超出的谷歌按量收费）`; // @i18n-ignore model
    return undefined;
  };

  const provider: MapProvider = {
    id: GOOGLE_MAP_PROVIDER,
    get title() {
      return t("googleMaps.provider.title");
    },
    regions: ["abroad"],
    manualRegions: ["abroad", "mainland"],
    priority: GOOGLE_PRIORITY,
    ownBasemapOnly: true,
    basemap: () => {
      const secrets = options.secrets();
      const key = keys.browserKey(secrets);
      if (key === undefined) {
        const problem = keys.browserProblem(secrets);
        return problem === undefined ? { ready: false } : { ready: false, problem };
      }
      if (blocked().includes("dynamicMaps")) return { ready: false, problem: t("googleMaps.problem.mapsOver") };
      return { ready: true, key };
    },
    lookup: () => {
      const why = lookupWhy();
      return why === undefined ? { ready: true, provider: lookup } : { ready: false, why };
    },
    toolNote: TOOL_NOTE,
    usage: {
      title: "googleMaps.doctor.usage.title",
      run: () => {
        const secrets = options.secrets();
        return usageFinding(usage.view(), secrets.has(GOOGLE_MAPS_SECRET.browserKey) || secrets.has(GOOGLE_MAPS_SECRET.serverKey), usage.allowOverage());
      },
    },
    basemapEvent: (event) => (event === "loaded" ? usage.count("dynamicMaps") : keys.browserRejected()),
    staticMap: (req, signal) => staticMap(req, signal),
  };

  /** 设置 · 数据源 · 谷歌地图那一块要的 */
  const panel = (secrets: DataSourceSecrets): GoogleMapsSourcePanel => ({
    kind: "google-maps",
    browserKey: secrets.has(GOOGLE_MAPS_SECRET.browserKey),
    serverKey: secrets.has(GOOGLE_MAPS_SECRET.serverKey),
    usage: usage.view(),
    allowOverage: usage.allowOverage(),
    over: usage.over(),
    ...(keys.staticMap() === undefined ? {} : { staticMap: keys.staticMap() }),
  });
  const status = (secrets: DataSourceSecrets): DataSourceStatus => {
    const s = keys.status(secrets);
    if (s.connection === "not_connected") return s;
    // 超了免费量、没放开：照样连着，写一句停用了哪一样
    const over = blocked();
    const overText = over.length === 0 ? undefined : t("googleMaps.problem.over", { items: over.map(skuTitle).join(t("googleMaps.problem.joiner")) });
    const problem = [s.problem, overText].filter((x): x is string => x !== undefined).join(t("googleMaps.problem.joiner"));
    return { ...s, ...(problem === "" ? {} : { problem }), panel: panel(secrets) };
  };

  return {
    provider,
    status,
    async configure(values, secrets) {
      const allow = values[ALLOW_OVERAGE_FIELD]?.trim();
      if (allow === "on" || allow === "off") {
        usage.setAllowOverage(allow === "on");
        options.log(`谷歌地图：超了免费量${allow === "on" ? "放开了（超出的谷歌按量收费）" : "先停用（默认）"}`); // @i18n-ignore log
      }
      await keys.configure(values, secrets);
      return status(secrets);
    },
    recheck: (secrets, signal) => keys.recheck(secrets, signal),
    reset: () => keys.reset(),
  };
}
