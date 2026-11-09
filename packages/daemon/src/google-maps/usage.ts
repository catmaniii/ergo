// 谷歌地图的用量（446）：每个月按谷歌的计费项（SKU）数用了几次——谷歌的免费量是"每个计费项每月一份"
// （developers.google.com/maps/billing-and-pricing/pricing，2026-11 读的，以 Google Cloud 控制台为准）：
// - dynamicMaps 地图加载（Maps JavaScript API 建一次地图，地图页经 POST /api/map/basemap 报来）：每月 10,000 次；
// - textSearch 搜地点（Places API (New) Text Search Pro：按名字搜、"附近的 xx"）：每月 5,000 次；
// - nearbySearch 周边（Nearby Search Pro：不说找什么、列出附近有什么）：每月 5,000 次；
// - geocoding 地址 ↔ 位置（Geocoding API）：每月 10,000 次；
// - routesEssentials 步行、公交的路线（Routes API Compute Routes Essentials）：每月 10,000 次；
// - routesPro 开车的路线（带实时路况 TRAFFIC_AWARE，算 Compute Routes Pro）：每月 5,000 次；
// - staticMaps 聊天卡片的预览图（451，Maps Static API 取一张静态地图）：每月 10,000 次。
// 只数次数，不记查了什么。存在插件自己的存储（数据目录的 google-maps/usage.json，{ format: 1, months: { "2026-11": { … } } }，
// 留最近 12 个月），写文件先写临时文件再改名；读不了当从 0 数、记日志。月份按本地日期算（谷歌按太平洋时间的自然月，月初差几个小时）。
// 每发一次请求就记一次（Key 不认、限流的也算：宁可多数）。测服务端 Key 时那三次也算（搜地点那一次只要编号，算谷歌不限量的 IDs Only，不数）。
// 超了怎么办（用户 2026-11-08 定）：到了八成体检提醒；哪一项到了免费量，没放开时先停用这家——底图那一项超了地图页不用谷歌底图，
// 查询的哪一项超了秘书不用谷歌查（都退回 OpenStreetMap，说明一句）；用户可以在 设置 · 数据源 · 谷歌地图 里放开（超出的谷歌按量收费），
// 放开记在 google-maps/settings.json（{ format: 1, allowOverage }），不是密钥、不进密钥区。
import fs from "node:fs";
import path from "node:path";
import { GOOGLE_MAPS_SKUS, type GoogleMapsSku, type GoogleMapsUsageView, localDate, t } from "@ergo/protocol";
import type { MapUsageFinding } from "../map/api.ts";
import { writeFileAtomic } from "../util/atomic-file.ts";

/** 每个计费项每月的免费量（次）：谷歌价目页上的数，以控制台为准 */
export const GOOGLE_MAPS_MONTHLY_FREE: Readonly<Record<GoogleMapsSku, number>> = {
  dynamicMaps: 10_000,
  textSearch: 5_000,
  nearbySearch: 5_000,
  geocoding: 10_000,
  routesEssentials: 10_000,
  routesPro: 5_000,
  staticMaps: 10_000,
};

/** 到了免费量的几成提醒 */
export const GOOGLE_MAPS_WARN_RATIO = 0.8;

/** 查询用的几项（服务端 Key）：哪一项超了，秘书先不用谷歌查（静态地图那一项超了只是卡片没有谷歌的预览图，不影响查询） */
export const LOOKUP_SKUS: readonly GoogleMapsSku[] = ["textSearch", "nearbySearch", "geocoding", "routesEssentials", "routesPro"];

/** 留最近几个月 */
const KEEP_MONTHS = 12;

/** 插件自己的存储里的两个文件（移除插件连数据删时整个 google-maps/ 删掉） */
export const USAGE_FILE = "usage.json";
export const SETTINGS_FILE = "settings.json";

type Counts = Record<GoogleMapsSku, number>;

interface UsageFile {
  format: 1;
  months: Record<string, Counts>;
}

const zero = (): Counts => Object.fromEntries(GOOGLE_MAPS_SKUS.map((s) => [s, 0])) as Counts;
/** 文件里的一个次数：不是非负整数的当 0 */
const nonNegative = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);
/** 本地月份 "2026-11" */
const monthOf = (ms: number) => localDate(new Date(ms)).slice(0, 7);

export interface GoogleMapsUsage {
  /** 记一次 */
  count(sku: GoogleMapsSku): void;
  /** 这个月的 */
  view(): GoogleMapsUsageView;
  /** 这个月到了免费量的几项（不管放没放开） */
  over(): GoogleMapsSku[];
  /** 超了还接着用吗（用户在设置里放开了） */
  allowOverage(): boolean;
  setAllowOverage(on: boolean): void;
}

