// "用手机地图导航"的按钮（434）：聊天里的地图卡片上一个（MapCard.tsx），地图页标题栏看着二狗画的那一条上一个小图标（MapPage.tsx）。
// 只有一处能去的（路线的终点、一个地点）点了直接交出去；几处的（搜到的几家店、秘书标的几个点）先弹一个菜单挑去哪一处。
// 怎么交、交给谁在 navigate.ts：新版鸿蒙 App 拉系统的"选导航应用"面板（按钮），安卓 App 把 geo: 交给系统（链接），
// 浏览器和旧版鸿蒙 App 打开那一家的导航网址（新窗口打开的链接）。都是用户点了才交，二狗自己不拉起导航。
// 字：手机上（App 里、手机浏览器）"用手机地图导航"，电脑上"打开网页地图导航"。
import { type ReactNode, useMemo, useRef, useState } from "react";
import { pageAppReport, pageNativeApp } from "../../app/page-native.ts";
import { type MapProviderView, t } from "../../state/index.ts";
import { Icon } from "../../ui/icons.tsx";
import { PopupMenu } from "../../ui/popup.tsx";
import { usePlugins } from "../api.ts";
import { type MapNavTarget, type NavEnv, type NavHandoff, navHandoff, navigationUrl, nativeTarget, phoneUserAgent } from "./navigate.ts";

/** 能去的一处和怎么交出去 */
export interface NavItem {
  readonly target: MapNavTarget;
  readonly handoff: NavHandoff;
}

/** 按钮要的：能去的几处（交不出去的不在里面）、写手机还是电脑的字 */
export interface NavChoices {
  readonly items: readonly NavItem[];
  readonly phone: boolean;
}

/** 这一页开在哪（读页面的全局对象；没有页面时是浏览器、电脑） */
export function pageNavEnv(): NavEnv {
  const report = pageAppReport();
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return { app: report?.platform, panel: pageNativeApp()?.navigation !== undefined, phone: report !== undefined || phoneUserAgent(ua) };
}

/** 能去的几处各怎么交出去：导航网址看守护进程报的几家（providers）和插槽里登记了 navigation 的几家 */
export function useNavChoices(targets: readonly MapNavTarget[] | undefined, providers: readonly MapProviderView[] | undefined): NavChoices {
  const plugins = usePlugins();
  const version = plugins.version();
  return useMemo(
    () => {
      const env = pageNavEnv();
      const navigationOf = (id: string) => {
        const entry = plugins.get("mapBasemaps", id);
        return entry?.navigation === undefined ? undefined : (target: MapNavTarget) => entry.navigation?.(target);
      };
      const items = (targets ?? []).flatMap((target): NavItem[] => {
        const handoff = navHandoff(target, env, navigationUrl(target, providers, navigationOf));
        return handoff === undefined ? [] : [{ target, handoff }];
      });
      return { items, phone: env.phone };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version 只用来在插件装、停之后重算
    [targets, providers, plugins, version],
  );
}

/** 新版鸿蒙 App：拉系统的面板；没拉起来（App 出错、拒绝了这个页面）打开导航网址 */
async function openInApp(target: MapNavTarget, fallback: string | undefined): Promise<void> {
  const native = pageNativeApp()?.navigation;
  const ok = native === undefined ? false : await native(nativeTarget(target));
  if (!ok && fallback !== undefined) window.open(fallback, "_blank", "noopener,noreferrer");
}

/** 交出去的那一下：面板是按钮；geo: 是链接（安卓 App 把它交给系统）；导航网址是新窗口打开的链接 */
function NavAction({ item, className, label, onDone, children }: { item: NavItem; className: string; label?: string | undefined; onDone?: (() => void) | undefined; children: ReactNode }) {
  const named = label === undefined ? {} : { "aria-label": label, title: label };
  const h = item.handoff;
  if (h.kind === "panel")
    return (
      <button
        type="button"
        className={className}
        data-handoff={h.kind}
        {...named}
        onClick={() => {
          onDone?.();
          void openInApp(item.target, h.fallback);
        }}
      >
        {children}
      </button>
    );
  return (
    <a className={className} data-handoff={h.kind} href={h.url} {...(h.kind === "web" ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...named} onClick={onDone}>
      {children}
    </a>
  );
}

/** 一处在菜单里写什么：名字，没名字写"第 N 处" */
const itemName = (item: NavItem, i: number) => item.target.name ?? t("ui.plugins.map.navigate.unnamed", { n: i + 1 });

/**
 * 按钮本身：compact 是标题栏上的小图标（字放进 aria-label）；align 是几处时菜单和按钮哪边对齐。
 * 一处都去不了（浏览器里一家导航网址都没有、足迹卡）不画
 */
export function MapNavigate({ choices, compact = false, align = "start" }: { choices: NavChoices; compact?: boolean; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const { items, phone } = choices;
  if (items.length === 0) return null;
  const label = t(phone ? "ui.plugins.map.navigate.phone" : "ui.plugins.map.navigate.web");
  const className = compact ? "icon-btn map-nav-btn" : "map-nav-btn";
  const face = compact ? (
    <Icon name="navigate" />
  ) : (
    <>
      <Icon name="navigate" />
      {label}
    </>
  );
  if (items.length === 1)
    return (
      <NavAction item={items[0]!} className={className} label={compact ? label : undefined}>
        {face}
      </NavAction>
    );
  // 链接点下去以后再收起菜单：先收起的话链接已经不在页面上，浏览器不跟着它走
  const close = () => setOpen(false);
  const closeSoon = () => window.setTimeout(close, 0);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`${className}${open ? " on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(compact ? { "aria-label": label, title: label } : {})}
        // 菜单开着时再按一下是收起（按下不让菜单先关、点击再打开）
        onPointerDown={(e) => {
          if (open) e.stopPropagation();
        }}
        onClick={() => setOpen(!open)}
      >
        {face}
      </button>
      {open && (
        <PopupMenu anchor={anchor} align={align} className="row-menu map-nav-menu" label={t("ui.plugins.map.navigate.pick")} onClose={close}>
          <div className="map-nav-head">{t("ui.plugins.map.navigate.pick")}</div>
          {items.map((item, i) => (
            <NavAction key={`${item.target.lat},${item.target.lon},${i}`} item={item} className="map-nav-item" label={t("ui.plugins.map.navigate.to", { name: itemName(item, i) })} onDone={closeSoon}>
              <Icon name="pin" />
              <span className="map-nav-name">{itemName(item, i)}</span>
            </NavAction>
          ))}
        </PopupMenu>
      )}
    </>
  );
}
