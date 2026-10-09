// 风格 token 实际的颜色（39 号票）：对比度测试、地址栏颜色、设置里的预览都靠它。顺着 var(--别的 token) 找下去；
// 半透明的颜色（玻璃这类风格的面板）按"叠在页面底色上"算——不支持毛玻璃的浏览器退回的就是这个样子，字的对比度不能靠模糊撑。
import { describe, expect, test } from "vitest";
import { BASE_STYLE, effectiveTokens, fontStack, resolveColor, type VisualStyle } from "../../src/visual-styles/index.ts";

function tokensOf(tokens: VisualStyle["tokens"]) {
  return effectiveTokens({ id: "t", name: "测试", blurb: "", tokens }, BASE_STYLE);
}

describe("token 实际的颜色", () => {
  test("浅深两个值各取各的", () => {
    const tokens = tokensOf({ text: ["#111111", "#EEEEEE"] });
    expect(resolveColor(tokens, "text", "light")).toBe("#111111");
    expect(resolveColor(tokens, "text", "dark")).toBe("#eeeeee");
  });

  test("顺着 var(--别的 token) 找下去", () => {
    const tokens = tokensOf({ primary: ["#123456", "#654321"], "nav-on": "var(--primary)", badge: "var(--nav-on)" });
    expect(resolveColor(tokens, "badge", "dark")).toBe("#654321");
  });

  test("半透明的颜色叠在页面底色上算：#rrggbbaa 和 rgba() 一样", () => {
    const tokens = tokensOf({ bg: "#000000", surface: "#ffffff80", fill: "rgba(255, 255, 255, 0.5)" });
    expect(resolveColor(tokens, "surface", "light")).toBe("#808080");
    expect(resolveColor(tokens, "fill", "light")).toBe("#808080");
  });

  test.each<[string, string]>([
    ["color-mix(in srgb, red 50%, blue)", "不是能算出来的颜色"],
    ["var(--nope)", "不认识的 token"],
  ])("算不出来的写法报错：%s", (value, message) => {
    expect(() => resolveColor(tokensOf({ surface: value }), "surface", "light")).toThrow(message);
  });

  test("页面底色自己不能半透明", () => {
    expect(() => resolveColor(tokensOf({ bg: "#ffffff80" }), "bg", "light")).toThrow("页面底色");
  });

  test("字体栈：顺着里面的 var() 展开，字族名去掉引号；标题、数字没写就跟正文", () => {
    const tokens = tokensOf({ "font-body": '"Body Sans", sans-serif', "font-num": "'Num Mono', var(--font-body)" });
    expect(fontStack(tokens, "font-num")).toEqual(["Num Mono", "Body Sans", "sans-serif"]);
    expect(fontStack(tokens, "font-title")).toEqual(["Body Sans", "sans-serif"]);
  });

  test("互相引用成环：报错，不死循环", () => {
    expect(() => resolveColor(tokensOf({ primary: "var(--nav-on)", "nav-on": "var(--primary)" }), "primary", "light")).toThrow("环");
  });
});
