// 地图页的隔离框（453，ADR-0059）：别家地图的脚本（谷歌）关进一个 <iframe sandbox="allow-scripts">，读不到外层的页面——
// 足迹、点、线画在外层盖着的自己那一层上，地图页右侧的聊天窗（444）也在外层。框里是一个空壳页面（public/map-frame.html，
// 守护进程照样给它回应头里的 sandbox）：外层等它说"好了"，交给它一段要跑的代码（那家的小桥）和设置（Key、一开始看哪里、深浅），
// 之后用 postMessage 来回：外层发"挪到哪里、放大缩小、换深浅"，框里报"此刻画着哪一片、停下来了、加载好了、加载不了"。
// - 框是不透明来源：没有 cookie、本地存储，发出去的请求不带 Referer（原型量过），不能把外层导航走、不能弹窗；
// - 只认这个框发来的（e.source 是它、带着 ergoMapFrame 记号），交给框的只有视野和设置，足迹、点、线一样都不交；
// - 地址：经二狗打开时是守护进程的 /map-frame.html（和页面同源，打开它的请求带着这台设备的凭证）；
//   演示页（file://）是 dist-demo/ 里挨着 index.html 的同一个文件。
// 插件之间不互相 import：这里放在核心，谷歌地图插件（以后要关进框的别家也一样）用它。

import { MAP_FRAME_PATH } from "../state/index.ts";

/** 框的地址：public/map-frame.html 构建时原样拷进产物；经二狗打开时按绝对地址（页面可能开在别的路径上），file:// 时挨着页面 */
export function mapFrameSrc(win: Pick<Window, "location">): string {
  return win.location.protocol === "file:" ? MAP_FRAME_PATH.slice(1) : MAP_FRAME_PATH;
}
/** 来回的消息都带这个记号（别的 postMessage 不理） */
export const MAP_FRAME_MARK = "ergoMapFrame";

/** 框里报来的一条（type 之外的字段那家的小桥自己定） */
export interface MapFrameMessage {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface MapFrame {
  /** 发一条给框里（init 之后才发得出去；之前发的排着，init 后一起发） */
  post(msg: MapFrameMessage): void;
  /** 拆掉框、不再收它的消息 */
  destroy(): void;
  readonly element: HTMLIFrameElement;
}

/**
 * 在 host 里开一个隔离框：等框说"好了"，发一次 init（code 是框里要跑的那一段，拿到 env、config 两个参数；只发一次，
 * 框后来又说"好了"也不再发：免得框被它里面的脚本导航到别处后又拿到设置），框里来的别的消息交给 onMessage
 */
export function openMapFrame(host: HTMLElement, init: { code: string; config: unknown }, onMessage: (msg: MapFrameMessage) => void, src?: string): MapFrame {
  const doc = host.ownerDocument;
  const win = doc.defaultView ?? window;
  // sandbox 紧接着就设上（allow-scripts，不给 allow-same-origin）
  // oxlint-disable-next-line react/iframe-missing-sandbox
  const frame = doc.createElement("iframe");
  frame.className = "map-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", "map");
  frame.src = src ?? mapFrameSrc(win);
  let inited = false;
  let destroyed = false;
  const queue: MapFrameMessage[] = [];
  const send = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ ...msg, [MAP_FRAME_MARK]: 1 }, "*");
  const listener = (e: MessageEvent) => {
    if (destroyed || e.source !== frame.contentWindow) return;
    const data = e.data as Record<string, unknown> | null;
    if (typeof data !== "object" || data === null || data[MAP_FRAME_MARK] !== 1 || typeof data.type !== "string") return;
    if (data.type === "frame-ready") {
      if (inited) return;
      inited = true;
      send({ type: "init", code: init.code, config: init.config });
      for (const m of queue.splice(0)) send({ ...m });
      return;
    }
    onMessage(data as MapFrameMessage);
  };
  win.addEventListener("message", listener);
  host.append(frame);
  return {
    element: frame,
    post(msg) {
      if (destroyed) return;
      if (inited) send({ ...msg });
      else queue.push(msg);
    },
    destroy() {
      destroyed = true;
      win.removeEventListener("message", listener);
      frame.remove();
    },
  };
}
