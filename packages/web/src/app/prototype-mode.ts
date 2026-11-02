// 这份页面是哪一种，构建时就定了，不看地址（`vite build --mode demo` 给的 import.meta.env.MODE）：
// - 安装版（`npm run build:web`，dist/）：由守护进程提供（http://127.0.0.1:8810、外网的 https 域名），连守护进程。
//   产物里一条假数据都没有（vite.config.ts）；被人直接打开（file://）时没有守护进程可连，只显示一句"要经二狗打开"（pages/OpenThroughErgo.tsx）。
// - 演示页（`npm run build:demo`，dist-demo/）：全是原型自带的编的数据（src/prototype/），不连守护进程。放在 GitHub Pages 上是 https，
//   评审、页面测试 page-opens 用 file:// 打开它。
// 这里只放纯函数，不碰 window、import.meta.env（Node 里的测试也能引）；取值的地方在 main.tsx、locale-boot.ts、AboutPage.tsx。
// 要让假数据不进安装版的分支不走这里：写 `import.meta.env.MODE === "demo"` 字面的比较，构建时才摇得掉。

/** 演示页那份构建的 Vite mode（`vite build --mode demo`） */
export const DEMO_BUILD_MODE = "demo";

/** 页面用不用原型的假数据：只看这份构建是不是演示页 */
export function isPrototypePage(buildMode: string | undefined): boolean {
  return buildMode === DEMO_BUILD_MODE;
}

/** 安装版的页面被直接打开了（file://）：没有守护进程可连，也没有假数据可看 */
export function openedWithoutDaemon(protocol: string, buildMode: string | undefined): boolean {
  return protocol === "file:" && !isPrototypePage(buildMode);
}

/** 安装版被直接打开时用哪种语言（打包进去的中文、英文）：跟系统语言，中文的用中文，别的都用英文 */
export function systemLanguage(language: string | undefined): "zh-CN" | "en" {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
