// 设置里风格预览（39 号票）在浏览器里的那一半：给预览的容器挂 shadow root、用上页面样式表复制出来的那份、
// 让预览里的按钮 Tab 不到。为什么这样画、复制时改了什么，见 src/visual-styles/preview.ts 开头；预览用的字体样式表由
// app/theme.ts 的 showPreviewFonts 挂（和风格的字体样式表同一段代码）。
// 这里不碰浏览器的全局变量（浏览器里由 page-style-preview.ts 接上），能在 Node 里测。
import { previewCss } from "../visual-styles/index.ts";

/** shadow root 里用到的那部分（浏览器里就是 ShadowRoot） */
export interface PreviewRoot {
  querySelectorAll(selector: string): Iterable<{ setAttribute(name: string, value: string): void }>;
}

/** 预览的容器（浏览器里就是挂着 data-style、data-theme 的那个元素） */
export interface PreviewHost<R extends PreviewRoot> {
  readonly shadowRoot: R | null;
  attachShadow?(init: { mode: "open" }): R;
}

export interface PreviewEnv<R extends PreviewRoot> {
  /** 页面内联的样式（单文件页面里是 <style> 的文字；字体样式表是 <link>，不算） */
  pageCss(): string;
  /** 给一个新的 shadow root 用上这份样式表（能共用一份解析好的就共用，不能就各放一份 <style>） */
  adopt(root: R, css: string): void;
}

/**
 * 能拿到焦点的元素：预览里的按钮、链接、输入框……都不让 Tab 到。容器上的 inert 在新浏览器上已经做到了，
 * Chrome 102 以前的老 WebView 不认 inert，这些元素又在 aria-hidden 里面（读屏不念、键盘却能停上去），所以再挂 tabindex="-1"
 */
export const FOCUSABLE = "a[href], area[href], button, input, select, textarea, iframe, summary, audio[controls], video[controls], [tabindex], [contenteditable]";

export interface StylePreviews<R extends PreviewRoot> {
  /** 给容器挂上 shadow root（挂过就用原来的），用上复制的样式表；浏览器不支持 shadow root 就给 undefined（预览空着） */
  open(host: PreviewHost<R>): R | undefined;
  /** 场景画好之后调：里面能拿到焦点的都不让 Tab 到（场景是固定的，画一次就够；改了场景结构也照样认） */
  unfocus(root: R): void;
}

export function stylePreviewsIn<R extends PreviewRoot>(env: PreviewEnv<R>): StylePreviews<R> {
  // 页面样式表只复制、改写一次，所有预览共用
  let css: string | undefined;
  return {
    open(host) {
      if (host.shadowRoot) return host.shadowRoot;
      if (typeof host.attachShadow !== "function") return undefined;
      const root = host.attachShadow({ mode: "open" });
      css ??= previewCss(env.pageCss());
      env.adopt(root, css);
      return root;
    },
    unfocus(root) {
      for (const el of root.querySelectorAll(FOCUSABLE)) el.setAttribute("tabindex", "-1");
    },
  };
}
