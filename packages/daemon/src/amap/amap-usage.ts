// 高德 Web 服务的用量（432）：每个月调了几次，分两类记——高德个人认证开发者的免费量也是这么分的
// （2026-11 调研，lbs.amap.com/upgrade，以高德控制台为准）：
// - search 搜地点（关键字搜索、周边搜索）：每月约 5,000 次；
// - lbs 地址和路线（地理编码、逆地理编码、路线规划）：每月约 15 万次。
// 只数次数，不记查了什么（起点、终点、搜的词都不记）。存在插件自己的存储里（数据目录的 amap/usage.json，
// { format: 1, months: { "2026-11": { search, lbs } } }，留最近 12 个月），写文件先写临时文件再改名；读不了当从 0 数、记日志。
// 455 以前高德在地图插件里，用量记在 map/amap-usage.json：高德插件第一次启用时挪过来（migrateAmapUsage），次数原样接着数。
// 月份按本地日期算（高德按自然月）。每发一次请求就记一次（Key 不认、限流的也算：高德那边算不算说不准，宁可多数）。
// 体检（409 的插件体检项）：本月哪一类到了免费量的 80% 提示注意，到了 100% 算坏了（超出的高德可能拒绝或收费），见 usageFinding。
import fs from "node:fs";
import path from "node:path";
import { type AmapUsageView, localDate } from "@ergo/protocol";
import { writeFileAtomic } from "../util/atomic-file.ts";
import type { MapUsageFinding, MapUsageMessage } from "../map/api.ts";

/** 两类：搜地点、地址和路线 */
export type AmapUsageKind = "search" | "lbs";

/** 高德个人认证开发者每月的免费量（次）：页面上的数，以控制台为准 */
export const AMAP_PERSONAL_MONTHLY_LIMITS: Readonly<Record<AmapUsageKind, number>> = { search: 5_000, lbs: 150_000 };

/** 到了免费量的几成提示注意 */
export const AMAP_USAGE_WARN_RATIO = 0.8;

/** 留最近几个月 */
const KEEP_MONTHS = 12;

/** 用量文件在插件自己的存储里叫什么（数据目录的 amap/；移除插件连数据删时整个 amap/ 删掉） */
export const AMAP_USAGE_FILE = "usage.json";

/** 455 以前的用量文件：地图插件名下（数据目录里的相对路径） */
export const LEGACY_AMAP_USAGE = path.join("map", "amap-usage.json");

interface UsageFile {
  format: 1;
  months: Record<string, Record<AmapUsageKind, number>>;
}

export interface AmapUsage {
  /** 记一次 */
  count(kind: AmapUsageKind): void;
  /** 这个月的 */
  view(): AmapUsageView;
}

/** 文件里的一个次数：不是非负整数的当 0 */
const nonNegative = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** 本地月份 "2026-11" */
export const monthOf = (ms: number) => localDate(new Date(ms)).slice(0, 7);

