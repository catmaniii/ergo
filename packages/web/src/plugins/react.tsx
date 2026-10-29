// 网页插件宿主的 React 那一半（193 号票）：把宿主（plugins/host.ts）交给界面、按守护进程报的状况装和停、核心各处按插槽取。
// - PluginHostProvider：组合根（App.tsx）建好宿主（插件清单在 plugins/manifest.ts）后从这里交下去；没给的地方（只渲染一个组件的测试）
//   是一个空宿主——什么插件都没有，插件拥有的位置也不认得；
// - PluginStatusSync：盯着前端状态层里的插件状况（插件频道上的 plugin_status），变了就 apply；
// - PluginBackground（214 号票）：画在用的插件登记的后台部件（background 插槽，比如语音插件的自动播放），整个页面一份；
// - usePlugins：取宿主，装、停时跟着重画；useUnavailable：停用的插件拥有的会话条目（按种类，卡片按卡片类型）交回它的名字，
//   会话、详情据此换成占位（state/chat-items.ts 的 maskUnavailable）；
// - useRouteAvailable（213 号票）：某个地址的页面现在在不在（归停用的插件的不在），核心里去那一页的链接据此不出；
// - PluginRoutePage（213 号票）：有自己地址的插件页面（日历的 #/calendar）在核心的路由里怎么画：插件在就画它的 Section，停用了写"X插件没启用"。
import { createContext, type ReactNode, useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import { type Navigate, navItemOf, type Route } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { type ChatItem, t } from "../state/index.ts";
import { TopBar } from "../ui/common.tsx";
import { createWebPluginHost, type WebPluginHost } from "./host.ts";

const EMPTY_HOST = createWebPluginHost({ plugins: [] });

const PluginHostContext = createContext<WebPluginHost>(EMPTY_HOST);

export function PluginHostProvider({ host, children }: { host: WebPluginHost; children?: ReactNode }) {
  return <PluginHostContext.Provider value={host}>{children}</PluginHostContext.Provider>;
}

/** 网页插件宿主；装、停时跟着重画 */
export function usePlugins(): WebPluginHost {
  const host = useContext(PluginHostContext);
  useSyncExternalStore(host.subscribe, host.version, host.version);
  return host;
}

/** 按守护进程报的插件状况装和停网页插件（放在 StoreProvider、PluginHostProvider 里面，整个页面一份） */
export function PluginStatusSync() {
  const host = useContext(PluginHostContext);
  const report = useStore().ui.pluginStatus?.plugins;
  useEffect(() => host.apply(report), [host, report]);
  return null;
}

/** 在用的插件登记的后台部件（214 号票）：不画东西，装、停时跟着挂上、卸下（放在 StoreProvider、PluginHostProvider 里面，整个页面一份） */
export function PluginBackground() {
  const parts = usePlugins().list("background");
  return (
    <>
      {parts.map(({ id, Run }) => (
        <Run key={id} />
      ))}
    </>
  );
}

/**
 * 这一条会话条目归哪个没在用的插件（它给人看的名字）：对话条目按种类（调用记忆归记忆插件），卡片按卡片类型（提醒卡归提醒插件）。
 * 插件都在用时交回 undefined
 */
export function useUnavailable(): (item: ChatItem) => string | undefined {
  const host = usePlugins();
  const { ui } = useStore();
  const cards = ui.cards;
  const version = host.version();
  return useCallback(
    (item: ChatItem) => {
      if (item.kind === "card") {
        const type = cards[item.cardId]?.card.type;
        return type === undefined ? undefined : host.unavailable("cards", type);
      }
      return host.unavailable("chatItems", item.kind);
    },
    // version：装、停之后换一个函数（会话的条目跟着重算）
    // eslint-disable-next-line react-hooks/exhaustive-deps, react/memo-dependencies -- version 只用来在装、停之后换一个
    [host, cards, version],
  );
}

/**
 * 某个地址的页面现在在不在（213 号票）：归停用的插件的页面不在（日历插件停用时的 #/calendar、记忆插件停用时的 #/more/memory），
 * 核心里去那一页的链接据此不出（设置 · 工作日规则里的"日历"、待办里到点的提醒的"去看看"）。按地址属于导航的哪一项认
 */
export function useRouteAvailable(): (route: Route) => boolean {
  const host = usePlugins();
  return (route) => {
    const item = navItemOf(route);
    return item === undefined || item === "more" || host.unavailable("pages", item) === undefined;
  };
}

/**
 * 有自己地址的插件页面（PageSlot.route，213 号票：日历的 #/calendar[/月份 | /日期]）在核心的路由里画：插件在用就画它的 Section
 * （item 是地址里的那一段），停用了和 #/more/<页面 id> 一样写"X插件没启用，这一页暂时看不到"
 */
export function PluginRoutePage({ id, wide, item, navigate }: { id: string; wide: boolean; item: string | undefined; navigate: Navigate }) {
  const host = usePlugins();
  const page = host.get("pages", id);
  if (page) return <page.Section wide={wide} item={item} sub={undefined} navigate={navigate} />;
  const off = host.unavailable("pages", id) ?? id;
  return (
    <div className="chat-col">
      <TopBar title={off} />
      <div className="page-placeholder">{t("ui.plugins.pageUnavailable", { plugin: off })}</div>
    </div>
  );
}
