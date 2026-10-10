/**
 * 会话历史：同一份内容在三档缩放层级间一镜到底（54 号票，规格第 19 节"会话区照搬 AgentSense"）。
 *
 * 来源：AgentSense web/src/ui/ZoomHistory.tsx（D:\code\claudecode\user_agent_sense_of_security，2026-10-09 的工作区）。
 * 照搬的是通用骨架，结构、做法、数值都没改：
 * - viewport（滚动）> sizer（撑出缩放后的高度）> content（整体 scale），缩放由 zoom.ts 的 ZoomController 逐帧写 CSS 变量，不触发 React 渲染；
 * - 每条一个 .zi：对话层（.zi-l0，完整内容）、要点层（.zi-l1，一行字的色块）、全局层（.zi-l2，纯色块）叠在同一个矩形里交叉淡入淡出；
 *   内容多的条（≥150px）要点层是对话层内容的缩影加一张浮在顶上的小标题卡（data-long）；
 * - 两个 ResizeObserver（内容变高、视口变化）、跟着最新的走（只在对话层、停在底部、手指没按着时）；
 * - 捏合挂在整块上（usePinch：双指，Ctrl/⌘ + 滚轮，触控板捏合），以双指中点下的内容为锚；松手吸附；
 * - 缩小状态下点一条：以点击处为焦点放大回对话层，这条滑到不低于视口 40% 的地方，闪一下；
 * - zoomTo（标题栏的 ▤ / 💬，以视口中心为焦点）、reveal（在对话中定位）、报告正在看哪一条（视口 40% 高处）；
 * - 右侧标注逐条定位、画箭头（layoutAnnotations 里风险标注那一段：按锚点高度对齐，上一条挤住就往下让，箭头指回去）；
 * - 缩小后输入框淡出，换成一条图例。
 * 条目换成二狗的（52 号票会话条目层的 ChatItem，对话层怎么画由外面传进来）。
 * 没搬的：分支和回退（SwapOverlay、AbandonedStub、回退点）是 AgentSense 特有的概念；同类操作折叠换成了二狗的工具调用组（52 号票）；
 * 阶段框折叠、固定计划的"接下来的计划"虚线框属于两种任务的界面；计划底色带、书脊、左侧任务卡和右侧标注的完整内容（×N）在 55 号票。
 * 写法上为了过二狗的 lint（React 的 refs、immutability 规则）改了几处，行为不变：外面传进来的回调渲染完再写进 ref
 * （原文在渲染时写）；"条目变了、换了档、缩放停稳之后重新排标注"原文是一个带 [level, items, settled] 的 effect，
 * 这里是每次渲染后排一次加上停稳时排一次；flash、layoutAnnotations 挪到组件外面。
 *
 * 57 号票：工具调用组只存在于对话层——对话层是一行"调用了 N 个工具 ›"（.zi-grouprow），缩小后照 AgentSense（它没有组，每次调用各是一条）
 * 组里每次调用、每段思考各画一块（.zi-step），性质、小圆点、右侧标注都按这一次算；哪样显示由 data-level 决定，照 AgentSense 同类折叠
 * 的做法（.zh[data-level="0"] .zi-folded 隐藏）。跨过对话层那一档时内容高度会变，焦点按组里的比例换算到新布局（zoom.ts 的
 * onLevelLayout），手指下面的内容不跳走。缩小着点一块：放大回去落在组那一行、闪那一行，打开这一次调用的详情。
 *
 * 二狗多出来的：往上翻加载更早的一页（AgentSense 整个会话一次进 DOM）。和缩放共存：任何一档滚到顶都取更早的一页，
 * 缩小状态下停稳时已经在顶上也取；取回来之后视口里那一条的下沿留在原处（锚点按条目 id 存，用 locateChatItem 找：
 * 一组调用跨两页时，翻回来之后组的 id 会变，下沿不变）。
 */
