// 悬浮按钮上的二狗图标：图标的字节打进页面桥（assets/ergo-icon.webp，Vite 的 ?inline），注入时解成位图、
// 画进按钮里的 canvas（封闭的 shadow root 里）。不用 <img src="data:…"> 也不用 background-image：网站的 CSP（img-src、default-src）会拦
// data: 图片，字节解成位图再画到 canvas 这条路 CSP 不管（和挑图片窗口的缩略图一样，pick.ts）。canvas 不接事件（样式里 pointer-events: none），
// 按下、长按还是按钮自己的，手机上长按也不会弹"保存图片"。
// 解不出来、画不上回 undefined：按钮留着原来的 SVG，不会是空白的。
import ICON_URL from "../assets/ergo-icon.webp?inline";
import { bitmapOfBase64, type PickTools } from "./pick.ts";

export async function paintFabIcon(doc: Document, tools: Pick<PickTools, "decode" | "makeBitmap" | "BlobCtor">): Promise<HTMLCanvasElement | undefined> {
  try {
    const bitmap = await bitmapOfBase64(tools, ICON_URL.slice(ICON_URL.indexOf(",") + 1));
    const canvas = doc.createElement("canvas");
    // 原图的大小（192，按钮 36 像素，四倍屏也够），多大的屏都不用重画
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  } catch {
    return undefined;
  }
}
