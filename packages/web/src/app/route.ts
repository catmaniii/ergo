// 页面路由：用 URL 的 # 部分，直接从文件打开（file://）也能用，刷新后停在原来的页面。
// 地址怎么拆、怎么拼在 route-hash.ts（纯函数），这里只盯着地址的变化。跳转压一条记录并记下来处，标题栏的 ‹ 回上一级不压新记录
// （88 号票评审，history-nav.ts）。
import { useCallback, useEffect, useState } from "react";
import { backToHash, cameFrom, pushHash } from "./history-nav.ts";
import { legacyHashRedirect, type Navigate, parseHash, type Route, toHash } from "./route-hash.ts";

export * from "./route-hash.ts";

/** 旧地址（比如 167 号票之前设置里删除素材的 #/more/materials）在地址栏里换成新地址，不压新记录；页面照拆出来的新地址显示 */
function currentRoute(): Route {
  const to = legacyHashRedirect(window.location.hash);
  if (to !== undefined) window.location.replace(to);
  return parseHash(to ?? window.location.hash);
}

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const navigate = useCallback((r: Route) => pushHash(window, toHash(r)), []);
  return [route, navigate];
}

/** 标题栏的 ‹ 回到上一级 r：上一条历史就是 r（从它跳过来的）就后退一步，否则把这一条换成 r，不压新记录 */
export function goBackTo(r: Route): void {
  backToHash(window, toHash(r));
}

/** 素材详情的 ‹（343 号票）：从数据源详情的"已获取的"点过来的回那里，别的回列表 r */
export function goBackFromMaterial(r: Route): void {
  const from = cameFrom(window);
  const route = from === undefined ? undefined : parseHash(from);
  backToHash(window, from !== undefined && route?.tab === "more" && route.page === "data-sources" && route.item !== undefined ? from : toHash(r));
}