import { forwardRef, type MouseEvent, memo, type ReactNode, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import {
  type ChatItem,
  CONTENT_KIND_LABEL,
  type ContentKind,
  chatItemNature,
  locateChatItem,
  type OpStyle,
  type TimelineMark,
  TOOL_NATURE_LABEL,
  TOOL_NATURES,
  type ToolNature,
  toolNatureOf,
  type ZoomBlock,
  zoomBlocks,
} from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { MarkChip, markLevel } from "./marks.tsx";
import { usePinch } from "./usePinch.ts";
import { PRESETS, ZoomController, type ZoomLevel } from "./zoom.ts";

export type { ZoomLevel };

export interface ZoomHistoryHandle {
  /** 以视口中心为焦点缩放到某一档 */
  zoomTo(level: ZoomLevel): void;
  /** 在对话层定位到某条历史 */
  reveal(chatId: string): void;
  /** 接着跟最新的走（自己发了消息：二狗原来的规矩，发完回到底部） */
  followLatest(): void;
}

/** 往上翻：还有没有更早的、是不是正在取、去取 */
export interface OlderHistory {
  canLoad: boolean;
  loading: boolean;
  load(): void;
}

interface Props {
  items: readonly ChatItem[];
  /** 对话层里一条的完整内容 */
  renderItem(item: ChatItem): ReactNode;
  /**
   * 缩小后组里一块（一次调用、一段思考）的对话层内容（57 号票）：只在跨档淡入淡出的那一下看得见，撑出这一块的高度
   * （AgentSense 每次调用的矩形高度就是它工具行的高度）
   */
  renderBlock(block: ZoomBlock): ReactNode;
  /** 某条上面另起的一行（日期分隔线）：对话层的东西，缩小后淡出、位置照留 */
  above?(item: ChatItem, index: number): ReactNode;
  /** 刚到的条目（播到达动效） */
  isFresh?(item: ChatItem, index: number): boolean;
  /** 没有条目时 */
  empty?: ReactNode;
  /** 内容最前面（"加载更早的消息"） */
  head?: ReactNode;
  /** 内容最后面（正在合成的语音、"正在回复…"） */
  tail?: ReactNode;
  footer?: ReactNode;
  older?: OlderHistory;
  /** 缩小状态下点中某条历史（条目 id；组里的一块是那次调用、那段思考的 id）：precise = 点中的是能打开详情的 */
  onZoomTap?(id: string, precise: boolean): void;
  onLevelChange?(level: ZoomLevel): void;
  /**
   * 挂上时从哪一档开始（二狗：AgentSense 的会话历史不随会话重建，换了会话档位照旧；二狗换了会话是重新挂上，
   * 所以把整页记着的那一档带进来）。不是对话层时停在最新一条（底部）
   */
  initialLevel?: ZoomLevel;
  /** 对话层滚动时，屏幕上正在看的那一条（视口 40% 高处）；atBottom = 停在最新一条 */
  onFocusChat?(chatId: string | undefined, atBottom: boolean): void;
}

/** 离顶部不到这么多像素（屏幕上）就取更早的一页（二狗原来的数） */
const LOAD_OLDER_WITHIN_PX = 80;

/** 往上翻取更早的一页之前记下的锚点：视口里那一条（id）的下沿离视口顶多远（屏幕像素） */
interface OlderAnchor {
  id: string;
  bottom: number;
  /** 取之前最前面那一条：它变了就是更早的一页到了 */
  firstId: string | undefined;
}

/** 一个矩形要的东西：条目，或者缩小后组里的一块（57 号票） */
interface ZView {
  id: string;
  content: ContentKind;
  /** 条目的种类（ck-）；组里的一块是 step */
  kind: string;
  tone: OpStyle | undefined;
  keyLine: string;
  marks: readonly TimelineMark[];
  error: boolean;
  nature: ToolNature | undefined;
  /** 工具调用组那一行（只在对话层）、组里的一块（只在缩小后）：所属的组；换档时按它换算焦点 */
  group?: { id: string; role: "row" | "step" } | undefined;
}

function ZItemView({ view, fresh, above, children }: { view: ZView; fresh: boolean; above: ReactNode; children: ReactNode }) {
  const layer = `bg-${view.content}${view.nature ? ` n-${view.nature}` : ""}${view.error ? " zi-err" : ""}`;
  const { group } = view;
  return (
    <>
      {above}
      {/* data-item：条目层的 id（56 号票的详情页按它打开、定位）；data-group：工具调用组（57 号票，对话层一行、缩小后逐次画） */}
      <div
        className={`zi k-${view.content} ck-${view.kind}${view.tone ? ` t-${view.tone}` : ""}${group ? ` zi-${group.role === "row" ? "grouprow" : "step"}` : ""}`}
        data-chat-id={view.id}
        data-item={view.id}
        data-group={group?.id}
      >
        <div className={`zi-l0${fresh ? " fx-new" : ""}`}>{children}</div>
        <div className={`zi-l1 ${layer}`}>
          {/* 要点层只写一行，不盖住底下的内容；细节展开看 */}
          <div className="zi-cap">
            <div className="zi-title">
              <NamedText text={view.keyLine} />
            </div>
          </div>
          {/* 有关注（右侧标注）就有的小圆点，有高的用高亮色（AgentSense 的 zi-risk-dot；二狗的标注就是它的 risks） */}
          {view.marks.length > 0 && <div className={`zi-risk-dot${view.marks.some((m) => markLevel(m) === "high") ? " high" : ""}`} />}
        </div>
        <div className={`zi-l2 ${layer}`} />
        {view.marks.length > 0 && (
          <div className="zd-right">
            {view.marks.map((m) => (
              <MarkChip key={m.key} mark={m} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** 一块缩小后的样子：调用按这一次算性质、小圆点、标注（不是组里取最重的）；思考是思考的底色 */
function blockView(block: ZoomBlock): ZView {
  const group = { id: block.groupId, role: "step" as const };
  if (block.kind === "thinking") return { id: block.id, content: "thinking", kind: "step", tone: undefined, keyLine: block.keyLine, marks: [], error: false, nature: undefined, group };
  return { id: block.id, content: "tool", kind: "step", tone: block.tone, keyLine: block.keyLine, marks: block.marks, error: block.error, nature: toolNatureOf(block.call.part), group };
}

/**
 * 条目没变就不重画（缩放跨档、别的频道来了事件时，几百条不必每条都重画）。
 * 工具调用组画成两样（57 号票）：对话层那一行（性质、小圆点按组里最重的），和缩小后组里每次调用、每段思考各一块；
 * 哪样显示由 .zh 的 data-level 决定（zoom.css），照 AgentSense 同类折叠的做法（对话层隐藏、缩小后逐条出现）
 */
const ZItem = memo(function ZItem({
  item,
  fresh,
  above,
  renderItem,
  renderBlock,
}: {
  item: ChatItem;
  fresh: boolean;
  above: ReactNode;
  renderItem(item: ChatItem): ReactNode;
  renderBlock(block: ZoomBlock): ReactNode;
}) {
  const blocks = zoomBlocks(item);
  const view: ZView = {
    id: item.id,
    content: item.content,
    kind: item.kind,
    tone: item.tone,
    keyLine: item.keyLine,
    marks: item.marks,
    error: item.error,
    nature: chatItemNature(item),
    group: blocks.length > 0 ? { id: item.id, role: "row" } : undefined,
  };
  return (
    <>
      <ZItemView view={view} fresh={fresh} above={above}>
        {renderItem(item)}
      </ZItemView>
      {blocks.map((b) => (
        <ZItemView key={b.id} view={blockView(b)} fresh={false} above={null}>
          {renderBlock(b)}
        </ZItemView>
      ))}
    </>
  );
});

/** 图例：六种内容类型；工具那一格放三块色样（只看 → 动手 → 删改） */
const LEGEND_KINDS = Object.entries(CONTENT_KIND_LABEL) as [ContentKind, string][];
const NATURES_TEXT = TOOL_NATURES.map((n) => TOOL_NATURE_LABEL[n]).join(" / ");

/** 闪一下（点缩小的条放大回去、在对话中定位） */
function flash(el: Element) {
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
}

/** "在对话中定位"闪一下：56 号票的样子（detail.css 的 .dp-flash，底色加一圈同色外框） */
function flashFrame(el: HTMLElement) {
  el.classList.remove("dp-flash");
  // 重新挂上才会再播一次
  void el.offsetWidth;
  el.classList.add("dp-flash");
  setTimeout(() => el.classList.remove("dp-flash"), 1600);
}

/** 内容够多的条（≥150px）：要点层直接显示对话层真实内容的缩影 */
function markLong(content: HTMLElement) {
  for (const zi of content.querySelectorAll<HTMLElement>(".zi")) {
    zi.dataset.long = zi.offsetHeight >= 150 ? "1" : "";
  }
}

/**
 * 右侧标注逐条定位、画箭头。缩放过程中每一帧都要重算（ctl.onScale），
 * 否则标注停在上一档算好的位置、色块却在缩放，箭头会偏得很离谱，停下来才跳回去。
 * （AgentSense layoutAnnotations 里风险标注那一段，原样；分支面板、回退点那几段二狗没有）
 */
function layoutAnnotations(content: HTMLElement, ctl: ZoomController | null) {
  const level = ctl?.level ?? 0;
  const s = ctl?.s ?? 1;
  // 标注按这一档排版、再整体缩放，所以它们内部的长度单位是 DS 像素
  const DS = 0.45;
  const k = DS / s;
  const contentTop = content.getBoundingClientRect().top;
  const cy = (clientY: number) => (clientY - contentTop) / s;
  // 风险标注：默认与"这条风险在原文里的那一行"水平对齐，箭头就是一条横线；
  // 只有上一条把它挤住时才往下让，让出来的部分靠斜线补，箭头指的点不变。
  // 先把要量的都量完、再一起写（二狗：原文边量边写，每写一次下一次量就得重新排版，几百条时捏合会卡；算法和结果不变）
  const writes: (() => void)[] = [];
  let bottom = -Infinity;
  for (const el of content.querySelectorAll<HTMLElement>(".zd-right")) {
    const item = el.parentElement!;
    // 这一档藏起来的（工具调用组那一行在缩小后、组里的块在对话层，57 号票）：不占位置，也不挤别人
    if (item.getClientRects().length === 0) continue;
    const it = item.getBoundingClientRect();
    const l0 = item.querySelector<HTMLElement>(".zi-l0");
    const itemTop = cy(it.top);
    const left = level === 0 ? 0 : el.getBoundingClientRect().left;
    for (const chip of el.querySelectorAll<HTMLElement>(".zd-risk, .zd-repeat")) {
      const svg = chip.querySelector<SVGSVGElement>(".zd-risk-leader");
      const path = svg?.querySelector("path");
      if (level === 0) {
        writes.push(() => {
          chip.style.removeProperty("top");
          path?.removeAttribute("d");
        });
        continue;
      }
      const key = chip.dataset.mark;
      const src = key && l0 ? l0.querySelector<HTMLElement>(`[data-mark="${CSS.escape(key)}"]`) : null;
      const sr = src?.getBoundingClientRect();
      // 原文里那一行的中线；找不到就退回色块正中
      const anchor = sr && sr.height ? cy(sr.top + sr.height / 2) : itemTop + it.height / s / 2;
      const chipH = chip.offsetHeight;
      const hC = chipH * k;
      const top = Math.max(anchor - hC / 2, bottom + 4 / s);
      bottom = top + hC;
      writes.push(() => {
        chip.style.top = `${(top - itemTop) / k}px`;
      });
      if (!svg || !path) continue;
      // 箭头：从标注左缘拉到色块右缘的锚点高度
      const w = Math.max(6 / DS, (left - it.right) / (s * k));
      const dy = (anchor - (top + hC / 2)) / k;
      const pad = 6 / DS;
      const h = 2 * (Math.abs(dy) + pad);
      const y0 = h / 2;
      const y1 = h / 2 + dy;
      const len = Math.hypot(w, dy) || 1;
      const ux = -w / len;
      const uy = dy / len;
      const a2 = 3.5 / DS;
      writes.push(() => {
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.style.left = `${-w}px`;
        svg.style.top = `${chipH / 2 - h / 2}px`;
        path.setAttribute("d", `M${w} ${y0} L0 ${y1} M0 ${y1} l${-ux * a2 - uy * a2} ${-uy * a2 + ux * a2} M0 ${y1} l${-ux * a2 + uy * a2} ${-uy * a2 - ux * a2}`);
      });
    }
  }
  for (const write of writes) write();
}

/** 这一档看得见的矩形（藏起来的没有盒子） */
const shown = (el: HTMLElement) => el.getClientRects().length > 0;

/** 一组看得见的那几块（对话层是那一行，缩小后是组里每一块）上下沿的范围（内容坐标，未缩放） */
function groupSpan(content: HTMLElement, group: string): { top: number; bottom: number } | undefined {
  let top = Infinity;
  let bottom = -Infinity;
  for (const el of content.querySelectorAll<HTMLElement>(`.zi[data-group="${CSS.escape(group)}"]`)) {
    if (!shown(el)) continue;
    top = Math.min(top, el.offsetTop);
    bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
  }
  return top < bottom ? { top, bottom } : undefined;
}

/** 换档前记下的焦点：落在哪个工具调用组的第几成高度上、落在哪一条的多深处、或者在最后一条下面 */
type LayoutAnchor = { group: string; frac: number } | { el: HTMLElement; offset: number } | { end: true };

/**
 * 焦点那一点（内容坐标）在现在的布局里落在哪（57 号票：工具调用组在对话层是一行、缩小后逐次画，跨过对话层那一档时布局会变）。
 * 落在组上的记成组里的比例，换档后放到组新的范围里同样的比例处；落在别的条上的记成离它上沿多远
 */
function captureAnchor(content: HTMLElement, contentY: number): LayoutAnchor | undefined {
  let last: HTMLElement | undefined;
  for (const el of content.querySelectorAll<HTMLElement>(".zh-content > .zi")) {
    if (!shown(el)) continue;
    last = el;
    if (el.offsetTop + el.offsetHeight <= contentY) continue;
    const group = el.dataset.group;
    const span = group ? groupSpan(content, group) : undefined;
    if (group && span) return { group, frac: Math.min(1, Math.max(0, (contentY - span.top) / (span.bottom - span.top))) };
    return { el, offset: contentY - el.offsetTop };
  }
  return last ? { end: true } : undefined;
}

/** 换档后：记下的焦点在新布局里的内容坐标；找不到就是 undefined */
function restoreAnchor(content: HTMLElement, anchor: LayoutAnchor): number | undefined {
  if ("end" in anchor) return content.offsetHeight;
  if ("group" in anchor) {
    const span = groupSpan(content, anchor.group);
    return span ? span.top + anchor.frac * (span.bottom - span.top) : undefined;
  }
  return shown(anchor.el) ? anchor.el.offsetTop + anchor.offset : undefined;
}

/** 视口里的高度：屏幕坐标换成离视口顶多远 */
const viewportY = (viewport: HTMLElement, clientY: number) => clientY - viewport.getBoundingClientRect().top;

/** 离底部不到 24px 算停在最新一条 */
const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 24;

export const ZoomHistory = forwardRef<ZoomHistoryHandle, Props>(function ZoomHistory(props, ref) {
  const { items, older, onFocusChat, onLevelChange, onZoomTap, renderItem, renderBlock, above, isFresh } = props;
  // 只在挂上时用一次
  const initialLevelRef = useRef(props.initialLevel ?? 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<ZoomController | null>(null);
  const followRef = useRef(true);
  /** 手指是否正按在列表上（按住时绝不自动滚动） */
  const touchingRef = useRef(false);
  /** 下一次 scroll 事件由程序触发，不代表用户意图 */
  const programmaticRef = useRef(false);
  /** 正在缩放（捏着、动画没停）：这时不去取更早的，免得内容在手指下面跳；停稳后再看（二狗：往上翻） */
  const zoomingRef = useRef(false);
  // 外面传进来的、每次渲染都可能换的东西放进 ref（渲染完再写）：缩放控制器只建一次，重建会回到对话层
  const focusCb = useRef(onFocusChat);
  const levelCb = useRef(onLevelChange);
  const itemsRef = useRef(items);
  const olderRef = useRef(older);
  useLayoutEffect(() => {
    focusCb.current = onFocusChat;
    levelCb.current = onLevelChange;
    itemsRef.current = items;
    olderRef.current = older;
  });
  // 屏幕上正在看哪一条：滚动、内容变化时报给外面
  const focusRaf = useRef(0);
  const reportFocus = useCallback(() => {
    cancelAnimationFrame(focusRaf.current);
    focusRaf.current = requestAnimationFrame(() => {
      const vp = viewportRef.current;
      const content = contentRef.current;
      if (!vp || !content || !focusCb.current) return;
      const r = vp.getBoundingClientRect();
      const y = r.top + r.height * 0.4;
      let pick: string | undefined;
      for (const el of content.querySelectorAll<HTMLElement>(".zi[data-chat-id]")) {
        if (el.getBoundingClientRect().bottom >= y) {
          pick = el.dataset.chatId;
          break;
        }
      }
      focusCb.current(pick, atBottom(vp));
    });
  }, []);
  const pinchRef = useRef({ s0: 1, focalY: 0, contentY: 0 });
  const [level, setLevel] = useState<ZoomLevel>(0);

  // ── 往上翻（二狗）：取之前记下锚点，取回来之后把锚点那一条的下沿放回原处 ──
  const anchorRef = useRef<OlderAnchor | undefined>(undefined);
  const loadOlder = useCallback(() => {
    const o = olderRef.current;
    const vp = viewportRef.current;
    const content = contentRef.current;
    if (!o || !o.canLoad || o.loading || zoomingRef.current || !vp || !content) return;
    // 锚点：视口里第一条下沿露在视口里的（取下沿：一组调用并上更早的调用时上沿会变，下沿不变）
    const top = vp.getBoundingClientRect().top;
    for (const el of content.querySelectorAll<HTMLElement>(".zi[data-chat-id]")) {
      const bottom = el.getBoundingClientRect().bottom - top;
      if (bottom > 0) {
        anchorRef.current = { id: el.dataset.chatId!, bottom, firstId: itemsRef.current[0]?.id };
        break;
      }
    }
    o.load();
  }, []);
  const loading = older?.loading ?? false;
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const ctl = ctlRef.current;
    const vp = viewportRef.current;
    const content = contentRef.current;
    if (!a || !ctl || !vp || !content) return;
    // 更早的一页还没到：等着；到了（最前面那一条变了）就放回去；取完了却没有新的（失败、没有更早的）就不管了
    if (items[0]?.id === a.firstId) {
      if (!loading) anchorRef.current = undefined;
      return;
    }
    anchorRef.current = undefined;
    // 缩小后组里的一块按自己的 id（调用、思考的 id 不变）；条目按 locateChatItem 找现在的那一条
    const exact = content.querySelector<HTMLElement>(`.zi-step[data-chat-id="${CSS.escape(a.id)}"]`);
    const found = exact ? undefined : locateChatItem(items, a.id);
    const el = exact ?? (found ? content.querySelector<HTMLElement>(`.zi[data-chat-id="${CSS.escape(found.item.id)}"]`) : null);
    if (!el) return;
    // 先把滚动范围撑出来（ResizeObserver 要到下一帧才报），再把下沿放回原处
    ctl.setContentHeight(content.offsetHeight, 0);
    programmaticRef.current = true;
    vp.scrollTop = (el.offsetTop + el.offsetHeight) * ctl.s - a.bottom;
  }, [items, loading]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const content = contentRef.current!;
    const ctl = new ZoomController(viewport, sizerRef.current!, content, rootRef.current!);
    ctlRef.current = ctl;
    // 缩放停稳：两侧标注重新避让排版；缩小状态下停稳时已经在顶上（整页都放得下、滚不动），照样取更早的一页（二狗）
    ctl.onSettle = () => {
      zoomingRef.current = false;
      layoutAnnotations(content, ctl);
      if (ctl.level > 0 && viewport.scrollTop < LOAD_OLDER_WITHIN_PX) loadOlder();
    };
    ctl.onScale = () => layoutAnnotations(content, ctl);
    // 跨过对话层那一档时布局会变（57 号票：工具调用组对话层一行、缩小后逐次画）：焦点那一点换算到新布局里，内容不在手指下面跳走。
    // 滚动范围先按新的内容高度撑出来，再放焦点
    ctl.onLevelLayout = (contentY) => {
      const anchor = captureAnchor(content, contentY);
      return () => {
        ctl.setContentHeight(content.offsetHeight, 0);
        return (anchor && restoreAnchor(content, anchor)) ?? contentY;
      };
    };
    const off = ctl.onLevelChange((l) => {
      setLevel(l);
      levelCb.current?.(l);
    });
    // 从记住的那一档开始（二狗）：内容底边对齐视口底边，停在最新一条
    const start = initialLevelRef.current;
    if (start > 0) {
      ctl.setContentHeight(content.offsetHeight, 0);
      programmaticRef.current = true;
      ctl.set(PRESETS[start], viewport.clientHeight, content.offsetHeight);
    }
    // 内容高度变化（新消息、流式输出）→ 更新滚动范围；对话层且在底部时跟随到底
    const ro = new ResizeObserver(() => {
      ctl.setContentHeight(content.offsetHeight, 0);
      if (followRef.current && !touchingRef.current && ctl.level === 0 && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1) {
        programmaticRef.current = true;
        viewport.scrollTop = viewport.scrollHeight;
      }
      reportFocus();
    });
    ro.observe(content);
    // 视口大小变化（拖分栏、旋转、折叠、输入框上方多了一条提醒）→ 重新居中；原来跟着最新一条的，接着跟
    const ro2 = new ResizeObserver(() => {
      const following = followRef.current && !touchingRef.current;
      ctl.relayout();
      if (following && ctl.level === 0) {
        programmaticRef.current = true;
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
    ro2.observe(viewport);
    return () => {
      off();
      ro.disconnect();
      ro2.disconnect();
      ctl.dispose();
    };
  }, [reportFocus, loadOlder]);

  // 每次渲染之后（条目变了、换了档）：内容多的条重新量，两侧标注重新避让排版
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    markLong(content);
    layoutAnnotations(content, ctlRef.current);
  });

  // 捏合挂在整块上（连输入框那一栏也算）
  usePinch(rootRef, {
    onStart(c) {
      const ctl = ctlRef.current!;
      zoomingRef.current = true;
      const focalY = viewportY(viewportRef.current!, c.y);
      pinchRef.current = { s0: ctl.s, focalY, contentY: ctl.contentYAt(focalY) };
    },
    onChange(ratio, c) {
      const p = pinchRef.current;
      p.focalY = viewportY(viewportRef.current!, c.y);
      // 跨档改了布局时焦点换算过（57 号票），接着用换算后的
      p.contentY = ctlRef.current!.set(p.s0 / ratio, p.focalY, p.contentY);
    },
    onEnd() {
      const p = pinchRef.current;
      ctlRef.current!.snap(p.focalY, p.contentY);
    },
  });

  useImperativeHandle(ref, () => ({
    zoomTo(l) {
      const ctl = ctlRef.current!;
      zoomingRef.current = true;
      const focalY = viewportRef.current!.clientHeight / 2;
      ctl.animateTo(PRESETS[l], ctl.contentYAt(focalY), focalY);
    },
    reveal(chatId) {
      // 存的 id 可能是组原来的 id、组里某一步的 id：一律经 locateChatItem 找到现在的那一条
      const found = locateChatItem(itemsRef.current, chatId);
      const content = contentRef.current;
      const row = found && content ? content.querySelector<HTMLElement>(`.zi[data-chat-id="${CSS.escape(found.item.id)}"]`) : null;
      if (!found || !content || !row) return;
      // 二狗：组里的某一步（56 号票的详情里点的是一次调用、一段思考）定位到那一步、闪那一步；别的定位到整条、闪整条（AgentSense）
      const stepId = found.call?.id ?? (chatId !== found.item.id ? chatId : undefined);
      // 57 号票：缩小着的时候组那一行藏着，组里每一步各是一块——从那一块（找不到就是组里第一块）放大回去，跨档时焦点换算到组那一行
      const block = shown(row)
        ? null
        : (content.querySelector<HTMLElement>(`.zi-step[data-chat-id="${CSS.escape(stepId ?? "")}"]`) ?? content.querySelector<HTMLElement>(`.zi-step[data-group="${CSS.escape(found.item.id)}"]`));
      const el = block ?? row;
      const step = stepId === undefined || block ? null : row.querySelector<HTMLElement>(`.zi-l0 [data-item="${CSS.escape(stepId)}"]`);
      const ctl = ctlRef.current!;
      const vp = viewportRef.current!;
      followRef.current = false;
      const toY = vp.clientHeight * 0.3;
      // 要放到 toY 的那一点在内容里的高度（未缩放）：整条是它的 offsetTop（AgentSense），某一步按屏幕位置换算
      const top = step ? (step.getBoundingClientRect().top - content.getBoundingClientRect().top) / ctl.s : el.offsetTop;
      // 缩小着的：以它为焦点放大回对话层，同时滑到 toY；已在对话层：滚过去（AgentSense）
      if (ctl.level === 0) vp.scrollTo({ top: top * ctl.s - toY, behavior: "smooth" });
      else {
        zoomingRef.current = true;
        ctl.animateTo(1, top, top * ctl.s - vp.scrollTop, toY);
      }
      // 闪一下：底色之外加一圈同色外框（56 号票第 10 条，用户认可：二狗的气泡、工具行自己有底色，光闪底色看不见）。
      // 从缩小后的一块放大回去的，闪的是对话层里组那一行
      flashFrame(step ?? row.querySelector<HTMLElement>(".zi-l0") ?? row);
    },
    followLatest() {
      followRef.current = true;
    },
  }));

  /**
   * 缩小状态下点中某条历史：以它为焦点一镜到底放大回对话层。
   * 点的是组里的一块（一次调用，57 号票）：放大回去落在对话层里组那一行（跨档时焦点换算过去）、闪那一行；打开的是这一次调用的详情
   */
  const onContentClick = useCallback(
    (e: MouseEvent) => {
      const ctl = ctlRef.current;
      const vp = viewportRef.current;
      const content = contentRef.current;
      if (!ctl || !vp || !content || ctl.level === 0) return;
      // 两侧标注里的按钮自己处理点击
      if ((e.target as HTMLElement).closest("button")) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-chat-id]");
      const id = el?.dataset.chatId;
      if (!el || !id) return;
      const group = el.classList.contains("zi-step") ? el.dataset.group : undefined;
      const item = items.find((x) => x.id === (group ?? id));
      if (!item) return;
      followRef.current = false;
      zoomingRef.current = true;
      const focalY = viewportY(vp, e.clientY);
      const contentY = ctl.contentYAt(focalY);
      ctl.animateTo(1, contentY, focalY, Math.min(focalY, vp.clientHeight * 0.4));
      flash((group && content.querySelector<HTMLElement>(`.zi-grouprow[data-group="${CSS.escape(group)}"]`)) || el);
      onZoomTap?.(id, item.detail !== undefined);
    },
    [items, onZoomTap],
  );

  return (
    <div className="zh" ref={rootRef} data-level={level}>
      <div
        className="zh-viewport"
        ref={viewportRef}
        onScroll={(e) => {
          reportFocus();
          const el = e.currentTarget;
          // 往上翻（二狗）：滚到顶附近取更早的一页（任何一档都一样）；程序滚的、缩放中的不算
          const programmatic = programmaticRef.current;
          if (!programmatic && el.scrollTop < LOAD_OLDER_WITHIN_PX && el.scrollHeight > el.clientHeight) loadOlder();
          if (programmatic) {
            programmaticRef.current = false;
            return;
          }
          followRef.current = atBottom(el);
        }}
        onTouchStart={() => {
          touchingRef.current = true;
        }}
        onTouchMove={() => {
          followRef.current = false;
        }}
        onTouchEnd={(e) => {
          touchingRef.current = false;
          followRef.current = atBottom(e.currentTarget);
        }}
        onWheel={(e) => {
          if (e.deltaY < 0) followRef.current = false;
        }}
      >
        <div className="zh-sizer" ref={sizerRef}>
          <div className="zh-content" ref={contentRef} onClickCapture={level > 0 ? onContentClick : undefined}>
            {props.head}
            {items.length === 0 && props.empty}
            {items.map((it, i) => (
              <ZItem key={it.id} item={it} fresh={isFresh?.(it, i) ?? false} above={above?.(it, i)} renderItem={renderItem} renderBlock={renderBlock} />
            ))}
            {props.tail}
          </div>
        </div>
      </div>
      <div className="zh-footer">
        {props.footer}
        <div className="zh-legend">
          {LEGEND_KINDS.map(([k, label]) =>
            k === "tool" ? (
              <span key={k} title={`工具调用：${NATURES_TEXT}`}>
                {TOOL_NATURES.map((n) => (
                  <i key={n} className={`bg-tool n-${n}`} />
                ))}
                {label}（{NATURES_TEXT}）
              </span>
            ) : (
              <span key={k}>
                <i className={`bg-${k}`} />
                {label}
              </span>
            ),
          )}
        </div>
      </div>
    </div>
  );
});
