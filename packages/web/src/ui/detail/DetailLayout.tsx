/**
 * 详情页放在哪（56 号票，照搬 AgentSense App.tsx 的宽窄两种布局和返回栈；取代原来的 WithToolDetail 和竖屏的底部弹层）：
 * - 宽屏：会话 | 详情，有详情时才出现右栏和分隔线；右栏能拖宽，但显示宽度封顶在窗宽的 32%（state/detail-pane.ts）；
 *   会话的内容列始终铺满中间一栏，开合详情不改变它；
 * - 窄屏：详情整页从右边滑入，盖住底部导航（页面挂到 App 外框里的 .dp-host 上，不在会话页里面），底下的会话和导航往左让 30%；
 *   标题栏的 ‹ 一层层退，退到底滑回会话；
 * - 返回栈、"在对话中定位"、宽窄切换、鸿蒙的系统返回都走状态层的纯函数（state/detail-pane.ts）；系统返回经 62 号票的
 *   useBackLayer 接进页面的返回栈。
 * 用法：页面里 const conversationRef = useRef<ConversationHandle>(null); const detail = useDetail(wide, 会话, conversationRef)，
 * 会话组件接 onDetail={detail.open} ref={conversationRef}，外面包 <DetailLayout wide detail={detail} conversation={会话}>。
 */
