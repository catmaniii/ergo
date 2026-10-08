// 前端状态层：外观（34 号票）。用户在设置里选浅色、深色或跟随系统（默认），按"选的外观"和"系统现在是不是深色"
// 算出实际用哪种；记住的选择读出来不认识（旧版本留下的、被改过的）就按跟随系统处理。
import { describe, expect, test } from "vitest";
import { type Theme, type ThemeChoice, themeChoiceOf, resolveTheme } from "../../src/state/index.ts";

describe("实际用哪种外观", () => {
  test.each<[ThemeChoice, boolean, Theme]>([
    ["light", false, "light"],
    ["light", true, "light"], // 选浅色：系统是深色也用浅色
    ["dark", false, "dark"], // 选深色：系统是浅色也用深色
    ["dark", true, "dark"],
    ["system", false, "light"], // 跟随系统：照系统
    ["system", true, "dark"],
  ])("选 %s、系统是深色 %s：用 %s", (choice, systemDark, theme) => {
    expect(resolveTheme(choice, systemDark)).toBe(theme);
  });
});

describe("记住的选择", () => {
  test.each<[string | null, ThemeChoice]>([
    ["light", "light"],
    ["dark", "dark"],
    ["system", "system"],
    [null, "system"], // 没选过
    ["", "system"],
    ["Dark", "system"], // 不认识的值
    ["auto", "system"],
  ])("存的是 %j：当作 %s", (raw, choice) => {
    expect(themeChoiceOf(raw)).toBe(choice);
  });
});
