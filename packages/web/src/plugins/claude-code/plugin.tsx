// Claude Code 插件的网页这一半（305 号票，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/claude-code/plugin.ts）。
// 插件名和守护进程的一样（claude-code）：守护进程报它在运行就装，停用了、移除了就停。登记的：
// - 设置 · Claude Code 的页面内容（settingsPages，ClaudeCodePage.tsx）：新建时的默认文件夹。地址、名字、在设置列表里的位置（能力那一组、
//   插件后面）留在核心（MorePage 的一种）；插件停用时设置列表里没有这一项，地址写"Claude Code插件没启用"。
// 发起任务、新建项目里选 Claude Code、"在哪个文件夹做"、从会话接管、⚙ 里的运行时一块都是核心按运行时清单画的（运行时是内核的贡献点），不在这里。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { ClaudeCodePage } from "./ClaudeCodePage.tsx";

export const claudeCodeWebPlugin: WebPluginDefinition = {
  name: "claude-code",
  get title() {
    return t("ui.plugins.claudeCode.title");
  },
  owns: { settingsPages: ["claude-code"] },
  // 设置 · 插件里列的网页上的栏目（211 号票）
  get brings() {
    return [t("ui.plugins.claudeCode.brings.settings")];
  },
  setup(ctx) {
    ctx.register("settingsPages", { id: "claude-code", Page: ClaudeCodePage });
  },
};
