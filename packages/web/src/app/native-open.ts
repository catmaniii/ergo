// 在鸿蒙 App 的原生内置浏览器里打开一个地址（134 号票：132 号票的内置浏览器叠层在 App 里改到"浏览"里打开，外部网站也是）。
// 212 号票起原生内置浏览器是浏览插件的：插件装上时登记打开的办法（plugins/browsing/page-browse.ts 的 openInPageNativeBrowser），
// 停用时撤掉；核心（app/page-in-app-browser.ts）经这里取，没登记（不在 App 里、旧版 App、浏览插件没启用）时返回 false，调用方照旧
// （嵌入框叠层、外部网站新开窗口）。核心留的口子，核心不 import 插件。

let opener: ((url: string) => boolean) | undefined;

/** 登记打开的办法（浏览插件装上时）；返回撤销（停用时） */
export function setPageNativeOpener(open: (url: string) => boolean): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = undefined;
  };
}

/** 在 App 的原生浏览器里打开（切到"浏览"）；没有登记的办法、打不开返回 false，调用方照旧 */
export function openInPageNativeBrowser(url: string): boolean {
  return opener?.(url) ?? false;
}
