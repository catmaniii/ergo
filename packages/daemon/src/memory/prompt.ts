// 记忆插件在系统提示里贡献的（129 号票，ADR-0027，照提醒插件的写法）：
// - 条件"记忆"：记忆插件在运行时成立。秘书的默认提示（prompts/secretary.md）"快速动作"那一段里讲记住、忘掉、彻底删除、别推断
//   和先用 search_materials 检索的那两句包在它里面；242 号票起讲记忆管理员（深聊、动手转给它）的那一段也包在它里面；
//   插件停用（配置 plugins.disabled）时秘书的提示里就没有这几句；
// - search_materials、read_material（166 号票）、ask_curator（242 号票）的工具名占位符：插件停用也认得、也有值，
//   用户改过的提示里写了不至于出错；
// - 没有片段：要讲的只有半段话，包在条件里就够了。
// 174 号票：说明在设置 · 系统提示里给人看，跟着当前语言（取值函数）；条件的名字是提示文件里的写法（数据），不翻。
import { t } from "@ergo/protocol";
import type { PluginPrompts } from "../prompts/index.ts";
import { ASK_CURATOR, ASK_MEMORY, READ_MATERIAL, SEARCH_MATERIALS } from "./tool-names.ts";

export const memoryPrompts: PluginPrompts = {
  plugin: "memory",
  flag: {
    name: "记忆", // @i18n-ignore data：条件的名字
    get description() {
      return t("memory.prompt.flag");
    },
  },
  placeholders: [
    {
      name: SEARCH_MATERIALS,
      value: SEARCH_MATERIALS,
      get description() {
        return t("memory.prompt.toolName");
      },
    },
    {
      name: READ_MATERIAL,
      value: READ_MATERIAL,
      get description() {
        return t("memory.prompt.toolName166");
      },
    },
    {
      name: ASK_MEMORY,
      value: ASK_MEMORY,
      get description() {
        return t("memory.prompt.toolName232");
      },
    },
    {
      name: ASK_CURATOR,
      value: ASK_CURATOR,
      get description() {
        return t("memory.prompt.toolName242");
      },
    },
  ],
  fragments: [],
};
