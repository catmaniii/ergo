// 提醒插件在系统提示里贡献的（128 号票，ADR-0027）：
// - 条件"提醒"：提醒插件在运行时成立。秘书的默认提示（prompts/secretary.md）里讲提醒的地方都包在它里面——插进下面的片段的那一段，
//   和"承诺即任务""定时触发的任务"两句里顺带说到简单提醒的半句；插件停用（配置 plugins.disabled）时秘书的提示里就没有提醒；
// - 工具名的占位符（{{create_reminder}} 这样的；185 号票加了 {{archive_reminder}} 和删除的快速动作 {{delete_reminder}}）：插件停用也认得、
//   也有值，用户改过的提示里写了不至于出错；
// - 片段 reminders：秘书怎么建、改、取消简单提醒（默认的在本目录的 prompts/reminders.md，用户改的照样在数据目录配置区的 prompts/）。
// 174 号票：说明、片段的名字在设置 · 系统提示里给人看，跟着当前语言（取值函数）；条件的名字是提示文件里的写法（数据），不翻。
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import type { PluginPrompts } from "../prompts/index.ts";
import { DELETE_REMINDER_ACTION, REMINDER_TOOL } from "./tool-names.ts";

export const remindersPrompts: PluginPrompts = {
  plugin: "reminders",
  flag: {
    name: "提醒", // @i18n-ignore data：条件的名字
    get description() {
      return t("reminders.prompt.flag");
    },
  },
  // 工具名，和删除的快速动作（185 号票，{{delete_reminder}}）
  placeholders: [...Object.values(REMINDER_TOOL), DELETE_REMINDER_ACTION].map((name) => ({
    name,
    value: name,
    get description() {
      return t("reminders.prompt.toolName");
    },
  })),
  fragments: [
    {
      id: "reminders",
      get title() {
        return t("reminders.prompt.title");
      },
      get description() {
        return t("reminders.prompt.description", { tool: REMINDER_TOOL.create });
      },
      defaultFile: fileURLToPath(new URL("./prompts/reminders.md", import.meta.url)),
      includedBy: ["secretary"],
    },
  ],
};