import { createContext, type ReactNode, type RefObject, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../../app/page-back.ts";
import {
  closeDetail,
  type ConversationId,
  type DetailTarget,
  DETAIL_WIDTH_INITIAL,
  detailColumnWidth,
  type DetailNav,
  detailShown,
  dragDetailWidth,
  drillDetail,
  layoutChanged,
  NO_DETAIL,
  openDetail,
  revealFromDetail,
  systemBack,
} from "../../state/index.ts";
import { Splitter } from "../common.tsx";
import type { ConversationHandle } from "../conversation/Conversation.tsx";
import { DetailPane } from "./DetailPane.tsx";
import type { StageDetailSource } from "./StageDetail.tsx";

/** 整个应用外框的宽度（右栏封顶在它的 32%；AgentSense 用的是窗宽，二狗的原型能切"手机宽度"，所以量外框） */
export const FrameWidth = createContext<number>(typeof window === "undefined" ? 1024 : window.innerWidth);

/** 窄屏详情页挂在哪：App 外框里盖住底部导航的那一层（没有时就地画） */
export const DetailHost = createContext<HTMLElement | null>(null);

export interface DetailController {
  readonly nav: DetailNav;
  /** 详情看得见吗（宽屏右栏在、窄屏滑到了详情页） */
  readonly shown: boolean;
  /** 从会话里打开一条（条目、组里某一步、挂着的内部调用的 id） */
  open(id: string): void;
  /** 从会话外面打开一页详情（60 号票：计划台账里的一份计划、阶段抽屉里的一个阶段），清空返回栈 */
  show(target: DetailTarget): void;
  /** 详情里钻进另一条 */
  drill(id: string): void;
  /** 详情里钻进另一页（84 号票：阶段详情里点一条规则） */
  go(target: DetailTarget): void;
  /** 标题栏的 ‹ */
  close(): void;
  /** 在对话中定位（现在这一条）；给了 id 就定位到那一条（阶段详情的"回到会话里这一段"） */
  reveal(id?: string): void;
}

/**
 * 一个会话页的详情：返回栈和开合（AgentSense App.tsx 的 detail / detailBack / page）。
 * conversationRef 是页面给会话组件的 ref（"在对话中定位"经它调 reveal）
 */
export function useDetail(wide: boolean, conversation: ConversationId | undefined, conversationRef: RefObject<ConversationHandle | null>): DetailController {
  const [nav, setNav] = useState<DetailNav>(NO_DETAIL);
  // 定位、系统返回要的是点下去那一刻的状态
  const navRef = useRef(nav);
  useEffect(() => {
    navRef.current = nav;
  });
  // 换了会话：详情和返回栈都清掉（AgentSense 打开另一个会话时同样清空）
  const [shownFor, setShownFor] = useState(conversation);
  if (shownFor !== conversation) {
    setShownFor(conversation);
    setNav(NO_DETAIL);
  }
  // 宽窄切换：宽屏变窄屏时回到会话页
  const [wasWide, setWasWide] = useState(wide);
  if (wasWide !== wide) {
    setWasWide(wide);
    setNav((n) => layoutChanged(n, wasWide, wide));
  }
  const open = useCallback((id: string) => setNav((n) => openDetail(n, { type: "item", id }, wide)), [wide]);
  const show = useCallback((target: DetailTarget) => setNav((n) => openDetail(n, target, wide)), [wide]);
  const drill = useCallback((id: string) => setNav((n) => drillDetail(n, { type: "item", id })), []);
  const go = useCallback((target: DetailTarget) => setNav((n) => drillDetail(n, target)), []);
  const close = useCallback(() => setNav((n) => closeDetail(n, wide)), [wide]);
  const reveal = useCallback(
    (at?: string) => {
      const { nav: next, reveal: id } = revealFromDetail(navRef.current, wide, at);
      setNav(next);
      if (id !== undefined) conversationRef.current?.reveal(id);
    },
    [wide, conversationRef],
  );
  // 系统返回（鸿蒙的返回键，62 号票的返回栈）：详情先一层层退，窄屏再滑回会话。有东西可退时挂一层——窄屏的详情页开着，
  // 或者详情里点进去过（宽屏也算）；宽屏只开着一层时不挂，交给外面（照 AgentSense：返回先退详情的栈，窄屏再回会话，宽屏栈空了不关右栏）
  const back = useCallback(() => {
    const next = systemBack(navRef.current, wide);
    if (!next) return false;
    setNav(next);
    return true;
  }, [wide]);
  useBackLayer("overlay", systemBack(nav, wide) !== undefined, back);
  return { nav, shown: detailShown(nav, wide), open, show, drill, go, close, reveal };
}

/**
 * 主栏 + 详情：宽屏在右栏，窄屏整页滑入。
 * stages：长程任务的阶段（60 号票：阶段详情要的交付件、验收、授权、预算这些计划里写的，和能不能从这里重做），任务详情页给
 */
export function DetailLayout({
  wide,
  detail,
  conversation,
  stages,
  children,
}: {
  wide: boolean;
  detail: DetailController;
  conversation: ConversationId | undefined;
  stages?: StageDetailSource | undefined;
  children: ReactNode;
}) {
  const frameWidth = useContext(FrameWidth);
  const host = useContext(DetailHost);
  const [width, setWidth] = useState(DETAIL_WIDTH_INITIAL);
  const pane = conversation ? (
    <DetailPane detail={detail.nav.detail} conversation={conversation} onClose={detail.close} onReveal={detail.reveal} onOpen={detail.drill} onGo={detail.go} stages={stages} />
  ) : null;
  if (wide) {
    return (
      <div className="panes">
        {/* 会话的内容列始终铺满中间这一栏：开合详情不改变它 */}
        <div className="pane pane-main">{children}</div>
        {detail.nav.detail && pane && (
          <>
            <Splitter onDrag={(dx) => setWidth((w) => dragDetailWidth(w, dx, frameWidth))} />
            <div className="pane pane-detail" style={{ width: detailColumnWidth(width, frameWidth) }}>
              {pane}
            </div>
          </>
        )}
      </div>
    );
  }
  const at = detail.nav.page === "detail";
  const page = (
    <div className={`dp-page${at ? " at-detail" : ""}`} aria-hidden={!at}>
      {pane}
    </div>
  );
  return (
    <>
      {children}
      {host ? createPortal(page, host) : page}
    </>
  );
}
