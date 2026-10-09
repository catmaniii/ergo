// 来源：AgentSense web/src/ui/zoom.ts（D:\code\claudecode\user_agent_sense_of_security，提交 99656b5，2026-10-09），54 号票原样搬。
// 和原文的差别只有两处，都不改行为：缩进从 tab 换成两个空格（二狗的写法）；二狗开着 noUncheckedIndexedAccess，
// levelOf 里按下标取预设比例的两处加了非空断言（!）。下面的注释是原文。
// 原文开头说"四档"：第四档计划层在 AgentSense 2026-10-04 去掉了（MIN_SCALE 停在全局层，捏不到 0.06），二狗也只有三档（规格第 19 节）。

/**
 * 一镜到底：整条聊天记录作为一个整体等比缩放（像看地图），每段历史的矩形形状始终不变，
 * 只有矩形里显示的内容随比例换层级。松手吸附到四档预设比例；最后一档（计划层）历史淡出，换成计划的图。
 *
 * 结构：viewport（滚动容器）> sizer（高度 = 内容高 × s，撑出滚动范围）> content（宽 = 视口宽，scale(s) 且水平居中）
 * 每帧只写 CSS 变量与 sizer 高度，不触发 React 渲染。
 */

/** 四档预设：对话层 / 要点层 / 全局层 / 计划层 */
export const PRESETS = [1, 0.45, 0.15, 0.06] as const;
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
  private lastLevel: ZoomLevel = 0;

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
    // 内容本身居中，缩放以左上角为原点，所以按自身宽度回推居中量
    this.content.style.transform = `translateX(${((w * (1 - s)) / 2).toFixed(2)}px) scale(${s.toFixed(4)})`;
    this.layout();
    const level = levelOf(s);
    // 当前这一档的预设比例：标注的宽度按它算，只在换档时变，缩放过程中文字不来回折行。
    // 从对话层往外捏、标注正在淡入的那几帧，条还很宽、右侧留白比要点层窄，只能按实时比例算（这时标注半透明，折行变化看不出来）
    vars.setProperty("--sl", level === 0 ? s.toFixed(4) : String(PRESETS[Math.min(level, 2)]));
    this.varsTarget.dataset.level = String(level);
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      for (const l of this.listeners) l(level);
    }
  }

  /** 把比例设为 s，同时让视口 y 处的内容点保持不动 */
  private scaleAround(s: number, focalY: number, contentY: number) {
    this.apply(s);
    this.viewport.scrollTop = contentY * s - focalY;
    this.onScale?.();
  }

  /** 视口 y 处对应的内容坐标 */
  contentYAt(focalY: number) {
    return (this.viewport.scrollTop + focalY) / this.s;
  }

  /** 跟手缩放 */
  set(s: number, focalY: number, contentY: number) {
    cancelAnimationFrame(this.raf);
    this.scaleAround(Math.min(1, Math.max(MIN_SCALE, s)), focalY, contentY);
  }

  /**
   * 动画缩放到目标比例。焦点（内容坐标 contentY）从视口 fromY 滑到 toY，
   * 例如点击某个色块时让它边放大边滑到屏幕上部。
   */
  animateTo(target: number, contentY: number, fromY: number, toY = fromY, duration = 420) {
    cancelAnimationFrame(this.raf);
    const from = this.s;
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      // 在对数空间插值，缩放速度感受均匀
      const s = Math.exp(Math.log(from) + (Math.log(target) - Math.log(from)) * e);
      this.scaleAround(s, fromY + (toY - fromY) * e, contentY);
      if (p < 1) this.raf = requestAnimationFrame(step);
      else this.onSettle?.();
    };
    this.raf = requestAnimationFrame(step);
  }

  /** 松手：吸附到最近的预设比例 */
  snap(focalY: number, contentY: number) {
    this.animateTo(PRESETS[levelOf(this.s)], contentY, focalY, focalY, 260);
  }

  /** 视口宽度变化（旋转屏幕等）后重新定位 */
  relayout() {
    this.apply(this.s);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }
}
