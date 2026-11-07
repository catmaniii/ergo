// 地图插件的"我的足迹"（430）：GET /api/map/day?date=YYYY-MM-DD 和以后秘书的"画在地图上"（431）都经它。
// 足迹由"手机"插件的服务现算（phone/footprints.ts：只读它自己存储里的原始位置点、照片的时间地点、起了名的常去的地方），
// 这里只管日期写法、手机插件在不在；**不联网、不调任何地图服务**——每天的轨迹、停留、照片地点只在二狗里画。
// 手机插件是可选依赖（wants）：没装、停用了回"手机插件没启用"，地图照样能看。
import { type MapDayView, mapDateProblem, t } from "@ergo/protocol";
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
