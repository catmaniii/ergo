// 设置顶部的"外观"（34 号票）：浅色、深色、跟随系统（默认），选了马上生效，只记在这台设备上。
// 跟随系统时顺带说一句系统现在是深色还是浅色，系统切了跟着变。
import { useSyncExternalStore } from "react";
import { pageTheme } from "../../app/page-theme.ts";
import { THEME_CHOICES, type ThemeChoice } from "../../state/index.ts";
import { Segmented } from "../../ui/common.tsx";

const LABEL: Record<ThemeChoice, string> = { light: "浅色", dark: "深色", system: "跟随系统" };
const OPTIONS = THEME_CHOICES.map((c) => ({ value: c, label: LABEL[c] }));

export function AppearancePicker() {
  const theme = pageTheme();
  const choice = useSyncExternalStore(theme.subscribe, theme.choice);
  const current = useSyncExternalStore(theme.subscribe, theme.theme);
  return (
    <div className="appearance">
      <div className="menu-text">
        外观
        <small>只对这台设备生效{choice === "system" ? `；系统现在是${current === "dark" ? "深色" : "浅色"}` : ""}</small>
      </div>
      <Segmented<ThemeChoice> role="radio" label="外观" value={choice} options={OPTIONS} onChange={theme.choose} />
    </div>
  );
}
