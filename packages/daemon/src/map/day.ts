// 地图插件的"我的足迹"（430）：GET /api/map/day?date=YYYY-MM-DD 和以后秘书的"画在地图上"（431）都经它。
// 足迹由"手机"插件的服务现算（phone/footprints.ts：只读它自己存储里的原始位置点、照片的时间地点、起了名的常去的地方），
// 这里只管日期写法、手机插件在不在；**不联网、不调任何地图服务**——每天的轨迹、停留、照片地点只在二狗里画。
// 手机插件是可选依赖（wants）：没装、停用了回"手机插件没启用"，地图照样能看。
// 地图页"回到我现在的位置"（442）的退路也在这里：手机最近交来的一个位置点（GET /api/map/latest），同样只读手机插件、不联网。
import { type MapDayView, type MapLatestView, mapDateProblem, t } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import type { PhoneService } from "../phone/api.ts";

/** phone 是现取手机插件的服务（停了是 undefined，不要存起来） */
export function createMapDay(phone: () => Pick<PhoneService, "footprints"> | undefined): (date: string) => MapDayView {
  return (date) => {
    const problem = mapDateProblem(date);
    if (problem !== undefined) throw new RequestRejected("bad_params", problem);
    const service = phone();
    if (!service) throw new RequestRejected("not_allowed", t("plugins.notEnabled", { title: t("phone.plugin.title") }));
    return service.footprints(date);
  };
}

/** 精度最多报到多少米（App 报得离谱时截住） */
const ACCURACY_MAX_M = 100_000;

/**
 * 手机最近交来的一个位置点（442，GET /api/map/latest）：地图页"回到我现在的位置"在这台设备定不了位时退一步用它。
 * 只交这一个点（时间、坐标、精度），不给轨迹；手机插件没启用、还没交来过时没有 point
 */
export function createMapLatest(phone: () => Pick<PhoneService, "latestPoint"> | undefined): () => MapLatestView {
  return () => {
    const point = phone()?.latestPoint();
    if (point === undefined) return {};
    const accuracy = point.acc !== undefined && Number.isFinite(point.acc) && point.acc >= 0 ? Math.min(point.acc, ACCURACY_MAX_M) : undefined;
    return { point: { at: point.at, lat: point.lat, lon: point.lon, ...(accuracy === undefined ? {} : { accuracy }) } };
  };
}
