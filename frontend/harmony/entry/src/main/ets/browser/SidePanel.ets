/**
 * 浏览侧边栏（147 号票）在 App 这一侧。2026-10-18 用户纠正：浏览器是主体不缩，侧边栏盖在上面——原生的内置浏览器（另一个 Web 组件）
 * 盖在二狗的网页上面，二狗的网页画的东西到不了它上面，所以侧边栏由 App 另开一个 Web 组件承载：加载二狗的网页的侧边栏模式
 * （地址加 ?ergo=side，网页一侧 packages/web/src/app/side-remote.ts），摆在原生网页上面——
 * - 摆在哪由二狗的网页（"浏览"页）经原生桥 browserSide(json) 报来（CSS 像素和 devicePixelRatio，Index.ets 换成 vp）：宽屏盖住网页
 *   右边 400 宽的一块（侧边栏外面露出来的网页照常收触摸，它们是两个不相叠的组件），窄屏整屏盖住；第一次展开时才建，之后留着
 *   （收起只是藏起来，会话、输入框里打了一半的都在），从右边滑进滑出；
 * - 报来的 view（JSON 字符串）原样转给侧边栏的网页（window.__ergoSide），侧边栏的网页起来时调 ready() 再要一次；
 * - 侧边栏的网页能调的只有 window.ergoSide 的三个方法：close（收起）、clearSelection（"现在在看"的 ×）、ready，Index.ets 把前两个
 *   转给二狗的网页（window.__ergoBrowser 的 {type: "side"}），由"浏览"页那一份状态办；和二狗的原生桥一样只认配好的来源；
 * - 侧边栏的网页也是二狗自己的（受信任的同源页面）：另挂一个二狗原生桥（主会话定：侧边栏挂二狗原生桥走原生录音），同一个
 *   NativeBridge 类、自己一份原生录音器，只开 NATIVE_SIDE_BRIDGE_METHODS（版本号、日志、录音那一组），"按住说话"照 63 号票走原生录音器；
 *   不重复要"浏览"页签、不接管外链，侧边栏里点的外部网页链接改到内置浏览器里打开（Index.ets 的 sideIntercept）。外部网页那个原生浏览器照旧不挂原生桥；
 * - 键盘：照主界面的 Web（ArkWeb 默认的 RESIZE_CONTENT，键盘弹起时网页的视口跟着变矮，输入框不被挡），侧边栏的 Web 写明同一个设法。
 */
import { oldNameOf } from '../common/OldNames';

/** 侧边栏的网页里看到的名字：window.ergoSide */
export const SIDE_HOST_NAME = 'ergoSide';
/** 侧边栏的网页能调的方法 */
export const SIDE_HOST_METHODS: string[] = ['close', 'clearSelection', 'ready'];

/** 报来的侧边栏：CSS 像素（相对二狗的网页的视口）、要不要显示 */
export interface SideRectMessage {
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** browserSide(json)：侧边栏摆在哪、网页的 devicePixelRatio、交给侧边栏网页的样子（JSON 字符串） */
export interface SideLayoutMessage {
  dpr: number;
  side: SideRectMessage;
  view: string;
}

/** 换成 vp 之后：Index.ets 照它摆侧边栏的 Web */
export class SideFrame {
  visible: boolean = false;
  x: number = 0;
  y: number = 0;
  width: number = 0;
  height: number = 0;
}

/** 推给二狗的网页的：侧边栏上点了什么（close、clearSelection、link） */
export class SideForward {
  type: string = 'side';
  action: string;

  constructor(action: string) {
    this.action = action;
  }
}

function isFiniteNumber(v: number | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 报来的侧边栏（JSON）；不对是 undefined */
export function parseSideLayout(json: string): SideLayoutMessage | undefined {
  let value: SideLayoutMessage;
  try {
    value = JSON.parse(json) as SideLayoutMessage;
  } catch (e) {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || !isFiniteNumber(value.dpr) || value.dpr <= 0 || typeof value.view !== 'string') {
    return undefined;
  }
  const side = value.side;
  if (side === null || typeof side !== 'object' || typeof side.visible !== 'boolean' || !isFiniteNumber(side.x) ||
    !isFiniteNumber(side.y) || !isFiniteNumber(side.width) || !isFiniteNumber(side.height)) {
    return undefined;
  }
  return value;
}

/** 侧边栏的网页的地址：二狗的地址（去掉 # 后面的）加 ergo=side（312 号票：旧的参数名也带上，网页还是旧版时照样认得出） */
export function sideUrlOf(href: string): string {
  const hash = href.indexOf('#');
  const base = hash < 0 ? href : href.substring(0, hash);
  return `${base}${base.indexOf('?') < 0 ? '?' : '&'}ergo=side&${oldNameOf('ergo')}=side`;
}

/** 侧边栏的网页能调的对象（javaScriptProxy：window.ergoSide）：收起、取消选中、网页起来了 */
export class SideHost {
  private onAction: (action: string) => void;

  constructor(onAction: (action: string) => void) {
    this.onAction = onAction;
  }

  close(): void {
    this.onAction('close');
  }

  clearSelection(): void {
    this.onAction('clearSelection');
  }

  ready(): void {
    this.onAction('ready');
  }
}