export function openAmapUsage(options: { file: string; now: () => number; log: (line: string) => void }): AmapUsage {
  let data: UsageFile | undefined;
  const load = (): UsageFile => {
    if (data) return data;
    data = { format: 1, months: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(options.file, "utf8")) as Partial<UsageFile>;
      if (parsed.format === 1 && typeof parsed.months === "object" && parsed.months !== null) {
        for (const [month, n] of Object.entries(parsed.months)) {
          if (!/^\d{4}-\d{2}$/.test(month) || typeof n !== "object" || n === null) continue;
          data.months[month] = { search: nonNegative(n.search), lbs: nonNegative(n.lbs) };
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") options.log(`高德地图：用量文件读不了，从 0 数：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
    }
    return data;
  };
  const save = (file: UsageFile) => {
    const kept = Object.keys(file.months).toSorted().slice(-KEEP_MONTHS);
    const months = Object.fromEntries(kept.map((m) => [m, file.months[m]!]));
    file.months = months;
    try {
      writeFileAtomic(options.file, JSON.stringify(file));
    } catch (err) {
      options.log(`高德地图：用量文件写不了：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
    }
  };
  return {
    count(kind) {
      const file = load();
      const month = monthOf(options.now());
      const now = file.months[month] ?? { search: 0, lbs: 0 };
      file.months[month] = { ...now, [kind]: now[kind] + 1 };
      save(file);
    },
    view() {
      const month = monthOf(options.now());
      const now = load().months[month] ?? { search: 0, lbs: 0 };
      return { month, search: now.search, lbs: now.lbs, searchLimit: AMAP_PERSONAL_MONTHLY_LIMITS.search, lbsLimit: AMAP_PERSONAL_MONTHLY_LIMITS.lbs };
    },
  };
}

/** 用量文件的完整路径：插件自己的存储（数据目录的 amap/） */
export const amapUsageFile = (amapDir: string) => path.join(amapDir, AMAP_USAGE_FILE);

/**
 * 455 的迁移：高德的用量从地图插件名下（<数据目录>/map/amap-usage.json）挪到高德插件名下（<数据目录>/amap/usage.json），
 * 用户不用重来、次数原样接着数。高德插件每次启用时叫一次，能重复执行：
 * - 旧的不在：什么都不做（新装的、挪过了的）；
 * - 新的已经在：不动（旧的留着不删，"连数据删"时一起删：插件的 removal 里写了旧的路径）；
 * - 挪：先改名；改名不成（Windows 上被占着、跨盘）就复制一份再删旧的；复制也不成就接着用旧的那一份，下次启用再试。
 * 旧的挪走以后 map/ 空了就删掉这个目录（地图插件名下只放过这一个文件）。交回这一次要用的用量文件
 */
export function migrateAmapUsage(options: { root: string; dir: string; log: (line: string) => void }): string {
  const file = amapUsageFile(options.dir);
  const legacy = path.join(options.root, LEGACY_AMAP_USAGE);
  if (!fs.existsSync(legacy) || fs.existsSync(file)) return file;
  try {
    fs.mkdirSync(options.dir, { recursive: true });
    try {
      fs.renameSync(legacy, file);
    } catch {
      fs.copyFileSync(legacy, file);
      fs.rmSync(legacy, { force: true });
    }
    options.log("高德地图：用量从地图插件名下挪过来了（map/amap-usage.json → amap/usage.json）"); // @i18n-ignore log
  } catch (err) {
    options.log(`高德地图：用量挪不过来，先接着用旧的那一份：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
    return fs.existsSync(file) ? file : legacy;
  }
  try {
    fs.rmdirSync(path.dirname(legacy));
  } catch {
    // 不空（还有别的东西）、删不了：留着
  }
  return file;
}

/** 一句话：文案键 + 参数（和体检的 DoctorMessage 一样） */
export type UsageMessage = MapUsageMessage;

/** 体检里"高德的用量"那一项（和 409 的 DoctorFinding 同形：五种结果之一、事实、怎么修、动作；445 起是插槽的 MapUsageFinding） */
export type AmapUsageFinding = MapUsageFinding;

/** 设置 · 数据源 · 高德地图的地址（体检的"去看看"） */
const AMAP_SOURCE_ROUTE = "#/more/data-sources/amap";

/**
 * 体检：本月的用量离个人档的免费量多远（纯函数）。没填 Web 服务 Key 是不适用；哪一类到了 80% 注意、到了 100% 坏了，
 * 两类都写进事实里（"搜地点 4,100 / 5,000 次"）
 */
export function usageFinding(usage: AmapUsageView, lookup: boolean): AmapUsageFinding {
  if (!lookup) return { level: "na", fact: { key: "amap.doctor.usage.noKey" } };
  const ratio = Math.max(usage.search / usage.searchLimit, usage.lbs / usage.lbsLimit);
  const params = { month: usage.month, search: usage.search, searchLimit: usage.searchLimit, lbs: usage.lbs, lbsLimit: usage.lbsLimit };
  const action = { kind: "open" as const, route: AMAP_SOURCE_ROUTE };
  if (ratio >= 1) return { level: "error", fact: { key: "amap.doctor.usage.over", params }, fix: { key: "amap.doctor.usage.fixOver" }, action };
  if (ratio >= AMAP_USAGE_WARN_RATIO) return { level: "warn", fact: { key: "amap.doctor.usage.near", params }, fix: { key: "amap.doctor.usage.fixNear" }, action };
  return { level: "ok", fact: { key: "amap.doctor.usage.ok", params } };
}
