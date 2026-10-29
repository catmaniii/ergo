// 设置列表里的一组（247 号票）：组标题一行，点一下收起 / 展开（▸ / ▾），收起时组里的项不画，标题行还在。
// 字号、间距照页面里的一节（.sec-head 的排法、.sec-head h3 的字号），配色只用 token（样式在 styles/pages.css 的"更多"那一段）。
// 展开哪几组记在这台设备上（state/settings-groups.ts、app/page-settings-fold.ts）；宽屏左栏、窄屏整页、"更多"里收进来的设置
// 画的都是这一个列表，收起哪几组一起跟着变。四组各放哪些页在 pages/MorePage.tsx 的 SETTINGS_GROUPS。
import type { ReactNode } from "react";
import { type SettingsGroupId, tTable } from "../../state/index.ts";

/** 四组的名字（168 号票起按当前语言现取） */
const TITLE: Readonly<Record<SettingsGroupId, string>> = tTable({
  identity: "shell.settings.group.identity",
  ability: "shell.settings.group.ability",
  rules: "shell.settings.group.rules",
  data: "shell.settings.group.data",
});

export function SettingsGroup({ id, collapsed, onToggle, children }: { id: SettingsGroupId; collapsed: boolean; onToggle(): void; children?: ReactNode }) {
  return (
    <section className="sec settings-group" data-group={id}>
      <button type="button" className="settings-group-head" aria-expanded={!collapsed} onClick={onToggle}>
        <span className="settings-group-title">{TITLE[id]}</span>
        <span className="settings-group-caret" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>
      {!collapsed && <div className="settings-group-body">{children}</div>}
    </section>
  );
}
