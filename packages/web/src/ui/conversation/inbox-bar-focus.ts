// 从待办详情点"去任务 ›""去项目 ›""去对话里 ›"跳到会话时，记下是哪一项（107 号票）：会话里的"等你处理"栏挂上时，这一项在这一栏里
// 就默认展开、滚到眼前、闪一下。只在这个页面的内存里记一会儿（不进地址：刷新之后不再展开；没跳到它所在的栏的，过一会儿作废，
// 免得之后从别处进这个会话时又闪），栏里认到了就清掉。
let pending: { itemId: string; at: number } | undefined;

/** 记下的多久之内算数（毫秒）：跳过去、会话挂上用不了这么久 */
const FOCUS_TTL_MS = 10_000;

/** 待办详情点了跳转：记下这一项 */
export function markInboxBarFocus(itemId: string): void {
  pending = { itemId, at: Date.now() };
}

/** 栏挂上时：记下的那一项在这一栏里（ids）就是它。只看不清（React 严格模式下初始化会调两次），展开、闪过之后再清 */
export function peekInboxBarFocus(ids: readonly string[]): string | undefined {
  if (pending === undefined || Date.now() - pending.at > FOCUS_TTL_MS) return undefined;
  return ids.includes(pending.itemId) ? pending.itemId : undefined;
}

/** 栏里展开、闪过了：清掉 */
export function clearInboxBarFocus(itemId: string): void {
  if (pending?.itemId === itemId) pending = undefined;
}
