// 页面路由：用 URL 的 # 部分，直接从文件打开（file://）也能用，刷新后停在原来的页面。
// 地址怎么拆、怎么拼在 route-hash.ts（纯函数），这里只盯着地址的变化。
import { useCallback, useEffect, useState } from "react";
import { type Navigate, parseHash, type Route, toHash } from "./route-hash.ts";

export * from "./route-hash.ts";

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const navigate = useCallback((r: Route) => {
    window.location.hash = toHash(r);
  }, []);
  return [route, navigate];
}
