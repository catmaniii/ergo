// 会话滚到底（108 号票，纯函数）：滚到最后一条就停；右下角"回到最新"的 ↓。界面那一半在 ui/zoom/ZoomHistory.tsx。
//
// 滚动范围：会话历史是 viewport > sizer > content（54 号票照搬 AgentSense），sizer 撑出"内容高 × 比例"。原来挂在内容里、
// 伸到内容外面的东西也算进 viewport 的滚动范围——对话层里看不见的右侧标注叠在它那一条旁边往下排（一组调用的标注能叠好几百像素）、
// 缩小后被挤到下面的标注和它们的箭头——滚到底还能往下滚出一大片空白。108 号票起 sizer 把伸出去的裁掉（zoom.css 的 overflow-y: clip），
// 滚动范围就是 sizer 的高度；缩小后被挤到最后一条下面、看得见的标注和左侧的卡不裁，那一截照 AgentSense"只在缩小时出现的尾部区域"
// （ZoomController.setContentHeight 的 extra）算进滚动范围（zoomedOutTail）。
//
// ↓（用户 2026-10-13 定：只要这一个，不要"到最上面"）：离开底部才出，停在底部、内容不满一屏都不出；点了滚到最新一条、接着跟最新的走；
// 离开底部期间新到了消息写条数，只多了思考、工具调用标一个圆点。
import type { ContentKind } from "./chat-items.ts";

/** 离底部不到这么多像素算停在最新一条（和 ZoomHistory 跟随最新一条用的是同一个数） */
export const AT_LATEST_PX = 24;

/** 可视区的滚动位置（滚动容器本身就合这个形状） */
export interface ScrollSpot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 停在最新一条（底部）；内容不满一屏时滚不动，也算停在底部 */
export function atLatest(spot: ScrollSpot): boolean {
  return spot.scrollHeight - spot.scrollTop - spot.clientHeight < AT_LATEST_PX;
}

/** ↓ 出不出：离开了底部才出（内容不满一屏、停在底部都不出） */
export function jumpToLatestShown(spot: ScrollSpot): boolean {
  return !atLatest(spot);
}

/**
 * 每次滚动之后（程序滚的也算）：点了 ↓ 正滑向底部（jumping）的还算不算在滑，跟不跟最新的走。prevTop 是上一次滚动停在哪。
 * - 到了底部：不算在滑了，接着跟最新的走；
 * - 往上滚了（scrollTop 变小：拖滚动条、键盘翻页、"查看"定位、缩小后点一块放大……）：不算在滑了，跟不跟看在不在底部。
 *   评审 2026-10-13：原来只在"不是程序滚的"那一支里、到了底部才清，滑的途中内容变高、程序一下滚到底就清不掉，
 *   之后这些不经滚轮、触摸的往上滚每次都被当成还在滑，新内容一来又被拉回底部；
 * - 还在往下滑：一路都算跟着最新的走（中途来了新的接着跟到底）。
 * 没在滑的，跟不跟最新的就看停没停在底部（和原来一样）
 */
export function afterScroll(jumping: boolean, prevTop: number, spot: ScrollSpot): { jumping: boolean; follow: boolean } {
  const latest = atLatest(spot);
  const still = jumping && !latest && spot.scrollTop >= prevTop;
  return { jumping: still, follow: still || latest };
}

/**
 * 离开底部之后新到的条目：seen 是最后一次停在底部时最后一条的 id，取它后面的（往上翻插在前面的更早的不算）。
 * 那时还一条都没有（seen 是 undefined）就都算新的；它找不到了（被删了）不算——宁可不标，也不标错
 */
export function newSince<T extends { id: string }>(items: readonly T[], seen: string | undefined): readonly T[] {
  if (seen === undefined) return items;
  const i = items.findIndex((it) => it.id === seen);
  return i < 0 ? [] : items.slice(i + 1);
}

/** ↓ 上的标记：条数（count），或者一个圆点（dot） */
export type JumpBadge = { count: string } | "dot";

/**
 * ↓ 上标什么：新到了消息（你说的、回复、卡片、说明和记录）写条数，太多写"99+"；只多了思考、工具调用（agent 还在干活，
 * 没说话）标一个圆点；什么都没有不标
 */
export function jumpBadge(items: readonly { id: string; content: ContentKind }[], seen: string | undefined): JumpBadge | undefined {
  const fresh = newSince(items, seen);
  const n = fresh.filter((it) => it.content !== "thinking" && it.content !== "tool").length;
  if (n > 0) return { count: n > 99 ? "99+" : String(n) };
  return fresh.length > 0 ? "dot" : undefined;
}

/** 缩小后伸到最后一条下面的标注、卡离可视区底边留多少（屏幕像素） */
export const ZOOM_TAIL_GAP_PX = 8;

/**
 * 缩小后条外的东西伸到内容下面多少（内容坐标，未缩放）：bottom 是右侧标注、左侧的卡最低的下沿（内容坐标），
 * 再留 ZOOM_TAIL_GAP_PX 屏幕像素；没伸出去、或者没有（对话层看不见标注，是 -Infinity）是 0
 */
export function zoomedOutTail(bottom: number, contentHeight: number, s: number): number {
  if (!Number.isFinite(bottom)) return 0;
  return Math.max(0, Math.ceil(bottom + ZOOM_TAIL_GAP_PX / s - contentHeight));
}
