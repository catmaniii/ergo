// 设置 · 外观与风格：外观和风格不再摊在设置列表上，合成设置里的一项，点进去是这一页。
// 上面是"外观"：浅色、深色、跟随系统（默认），选了马上生效，只记在这台设备上；跟随系统时顺带说一句系统现在是深色
// 还是浅色，系统切了跟着变。中间是"显示"：界面字号（按设备、按屏幕形态各记一份，见 state/font-scale.ts）。
// 下面是"风格"（StylePicker.tsx）：和浅色 / 深色 / 跟随系统是两回事，每套风格都有浅色、深色。
// 设置列表上那一项的副标题是 AppearanceSummary：现在选的，比如"跟随系统 · 净白格栅"；经典换过主色的是"跟随系统 · 经典（橙）"。
// 经典的主色色块在风格里，选中经典时紧跟在它后面（StylePicker.tsx 的 AccentPicker）。
import { useSyncExternalStore } from "react";
import { pageFontScale } from "../../app/page-font-scale.ts";
import { pageTheme } from "../../app/page-theme.ts";
import {
  appearanceSummary,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_PRESETS,
  FONT_SCALE_STEP,
  type FontScalePreset,
  fontScalePresetOf,
  t,
  THEME_CHOICE_LABEL,
  THEME_CHOICES,
  type ThemeChoice,
} from "../../state/index.ts";
import { Section, Segmented } from "../../ui/common.tsx";
import { VISUAL_STYLES } from "../../visual-styles/index.ts";
import { StylePicker } from "./StylePicker.tsx";

export function AppearancePage() {
  // 选项的名字按当前语言现取（不在模块顶层取）
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
      <Section title={t("pages.appearance.display")}>
        <FontScaleSetting />
      </Section>
      <Section title={t("pages.appearance.style")}>
        <span className="muted">{t("pages.appearance.styleHint")}</span>
        <StylePicker />
      </Section>
    </>
  );
}

/**
 * 显示 · 字号：四个预设（小、标准、大、特大）加一根细调滑杆（0.85–1.5，一格 0.05），选了整个页面马上跟着变；
 * 下面一小段示例（标题、正文、一行小字）就是实时预览。按设备、按屏幕形态各记一份：说明里写出现在是哪种形态
 */
function FontScaleSetting() {
  const fontScale = pageFontScale();
  const scale = useSyncExternalStore(fontScale.subscribe, fontScale.scale);
  const form = useSyncExternalStore(fontScale.subscribe, fontScale.form);
  const options = FONT_SCALE_PRESETS.map((p) => ({ value: p.id, label: t(`pages.appearance.fontScale.${p.id}`) }));
  const preset = fontScalePresetOf(scale);
  const percent = Math.round(scale * 100);
  return (
    <div className="font-scale">
      <span className="muted">{t(`pages.appearance.fontScale.hint.${form}`)}</span>
      <div className="appearance-choice">
        <Segmented<FontScalePreset | "custom">
          role="radio"
          label={t("pages.appearance.fontScale.label")}
          value={preset ?? "custom"}
          options={options}
          onChange={(id) => {
            const picked = FONT_SCALE_PRESETS.find((p) => p.id === id);
            if (picked) fontScale.choose(picked.scale);
          }}
        />
      </div>
      <label className="font-scale-slider">
        <span>{t("pages.appearance.fontScale.fine")}</span>
        <input
          type="range"
          min={FONT_SCALE_MIN}
          max={FONT_SCALE_MAX}
          step={FONT_SCALE_STEP}
          value={scale}
          aria-valuetext={t("pages.appearance.fontScale.percent", { percent })}
          onChange={(e) => fontScale.choose(Number(e.currentTarget.value))}
        />
        <b className="font-scale-value">{t("pages.appearance.fontScale.percent", { percent })}</b>
      </label>
      <div className="font-scale-preview card" aria-hidden="true">
        <div className="font-scale-preview-title">{t("pages.appearance.fontScale.previewTitle")}</div>
        <p>{t("pages.appearance.fontScale.previewBody")}</p>
        <div className="muted">{t("pages.appearance.fontScale.previewMeta")}</div>
      </div>
    </div>
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
  // 换过主色的带上主色的名字，比如"经典（橙）"；默认的那种不写，和原来一样
  const chosen = current?.accents?.find((a) => a.id === accent);
  const changed = chosen !== undefined && chosen !== current?.accents?.[0];
  return <>{appearanceSummary(choice, changed ? t("pages.appearance.styleWithAccent", { style: name, accent: chosen.name }) : name)}</>;
}
