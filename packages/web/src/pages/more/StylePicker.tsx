// 设置 · 外观 · 风格（39 号票）：风格清单里的每一套，浅色、深色两张预览加名字；选了马上生效，只记在这台设备上。
// 预览是用这套风格自己的 token 和规则现场画的一小段场景（StylePreview.tsx，原理见 src/visual-styles/preview.ts），
// 风格清单里加了风格，这里自动多一项。
// 119 号票：能换主色的风格（现在只有经典）选中时，紧跟在它的选项后面出现一排主色色块（AccentPicker），点了马上换、记在这台设备上；
// 选别的风格时不显示。经典的两张预览按经典选过的主色画。
import { Fragment, useSyncExternalStore } from "react";
import { pageTheme } from "../../app/page-theme.ts";
import { t } from "../../state/index.ts";
import { stylePreviews, VISUAL_STYLES, type VisualStyle } from "../../visual-styles/index.ts";
import { StylePreview, usePreviewFonts } from "./StylePreview.tsx";

export function StylePicker() {
  const theme = pageTheme();
  const current = useSyncExternalStore(theme.subscribe, theme.style);
  // 现在这套风格的主色（不能换主色的风格是 undefined）；主色变了这里重画，经典的预览跟着换
  const accent = useSyncExternalStore(theme.subscribe, () => theme.accent());
  usePreviewFonts();
  return (
    <div className="style-options" role="radiogroup" aria-label={t("pages.stylePicker.style")}>
      {stylePreviews(VISUAL_STYLES).map(({ style, themes }) => {
        const on = style.id === current;
        return (
          <Fragment key={style.id}>
            <button type="button" role="radio" aria-checked={on} className={`style-option${on ? " on" : ""}`} onClick={() => theme.chooseStyle(style.id)}>
              <span className="style-thumbs">
                {themes.map((tone) => (
                  <StylePreview key={tone} styleId={style.id} theme={tone} accent={theme.accent(style.id)} />
                ))}
              </span>
              <span className="style-option-text">
                {style.name}
                <small>{style.blurb}</small>
              </span>
            </button>
            {on && style.accents?.length && accent !== undefined ? <AccentPicker style={style} current={accent} onChoose={theme.chooseAccent} /> : null}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * 一套风格的主色（119 号票）：一排色块，点了马上换，当前那个打勾。每个色块挂着这套风格和这种主色（data-style、data-accent），
 * 底色是 var(--primary-fill)——生成的样式表在这两个属性上换 token，所以色块就是那种主色在现在深浅下的实色块（主按钮的颜色）
 */
function AccentPicker({ style, current, onChoose }: { style: VisualStyle; current: string; onChoose(id: string): void }) {
  return (
    <div className="accent-picker" role="radiogroup" aria-label={t("pages.stylePicker.accentOf", { style: style.name })}>
      <span className="accent-picker-title">{t("pages.stylePicker.accent")}</span>
      <span className="accent-swatches">
        {(style.accents ?? []).map((a) => {
          const on = a.id === current;
          return (
            <button key={a.id} type="button" role="radio" aria-checked={on} className={`accent-swatch${on ? " on" : ""}`} onClick={() => onChoose(a.id)}>
              <span className="accent-dot" data-style={style.id} data-accent={a.id} aria-hidden="true">
                {on && (
                  <svg viewBox="0 0 24 24" width="16" height="16">
                    <path d="m5.5 12.5 4.25 4.25 8.75-9.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="accent-name">{a.name}</span>
            </button>
          );
        })}
      </span>
    </div>
  );
}
