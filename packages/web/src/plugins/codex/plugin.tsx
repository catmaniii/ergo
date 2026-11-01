// Codex 插件的网页这一半（ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/codex/plugin.ts）。
// 插件名和守护进程的一样（codex）：守护进程报它在运行就装，停用了、没装上（本机没有 Codex）就停。登记的：
// - 设置 · Codex 的页面内容（settingsPages，CodexPage.tsx）：新建时的默认文件夹。地址、名字、在设置列表里的位置（能力那一组、插件后面）留在核心（MorePage 的一种）。
// 发起任务、新建项目里选 Codex、"在哪个文件夹做"、从会话接管、⚙ 里的运行时一块都是核心按运行时清单画的（运行时是内核的贡献点），不在这里。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { CodexPage } from "./CodexPage.tsx";

export const codexWebPlugin: WebPluginDefinition = {
  name: "codex",
  get title() {
    return t("ui.plugins.codex.title");
  },
  owns: { settingsPages: ["codex"] },
  // 设置 · 插件里列的网页上的栏目
  get brings() {
    return [t("ui.plugins.codex.brings.settings")];
  },
  setup(ctx) {
    ctx.register("settingsPages", { id: "codex", Page: CodexPage });
  },
};
