// 没装的组件对应的功能灰掉、点一下去装（323 号票）：组件清单（GET /api/components，取一次缓存着；设置 · 组件每次取到新的换上，
// 挂着的跟着变）里每个功能能不能用（ComponentsView.features）。还没取到、取不到的一律当能用（不挡人）。
// - useComponentGate(功能)：这个功能没法用时回要装的那个组件（能用是 undefined）；
// - goInstallComponent(组件)：去设置 · 组件，那一块亮一下（ComponentsPage 认 takeComponentFocus）；
// - ComponentMissing：一行"要先装「语音识别」组件 · 去装 ›"，放在灰掉的功能旁边。
import { useEffect, useState } from "react";
import { toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { type ComponentFeatureGate, type ComponentsView, missingComponentFor, t } from "../state/index.ts";

let cached: ComponentsView | undefined;
let inFlight: Promise<void> | undefined;
const listeners = new Set<(view: ComponentsView) => void>();

/** 设置 · 组件取到新的清单：换上，挂着的跟着变 */
export function setComponentsCache(view: ComponentsView): void {
  cached = view;
  for (const listener of listeners) listener(view);
}

/** 组件清单（取一次缓存着）；还没取到是 undefined */
export function useComponents(): ComponentsView | undefined {
  const { http } = useStore();
  const [view, setView] = useState(cached);
  useEffect(() => {
    listeners.add(setView);
    if (cached === undefined && inFlight === undefined) {
      inFlight = http.components().then(
        (v) => {
          inFlight = undefined;
          setComponentsCache(v);
        },
        () => {
          // 取不到（守护进程还没这个接口、断着）：当都能用，下次挂上再取
          inFlight = undefined;
        },
      );
    }
    return () => {
      listeners.delete(setView);
    };
  }, [http]);
  return view;
}

/** 这个功能没法用时要装的组件（能用、还没取到清单是 undefined） */
export function useComponentGate(feature: string): ComponentFeatureGate | undefined {
  return missingComponentFor(useComponents(), feature);
}

let focus: string | undefined;

/** 设置 · 组件打开时要亮一下的那一块（取一次就清掉） */
export function takeComponentFocus(): string | undefined {
  const id = focus;
  focus = undefined;
  return id;
}

/** 去设置 · 组件装这个组件 */
export function goInstallComponent(component: string): void {
  focus = component;
  window.location.hash = toHash({ tab: "more", page: "components" });
}

/** 灰掉的功能旁边那一行："要先装「X」组件 · 去装 ›" */
export function ComponentMissing({ gate, className }: { gate: ComponentFeatureGate; className?: string }) {
  return (
    <button type="button" className={`component-missing${className ? ` ${className}` : ""}`} data-component={gate.component} onClick={() => goInstallComponent(gate.component)}>
      <span>{t("ui.components.missing", { title: gate.title })}</span>
      <span className="component-missing-go">{t("ui.components.goInstall")}</span>
    </button>
  );
}
