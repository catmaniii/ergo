// 插件清单（ADR-0027）：组合根（daemon.ts）只装内核、按这份清单装插件；配置 plugins.disabled 里写插件名能停用某个，默认全开。
// 加一个插件：写好它的定义（PluginDefinition，见 host.ts；怎么写见插件开发手册 docs/architecture/plugin-development.md），在这里加一行。先后只在依赖相同时起作用（宿主按依赖排顺序）。
// 先后也是插件给同一种 agent 的工具的先后（agent 贡献按插件装的先后排）：记忆插件排在提醒后面，秘书看到的工具顺序才和
// 搬过来之前一样——附件工具、提醒的三个、search_materials、内核的 propose_quick_action……别随手调。
// 日历插件没有给 agent 的东西，排在记忆后面；它要的提醒是可选依赖，宿主照样把它排在提醒后面装。
// 语音插件排在日历后面：它的口语总结、发语音不经 agent 贡献缝（是"每个会话都配的工具"，排在联网工具后面），
// 排在哪里不影响工具的顺序。
// 浏览插件的网页工具写着 at: "end"（排在内核的工具之后），和它在清单里的位置无关；放在最后，设置 · 插件、插件状况里排最后。
// 它可选地要语音插件（wants，悬浮按钮上说话），宿主照样把它排在语音后面装。
// Claude Code 插件只带来一个 agent 运行时（数据契约里登记），没有给 agent 的工具；网页的那一半只有设置 · Claude Code 这一页。
// 手机插件只在数据契约里登记两个数据源（通讯录选人、手机日历），没有给 agent 的工具，排在最后；它可选地要日历插件。
// Google 插件（第一个真的数据源插件）排在手机后面、最后：日历订阅登记成数据源（按需查的工具由内核替它给秘书，排在插件贡献的工具那一处的最后）；
// 它可选地要日历插件（wants，只为写"日历插件没启用"），宿主照样把它排在日历后面装。
// Looki 插件排在 Google 后面、最后：数据契约里登记数据源 looki（按需查的工具由内核替它给秘书），网页那一半在设置 · 数据源里画填 Key 的那一块。
// Codex 插件和 Claude Code 插件一样只带来一个 agent 运行时（数据契约里登记），网页那一半是设置 · Codex 这一页；排在最后。
// 地图插件（429）没有给 agent 的工具，排在最后：数据契约里登记数据源 amap"高德地图"（填 Key），服务给网关的瓦片转发、
// 高德安全密钥代理和 GET /api/map/config；网页那一半是地图页和高德地图的填 Key 那一块。
// 谷歌地图插件（446）排在地图后面、最后：它要地图插件的"地图服务"插槽（needs），在那里登记一家 google；没有给 agent 的工具
// （查地点、算路线还是地图插件那几个）；数据契约里登记数据源 google-maps"谷歌地图"（填两个 Key）。
import { browsingPlugin } from "../browsing/plugin.ts";
import { calendarPlugin } from "../calendar/plugin.ts";
import { claudeCodePlugin } from "../claude-code/plugin.ts";
import { codexPlugin } from "../codex/plugin.ts";
import { googlePlugin } from "../google/plugin.ts";
import { googleMapsPlugin } from "../google-maps/plugin.ts";
import { lookiPlugin } from "../looki/plugin.ts";
import { mapPlugin } from "../map/plugin.ts";
import { memoryPlugin } from "../memory/plugin.ts";
import { phonePlugin } from "../phone/plugin.ts";
import { remindersPlugin } from "../reminders/plugin.ts";
import { voicePlugin } from "../voice/plugin.ts";
import type { PluginDefinition } from "./host.ts";

export const PLUGIN_MANIFEST: readonly PluginDefinition[] = [remindersPlugin, memoryPlugin, calendarPlugin, voicePlugin, browsingPlugin, claudeCodePlugin, phonePlugin, googlePlugin, lookiPlugin, codexPlugin, mapPlugin, googleMapsPlugin];
