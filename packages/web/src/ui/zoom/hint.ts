// "缩小看全貌"怎么操作：手机、触屏上是双指捏合，电脑浏览器上是按住 Ctrl 往下滚滚轮。
// 不另外认鸿蒙壳：二狗的鸿蒙 App（62 号票）里网页跑在触屏上，按 pointer: coarse 就认得出来。
import { t } from "../../state/index.ts";

export function zoomOutHint(): string {
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return touch ? t("ui.hint.pinch") : t("ui.hint.ctrlScroll");
}
