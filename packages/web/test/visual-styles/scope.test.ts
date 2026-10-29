// 每套风格自己的规则（<id>/style.css，39 号票）只能管到这套风格：每条规则的每个选择器都以
// :root[data-style="<自己的 id>"] 开头。几张风格票并行写时，写漏一个前缀就会漏到经典和别的风格上，这里一条条扫。
// 根元素上只能再加属性（比如 [data-theme="dark"]），往下接只能是空格（后代）或者 "> body"：设置里的预览把开头换成
// :host(...)、把根元素本身和 body 换成场景最外层，:has()、.类名、"> 别的"这些对不上。
// @media / @supports / @container 里面照样查；@keyframes 的名字要以"<id>-"开头（免得和别的风格、经典的动画重名）；
// 别的 @ 规则（@font-face、@import……）不许写在这里：字体由风格的 fonts 提供。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { VISUAL_STYLES } from "../../src/visual-styles/index.ts";

const STYLES_DIR = path.resolve(import.meta.dirname, "../../src/visual-styles");

/** 一份样式表里不合规矩的地方 */
function violations(css: string, id: string): string[] {
  const prefix = `:root[data-style="${id}"]`;
  const out: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  // 读到下一个 { 或 } 为止，返回读到的那一段和停在哪个字符
  const until = (): [string, string | undefined] => {
    const start = i;
    while (i < text.length && text[i] !== "{" && text[i] !== "}") i++;
    return [text.slice(start, i).trim(), text[i++]];
  };
  // 跳过一个已经读掉 { 的块（声明块、@keyframes 的内容）
  const skipBlock = () => {
    for (let depth = 1; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
  };
  const walk = () => {
    while (i < text.length) {
      const [head, stop] = until();
      if (stop !== "{") return; // 到了外层块的 } 或者结尾
      if (head.startsWith("@")) {
        const name = /^@([a-z-]+)/.exec(head)?.[1];
        if (name === "media" || name === "supports" || name === "container") {
          walk();
        } else if (name === "keyframes") {
          const anim = head.replace(/^@keyframes\s+/, "");
          if (!anim.startsWith(`${id}-`)) out.push(`@keyframes ${anim}：名字要以 ${id}- 开头`);
          skipBlock();
        } else {
          out.push(`${head}：风格的 style.css 里不写这种 @ 规则`);
          skipBlock();
        }
        continue;
      }
      for (const selector of head.split(",").map((s) => s.trim())) {
        if (!selector.startsWith(prefix)) out.push(`${selector}：没以 ${prefix} 开头`);
        // 设置里的预览把开头换成 :host(...)、把根元素本身和 body 换成场景最外层（src/visual-styles/preview.ts）：
        // 根元素上只能再加属性，往下接只能是空格（后代）或者 > body
        else if (!/^(?:$|\s*>\s*body(?![\w-])|\s+(?=[^\s>+~]))/.test(selector.slice(prefix.length).replace(/^(?:\[[^\]]*\])+/, ""))) {
          out.push(`${selector}：根元素上只能再加属性（[...]），往下接只能是空格（后代）或者 > body`);
        }
      }
      skipBlock();
    }
  };
  walk();
  return out;
}

describe("扫描的规矩本身", () => {
  test("合规的：每个选择器都带前缀，@media 里也是", () => {
    const css = `:root[data-style="x"] .a, :root[data-style="x"] .b { color: red; }
      /* 注释里的 .c { } 不算 */
      @media (max-width: 600px) { :root[data-style="x"] .c { color: blue; } }
      :root[data-style="x"][data-theme="dark"] .d, :root[data-style="x"] > body, :root[data-style="x"]>body .e2, :root[data-style="x"] { color: red; }
      @keyframes x-pulse { from { opacity: 0; } to { opacity: 1; } }`;
    expect(violations(css, "x")).toEqual([]);
  });

  test("不合规的：漏了前缀、前缀是别的风格、@media 里漏了、动画名、@font-face、根元素上挂了属性以外的东西", () => {
    const css = `.a { color: red; }
      :root[data-style="x"] .b, .c { color: red; }
      :root[data-style="y"] .d { color: red; }
      @media (prefers-reduced-motion: reduce) { .e { animation: none; } }
      @keyframes pulse { from { opacity: 0; } }
      @font-face { font-family: "Z"; }
      :root[data-style="x"]:has(.f) .g, :root[data-style="x"].h, :root[data-style="x"] > .i, :root[data-style="x"][data-theme="dark"] + .j { color: red; }`;
    expect(violations(css, "x")).toEqual([
      '.a：没以 :root[data-style="x"] 开头',
      '.c：没以 :root[data-style="x"] 开头',
      ':root[data-style="y"] .d：没以 :root[data-style="x"] 开头',
      '.e：没以 :root[data-style="x"] 开头',
      "@keyframes pulse：名字要以 x- 开头",
      "@font-face：风格的 style.css 里不写这种 @ 规则",
      ':root[data-style="x"]:has(.f) .g：根元素上只能再加属性（[...]），往下接只能是空格（后代）或者 > body',
      ':root[data-style="x"].h：根元素上只能再加属性（[...]），往下接只能是空格（后代）或者 > body',
      ':root[data-style="x"] > .i：根元素上只能再加属性（[...]），往下接只能是空格（后代）或者 > body',
      ':root[data-style="x"][data-theme="dark"] + .j：根元素上只能再加属性（[...]），往下接只能是空格（后代）或者 > body',
    ]);
  });
});

describe("风格清单里每一套的 style.css 只管到自己", () => {
  test.each(VISUAL_STYLES.map((s) => [s.name, s.id] as const))("%s（%s）", (_name, id) => {
    const file = path.join(STYLES_DIR, id, "style.css");
    const css = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    expect(violations(css, id)).toEqual([]);
  });
});
