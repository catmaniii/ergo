// 地图上的"我的足迹"（430）：某一天去过哪、在哪待了多久、照片在哪拍的、常去的地方。名字、纯函数（不引用 TypeBox），
// 响应的 schema 在 map-day-schema.ts。
// - 接口：GET /api/map/day?date=YYYY-MM-DD（HTTP_PATHS.mapDay），地图插件经手机插件的服务现算（守护进程里一律 WGS-84）；
//   只给本机端口和已配对的设备（外网端口由网关统一要设备凭证）；
// - 隐私：这些点只在二狗里画，**不发给任何地图服务**——守护进程算的时候不联网，页面把它们画在底图上面（底图只是瓦片）；
// - 地图页的地址：#/more/map/<YYYY-MM-DD> 看那一天的足迹（mapDayItem / parseMapDayItem）；#/more/map/<纬度>,<经度>[,<级别>] 是
//   定位到某处（map.ts 的 mapFocusItem），两种写法不会混（日期里没有逗号）。聊天里的足迹卡片（431）点开用前一种。

import { t } from "./i18n/runtime.ts";

/** 足迹里"有足迹的日子"最多列几天（新的在前；日期选择器的前一天、后一天和"最近有足迹的一天"用） */
export const MAP_DAY_DAYS_MAX = 400;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 是不是一个真的日期（YYYY-MM-DD，月、日在范围里：2026-02-30 不算） */
export function isMapDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** 日期写法不对时给人看的一句（接口回 400、秘书的工具回错用）；对的给 undefined */
export function mapDateProblem(value: string): string | undefined {
  return isMapDate(value) ? undefined : t("protocol.mapDay.badDate", { date: value.slice(0, 40) });
}

/** 地图页的地址里看哪一天的足迹（#/more/map/<item>）：拼 */
export function mapDayItem(date: string): string {
  return date;
}

/** 地图页的地址里看哪一天的足迹：拆；不是日期（比如是"纬度,经度"）给 undefined */
export function parseMapDayItem(item: string | undefined): string | undefined {
  return item !== undefined && isMapDate(item) ? item : undefined;
}

/** 日期往前、往后挪几天（YYYY-MM-DD 进出，按日历算，不受时区、夏令时影响） */
export function shiftMapDate(date: string, days: number): string {
  const m = DATE.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
