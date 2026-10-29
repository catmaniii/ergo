// 这个页面的风格预览（39 号票）：把 app/style-preview.ts 接到浏览器的 document 上。
// 单独一个文件，app/style-preview.ts 就不碰浏览器的全局变量，能在 Node 里测。
import { type StylePreviews, stylePreviewsIn } from "./style-preview.ts";

let previews: StylePreviews<ShadowRoot> | undefined;
/** 解析好的那份样式表：所有预览共用（浏览器支持 adoptedStyleSheets 时） */
let shared: CSSStyleSheet | undefined;

function canAdopt(root: ShadowRoot): boolean {
  return "adoptedStyleSheets" in root && typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype;
}

/** 第一次取时建好；页面样式表在第一次画预览时才复制 */
export function pageStylePreviews(): StylePreviews<ShadowRoot> {
  previews ??= stylePreviewsIn<ShadowRoot>({
    // 单文件页面里样式都内联在 <style> 里（开发服务器也是一份份 <style>）；字体样式表是 <link>，不复制
    pageCss: () => Array.from(document.querySelectorAll("style"), (el) => el.textContent ?? "").join("\n"),
    adopt(root, css) {
      if (canAdopt(root)) {
        if (!shared) {
          shared = new CSSStyleSheet();
          shared.replaceSync(css);
        }
        root.adoptedStyleSheets = [shared];
        return;
      }
      const style = document.createElement("style");
      style.textContent = css;
      root.append(style);
    },
  });
  return previews;
}
