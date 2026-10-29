// 设置 · 外观与风格（74 号票，用户 2026-10-10 定）：外观和风格不再摊在设置列表上，合成设置里的一项，点进去是这一页。
// 上面是"外观"（34 号票）：浅色、深色、跟随系统（默认），选了马上生效，只记在这台设备上；跟随系统时顺带说一句系统现在是深色
// 还是浅色，系统切了跟着变。下面是"风格"（39 号票，StylePicker.tsx）：和浅色 / 深色 / 跟随系统是两回事，每套风格都有浅色、深色。
// 设置列表上那一项的副标题是 AppearanceSummary：现在选的，比如"跟随系统 · 净白格栅"；经典换过主色的是"跟随系统 · 经典（橙）"（119 号票）。
// 经典的主色色块在风格里，选中经典时紧跟在它后面（StylePicker.tsx 的 AccentPicker）。
import { useSyncExternalStore } from "react";
import { pageTheme } from "../../app/page-theme.ts";
import { appearanceSummary, t, THEME_CHOICE_LABEL, THEME_CHOICES, type ThemeChoice } from "../../state/index.ts";
import { Section, Segmented } from "../../ui/common.tsx";
import { VISUAL_STYLES } from "../../visual-styles/index.ts";
import { StylePicker } from "./StylePicker.tsx";

export function AppearancePage() {
  // 选项的名字按当前语言现取（不在模块顶层取，171 号票）
  const options = THEME_CHOICES.map((c) => ({ value: c, label: THEME_CHOICE_LABEL[c] }));
  const theme = pageTheme();
  const choice = useSyncExternalStore(theme.subscribe, theme.choice);
  const current = useSyncExternalStore(theme.subscribe, theme.theme);
  return (
    <>
      <Section title={t("pages.appearance.theme")}>
        <span className="muted">{choice === "system" ? t(current === "dark" ? "pages.appearance.deviceOnlySystemDark" : "pages.appearance.deviceOnlySystemLight") : t("pages.appearance.deviceOnly")}</span>
        <div className="appearance-choice">
          <Segmented<ThemeChoice> role="radio" label={t("pages.appearance.theme")} value={choice} options={options} onChange={theme.choose} />
        </div>
      </Section>
      <Section title={t("pages.appearance.style")}>
        <span className="muted">{t("pages.appearance.styleHint")}</span>
        <StylePicker />
      </Section>
    </>
  );
}

/** 设置列表上"外观与风格"一项的副标题：现在选的外观和风格，选了马上跟着变 */
export function AppearanceSummary() {
  const theme = pageTheme();
  const choice = useSyncExternalStore(theme.subscribe, theme.choice);
  const style = useSyncExternalStore(theme.subscribe, theme.style);
  const accent = useSyncExternalStore(theme.subscribe, () => theme.accent());
  // theme.style() 只给风格清单里有的 id（找不到的已经按经典），名字从清单里取
  const current = VISUAL_STYLES.find((s) => s.id === style);
  const name = current?.name ?? style;
  // 换过主色（119 号票）的带上主色的名字，比如"经典（橙）"；默认的那种不写，和原来一样
  const chosen = current?.accents?.find((a) => a.id === accent);
  const changed = chosen !== undefined && chosen !== current?.accents?.[0];
  return <>{appearanceSummary(choice, changed ? t("pages.appearance.styleWithAccent", { style: name, accent: chosen.name }) : name)}</>;
}
