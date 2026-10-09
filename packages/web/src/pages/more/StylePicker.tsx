// 设置 · 外观 · 风格（39 号票）：风格清单里的每一套，浅色、深色两张预览加名字；选了马上生效，只记在这台设备上。
// 预览是用这套风格自己的 token 和规则现场画的一小段场景（StylePreview.tsx，原理见 src/visual-styles/preview.ts），
// 风格清单里加了风格，这里自动多一项。
import { useSyncExternalStore } from "react";
import { pageTheme } from "../../app/page-theme.ts";
import { stylePreviews, VISUAL_STYLES } from "../../visual-styles/index.ts";
import { StylePreview, usePreviewFonts } from "./StylePreview.tsx";

export function StylePicker() {
  const theme = pageTheme();
  const current = useSyncExternalStore(theme.subscribe, theme.style);
  usePreviewFonts();
  return (
    <div className="style-options" role="radiogroup" aria-label="风格">
      {stylePreviews(VISUAL_STYLES).map(({ style, themes }) => {
        const on = style.id === current;
        return (
          <button key={style.id} type="button" role="radio" aria-checked={on} className={`style-option${on ? " on" : ""}`} onClick={() => theme.chooseStyle(style.id)}>
            <span className="style-thumbs">
              {themes.map((t) => (
                <StylePreview key={t} styleId={style.id} theme={t} />
              ))}
            </span>
            <span className="style-option-text">
              {style.name}
              <small>{style.blurb}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}
