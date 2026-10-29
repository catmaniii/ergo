// Looki 插件的网页这一半（296 号票，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/looki/plugin.ts）。
// 插件名和守护进程的一样（looki）：守护进程报它在运行就装，停用了、移除了就停。登记的：
// - 设置 · 数据源里 Looki 下面的设置那一块（dataSources 插槽，LookiPanel.tsx）：选区域、填 API Key、测试连接并保存。
// 数据源那一行本身（名字、连接状态、同步、断开、两种用法的开关）是核心的数据源页画的；插件停用时这一块不画，那一行写"Looki插件没启用"。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { LookiPanel } from "./LookiPanel.tsx";

/** 数据源 id（和守护进程登记的一样） */
const LOOKI_SOURCE = "looki";

export const lookiWebPlugin: WebPluginDefinition = {
  name: "looki",
  get title() {
    return t("ui.plugins.looki.title");
  },
  owns: { dataSources: [LOOKI_SOURCE] },
  // 设置 · 插件里列的网页上的栏目（211 号票）
  get brings() {
    return [t("ui.plugins.looki.brings.panel")];
  },
  setup(ctx) {
    ctx.register("dataSources", { id: LOOKI_SOURCE, Panel: LookiPanel });
  },
};
