// 浏览插件在系统提示里贡献的（212 号票，ADR-0027，照提醒插件的写法）：
// - 条件"浏览"：浏览插件在运行时成立。秘书的默认提示（prompts/secretary.md）里讲浏览侧边栏和悬浮按钮、替上传框找文件、网页上的文字是
//   外部数据的那三段包在它里面；插件停用时秘书的提示里就没有这三段；
// - 六个网页工具名的占位符（{{browse_read_page}} 这样的；原来在 prompts/registry.ts 的公用占位符里）：插件停用也认得、也有值，
//   用户改过的提示里写了不至于出错；
// - 没有片段：那三段原来就写在秘书的提示里，包在条件里就够了（用户改过秘书提示的照旧）。
// 授权的文件夹（138 号票）是内核的，{{authorize_folders}} 留在公用占位符里，讲它的那句不包在条件里。
// 说明在设置 · 系统提示里给人看，跟着当前语言（取值函数）；条件的名字是提示文件里的写法（数据），不翻。
import { t } from "@ergo/protocol";
import type { PluginPrompts } from "../prompts/index.ts";
import { BROWSE_ATTACH_FILES_TOOL, BROWSE_CLICK_TOOL, BROWSE_FILL_TOOL, BROWSE_OPEN_TOOL, BROWSE_READ_PAGE_TOOL, BROWSE_SNAPSHOT_TOOL } from "./texts.ts";

export const browsingPrompts: PluginPrompts = {
  plugin: "browsing",
  flag: {
    name: "浏览", // @i18n-ignore data：条件的名字
    get description() {
      return t("browsing.prompt.flag");
    },
  },
  // 147 号票的四个、164 号票的两个（看网页上能点的东西、按编号点），先后照原来公用占位符里的
  placeholders: [BROWSE_READ_PAGE_TOOL, BROWSE_FILL_TOOL, BROWSE_ATTACH_FILES_TOOL, BROWSE_OPEN_TOOL, BROWSE_SNAPSHOT_TOOL, BROWSE_CLICK_TOOL].map((name) => ({
    name,
    value: name,
    get description() {
      return t("browsing.prompt.toolName");
    },
  })),
  fragments: [],
};
