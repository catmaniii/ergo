// 设置 · 数据源 · 高德地图的"试查一下"（432）：填好 Web 服务 Key 后拿它搜一个固定的地点，看通不通。
// 走数据源的"现在能查到的"（live）：只读，不写事件、不进素材、不经过模型；数据源详情页的"现在能查到的"也是它。
// 搜的是固定的词（北京的天安门，和 429 测 Key 时问的同一处），不是你的位置；算一次搜地点的用量。
// 查不成的原因给人看（按界面的语言），内核把里面的 Key 换成 ***。
import { t } from "@ergo/protocol";
import type { DataSourceLiveAnswer } from "../data-sources/api.ts";
import type { AmapLookup } from "./amap-lookup.ts";
import type { AmapUsage } from "./amap-usage.ts";
import { MapLookupError } from "./lookup.ts";

/** 试查搜的词和城市（固定的，不是你的位置） */
export const TRY_KEYWORD = "天安门"; // @i18n-ignore data：发给高德搜的词
export const TRY_CITY = "北京"; // @i18n-ignore data：发给高德的城市
/** 列几个 */
const TRY_LIMIT = 3;

/** 查不成的原因（给人看的） */
export function lookupProblemForPerson(err: MapLookupError): string {
  return t(`map.lookup.problem.${err.failure}`, { detail: err.code === undefined ? err.detail : `${err.detail} ${err.code}` });
}

export async function tryLookup(provider: AmapLookup, usage: AmapUsage, signal: AbortSignal): Promise<DataSourceLiveAnswer> {
  if (!provider.hasKey()) throw new Error(t("map.lookup.problem.no_key", { detail: "" }));
  let hits;
  try {
    hits = await provider.searchText({ keyword: TRY_KEYWORD, city: TRY_CITY, limit: TRY_LIMIT }, signal);
  } catch (err) {
    if (err instanceof MapLookupError) throw new Error(lookupProblemForPerson(err), { cause: err });
    throw err;
  }
  const now = usage.view();
  return {
    items: hits.map((hit, i) => {
      const subtitle = [hit.area, hit.address, hit.type].filter((s) => s !== undefined && s !== "").join(" · ");
      return { id: hit.id ?? `try-${i + 1}`, title: hit.name, ...(subtitle === "" ? {} : { subtitle }) };
    }),
    scope: t("map.try.scope", { keyword: TRY_KEYWORD, city: TRY_CITY }),
    notes: [hits.length === 0 ? t("map.try.empty") : t("map.try.ok"), t("map.try.usage", { search: now.search, searchLimit: now.searchLimit, lbs: now.lbs, lbsLimit: now.lbsLimit })],
  };
}
