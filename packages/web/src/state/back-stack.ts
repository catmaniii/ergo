// 前端状态层：返回栈（62 号票，照搬 AgentSense 的返回键）。
// 鸿蒙 App 里按系统返回键，网页按层级退一级：先关最后打开的弹窗、选择器、详情页（overlay），
// 没有再回这一页的上一级（page：标题栏的"‹ 返回"，比如任务详情回看板），都没有就是到了顶层，交给系统退出 App。
// 网页经原生桥 setCanGoBack 报"现在还能不能在网页里返回"（canGoBack），原生按返回键时调网页登记的返回函数（backTarget 那一层的关法）。
// 这里只管"开着哪些层、先退哪一层"；各层的关法和接原生桥在 app/page-back.ts、app/native-app.ts。

/** overlay：弹窗、选择器、详情页、抽屉——开着就先关它；page：这一页有"返回上一级" */
export type BackKind = "overlay" | "page";

/** 开着的一层；id 由登记的一方给，唯一 */
export interface BackLayer {
  readonly id: number;
  readonly kind: BackKind;
}

/** 开着的各层，按挂上的先后 */
export type BackStack = readonly BackLayer[];

/** 挂上一层；已经挂着的挪到最上面 */
export function openBackLayer(stack: BackStack, layer: BackLayer): BackStack {
  return [...stack.filter((l) => l.id !== layer.id), layer];
}

/** 拿下一层（关了、页面离开了） */
export function closeBackLayer(stack: BackStack, id: number): BackStack {
  return stack.some((l) => l.id === id) ? stack.filter((l) => l.id !== id) : stack;
}

/** 按返回键该退的那一层：最后挂上的 overlay，没有就是最后挂上的 page；都没有返回 undefined（交给系统） */
export function backTarget(stack: BackStack): BackLayer | undefined {
  return stack.findLast((l) => l.kind === "overlay") ?? stack.findLast((l) => l.kind === "page");
}

/** 现在还能不能在网页里返回 */
export function canGoBack(stack: BackStack): boolean {
  return backTarget(stack) !== undefined;
}

/** 开着弹窗、选择器、详情页、抽屉这些吗（116 号票：开着就不在回到前台时直接刷新，照旧提示） */
export function overlayOpen(stack: BackStack): boolean {
  return stack.some((l) => l.kind === "overlay");
}
