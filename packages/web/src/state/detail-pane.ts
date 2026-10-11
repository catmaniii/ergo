// 详情页的开合和返回栈（56 号票，规格第 19 节"会话区照搬 AgentSense"的详情页）：照搬 AgentSense App.tsx 的
// detail / detailBack / page（App.tsx:313-435、736-760），写成纯函数，界面（ui/detail/）只管画。
// - 宽屏：有详情时右栏才出现；
// - 窄屏：会话、详情两页常驻，详情从右边整页滑入（AgentSense 是会话列表、会话、详情三页，二狗的列表在各页自己管）；
// - 从会话里打开一条清空返回栈，详情里一层层点进去时把来处压栈，返回一层层退，退到底再关（宽屏）或回到会话（窄屏）。
// 详情按条目 id 存（AgentSense 存的是条目对象的快照，流式更新时不刷新；调研 15 §2.5 建议改成存 id），
// 显示时用 locateChatItem 现查（detailContent）。

/** 打开的是哪一条：条目的 id，或者组里某一步、挂在某一条上的内部工具调用的 id */
export interface DetailRef {
  readonly type: "item";
  readonly id: string;
}

/**
 * 详情页显示什么（60 号票照 AgentSense 的 Detail 加了三种）：会话里的一条（item）；一份流程计划（plan：按卡片 id，计划台账里点开的，
 * 会话没翻到那张卡时也看得了）；长程任务的一个阶段（stage：AgentSense 的 milestone，从阶段抽屉、阶段栏点开）；
 * 执行中出过的状况（incidents：AgentSense 的同名一页，从阶段抽屉、阶段栏下面那一行的个数点开，kind 是先筛的那一类）
 */
export type DetailTarget =
  | DetailRef
  | { readonly type: "plan"; readonly cardId: string }
  | { readonly type: "stage"; readonly taskId: string; readonly stageId: string }
  | { readonly type: "incidents"; readonly taskId: string; readonly kind?: string | undefined }
  // 长程任务一个阶段的一条时序规则（84 号票：阶段详情里点一条规则钻进来，照 AgentSense 点规则集看它的详情）
  | { readonly type: "rule"; readonly taskId: string; readonly stageId: string; readonly ruleId: string };

/** 一页详情的键（换一页正文从头看） */
export function detailKey(target: DetailTarget): string {
  switch (target.type) {
    case "item":
      return `item:${target.id}`;
    case "plan":
      return `plan:${target.cardId}`;
    case "stage":
      return `stage:${target.taskId}:${target.stageId}`;
    case "incidents":
      return `incidents:${target.taskId}:${target.kind ?? ""}`;
    case "rule":
      return `rule:${target.taskId}:${target.stageId}:${target.ruleId}`;
  }
}

export interface DetailNav {
  /** 现在显示的详情；没打开过（或宽屏关掉了）没有 */
  readonly detail: DetailTarget | undefined;
  /** 从一条详情钻进另一条时压下的来处，返回时一层层退 */
  readonly back: readonly DetailTarget[];
  /** 窄屏两页里现在在哪一页（宽屏不看它） */
  readonly page: "chat" | "detail";
}

export const NO_DETAIL: DetailNav = { detail: undefined, back: [], page: "chat" };

/** 从会话里点开一条（AgentSense 的 showDetail）：清空返回栈；窄屏滑到详情页 */
export function openDetail(nav: DetailNav, detail: DetailTarget, wide: boolean): DetailNav {
  return { detail, back: [], page: wide ? nav.page : "detail" };
}

/** 从一条详情钻进另一条（AgentSense 的 onOpen / onGo）：先把当前的压栈 */
export function drillDetail(nav: DetailNav, detail: DetailTarget): DetailNav {
  return { ...nav, detail, back: nav.detail ? [...nav.back, nav.detail] : nav.back };
}

