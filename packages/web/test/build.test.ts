// 构建产物（34 号票）：照 vite.config.ts 构建一遍（不写盘，不动 dist/），查两件靠构建配置才成立的事：
// - 颜色 token 的 light-dark() 被 Lightning CSS 按 cssTarget 降成了开关变量，产物的 CSS 里一个都不剩
//   （不然老一点的 WebView、ArkWeb 上颜色全丢）；
// - 外观的内联脚本原样留在 <head> 里、在页面脚本和样式之前（打开页面不闪）。
import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { beforeAll, describe, expect, test, vi } from "vitest";

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

  test("外观的内联脚本在 <head> 里、在页面脚本和样式之前", () => {
    const boot = html.indexOf('localStorage.getItem("ergou-theme")');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(html.indexOf('<script type="module"'));
    expect(boot).toBeLessThan(html.indexOf('<style rel="stylesheet"'));
    expect(boot).toBeLessThan(html.indexOf("</head>"));
  });
});
