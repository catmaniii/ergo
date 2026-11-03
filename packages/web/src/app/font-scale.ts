// 界面字号在浏览器里的那一半：读写这台设备记住的比例（localStorage，每种屏幕形态一个键），写到根元素上（style 里的
// --fs-k、属性 data-font-scale），窗口宽度跨过形态的分界（折叠屏折起、展开，电脑上拖窗口）时换成那种形态自己的那份。
// 算法在 state/font-scale.ts。打开页面时 index.html 的内联脚本在页面脚本加载前就按记住的写好，不先闪一下 1 的大小；
// 它和这里做的是同一件事，改一处要改另一处（test/app/font-scale.test.ts 比对两边的结果）。
import { clampFontScale, FONT_SCALE_DEFAULT, fontScaleCss, fontScaleKey, fontScaleMark, fontScaleOf, type ScreenForm, screenFormOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 根元素用到的那部分（浏览器里就是 document.documentElement；测试在 Node 里换成假的） */
export interface FontScaleRoot {
  readonly style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): string;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface FontScaleEnv {
  root: FontScaleRoot;
  /** 取不到（隐私模式、禁用了站点数据）时抛错 */
  storage(): DeviceStorage;
  /** 现在的窗口宽度（CSS 像素） */
  width(): number;
  /** 窗口大小变了时叫一声 */
  onResize(listener: () => void): void;
}

export interface FontScaleController {
  /** 现在的屏幕形态 */
  form(): ScreenForm;
  /** 现在这种形态用的比例 */
  scale(): number;
  /** 给现在这种形态选一个比例：马上生效，并记在这台设备上（落到范围里、按步长取整） */
  choose(scale: number): void;
  /** 形态或比例变了时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** 根元素上的变量名、属性名（index.html 的内联脚本、styles/base.css 用同样的） */
const SCALE_VAR = "--fs-k";
const SCALE_MARK = "data-font-scale";

function load(storage: () => DeviceStorage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

/** 记下来；1 就是没调过，擦掉 */
function save(storage: () => DeviceStorage, key: string, scale: number): void {
  try {
    if (scale === FONT_SCALE_DEFAULT) storage().removeItem(key);
    else storage().setItem(key, String(scale));
  } catch {
    // 存不了：这次打开里照样生效，下次打开回到 1
  }
}

/** 开场读出这种形态记住的比例写到根元素上（内联脚本已经写过一遍，这里再写一遍无妨），之后跟着窗口宽度换形态 */
export function fontScaleControllerIn(env: FontScaleEnv): FontScaleController {
  const listeners = new Set<() => void>();
  let form = screenFormOf(env.width());
  let scale = fontScaleOf(load(env.storage, fontScaleKey(form)));
  const apply = () => {
    const css = fontScaleCss(scale);
    if (css === undefined) env.root.style.removeProperty(SCALE_VAR);
    else env.root.style.setProperty(SCALE_VAR, css);
    const mark = fontScaleMark(scale);
    if (mark === undefined) env.root.removeAttribute(SCALE_MARK);
    else env.root.setAttribute(SCALE_MARK, mark);
    for (const listener of listeners) listener();
  };
  apply();
  env.onResize(() => {
    const next = screenFormOf(env.width());
    if (next === form) return;
    form = next;
    scale = fontScaleOf(load(env.storage, fontScaleKey(form)));
    apply();
  });
  return {
    form: () => form,
    scale: () => scale,
    choose(next) {
      scale = clampFontScale(next);
      save(env.storage, fontScaleKey(form), scale);
      apply();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
