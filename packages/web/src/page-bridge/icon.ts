// 页面桥里的小图标（悬浮按钮退回用的、气泡和挑图片窗口的 ×、发送、文件，地图那一行的两个）：SVG，跟着字的颜色。
// 用 DOM 一个个建出来，不写成 HTML 字符串塞进 innerHTML——开了 Trusted Types 的网页（响应头 require-trusted-types-for 'script'）
// 不许给 innerHTML 塞字符串，一塞就抛错，页面桥整个装不上、没有悬浮按钮。建元素、设属性这条路 Trusted Types 不管。
// 图标写成数据：边长、线宽、里面的几个形状；外层都是 24×24 的格子、不填色、描边跟着字的颜色、端点和拐角是圆的（个别的另给）。

const SVG_NS = "http://www.w3.org/2000/svg";

type Attrs = Readonly<Record<string, string | number>>;

/** 一个图标：边长（像素）、线宽、里面的形状（[标签, 属性]）；svg 是外层另给的属性（盖过默认的） */
export interface Icon {
  readonly size: number;
  readonly line: number;
  readonly shapes: readonly (readonly [tag: "path" | "rect" | "circle", attrs: Attrs])[];
  readonly svg?: Attrs;
}

function withAttrs<E extends Element>(e: E, attrs: Attrs): E {
  for (const key in attrs) e.setAttribute(key, String(attrs[key]));
  return e;
}

/** 画一个图标（每次新建一个） */
export function drawIcon(doc: Document, icon: Icon): SVGSVGElement {
  const svg = withAttrs(doc.createElementNS(SVG_NS, "svg"), {
    viewBox: "0 0 24 24",
    width: icon.size,
    height: icon.size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": icon.line,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    ...icon.svg,
  });
  for (const [tag, attrs] of icon.shapes) svg.append(withAttrs(doc.createElementNS(SVG_NS, tag), attrs));
  return svg;
}
