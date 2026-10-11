// 页面路由：用 URL 的 # 部分，直接从文件打开（file://）也能用，刷新后停在原来的页面。
// 地址怎么拆、怎么拼在 route-hash.ts（纯函数），这里只盯着地址的变化。跳转压一条记录并记下来处，标题栏的 ‹ 回上一级不压新记录
// （88 号票评审，history-nav.ts）。
import { useCallback, useEffect, useState } from "react";
import { backToHash, pushHash } from "./history-nav.ts";
import { type Navigate, parseHash, type Route, toHash } from "./route-hash.ts";

export * from "./route-hash.ts";

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
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
