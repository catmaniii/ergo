// 这个页面的界面字号：把 app/font-scale.ts 接到浏览器的根元素、localStorage 和窗口大小上。
// 单独一个文件，app/font-scale.ts 就不碰浏览器的全局变量，能在 Node 里测。
import { type FontScaleController, fontScaleControllerIn } from "./font-scale.ts";

let controller: FontScaleController | undefined;

/** 第一次取时读出这种形态记住的比例、写到根元素上，之后跟着窗口宽度换形态（main.tsx 开场就取一次） */
export function pageFontScale(): FontScaleController {
  controller ??= fontScaleControllerIn({
    root: document.documentElement,
    storage: () => localStorage,
    width: () => window.innerWidth,
    onResize: (listener) => window.addEventListener("resize", listener),
  });
  return controller;
}
