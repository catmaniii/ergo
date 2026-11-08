// 会话缩放的控制器。开着 noUncheckedIndexedAccess，levelOf 里按下标取预设比例的两处加了非空断言（!）。
// 加了一处：换档会改布局时的焦点换算（onLevelLayout）。工具调用组在对话层是一行，缩小后逐次画，跨过对话层那一档时
// 内容高度会变；不换算的话，焦点下面的内容会跳走。不设它时不换算；
// 为此 scaleAround、set 返回换算后的内容坐标，animateTo 接着用换算后的。
// 下面说"四档"：第四档计划层用不上（MIN_SCALE 停在全局层，捏不到 0.06），实际只有三档。

/**
 * 一镜到底：整条聊天记录作为一个整体等比缩放（像看地图），每段历史的矩形形状始终不变，
 * 只有矩形里显示的内容随比例换层级。松手吸附到四档预设比例；最后一档（计划层）历史淡出，换成计划的图。
 *
 * 结构：viewport（滚动容器）> sizer（高度 = 内容高 × s，撑出滚动范围）> content（宽 = 视口宽，scale(s) 且水平居中）
 * 每帧只写 CSS 变量与 sizer 高度，不触发 React 渲染。
 */

/** 四档预设：对话层 / 要点层 / 全局层 / 计划层 */
export const PRESETS = [1, 0.45, 0.15, 0.06] as const;

/**
 * 窄屏（视口窄于它，和 App 的 WIDE_MIN 一样：手机、侧边栏模式）：缩小后条不再居中，整体往左挪到只给左边的东西
 * （日期竖排、回退点、左侧卡、书脊）留够地方（setLeftRoom），要点层的条也收窄一点（NARROW_GIST_SCALE），
 * 右侧标注那一列宽出来。对话层不挪；比例越小挪得越多，捏合过程中连续地挪
 */
export const NARROW_MAX = 600;
/** 窄屏要点层停的比例：比 0.45 窄一点 */
export const NARROW_GIST_SCALE = 0.4;
/** 计划的图改成从标题栏往下拉，捏合只到全局层 */
export const MIN_SCALE = PRESETS[2];

export type ZoomLevel = 0 | 1 | 2 | 3;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** 各显示层级在比例 s 下的不透明度 */
export function layerOpacity(s: number) {
  const o0 = clamp01((s - 0.6) / 0.25);
  const o1 = s >= 0.45 ? clamp01((0.75 - s) / 0.2) : clamp01((s - 0.22) / 0.13);
  const o2 = clamp01((0.3 - s) / 0.1);
  // 计划层：历史淡出，换成计划的图
  const o3 = clamp01((0.11 - s) / 0.04);
  return { o0, o1, o2, o3 };
}

export function levelOf(s: number): ZoomLevel {
  let best = 0;
  for (let i = 1; i < PRESETS.length; i++) {
    if (Math.abs(Math.log(s / PRESETS[i]!)) < Math.abs(Math.log(s / PRESETS[best]!))) best = i;
  }
  return best as ZoomLevel;
}

export class ZoomController {
  s = 1;
  private raf = 0;
  private contentHeight = 0;
  private extraHeight = 0;
  private listeners = new Set<(level: ZoomLevel) => void>();
  /** 缩放动画结束（停在某一档）时回调 */
  onSettle?: () => void;
  /** 每次比例变化后回调（跟手缩放和动画的每一帧）：两侧标注靠它实时跟着色块走 */
  onScale?: () => void;
  /**
   * 二狗加的：换档会改布局（工具调用组在对话层是一行，缩小后逐次画）。换档之前用焦点那一点在旧布局里的内容坐标调用，
   * 返回的函数在换档之后调用，给出同一点在新布局里的内容坐标。不设就不换算
   */
  onLevelLayout?: (contentY: number) => () => number;
  private lastLevel: ZoomLevel = 0;
  /** 窄屏缩小后条的左缘离视口左缘至少留多少（屏幕像素；0 是不挪），由 ZoomHistory 按会话里有什么给 */
  private leftRoom = 0;
  /** 内容的左内边距（条的左缘在内容里的位置），挪的时候按条的左缘算 */
  private padLeft = 0;

  private readonly viewport: HTMLElement;
  private readonly sizer: HTMLElement;
  private readonly content: HTMLElement;
  /** CSS 变量写在这里（列根元素），让输入框等列表外元素也能跟着淡出 */
  private readonly varsTarget: HTMLElement;

  constructor(viewport: HTMLElement, sizer: HTMLElement, content: HTMLElement, varsTarget: HTMLElement) {
    this.viewport = viewport;
    this.sizer = sizer;
    this.content = content;
    this.varsTarget = varsTarget;
    this.apply(1);
  }

  get level() {
    return levelOf(this.s);
  }

