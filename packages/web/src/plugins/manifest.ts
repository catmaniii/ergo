// 网页插件清单（193 号票，ADR-0027）：网页里装哪些网页插件，只在这里列。组合根（App.tsx）建网页插件宿主时引它；
// 核心别处不 import 插件（test/plugins/boundary.test.ts 检查）。加一个网页插件：写好它的定义（plugins/api.ts 的 WebPluginDefinition，
// 见插件开发手册 docs/guides/plugin-development.md），在这里加一行。名字和守护进程的插件一样（守护进程报的状况按它对上）。
// 213 号票：日历插件（导航里的日历页）排在提醒、记忆后面，和守护进程的清单一样；导航里的位置按它登记的 order，不看这里的先后。
// 214 号票：语音插件排在日历后面；212 号票的浏览插件排在后面（"浏览"在导航里的位置是核心定的），都和守护进程的清单一样。
// 299 号票：手机插件排在最后（守护进程清单里 Claude Code 没有网页的那一半）。
// 297 号票：Google 插件排在手机后面，和守护进程的清单一样。
// 296 号票：Looki 插件（设置 · 数据源里填 Key 的那一块）排在 Google 后面、最后。
// 305 号票：Claude Code 插件有了网页的那一半（设置 · Claude Code），照守护进程的清单排在浏览后面、手机前面。
import { browsingWebPlugin } from "./browsing/plugin.tsx";
import { calendarWebPlugin } from "./calendar/plugin.tsx";
import { claudeCodeWebPlugin } from "./claude-code/plugin.tsx";
import { googleWebPlugin } from "./google/plugin.tsx";
import { lookiWebPlugin } from "./looki/plugin.tsx";
import { memoryWebPlugin } from "./memory/plugin.tsx";
import { phoneWebPlugin } from "./phone/plugin.tsx";
import { remindersWebPlugin } from "./reminders/plugin.tsx";
import { voiceWebPlugin } from "./voice/plugin.tsx";
import type { WebPluginDefinition } from "./api.ts";

export const WEB_PLUGIN_MANIFEST: readonly WebPluginDefinition[] = [remindersWebPlugin, memoryWebPlugin, calendarWebPlugin, voiceWebPlugin, browsingWebPlugin, claudeCodeWebPlugin, phoneWebPlugin, googleWebPlugin, lookiWebPlugin];
