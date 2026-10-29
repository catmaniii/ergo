// 网页插件能用的宿主接口（193 号票，ADR-0027）：写插件的定义、往插槽里放东西要的类型和钩子。
// 插件 import 网页核心只经这里和核心自己的模块（state/index.ts、app/、ui/、model/、util/、pages/……），状态层只经 state/index.ts；
// 不 import 别的插件、不 import 插件清单。核心不 import 插件（插件清单 manifest.ts 只由组合根 App.tsx 引）。
// test/plugins/boundary.test.ts 扫 import 检查这几条。写插件见插件开发手册 docs/guides/plugin-development.md。
export type { Undo, WebPluginContext, WebPluginDefinition, WebPluginHost, WebPluginOwns, WebPluginPage } from "./host.ts";
export type {
  BackgroundSlot,
  BoardEntryProps,
  BoardEntrySlot,
  ComposerVoiceSlot,
  CalendarSlot,
  CardSlot,
  ChatItemSlot,
  DataSourceSlot,
  DetailSlot,
  PageColumnProps,
  PageSectionProps,
  PageSlot,
  SettingsPageSlot,
  SettingsSectionSlot,
  SlotMap,
  SlotName,
  TabMountProps,
  TabSlot,
} from "./slots.ts";
export { usePlugins, useRouteAvailable } from "./react.tsx";
