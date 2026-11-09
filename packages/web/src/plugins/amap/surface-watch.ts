// 只出底图的引擎（453）报"此刻画着哪一片"用的小工具：底图在动（拖、捏、滚轮、惯性、动画）时每一帧读一次它的中心、级别、大小，
// 变了就报；停下来二十帧没变就歇着，等下一次有动静（手指、鼠标、那家地图自己的移动事件）再叫醒（poke）。
// 不一直跑着：地图停着的时候不占手机的电。叫醒的那一下当场读一次、变了当场报（和底图同一帧）。
import type { MapSurfaceView } from "../api.ts";

/** 停下来多少帧没变就歇着 */
const IDLE_FRAMES = 20;

export interface SurfaceWatch {
  /** 有动静了：当场读一次，接着每一帧读，直到停下来 */
  poke(): void;
  stop(): void;
}

export function watchSurface(read: () => MapSurfaceView | undefined, report: (view: MapSurfaceView) => void, win: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame"> = window): SurfaceWatch {
  let last = "";
  let frame = 0;
  let still = 0;
  let stopped = false;
  const check = () => {
    const v = read();
    if (v === undefined || v.width <= 0 || v.height <= 0) return;
    const key = `${v.lat}|${v.lon}|${v.zoom}|${v.width}|${v.height}|${v.datum}`;
    if (key === last) {
      still += 1;
      return;
    }
    last = key;
    still = 0;
    report(v);
  };
  const tick = () => {
    frame = 0;
    if (stopped) return;
    check();
    if (still < IDLE_FRAMES) frame = win.requestAnimationFrame(tick);
  };
  return {
    poke() {
      if (stopped) return;
      still = 0;
      check();
      if (frame === 0) frame = win.requestAnimationFrame(tick);
    },
    stop() {
      stopped = true;
      if (frame !== 0) win.cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
