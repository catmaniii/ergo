// 外观（纯函数，34 号票）：设置里选浅色、深色或跟随系统（默认）。选择按设备记住（存在这台设备的浏览器里），
// 不是个人数据，也不经协议。这里只算：记住的值认不认识、选的外观加上系统现在是不是深色，实际用哪种。
// 读写浏览器存储、给页面挂标记、跟着系统变，在 app/theme.ts。

/** 设置里的三个选项，按显示顺序 */
export const THEME_CHOICES = ["light", "dark", "system"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** 实际用的外观 */
export type Theme = "light" | "dark";

/** 记住的值：认识的原样用，没选过或不认识（旧版本留下的、被改过的）都当跟随系统 */
export function themeChoiceOf(raw: string | null): ThemeChoice {
  return THEME_CHOICES.find((c) => c === raw) ?? "system";
}

/** 实际用哪种：选了浅色、深色就照选的，不管系统；跟随系统时照系统 */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}