  onLevelChange(l: (level: ZoomLevel) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** 内容（未缩放）高度变化时调用；extra 为只在缩小时出现的尾部区域（接下来的计划） */
  setContentHeight(h: number, extra: number) {
    this.contentHeight = h;
    this.extraHeight = extra;
    this.layout();
  }

  private layout() {
    const extra = this.s < 0.9 ? this.extraHeight : 0;
    this.sizer.style.height = `${(this.contentHeight + extra) * this.s}px`;
  }

  /** 窄屏（手机、侧边栏模式）：缩小后条往左挪、要点层收窄。jsdom 里视口宽是 0，不算 */
  narrow(): boolean {
    const vw = this.viewport.clientWidth;
    return vw > 0 && vw < NARROW_MAX;
  }

  /** 这一档停在哪个比例：窄屏的要点层窄一点，别的照预设 */
  presetOf(level: ZoomLevel): number {
    return level === 1 && this.narrow() ? NARROW_GIST_SCALE : PRESETS[level];
  }

  /**
   * 比例 s 时内容往左挪多少（屏幕像素）：窄屏时居中会让条左边留得比 leftRoom 多，多出来的那一截挪掉；
   * 宽屏、没给 leftRoom、对话层附近（居中时左边本来就不到 leftRoom）不挪
   */
  shiftAt(s: number): number {
    if (this.leftRoom <= 0 || !this.narrow()) return 0;
    const w = this.content.clientWidth || this.viewport.clientWidth;
    return Math.max(0, (w * (1 - s)) / 2 + this.padLeft * s - this.leftRoom);
  }

  /** 窄屏缩小后条的左缘离视口左缘至少留多少（屏幕像素）：变了就按现在的比例重新摆 */
  setLeftRoom(px: number) {
    if (px === this.leftRoom) return;
    this.leftRoom = px;
    this.measurePad();
    this.apply(this.s);
  }

  private apply(s: number) {
    this.s = s;
    const { o0, o1, o2, o3 } = layerOpacity(s);
    const vars = this.varsTarget.style;
    vars.setProperty("--s", s.toFixed(4));
    vars.setProperty("--o0", o0.toFixed(3));
    vars.setProperty("--o1", o1.toFixed(3));
    vars.setProperty("--o2", o2.toFixed(3));
    vars.setProperty("--o3", o3.toFixed(3));
    // 内容列可以比视口窄（宽屏下详情栏空着时视口会变宽，但条的宽度不变）
    const vw = this.viewport.clientWidth;
    const w = this.content.clientWidth || vw;
    vars.setProperty("--colw", `${w}px`);
    vars.setProperty("--vpw", `${vw}px`);
    // 内容本身居中，缩放以左上角为原点，所以按自身宽度回推居中量；窄屏缩小后再往左挪（shiftAt）
    const zx = this.shiftAt(s);
    vars.setProperty("--zx", `${zx.toFixed(2)}px`);
    this.content.style.transform = `translateX(${((w * (1 - s)) / 2 - zx).toFixed(2)}px) scale(${s.toFixed(4)})`;
    this.layout();
    const level = levelOf(s);
    // 当前这一档的预设比例：标注的宽度按它算，只在换档时变，缩放过程中文字不来回折行。
    // 从对话层往外捏、标注正在淡入的那几帧，条还很宽、右侧留白比要点层窄，只能按实时比例算（这时标注半透明，折行变化看不出来）。
    // 这一档挪了多少（--zxl）同样按这个比例算：两侧标注的宽度跟着它
    const sl = level === 0 ? s : this.presetOf(Math.min(level, 2) as ZoomLevel);
    vars.setProperty("--sl", level === 0 ? s.toFixed(4) : String(sl));
    vars.setProperty("--zxl", `${this.shiftAt(sl).toFixed(2)}px`);
    this.varsTarget.dataset.level = String(level);
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      for (const l of this.listeners) l(level);
    }
  }

  /** 把比例设为 s，同时让视口 y 处的内容点保持不动；返回那一点的内容坐标（换档改了布局时是换算后的，二狗） */
  private scaleAround(s: number, focalY: number, contentY: number): number {
    const remap = levelOf(s) !== this.lastLevel ? this.onLevelLayout?.(contentY) : undefined;
    this.apply(s);
    const y = remap ? remap() : contentY;
    this.viewport.scrollTop = y * s - focalY;
    this.onScale?.();
    return y;
  }

  /** 视口 y 处对应的内容坐标 */
  contentYAt(focalY: number) {
    return (this.viewport.scrollTop + focalY) / this.s;
  }

  /** 跟手缩放；返回焦点那一点的内容坐标（换档改了布局时是换算后的，下一帧接着用它，二狗） */
  set(s: number, focalY: number, contentY: number): number {
    cancelAnimationFrame(this.raf);
    return this.scaleAround(Math.min(1, Math.max(MIN_SCALE, s)), focalY, contentY);
  }

  /**
   * 动画缩放到目标比例。焦点（内容坐标 contentY）从视口 fromY 滑到 toY，
   * 例如点击某个色块时让它边放大边滑到屏幕上部。
   */
  animateTo(target: number, contentY: number, fromY: number, toY = fromY, duration = 420) {
    cancelAnimationFrame(this.raf);
    const from = this.s;
    const start = performance.now();
    // 二狗：换档改了布局时焦点那一点的内容坐标会换算，后面的帧接着用换算后的
    let y = contentY;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      // 在对数空间插值，缩放速度感受均匀
      const s = Math.exp(Math.log(from) + (Math.log(target) - Math.log(from)) * e);
      y = this.scaleAround(s, fromY + (toY - fromY) * e, y);
      if (p < 1) this.raf = requestAnimationFrame(step);
      else this.onSettle?.();
    };
    this.raf = requestAnimationFrame(step);
  }

  /** 松手：吸附到最近的预设比例（窄屏的要点层是 NARROW_GIST_SCALE） */
  snap(focalY: number, contentY: number) {
    this.animateTo(this.presetOf(levelOf(this.s)), contentY, focalY, focalY, 260);
  }

  /** 视口宽度变化（旋转屏幕等）后重新定位（比例不变：窄宽屏换了，要点层下次吸附时才换到新宽度下的预设） */
  relayout() {
    this.measurePad();
    this.apply(this.s);
  }

  private measurePad() {
    this.padLeft = parseFloat(getComputedStyle(this.content).paddingLeft) || 0;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }
}
