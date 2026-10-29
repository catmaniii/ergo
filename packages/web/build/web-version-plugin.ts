// 页面是哪一版（116 号票）：构建时算出构建产物内容的哈希，写进 index.html <head> 开头的 <meta name="ergo-web-version">
// （写法在协议包的 web-version.ts）。守护进程从它提供的 index.html 里取出来告诉开着的页面（gateway/web-version.ts），
// 页面读自己的（src/app/web-version.ts），对不上就提示刷新。
// 哈希的是产物里的全部文件（按文件名排好，名字和内容一起算），和插件的先后无关：vite-plugin-singlefile 内联之后只剩 index.html，
// 之前是 index.html 加上脚本、样式。内容不变（同样的代码再构建一遍）版本号就不变，开着的页面不会白提示一次。
// 字体在写盘时才拷（visual-styles-plugin.ts），不在这里；换了字体包，样式里引用的带版本号的目录也变，照样算进来。
import { createHash } from "node:crypto";
import { webVersionMeta } from "@ergo/protocol";
import type { Plugin } from "vite";

/** 版本号取哈希的前几位（十六进制） */
const VERSION_HEX_DIGITS = 16;

export function webVersionPlugin(): Plugin {
  return {
    name: "ergo:web-version",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["index.html"];
      if (page?.type !== "asset") return this.error("构建产物里没有 index.html，写不了版本号");
      const hash = createHash("sha256");
      for (const name of Object.keys(bundle).toSorted()) {
        const file = bundle[name]!;
        hash.update(`${name}\0`);
        hash.update(file.type === "chunk" ? file.code : file.source);
        hash.update("\0");
      }
      const version = hash.digest("hex").slice(0, VERSION_HEX_DIGITS);
      const html = String(page.source);
      if (!html.includes("<head>")) return this.error("index.html 里没有 <head>，写不了版本号");
      page.source = html.replace("<head>", `<head>\n    ${webVersionMeta(version)}`);
    },
  };
}
