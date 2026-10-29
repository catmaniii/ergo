// 页面用不用原型的假数据（316 号票加了在线演示页）。两种情况没有守护进程、全部用原型自带的编的数据：
// 1. 直接打开构建产物（file://，评审、测试 page-opens 都这么开）；
// 2. 在线演示页：`npm run build:demo` 按 `vite build --mode demo` 构建一份（放 GitHub Pages，地址是 https，不是 file://），
//    构建时写死成原型，打开就是编的数据，不去连守护进程。
// 守护进程提供的页面（http://127.0.0.1:8810、外网的 https 域名）两样都不是，照常连守护进程。
// 这里只放纯函数，不碰 window、import.meta.env（Node 里的测试也能引）；取值的地方在 App.tsx、AboutPage.tsx、locale-boot.ts。

/** 在线演示页那份构建的 Vite mode（`vite build --mode demo`） */
export const DEMO_BUILD_MODE = "demo";

/** 页面用不用原型的假数据：页面的协议是 file:，或者这份构建是在线演示页的 */
export function isPrototypePage(protocol: string, buildMode: string | undefined): boolean {
  return protocol === "file:" || buildMode === DEMO_BUILD_MODE;
}
