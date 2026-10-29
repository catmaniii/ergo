// 设置列表的四组（247 号票，用户 2026-10-22 定方案 A）：身份、能力、规则、数据与设备。
// 这里只是"哪四组、这台设备记住了哪几组收起了"——分组和组里的页是界面的事，在 pages/MorePage.tsx 的 SETTINGS_GROUPS；
// 认、写、点一下这三样和任务看板、项目一览共用 board-fold.ts 的 foldedOf / foldedText / toggleFolded。
// 默认四组都展开（没记过时一组都不收起）。记在这台设备的浏览器里（localStorage 的 ergo-settings-folded，读写在
// app/board-fold-setting.ts 的 SETTINGS_FOLD，页面上那一份在 app/page-settings-fold.ts）。
import { foldedOf, foldedText, toggleFolded } from "./board-fold.ts";

/** 四组，按设置列表上的先后 */
export const SETTINGS_GROUP_IDS = ["identity", "ability", "rules", "data"] as const;
export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];

/** 没记过时收起哪几组：一组都不收（四组都展开） */
export const SETTINGS_GROUPS_FOLDED_DEFAULT: readonly SettingsGroupId[] = [];

/** 这台设备记住的值怎么认：没记过四组都展开；记过的按记的（空串是全展开），认不出的组名丢掉 */
export function settingsFoldedOf(raw: string | null): ReadonlySet<SettingsGroupId> {
  return foldedOf(raw, SETTINGS_GROUP_IDS, SETTINGS_GROUPS_FOLDED_DEFAULT);
}

/** 要记下的值：四组都展开时是 undefined（擦掉记号），否则按四组的先后用逗号连起来 */
export function settingsFoldedText(folded: ReadonlySet<SettingsGroupId>): string | undefined {
  return foldedText(folded, SETTINGS_GROUP_IDS, SETTINGS_GROUPS_FOLDED_DEFAULT);
}

/** 点一下这一组的标题：收起的展开，展开的收起 */
export function toggleSettingsGroup(folded: ReadonlySet<SettingsGroupId>, group: SettingsGroupId): Set<SettingsGroupId> {
  return toggleFolded(folded, group);
}