/** 退一层；栈空了是 undefined（AgentSense 的 popDetail） */
function popDetail(nav: DetailNav): DetailNav | undefined {
  const last = nav.back.at(-1);
  return last ? { ...nav, detail: last, back: nav.back.slice(0, -1) } : undefined;
}

/**
 * 详情标题栏左边的 ‹（AgentSense App.tsx:736-740）：先一层层退；退到底宽屏关掉右栏，窄屏滑回会话
 * （窄屏的详情页留着，和 AgentSense 一样，下次从会话里打开另一条时再换）
 */
export function closeDetail(nav: DetailNav, wide: boolean): DetailNav {
  return popDetail(nav) ?? (wide ? NO_DETAIL : { ...nav, page: "chat" });
}

/**
 * "在对话中定位"（AgentSense App.tsx:740-743）：窄屏先滑回会话页，再定位；宽屏详情栏不动。
 * reveal 是要定位的那一条的 id（会话组件照它用 locateChatItem 找）；不给就是现在这页详情的那一条——
 * 只有会话里的一条有（AgentSense 也只在 item 详情上给"在对话中定位"）；阶段详情的"回到会话里这一段"给的是那一段第一条的 id
 */
export function revealFromDetail(nav: DetailNav, wide: boolean, id?: string): { nav: DetailNav; reveal: string | undefined } {
  return { nav: wide ? nav : { ...nav, page: "chat" }, reveal: id ?? (nav.detail?.type === "item" ? nav.detail.id : undefined) };
}

/**
 * 系统返回手势（鸿蒙，AgentSense App.tsx:416-435）：详情先一层层退，窄屏再滑回会话；
 * 都退完了（宽屏栈空、窄屏已在会话页）交给外面，是 undefined
 */
export function systemBack(nav: DetailNav, wide: boolean): DetailNav | undefined {
  const popped = popDetail(nav);
  if (popped) return popped;
  return !wide && nav.page === "detail" ? { ...nav, page: "chat" } : undefined;
}

/** 宽窄切换（AgentSense App.tsx:384-389）：宽屏变窄屏时回到会话页；窄屏变宽屏时有详情就出现在右栏 */
export function layoutChanged(nav: DetailNav, wasWide: boolean, wide: boolean): DetailNav {
  return wasWide && !wide && nav.page !== "chat" ? { ...nav, page: "chat" } : nav;
}

// ───────────────────────── 宽屏右栏的宽度（AgentSense App.tsx:318-320、781） ─────────────────────────

/** 右栏宽度的初值 */
export const DETAIL_WIDTH_INITIAL = 288;

/** 拖分隔线：dx 是这一下往右挪了多少（往左拖变宽），范围 260 到窗宽的 60% */
export function dragDetailWidth(width: number, dx: number, frameWidth: number): number {
  return Math.min(frameWidth * 0.6, Math.max(260, width - dx));
}

/** 右栏显示的宽度：拖出来的宽度，但封顶在窗宽的 32%（封顶不少于 240） */
export function detailColumnWidth(width: number, frameWidth: number): number {
  return Math.min(width, Math.max(240, frameWidth * 0.32));
}

/** 窗宽不到这么多时，左边栏、会话、详情三栏已经挤满 */
export const LIST_WITH_DETAIL_MIN = 1200;

/**
 * 列表要不要让开（AgentSense App.tsx:486-487）：窗宽不到 1200、会话左边的阶段栏开着、详情也开着时，
 * 最左边的列表（任务列表）先让开，关掉详情再回来
 */
export function listYields(at: { frameWidth: number; sideOpen: boolean; detailOpen: boolean }): boolean {
  return at.sideOpen && at.detailOpen && at.frameWidth < LIST_WITH_DETAIL_MIN;
}

/** 详情看得见吗：宽屏是右栏在不在，窄屏是滑没滑到详情页 */
export function detailShown(nav: DetailNav, wide: boolean): boolean {
  return wide ? nav.detail !== undefined : nav.page === "detail";
}