export function openGoogleMapsUsage(options: { dir: string; now: () => number; log: (line: string) => void }): GoogleMapsUsage {
  const usageFile = path.join(options.dir, USAGE_FILE);
  const settingsFile = path.join(options.dir, SETTINGS_FILE);
  let data: UsageFile | undefined;
  let allow: boolean | undefined;
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") options.log(`谷歌地图：${path.basename(file)} 读不了，当没有：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
      return undefined;
    }
  };
  const write = (file: string, value: unknown) => {
    try {
      writeFileAtomic(file, JSON.stringify(value));
    } catch (err) {
      options.log(`谷歌地图：${path.basename(file)} 写不了：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
    }
  };
  const load = (): UsageFile => {
    if (data) return data;
    data = { format: 1, months: {} };
    const parsed = readJson(usageFile) as Partial<UsageFile> | undefined;
    if (parsed?.format === 1 && typeof parsed.months === "object" && parsed.months !== null) {
      for (const [month, n] of Object.entries(parsed.months)) {
        if (!/^\d{4}-\d{2}$/.test(month) || typeof n !== "object" || n === null) continue;
        data.months[month] = Object.fromEntries(GOOGLE_MAPS_SKUS.map((s) => [s, nonNegative((n as Record<string, unknown>)[s])])) as Counts;
      }
    }
    return data;
  };
  const current = (): Counts => load().months[monthOf(options.now())] ?? zero();
  const view = (): GoogleMapsUsageView => ({ month: monthOf(options.now()), counts: current(), limits: GOOGLE_MAPS_MONTHLY_FREE });
  return {
    count(sku) {
      const file = load();
      const month = monthOf(options.now());
      const now = file.months[month] ?? zero();
      file.months[month] = { ...now, [sku]: now[sku] + 1 };
      const kept = Object.keys(file.months).toSorted().slice(-KEEP_MONTHS);
      file.months = Object.fromEntries(kept.map((m) => [m, file.months[m]!]));
      write(usageFile, file);
    },
    view,
    over: () => {
      const counts = current();
      return GOOGLE_MAPS_SKUS.filter((s) => counts[s] >= GOOGLE_MAPS_MONTHLY_FREE[s]);
    },
    allowOverage() {
      if (allow === undefined) {
        const parsed = readJson(settingsFile) as { format?: unknown; allowOverage?: unknown } | undefined;
        allow = parsed?.format === 1 && parsed.allowOverage === true;
      }
      return allow;
    },
    setAllowOverage(on) {
      allow = on;
      write(settingsFile, { format: 1, allowOverage: on });
    },
  };
}

/** 一项的名字（给人看的） */
export const skuTitle = (sku: GoogleMapsSku) => t(`googleMaps.sku.${sku}`);

/** 设置 · 数据源 · 谷歌地图的地址（体检的"去看看"） */
const SOURCE_ROUTE = "#/more/data-sources/google-maps";

/**
 * 体检：本月每一项离免费量多远（纯函数）。两个 Key 都没填是不适用；哪一项到了八成注意、到了免费量坏了
 * （没放开时说已经停用了这家、退回 OpenStreetMap；放开了说超出的谷歌按量收费）。事实里只列用过的几项（"搜地点 4,100 / 5,000"）
 */
export function usageFinding(usage: GoogleMapsUsageView, configured: boolean, allowOverage: boolean): MapUsageFinding {
  if (!configured) return { level: "na", fact: { key: "googleMaps.doctor.usage.noKey" } };
  const ratio = (s: GoogleMapsSku) => usage.counts[s] / usage.limits[s];
  const used = GOOGLE_MAPS_SKUS.filter((s) => usage.counts[s] > 0);
  const items = (used.length === 0 ? GOOGLE_MAPS_SKUS : used).map((s) => t("googleMaps.doctor.usage.item", { name: skuTitle(s), count: usage.counts[s], limit: usage.limits[s] })).join(t("googleMaps.doctor.usage.sep"));
  const params = { month: usage.month, items };
  const action = { kind: "open" as const, route: SOURCE_ROUTE };
  const worst = Math.max(...GOOGLE_MAPS_SKUS.map(ratio));
  if (worst >= 1) {
    const over = GOOGLE_MAPS_SKUS.filter((s) => ratio(s) >= 1).map(skuTitle).join(t("googleMaps.doctor.usage.sep"));
    return { level: "error", fact: { key: allowOverage ? "googleMaps.doctor.usage.overAllowed" : "googleMaps.doctor.usage.over", params: { ...params, over } }, fix: { key: allowOverage ? "googleMaps.doctor.usage.fixOverAllowed" : "googleMaps.doctor.usage.fixOver" }, action };
  }
  if (worst >= GOOGLE_MAPS_WARN_RATIO) return { level: "warn", fact: { key: "googleMaps.doctor.usage.near", params }, fix: { key: "googleMaps.doctor.usage.fixNear" }, action };
  return { level: "ok", fact: { key: "googleMaps.doctor.usage.ok", params } };
}
