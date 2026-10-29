// 这个页面的返回栈（62 号票，系统返回键）：一份 back-registry.ts，和挂层用的 React 钩子。
// 弹窗（ui/common.tsx 的 Sheet）、选择器、详情页、抽屉开着时挂 overlay；标题栏有"‹ 返回"时挂 page（回这一页的上一级）。
// 开在鸿蒙 App 里时 page-native.ts 把它接到原生桥上；不在 App 里没人调它，浏览器的行为不变。
import { useEffect, useRef } from "react";
import type { BackKind } from "../state/index.ts";
import { type BackRegistry, createBackRegistry } from "./back-registry.ts";

let registry: BackRegistry | undefined;

export function pageBack(): BackRegistry {
  registry ??= createBackRegistry();
  return registry;
}

/** active 时挂上一层：按返回键时调 onBack（总是用最新的那个）；不 active 了、组件拿掉了就拿下 */
export function useBackLayer(kind: BackKind, active: boolean, onBack: (() => void) | undefined): void {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    return pageBack().open(kind, () => latest.current?.());
  }, [kind, active]);
}
