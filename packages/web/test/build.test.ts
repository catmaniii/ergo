// 构建产物（34 号票）：照 vite.config.ts 构建一遍（不写盘，不动 dist/），查两件靠构建配置才成立的事：
// - 颜色 token 的 light-dark() 被 Lightning CSS 按 cssTarget 降成了开关变量，产物的 CSS 里一个都不剩
//   （不然老一点的 WebView、ArkWeb 上颜色全丢）；
// - 外观的内联脚本原样留在 <head> 里、在页面脚本和样式之前（打开页面不闪）；
// - 43 号票：页面里不再有"秘书""待我处理"——界面上说到秘书的地方都用用户起的名字，待我处理叫"待办"
//   （代码、领域术语、给 agent 的话照旧，它们不进页面；构建产物里没有注释）。守护进程写的话里的秘书是名字占位，前端换成名字。
//   唯一的例外是协议包的旧说法对照表 LEGACY_WORDING：它认 43 号票之前存下的旧话，自己就得写着旧话（不显示出来）。
// - 39 号票起：风格清单生成的 token 和每套风格的规则进了页面，内联脚本里填好了风格表，页面不请求外部地址；
//   设置里的风格预览：页面样式复制给预览后每套风格的规则都换到了预览上，预览容器按 data-theme 切深浅。
import { fileURLToPath } from "node:url";
import { LEGACY_WORDING } from "@ergou/protocol";
import { build, type Rolldown } from "vite";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { BASE_STYLE, previewCss, stylePageInfo, VISUAL_STYLES } from "../src/visual-styles/index.ts";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

let html = "";

beforeAll(async () => {
  // 和 npm run build:web 一样按生产环境构建（vitest 把 NODE_ENV 设成了 test，Vite 会照它打开发版）
  vi.stubEnv("NODE_ENV", "production");
  try {
    const result = await build({ root: WEB_ROOT, configFile: `${WEB_ROOT}/vite.config.ts`, logLevel: "silent", build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
    const page = outputs.flatMap((o) => o.output).find((f) => f.fileName === "index.html");
    if (page?.type !== "asset") throw new Error("构建产物里没有 index.html");
    html = String(page.source);
  } finally {
    vi.unstubAllEnvs();
  }
}, 60_000);

/** 产物里内联的样式（vite-plugin-singlefile 把 CSS 放进 <head> 里的一个 <style rel="stylesheet">） */
function inlinedCss(): string {
  const css = /<style rel="stylesheet"[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1];
  if (css === undefined) throw new Error("构建产物里没有内联的样式");
  return css;
}

describe("构建产物", () => {
  test("CSS 里没有 light-dark(：都降成了跟着 color-scheme 切的开关变量", () => {
    const css = inlinedCss();
    expect(css).toContain("--bg:");
    expect(css).not.toContain("light-dark(");
    expect(css).toContain("--lightningcss-dark");
  });

  test("页面里没有“秘书”“待我处理”（43 号票：界面上用用户起的名字、“待办”）", () => {
    // 旧说法对照表里的旧话原样在页面里（每句都在），去掉它们再查
    for (const { old } of LEGACY_WORDING) expect(html).toContain(old);
    const rest = LEGACY_WORDING.reduce((page, { old }) => page.replaceAll(old, ""), html);
    for (const word of ["秘书", "待我处理"]) {
      // 前后各带一点上下文，失败时看得出是哪一处
      const hits = [...rest.matchAll(new RegExp(`.{0,30}${word}.{0,30}`, "g"))].map((m) => m[0]);
      expect(hits).toEqual([]);
      // 构建工具万一把中文写成 \uXXXX 转义，也查一遍
      const escaped = [...word].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
      expect(html.toLowerCase().includes(escaped)).toBe(false);
    }
  });

  test("风格清单里的每套风格都有 token：经典挂在 :root，别的挂在 [data-style=<id>] 上（39 号票）", () => {
    const css = inlinedCss();
    for (const style of VISUAL_STYLES) expect(css).toMatch(new RegExp(`\\[data-style=["']?${style.id}["']?\\]\\s*\\{[^}]*--surface:`));
    // 净白格栅深色的底色，经 Lightning CSS 降级后还在
    expect(css).toContain("#0b0b0c");
    // 每套风格自己的规则也进了页面
    expect(css).toMatch(/\[data-style=["']?grid["']?\][^{]*\.[a-z]/);
  });

  test("设置里的风格预览：页面样式复制给预览后，每套风格规则开头的 :root[...] 都换成了 :host(...)，一条不落（39 号票）", () => {
    const css = inlinedCss();
    const out = previewCss(css);
    expect(out).not.toMatch(/:root\[data-style/);
    for (const style of VISUAL_STYLES) {
      const before = css.match(new RegExp(`:root\\[data-style=["']?${style.id}["']?\\]`, "g")) ?? [];
      const after = out.match(new RegExp(`:host\\(\\[data-style=["']?${style.id}["']?\\]`, "g")) ?? [];
      expect({ id: style.id, count: after.length }).toEqual({ id: style.id, count: before.length });
    }
    // 净白格栅的规则确实在里面（压缩后也还是一条条以 :root[data-style=grid] 开头）
    expect(css.match(/:root\[data-style=["']?grid["']?\]/g)?.length).toBeGreaterThan(50);
  });

  test("预览容器按 data-theme 切深浅：color-scheme 降级后也带着开关变量，token 的浅深两样跟着它取（39 号票）", () => {
    const css = inlinedCss();
    expect(css).toMatch(/\.style-preview\{[^}]*--lightningcss-light:initial;[^}]*color-scheme:light/);
    expect(css).toMatch(/\.style-preview\[data-theme=["']?dark["']?\]\{[^}]*--lightningcss-dark:initial;[^}]*color-scheme:dark/);
    // 场景最外层压缩之后还是先 all: initial（挡住页面挂在根元素、body 上的可继承属性），深浅跟着宿主
    expect(css).toMatch(/\.preview-page\{all:initial;color-scheme:inherit;/);
  });

  test("内联脚本里填好了风格表：每套风格的地址栏颜色，有字体的给出字体样式表（39 号票）", () => {
    expect(html).not.toContain("/*VISUAL_STYLES*/");
    const table = /var STYLES = (\{.*?\});/.exec(html)?.[1];
    expect(table).toBeDefined();
    expect(JSON.parse(table!)).toEqual(stylePageInfo(VISUAL_STYLES, BASE_STYLE));
    expect(JSON.parse(table!).grid.fonts).toBe("fonts/grid.css");
  });

  test("页面里不请求外部地址：没有 http(s):// 开头的样式表、字体、脚本（39 号票：字体由二狗自己提供）", () => {
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(inlinedCss()).not.toMatch(/url\(\s*["']?https?:/);
    expect(inlinedCss()).not.toMatch(/@import/);
  });

  test("外观的内联脚本在 <head> 里、在页面脚本和样式之前", () => {
    const boot = html.indexOf('localStorage.getItem("ergou-theme")');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(html.indexOf('<script type="module"'));
    expect(boot).toBeLessThan(html.indexOf('<style rel="stylesheet"'));
    expect(boot).toBeLessThan(html.indexOf("</head>"));
  });
});
