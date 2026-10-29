/**
 * 会话历史：同一份内容在三档缩放层级间一镜到底（54 号票，规格第 19 节"会话区"）。
 *
 * 通用骨架：
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
 * 分支和回退（150 号票起有回退点和 ⑂，见下）；同类操作折叠用的是二狗的工具调用组（52 号票）；
 * 阶段框折叠、固定计划的"接下来的计划"虚线框属于两种任务的界面。
 * 写法上照 lint（React 的 refs、immutability 规则）：外面传进来的回调渲染完再写进 ref；
 * "条目变了、换了档、缩放停稳之后重新排标注"是每次渲染后排一次加上停稳时排一次；flash、layoutAnnotations 在组件外面。
 *
 * 57 号票：工具调用组只存在于对话层——对话层是一行"调用了 N 个工具 ›"（.zi-grouprow），缩小后不按组（每次调用各是一条）：
 * 组里每次调用、每段思考各画一块（.zi-step），性质、小圆点、右侧标注都按这一次算；哪样显示由 data-level 决定，同同类折叠
 * 的做法（.zh[data-level="0"] .zi-folded 隐藏）。跨过对话层那一档时内容高度会变，焦点按组里的比例换算到新布局（zoom.ts 的
 * onLevelLayout），手指下面的内容不跳走。缩小着点一块：放大回去落在组那一行、闪那一行，打开这一次调用的详情。
 *
 * 55 号票：缩小后条外的装饰（数据由状态层的 zoomDecor 给，state/zoom-decor.ts）——
 * - 右侧标注连着一样的只在第一块标、写 ×N（.zd-repeat）；验收通过的不标（书脊变绿就是通过了，sideMarks）；
 * - 左侧任务卡、工单卡（.zd-left > .zd-task），点开看完整情况（decor.tsx）；
 * - 底色带（.zh-band，placeBands 摆到起止两条之间，横向铺满视口）和左缘竖排的标签（.zh-band-labels，每帧摆到露出那一段的中间）；
 * - 书脊（.zh-spine：贴着条左边的窄色条，一轮一段，颜色是这一轮的结果；阶段名每帧摆到这一段露出部分的中间，挤住了往下让）；
 * - 重开之前的那几轮淡一点、标"已废弃"（.zi-stale）；图例补上书脊的颜色。
 * 起止落在工具调用组上时：对话层是组那一行，缩小后是组里第一块、最后一块（edgeEl）；跨档时重新摆。
 * 阶段会话条外的图标标注跟着阶段框（StageNoteChips，见 91 号票）。书脊名避让撤回箭头见 150 号票。
 *
 * 60 号票：流程的会话画固定计划的"接下来的计划"虚线框（future：放在内容最后、跟着一起缩放，样子在 ui/zoom/future.tsx 和 zoom.css）；
 * 它的敏感标注和条右侧的标注一起排版（layoutAnnotations 认 .zd-right，不管它挂在条上还是挂在虚线框的一格上）。
 *
 * 91 号票：长程任务的会话按阶段成框——
 * - 照常显示的之外，每段后台事项收成一个阶段框（状态层 stageBoxes 给，框的样子在 ui/conversation/StageBox.tsx）；框在三档里是同一块
 *   （.zi-stage：对话层是框，要点层写"第 N 阶段 标题"，全局层是色块），收着的阶段里的每一条三档都不画，条外的标注一类一条、
 *   指向框上那个图标（StageNoteChips）；展开了，这一块只剩框头，下面逐条画每次操作（.zi-grp-open，接着框左边那道颜色）；
 * - 框里的工具调用组每次操作一行：三档都画组里每次调用、每段思考那几块（57 号票缩小后的样子），组那一行不画；
 *   对话层里点一块打开那一次调用的详情；
 * - 书脊、底色带的上下沿：收着的框里的事落在框上，一个框里的事上沿从框顶开始（stageBoxEdge、stageBoxSpines）；
 * - 屏幕停在框上时，报给外面的是框里最后一件事（.sbox 的 data-focus-id），标题栏的阶段标签跟着它；
 * - 在对话中定位（reveal）到收着的框里的一条：先把框展开。缩小着点框：放大回对话层，闪一下。
 *
 * 往上翻加载更早的一页（不是整个会话一次进 DOM）。和缩放共存：任何一档滚到顶都取更早的一页，
 * 缩小状态下停稳时已经在顶上也取；取回来之后视口里那一条的下沿留在原处（锚点按条目 id 存，用 locateChatItem 找：
 * 一组调用跨两页时，翻回来之后组的 id 会变，下沿不变）。
 *
 * 150 号票：会话回退（数据由状态层的 zoomRollbacks、zoomForks 给，能回退的会话才有）——
 * - 回退点：条左边的 ↶（.zd-left > .zd-rollback），缩小后才看得见；一条直线指到它撤回的那条分界线（layoutAnnotations
 *   里回退点那一段：挨太近时只向左让位，线随之变长；有书脊时线停在书脊外沿）；点了弹出确认（rollback.tsx 的 RollbackDialog）；
 * - 分叉点：条右边的 ⑂ 小方块（.zd-fork > .zd-ab-dot，分支收着的样子），同一处几条分支横着排；
 * - 书脊名避让撤回箭头（placeLabels）。
 *
 * 151 号票：废弃分支（AbandonedStub、SwapOverlay、measureCol 在 ui/zoom/branches.tsx，数据在状态层 abandoned-branch.ts）——
 * - 点 ⑂ 展开：这条分支按主线同一套 DOM（ZItem 去掉条外的装饰，bare）、同一宽度原尺寸画出来，上方"⑂ 另一条分支 · N 段 ▾"、
 *   "切换到这条分支"；layoutAnnotations 把展开的面板挪到右侧标注右边、放不下贴着视口右缘，还被压住的标注收窄或藏起来；
 *   缩小后伸到最后一条下面的面板也算进滚动范围（108 号票的 sizer 裁掉了伸出去的）；点分支打开它的详情（branches.open）；
 * - 切换（switchBranch）：先量好从分叉处起的当前这一段和预览条，交给守护进程；当前分支变成切过去的那条、条目到了之后再量新布局，
 *   倒着放 SwapOverlay（等 items 变，还要等当前分支变了——切换要几秒，期间流式的回复、停下的那一轮也会让 items 变）。
 *   只数主干上的块（:scope > .zi，预览复用了同一套 .zi），切不成就把动画收掉。
 *
 * 108 号票：滚到最后一条就停，右下角"回到最新"的 ↓（规矩在状态层 state/scroll-end.ts）——
 * - 原来内容里伸到内容外面的东西也撑滚动范围：对话层看不见的右侧标注在它那一条旁边往下叠（一组调用的标注能叠好几百像素）、
 *   缩小后被挤下去的标注和箭头，滚到底还能往下滚出一大片空白。sizer 把伸出去的裁掉（zoom.css），缩小后伸到最后一条下面、看得见的
 *   标注和左侧的卡算进"只在缩小时出现的尾部区域"（setContentHeight 的 extra，原本给"接下来的计划"留的，原来一直是 0）：
 *   layoutAnnotations 多返回最低那条标注的下沿，每次排标注时跟着改滚动范围（layoutSides）；
 * - viewport 外面多包一层 .zh-main，↓（JumpToLatest）贴着它的右下角：离开底部才出，点了滚到最新一条、接着跟最新的走；
 *   离开底部期间新到了消息写条数，只多了思考、工具调用标一个圆点。
 */
import { Fragment, forwardRef, type MouseEvent, memo, type ReactNode, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLocale } from "../../app/locale.ts";
import {
  type ChatItem,
  CONTENT_KIND_LABEL,
  type ContentKind,
  chatItemNature,
  locateChatItem,
  type OpStyle,
  SPINE_STATE_LABEL,
  type TimelineMark,
  TOOL_NATURE_LABEL,
  TOOL_NATURES,
  type ToolNature,
  toolNatureOf,
  type ZoomBand,
  type ZoomBlock,
  type ConversationId,
  type ZoomDecor,
  type ZoomFork,
  type ZoomLeftCard,
  type ZoomRollbackPoint,
  jumpToLatestShown,
  sideMarks,
  STAGE_BOX_EDGE,
  type StageBoxView,
  type StageGroup,
  type StageNote,
  type VerdictStrip,
  stageBoxEdge,
  stageBoxRows,
  stageBoxSpines,
  zoomBlocks,
  zoomedOutTail,
  afterScroll,
  atLatest,
  jumpBadge,
  maxSeq,
  t,
} from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { T } from "../i18n.tsx";
import { StageBox, StageNoteChips, StageNoteLegend, VerdictStripView } from "../conversation/StageBox.tsx";
import { LeftCardDialog, LeftCardHead } from "./decor.tsx";
import { RollbackDialog } from "./rollback.tsx";
import { AbandonedStub, blockKey, measureCol, type Rect, type StubHost, type SwapCol, SwapOverlay, type SwapState } from "./branches.tsx";
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
   * （每次调用的矩形高度就是它工具行的高度）
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
  /** 流程的"接下来的计划"虚线框（60 号票）：在内容最后，跟着一起缩放 */
  future?: ReactNode;
  footer?: ReactNode;
  older?: OlderHistory;
  /** 缩小状态下点中某条历史（条目 id；组里的一块是那次调用、那段思考的 id）：precise = 点中的是能打开详情的 */
  onZoomTap?(id: string, precise: boolean): void;
  onLevelChange?(level: ZoomLevel): void;
  /**
   * 挂上时从哪一档开始（换了会话档位照旧；可这里换了会话是重新挂上，
   * 所以把整页记着的那一档带进来）。不是对话层时停在最新一条（底部）
   */
  initialLevel?: ZoomLevel;
  /** 对话层滚动时，屏幕上正在看的那一条（视口 40% 高处）；atBottom = 停在最新一条 */
  onFocusChat?(chatId: string | undefined, atBottom: boolean): void;
  /** 缩小后条外的装饰（55 号票：×N、左侧的卡、底色带、书脊、已废弃），状态层的 zoomDecor 给 */
  decor?: ZoomDecor | undefined;
  /** 打开某一条的详情（左侧任务卡点开后"看计划详情"；阶段框里点一次操作、点收着的框的标注） */
  onDetail?: ((id: string) => void) | undefined;
  /** 长程任务的会话按阶段成框（91 号票）：状态层 stageBoxes 给的每个框；不给就照旧逐条画 */
  boxes?: readonly StageBoxView[] | undefined;
  /** 框上的"验收和规则 ›"、收着的框上合起来好几件的标注：打开这个阶段的详情 */
  onStage?: ((stageId: string) => void) | undefined;
  /** 能在这里回退的会话（150 号票）：给了才画回退点（decor.rollbacks），点了弹确认、交给守护进程；只读的会话不给 */
  rollbackIn?: ConversationId | undefined;
  /** 废弃分支（151 号票）：给了 ⑂ 才点得开（预览、点分支打开详情）；switchTo 切过去（只读的会话不给） */
  branches?: BranchActions | undefined;
  /** 现在的当前分支（151 号票）：切换的双向动画等它变成切过去的那条才量新布局 */
  currentBranch?: string | undefined;
}

/** 废弃分支上能做的（151 号票）：在哪个会话、打开一条分支的详情、切过去（等守护进程做完；切不成拒绝） */
export interface BranchActions {
  conversation: ConversationId;
  open?: ((branchId: string) => void) | undefined;
  switchTo?: ((branchId: string) => Promise<unknown>) | undefined;
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

/** 一块矩形条外的东西（55 号票）：右侧标注的 ×N（0 是并进了前面那一块）、左边的卡、重开之前的（已废弃）、回退点和分叉点（150 号票） */
interface ZSide {
  repeat: number | undefined;
  left: ZoomLeftCard | undefined;
  stale: boolean;
  onOpenCard(card: ZoomLeftCard): void;
  /** 条左边的 ↶；不能回退的会话（或只读的）没有 */
  rollbacks: readonly ZoomRollbackPoint[] | undefined;
  /** 条右边的 ⑂：从这里分出去的废弃分支 */
  forks: readonly ZoomFork[] | undefined;
  onRollback(point: ZoomRollbackPoint): void;
  /** ⑂ 点开要的（151 号票）；不给（没接废弃分支的地方）只标出来 */
  stub: StubHost | undefined;
}

/**
 * 一条在哪个阶段框里（91 号票）：open = 框展开着；start / end = 框里第一行、最后一行的 id
 * （工具调用组拆成每次调用之后的）；first = 框里第一条（它的左侧卡挂在框上）；cls = 框的完成情况（接着框左边那道颜色）
 */
interface ZGrp {
  open: boolean;
  start: string | undefined;
  end: string | undefined;
  first: string;
  cls: string;
}

/** 在阶段框里的一行：zi-grp 的那几个类 */
const grpClass = (grp: ZGrp | undefined, id: string) =>
  grp ? ` zi-grp gs-${grp.cls}${grp.open ? " zi-grp-open" : ""}${grp.start === id ? " zi-grp-start" : ""}${grp.end === id ? " zi-grp-end" : ""}` : "";

function ZItemView({
  view,
  fresh,
  above,
  side,
  extra = "",
  onOpen,
  bare = false,
  children,
}: {
  view: ZView;
  fresh: boolean;
  above: ReactNode;
  side: ZSide;
  /** 阶段框里的那几个类（91 号票） */
  extra?: string;
  /** 对话层里点这一块：阶段框里的一次调用、一段思考打开它的详情（91 号票） */
  onOpen?: (() => void) | undefined;
  /**
   * 废弃分支预览里的一条（151 号票）：只有三层，不带条外的装饰、小圆点；也不带 data-chat-id 这些
   * （主干上按它们找条、定位、点中放大、报看到哪了，预览里的不算）
   */
  bare?: boolean;
  children: ReactNode;
}) {
  const layer = `bg-${view.content}${view.nature ? ` n-${view.nature}` : ""}${view.error ? " zi-err" : ""}`;
  const { group } = view;
  const { repeat, left, stale, rollbacks, forks } = side;
  // 连着一样的标注：第一块标出、写 ×N，后面的不标（repeat === 0 时 risks 为空；小圆点照旧）
  const risks = repeat === 0 || bare ? [] : view.marks;
  return (
    <>
      {above}
      {/* data-item：条目层的 id（56 号票的详情页按它打开、定位）；data-group：工具调用组（57 号票，对话层一行、缩小后逐次画） */}
      <div
        className={`zi k-${view.content} ck-${view.kind}${view.tone ? ` t-${view.tone}` : ""}${group ? ` zi-${group.role === "row" ? "grouprow" : "step"}` : ""}${stale ? " zi-stale" : ""}${extra}`}
        data-chat-id={bare ? undefined : view.id}
        data-item={bare ? undefined : view.id}
        data-group={bare ? undefined : group?.id}
      >
        {stale && <span className="zi-stale-tag">{t("ui.zoomHistory.staleTag")}</span>}
        <div className={`zi-l0${fresh ? " fx-new" : ""}${onOpen ? " zi-open" : ""}`} onClick={onOpen}>
          {children}
        </div>
        <div className={`zi-l1 ${layer}`}>
          {/* 要点层只写一行，不盖住底下的内容；细节展开看 */}
          <div className="zi-cap">
            <div className="zi-title">
              <NamedText text={view.keyLine} />
            </div>
          </div>
          {/* 有关注（右侧标注）就有的小圆点，有高的用高亮色（zi-risk-dot） */}
          {!bare && view.marks.length > 0 && <div className={`zi-risk-dot${view.marks.some((m) => markLevel(m) === "high") ? " high" : ""}`} />}
        </div>
        <div className={`zi-l2 ${layer}`} />
        {(risks.length > 0 || (!bare && (repeat ?? 0) > 1)) && (
          <div className="zd-right">
            {risks.map((m) => (
              <MarkChip key={m.key} mark={m} />
            ))}
            {(repeat ?? 0) > 1 && <span className="zd-repeat">×{repeat}</span>}
          </div>
        )}
        {(left || (rollbacks?.length ?? 0) > 0) && (
          <div className="zd-left">
            {left && <LeftCardHead card={left} onOpen={side.onOpenCard} />}
            {/* 回退点（150 号票）：条边上的一个小图标，点一下弹出确认；引线由 layoutAnnotations 画 */}
            {rollbacks?.map((p) => (
              <button
                key={rollbackKey(p)}
                type="button"
                className="zd-rollback"
                aria-label={p.label}
                title={p.label}
                onClick={(e) => {
                  e.stopPropagation();
                  side.onRollback(p);
                }}
              >
                <span className="zd-rb-icon">↶</span>
                <svg className="zd-rb-leader" aria-hidden="true">
                  <path />
                </svg>
              </button>
            ))}
          </div>
        )}
        {/* 分叉点（150 号票）：从这里分出去的废弃分支，一条一个小方块，同一处几条横着排；点开是整条分支（151 号票） */}
        {forks && forks.length > 0 && (
          <div className="zd-fork">
            {forks.map((f) =>
              side.stub ? (
                <AbandonedStub key={f.branchId} fork={f} host={side.stub} />
              ) : (
                <button key={f.branchId} type="button" className="zd-ab-dot" aria-label={t("ui.branches.abandoned")} title={t("ui.branches.abandoned")} onClick={(e) => e.stopPropagation()}>
                  ⑂
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** 一个回退点的 key：回到哪一条之前（消息、分支开始、阶段开始，152 号票） */
const rollbackKey = (p: ZoomRollbackPoint) => `${p.label}:${"messageId" in p.before ? p.before.messageId : "branchId" in p.before ? p.before.branchId : p.before.stageStart}`;

/** 一块缩小后的样子：调用按这一次算性质、小圆点、标注（不是组里取最重的）；思考是思考的底色 */
function blockView(block: ZoomBlock): ZView {
  const group = { id: block.groupId, role: "step" as const };
  if (block.kind === "thinking") return { id: block.id, content: "thinking", kind: "step", tone: undefined, keyLine: block.keyLine, marks: [], error: false, nature: undefined, group };
  return { id: block.id, content: "tool", kind: "step", tone: block.tone, keyLine: block.keyLine, marks: block.marks, error: block.error, nature: toolNatureOf(block.call.part), group };
}

/**
 * 条目没变就不重画（缩放跨档、别的频道来了事件时，几百条不必每条都重画）。
 * 工具调用组画成两样（57 号票）：对话层那一行（性质、小圆点按组里最重的），和缩小后组里每次调用、每段思考各一块；
 * 哪样显示由 .zh 的 data-level 决定（zoom.css），同同类折叠的做法（对话层隐藏、缩小后逐条出现）
 */
const ZItem = memo(function ZItem({
  item,
  fresh,
  above,
  renderItem,
  renderBlock,
  decor,
  onOpenCard,
  onRollback,
  grp,
  onOpenBlock,
  strip,
  stub,
  bare = false,
}: {
  item: ChatItem;
  fresh: boolean;
  above: ReactNode;
  renderItem(item: ChatItem): ReactNode;
  renderBlock(block: ZoomBlock): ReactNode;
  decor: ZoomDecor | undefined;
  onOpenCard(card: ZoomLeftCard): void;
  /** 点了条左边的 ↶（150 号票）；不给（只读、不能回退的会话）就不画回退点 */
  onRollback: ((point: ZoomRollbackPoint) => void) | undefined;
  /** 在哪个阶段框里（91 号票） */
  grp?: ZGrp | undefined;
  /** 阶段框里点一次调用、一段思考：打开它的详情 */
  onOpenBlock?: ((id: string) => void) | undefined;
  /** 阶段框里的验收结论：画成一行横条，不画整张进度卡（93 号票） */
  strip?: VerdictStrip | undefined;
  /** ⑂ 点开要的（151 号票） */
  stub?: StubHost | undefined;
  /** 废弃分支预览里的一条（151 号票）：只有三层 */
  bare?: boolean;
}) {
  // memo 了：换了语言自己也要重画（168 号票）
  useLocale();
  const blocks = zoomBlocks(item);
  // 阶段框里的工具调用组（91 号票）：三档都画组里每一块，组那一行不画（.zi-boxrow / .zi-boxstep）
  const boxed = grp !== undefined && blocks.length > 0;
  // 左边的卡挂在这一条上；工具调用组缩小后那一行藏着，挂到组里第一块（卡只在缩小后看得见）。
  // 阶段框里的：框收着时、框里第一条的，挂在框上（阶段的第一条的、收着的阶段里每一条的都挂在框上）
  const left = grp && (!grp.open || grp.first === item.id) ? undefined : decor?.left.get(item.id);
  const onBox = (id: string) => grp !== undefined && (!grp.open || (grp.first === item.id && (id === item.id || id === blocks[0]?.id)));
  const sideOf = (id: string, withLeft: boolean): ZSide => ({
    repeat: decor?.repeats.get(id),
    left: withLeft ? left : undefined,
    stale: decor?.stale.has(id) ?? false,
    onOpenCard,
    // 阶段框里的（152 号票）：框收着时每一条的、展开时框里第一条的回退点和 ⑂ 挂在框上
    //（框里第一条是工具调用组时，它和组里第一块的都算第一条的）
    rollbacks: onRollback && !onBox(id) ? decor?.rollbacks.get(id) : undefined,
    forks: onBox(id) ? undefined : decor?.forks.get(id),
    onRollback: onRollback ?? (() => undefined),
    stub,
  });
  const view: ZView = {
    id: item.id,
    content: item.content,
    kind: item.kind,
    tone: item.tone,
    keyLine: item.keyLine,
    // 验收通过的不在右侧标、也没有小圆点（书脊变绿就是通过了）
    marks: sideMarks(item.marks),
    error: item.error,
    nature: chatItemNature(item),
    group: blocks.length > 0 ? { id: item.id, role: "row" } : undefined,
  };
  return (
    <>
      <ZItemView view={view} fresh={fresh} above={above} side={sideOf(item.id, blocks.length === 0)} extra={`${grpClass(grp, item.id)}${boxed ? " zi-boxrow" : ""}`} bare={bare}>
        {strip ? <VerdictStripView strip={strip} onDetail={onOpenBlock && (() => onOpenBlock(item.id))} /> : renderItem(item)}
      </ZItemView>
      {blocks.map((b, i) => (
        <ZItemView
          key={b.id}
          view={blockView(b)}
          fresh={false}
          above={null}
          side={sideOf(b.id, i === 0)}
          extra={boxed ? `${grpClass(grp, b.id)} zi-boxstep` : ""}
          onOpen={boxed && onOpenBlock ? () => onOpenBlock(b.id) : undefined}
          bare={bare}
        >
          {renderBlock(b)}
        </ZItemView>
      ))}
    </>
  );
});

/**
 * 阶段框在三档里是同一块（91 号票）：收着的阶段在三档里都只画这一块，条外的标注一类一条、指向框上那个图标；
 * 展开了，这一块只剩框头（对话层），要点层、全局层是写着"第 N 阶段 标题"的色块，下面逐条画每次操作
 */
function StageZ({
  box,
  open,
  above,
  left,
  rollbacks,
  undo,
  forks,
  stub,
  onRollback,
  onToggle,
  onStage,
  onNote,
  onOpenCard,
}: {
  box: StageBoxView;
  open: boolean;
  above: ReactNode;
  left: ZoomLeftCard | undefined;
  /** 挂在框上的回退点（152 号票）：收着时框里每一条的，展开时框里第一条的 */
  rollbacks: readonly ZoomRollbackPoint[];
  /** 框底部的"⟲ 撤回到这一阶段开始前"（框里哪一条上的都算）：这个阶段开始的那个回退点 */
  undo: ZoomRollbackPoint | undefined;
  /** 挂在框上的 ⑂（同回退点）：收着时框里每一条的，展开时框里第一条的 */
  forks: readonly ZoomFork[];
  stub: StubHost | undefined;
  onRollback: ((point: ZoomRollbackPoint) => void) | undefined;
  onToggle(id: string): void;
  onStage?: ((stageId: string) => void) | undefined;
  onNote(box: StageBoxView, note: StageNote): void;
  onOpenCard(card: ZoomLeftCard): void;
}) {
  return (
    <>
      {above}
      <div className={`zi zi-stage k-${box.kind}${open ? " zi-stage-open" : ""}${box.stale ? " zi-stale" : ""}`} data-stage={box.id}>
        <div className="zi-l0">
          <StageBox box={box} open={open} onToggle={() => onToggle(box.id)} onStage={onStage} undo={undo} onRollback={onRollback} />
        </div>
        <div className={`zi-l1 bg-${box.kind} n-${box.nature}`}>
          <div className="zi-cap">
            <div className="zi-title">{box.caption}</div>
          </div>
        </div>
        <div className={`zi-l2 bg-${box.kind} n-${box.nature}`} />
        {!open && box.notes.length > 0 && <StageNoteChips notes={box.notes} onOpen={(n) => onNote(box, n)} />}
        {(left || (onRollback && rollbacks.length > 0)) && (
          <div className="zd-left">
            {left && <LeftCardHead card={left} onOpen={onOpenCard} />}
            {onRollback &&
              rollbacks.map((p) => (
                <button
                  key={rollbackKey(p)}
                  type="button"
                  className="zd-rollback"
                  aria-label={p.label}
                  title={p.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRollback(p);
                  }}
                >
                  <span className="zd-rb-icon">↶</span>
                  <svg className="zd-rb-leader" aria-hidden="true">
                    <path />
                  </svg>
                </button>
              ))}
          </div>
        )}
        {forks.length > 0 && (
          <div className="zd-fork">
            {forks.map((f) =>
              stub ? (
                <AbandonedStub key={f.branchId} fork={f} host={stub} />
              ) : (
                <button key={f.branchId} type="button" className="zd-ab-dot" aria-label={t("ui.branches.abandoned")} title={t("ui.branches.abandoned")} onClick={(e) => e.stopPropagation()}>
                  ⑂
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * 底色块左缘的竖排标签（"任务 N · 这件事是什么"，编号竖排时正着写）：任务写"任务 N · 标题"（这个会话里的第几个），
 * 工单写"工单 N · 标题"（工单编号里的数），秘书主线的一天写"10月8日"
 */
function BandLabel({ band }: { band: ZoomBand }) {
  if (band.kind === "day")
    return (
      <b>
        <T k="ui.zoomHistory.bandDay" params={{ month: <span className="zh-band-no">{band.month}</span>, date: <span className="zh-band-no">{band.date}</span> }} />
      </b>
    );
  return (
    <>
      <b>
        <T k={band.kind === "task" ? "ui.zoomHistory.bandTask" : band.kind === "run" ? "ui.zoomHistory.bandRun" : "ui.zoomHistory.bandWorkOrder"} params={{ no: <span className="zh-band-no">{band.no}</span> }} />
      </b>
      {band.title && ` · ${band.title}`}
    </>
  );
}

/** 图例：六种内容类型；工具那一格放三块色样（只看 → 动手 → 删改）。画的时候现取（跟着当前语言；CONTENT_KIND_LABEL、TOOL_NATURE_LABEL 取值时才查，不能在模块顶层取） */
const legendKinds = () => Object.entries(CONTENT_KIND_LABEL) as [ContentKind, string][];
const naturesText = () => TOOL_NATURES.map((n) => TOOL_NATURE_LABEL[n]).join(" / ");

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
 * （风险标注那一段；分支面板、回退点另算）。
 * 108 号票二狗加了返回值：最后（最低）那条标注的下沿（内容坐标，未缩放）；对话层、没有标注是 -Infinity
 */
function layoutAnnotations(content: HTMLElement, ctl: ZoomController | null, viewport: HTMLElement | null): number {
  const level = ctl?.level ?? 0;
  const s = ctl?.s ?? 1;
  // 标注按这一档排版、再整体缩放，所以它们内部的长度单位是 DS 像素
  const DS = 0.45;
  const k = DS / s;
  // 展开的分支面板（151 号票）先摆：标注被它压住的要收窄、藏起来，要在排标注之前
  if (viewport) layoutPanels(content, viewport, DS);
  const contentTop = content.getBoundingClientRect().top;
  const cy = (clientY: number) => (clientY - contentTop) / s;
  // 风险标注：默认与"这条风险在原文里的那一行"水平对齐，箭头就是一条横线；
  // 只有上一条把它挤住时才往下让，让出来的部分靠斜线补，箭头指的点不变。
  // 先把要量的都量完、再一起写（边量边写的话，每写一次下一次量就得重新排版，几百条时捏合会卡）
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
  layoutRollbacks(content, level, s, k, DS);
  // 标注从上往下排、只往下让，最后一条最低
  return bottom;
}

/**
 * 展开的分支面板（151 号票）：挪到风险标注右侧，放不下就贴着视口右缘；
 * 挪完还被面板压住的标注收窄换行，连收窄都放不下的整条藏起来（只露半截残字比盖住更难看）。面板连同它上面那块头部
 * （分支名 + 切换按钮，绝对定位、不在面板的盒子里）一起算；压住面板的标注不一定在同一条上，纵向有交叠的都要躲开。
 * 标注的位置先全量完再一起写（逐个面板边量边写量到的位置也一样，只是慢）；没有展开的面板时只把上次留下的收窄、隐藏清掉
 */
function layoutPanels(content: HTMLElement, viewport: HTMLElement, DS: number) {
  const rights = [...content.querySelectorAll<HTMLElement>(".zd-right")];
  // 先按不受限的宽度量一遍，才能知道标注列实际有多宽
  for (const el of rights) el.style.removeProperty("--risk-max");
  const panels = [...content.querySelectorAll<HTMLElement>(".zd-abandoned")];
  if (panels.length === 0) {
    for (const el of rights) el.style.removeProperty("visibility");
    return;
  }
  for (const panel of panels) panel.style.setProperty("--ab-offset", "0px");
  const labels = [...content.querySelectorAll<HTMLElement>(".zd-right .zd-risk, .zd-right .zd-repeat")].map((el) => el.getBoundingClientRect());
  const vp = viewport.getBoundingClientRect();
  const offsets = panels.map((panel) => {
    const box = spanOf(panel);
    let labelsRight = box.left;
    for (const lr of labels) {
      if (lr.bottom <= box.top || lr.top >= box.bottom) continue;
      labelsRight = Math.max(labelsRight, lr.right);
    }
    const want = labelsRight + 14 - box.left;
    const room = vp.right - 10 - box.right;
    return Math.max(0, Math.min(want, room)) / DS;
  });
  panels.forEach((panel, i) => panel.style.setProperty("--ab-offset", `${offsets[i]}px`));
  const boxes = panels.map((panel) => {
    const b = spanOf(panel);
    return new DOMRect(b.left, b.top, b.right - b.left, b.bottom - b.top);
  });
  const MIN_LABEL = 72;
  const writes = rights.map((el) => {
    const r = el.getBoundingClientRect();
    const hit = boxes.find((p) => p.top < r.bottom && p.bottom > r.top && p.left < r.right);
    if (!hit) return () => el.style.removeProperty("visibility");
    const room = hit.left - r.left - 10;
    if (room < MIN_LABEL) return () => (el.style.visibility = "hidden");
    return () => {
      el.style.removeProperty("visibility");
      el.style.setProperty("--risk-max", `${room / DS}px`);
    };
  });
  for (const write of writes) write();
}

/** 面板连同它上面那块头部（分支名 + 切换按钮）一起算，头部是绝对定位，不在面板的盒子里 */
function spanOf(panel: HTMLElement) {
  const r = panel.getBoundingClientRect();
  const head = panel.querySelector<HTMLElement>(".zd-ab-head")?.getBoundingClientRect();
  if (!head) return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  return { left: Math.min(r.left, head.left), right: Math.max(r.right, head.right), top: Math.min(r.top, head.top), bottom: r.bottom };
}

/** 缩小后展开的分支面板最低的下沿（内容坐标，未缩放）：伸到最后一条下面的也要滚得到（108 号票的 sizer 裁掉了伸出去的）；对话层不算 */
function panelsBottom(content: HTMLElement, ctl: ZoomController | null): number {
  if (!ctl || ctl.level === 0) return -Infinity;
  let bottom = -Infinity;
  for (const panel of content.querySelectorAll<HTMLElement>(".zd-abandoned")) bottom = Math.max(bottom, panel.getBoundingClientRect().bottom);
  return Number.isFinite(bottom) ? (bottom - content.getBoundingClientRect().top) / ctl.s : -Infinity;
}

/** 书脊的宽度和离条的缝（zoom.css 的 .zh-spine 同一组数） */
const SPINE_W = 3;
const SPINE_GAP = 3;

/**
 * 撤回图标贴着条，用一条直线指到它撤回的那条分界线；挨太近时只向左让位，线随之变长（150 号票）。
 * 先全部清掉、一起量、再一起写（不逐个按钮清掉让位再量），结果不变（让位只把按钮往左挪，挪多少算得出来）
 */
function layoutRollbacks(content: HTMLElement, level: number, s: number, k: number, DS: number) {
  if (level === 0) return;
  const buttons = [...content.querySelectorAll<HTMLElement>(".zd-rollback")].filter(shown);
  for (const btn of buttons) btn.style.marginRight = "";
  // 有书脊时线停在书脊外沿
  const inset = content.dataset.spine ? SPINE_W + SPINE_GAP + 1 : 0;
  const a = 3.5 / DS;
  let prevBottom = -Infinity;
  let lane = 0;
  const writes = buttons.map((btn) => {
    const item = btn.closest<HTMLElement>(".zi")!;
    const top = item.offsetTop;
    lane = top - prevBottom < 22 / s ? lane + 1 : 0;
    prevBottom = top;
    const margin = 6 / DS + lane * (26 / DS);
    // 清掉让位时量的右缘，再按让位挪过去（按钮按 DS 像素排版，屏幕上一个 DS 像素是 s·k）
    const right = btn.getBoundingClientRect().right - margin * s * k;
    const it = item.getBoundingClientRect();
    const dx = (it.left - inset - right) / (s * k);
    return () => {
      btn.style.marginRight = `${margin}px`;
      const svg = btn.querySelector<SVGSVGElement>(".zd-rb-leader")!;
      svg.setAttribute("width", String(dx));
      svg.setAttribute("height", String(10 / DS));
      svg.setAttribute("viewBox", `0 ${-5 / DS} ${dx} ${10 / DS}`);
      svg.style.top = `calc(50% - ${5 / DS}px)`;
      svg.querySelector("path")!.setAttribute("d", `M0 0 H${dx - 1 / DS} M${dx - 1 / DS - a} ${-a} L${dx - 1 / DS} 0 L${dx - 1 / DS - a} ${a}`);
    };
  });
  for (const write of writes) write();
}

/** 这一档看得见的矩形（藏起来的没有盒子） */
const shown = (el: HTMLElement) => el.getClientRects().length > 0;

/**
 * 缩小后左侧的卡最低的下沿（内容坐标，未缩放；108 号票）：卡挂在它那一条的上沿，互相不避让，前面一张高的可能比最后一张伸得还低
 * （评审 2026-10-13），所以看得见的每一张都量。对话层看不见，不算（-Infinity）
 */
function leftCardsBottom(content: HTMLElement, ctl: ZoomController | null): number {
  if (!ctl || ctl.level === 0) return -Infinity;
  let bottom = -Infinity;
  for (const card of content.querySelectorAll<HTMLElement>(".zd-left")) {
    if (shown(card)) bottom = Math.max(bottom, card.getBoundingClientRect().bottom);
  }
  return Number.isFinite(bottom) ? (bottom - content.getBoundingClientRect().top) / ctl.s : -Infinity;
}

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

/**
 * 书脊、底色块的上下沿落在哪一块上：条目 id 对到它的矩形；工具调用组在缩小后那一行藏着，
 * 上沿对到组里第一块、下沿对到最后一块（57 号票：组只存在于对话层）
 */
function edgeEl(content: HTMLElement, id: string, at: "top" | "bottom"): HTMLElement | null {
  // 阶段框那一块（91 号票：sbox:<组的 id>）
  if (id.startsWith(STAGE_BOX_EDGE)) return content.querySelector<HTMLElement>(`:scope > .zi-stage[data-stage="${CSS.escape(id.slice(STAGE_BOX_EDGE.length))}"]`);
  const row = content.querySelector<HTMLElement>(`:scope > .zi[data-chat-id="${CSS.escape(id)}"]`);
  if (row && shown(row)) return row;
  const steps = [...content.querySelectorAll<HTMLElement>(`:scope > .zi-step[data-group="${CSS.escape(id)}"]`)].filter(shown);
  return (at === "top" ? steps[0] : steps.at(-1)) ?? null;
}

/**
 * 把每块底色摆到它起止两条之间（内容坐标，跟着内容一起缩放）。竖直方向各向外让出半个条目间距，相邻两段之间留一条缝。
 * 书脊贴着条，从这一段第一条的上沿到最后一条的下沿；段与段之间的缝由 CSS 的透明边框留
 */
function placeBands(content: HTMLElement) {
  for (const band of content.querySelectorAll<HTMLElement>(":scope > .zh-band")) {
    const first = edgeEl(content, band.dataset.first!, "top");
    const last = edgeEl(content, band.dataset.last!, "bottom");
    if (!first || !last) {
      band.style.display = "none";
      continue;
    }
    const top = first.offsetTop - 4;
    band.style.display = "";
    band.style.top = `${top}px`;
    band.style.height = `${last.offsetTop + last.offsetHeight + 4 - top}px`;
  }
  for (const sp of content.querySelectorAll<HTMLElement>(":scope > .zh-spine")) {
    const first = edgeEl(content, sp.dataset.first!, "top");
    const last = edgeEl(content, sp.dataset.last!, "bottom");
    if (!first || !last) {
      sp.style.display = "none";
      continue;
    }
    sp.style.display = "";
    // 内容区有内边距，条不从 0 开始：贴着条的实际左缘
    sp.style.left = `${first.offsetLeft}px`;
    sp.style.top = `${first.offsetTop}px`;
    sp.style.height = `${last.offsetTop + last.offsetHeight - first.offsetTop}px`;
  }
}

/**
 * 底色块左缘的竖排标签、书脊的阶段名：在屏幕上露出的那一段里居中，所以每帧跟着滚动和缩放重新摆（一个 rAF 循环，
 * 书脊名避让撤回箭头的那部分二狗没有）
 */
function placeLabels(root: HTMLElement, content: HTMLElement, vp: HTMLElement, layer: HTMLElement, s: number) {
  // 对话层且没在缩放：底色本来就不显示，不用摆
  if (root.style.getPropertyValue("--o0") === "1.000") return;
  const rr = root.getBoundingClientRect();
  const v = vp.getBoundingClientRect();
  for (const label of layer.children as HTMLCollectionOf<HTMLElement>) {
    const band = content.querySelector<HTMLElement>(`:scope > .zh-band[data-band="${CSS.escape(label.dataset.band!)}"]`);
    const r = band && band.style.display !== "none" ? band.getBoundingClientRect() : undefined;
    const top = r ? Math.max(r.top, v.top) : 0;
    const h = r ? Math.min(r.bottom, v.bottom) - top : 0;
    // 露出来的一段太短就不硬塞
    if (!r || h < 48) {
      label.style.visibility = "hidden";
      continue;
    }
    label.style.visibility = "";
    label.style.maxHeight = `${h - 16}px`;
    label.style.transform = `translate(${Math.max(r.left, v.left) - rr.left}px, ${top - rr.top + (h - label.offsetHeight) / 2}px)`;
  }
  // 书脊的阶段名：写在色条左边、这一段露出部分的中间（分界线上挂着撤回箭头，放中间基本碰不到）。
  // 从上往下摆：和上一个名字、撤回箭头那一行挤住了就往下让；让到离这一段太远还放不下，就不写（150 号票起避让撤回箭头）
  const arrows = [...content.querySelectorAll<HTMLElement>(".zd-rollback")].map((b) => {
    const r = b.getBoundingClientRect();
    return { top: r.top - 2, bottom: r.bottom + 2 };
  });
  let lastBottom = -Infinity;
  for (const name of content.querySelectorAll<HTMLElement>(":scope > .zh-spine > .zh-spine-id")) {
    const r = name.parentElement!.getBoundingClientRect();
    const top = Math.max(r.top, v.top);
    const bottom = Math.min(r.bottom, v.bottom);
    const lh = name.offsetHeight * s;
    let y = (top + bottom) / 2 - lh / 2;
    const blocks = [{ top: -Infinity, bottom: lastBottom + 2 }, ...arrows];
    for (let i = 0; i < 4; i++) {
      const hit = blocks.find((a) => y < a.bottom && y + lh > a.top);
      if (!hit) break;
      y = hit.bottom;
    }
    // 露不出来、或者被挤得离开这一段一半以上：不写
    if (bottom - top <= 0 || y + lh / 2 > bottom + lh / 2 || blocks.some((a) => y < a.bottom && y + lh > a.top)) {
      name.style.visibility = "hidden";
      continue;
    }
    name.style.visibility = "";
    name.style.transform = `translateY(${(y - r.top) / s}px)`;
    lastBottom = y + lh;
  }
}

/** 视口里的高度：屏幕坐标换成离视口顶多远 */
const viewportY = (viewport: HTMLElement, clientY: number) => clientY - viewport.getBoundingClientRect().top;

/** 离底部不到 24px 算停在最新一条（108 号票起和 ↓ 共用状态层的 atLatest，数不变） */
const atBottom = (el: HTMLElement) => atLatest(el);

/** 会话历史告诉 ↓ 现在怎样：离开了底部没有、现在最后一条是哪条、手里最大的序号（停在底部时才给，118 号票） */
interface JumpHandle {
  check(away: boolean, lastId: string | undefined, seq: number | undefined): void;
}

/**
 * "回到最新"的 ↓（108 号票，规矩在 state/scroll-end.ts）：离开底部才出，淡入淡出；离开底部期间新到了消息写条数，
 * 只多了思考、工具调用标一个圆点。出没出、停在底部时的最后一条记在它自己这里：滚动时只重画这一个按钮，不重画整个会话
 */
const JumpToLatest = forwardRef<JumpHandle, { items: readonly ChatItem[]; onJump(): void }>(function JumpToLatest({ items, onJump }, ref) {
  const [on, setOn] = useState(false);
  /** 最后一次停在底部时最后一条的 id 和那时手里最大的序号：离开底部之后新到的从它后面算（state 的 newSince） */
  const [seenId, setSeenId] = useState<string | undefined>(() => items.at(-1)?.id);
  const [seenSeq, setSeenSeq] = useState<number | undefined>(() => maxSeq(items));
  useImperativeHandle(ref, () => ({
    check(away, lastId, seq) {
      setOn(away);
      if (!away) {
        setSeenId(lastId);
        setSeenSeq(seq);
      }
    },
  }), []);
  const badge = on ? jumpBadge(items, seenId, seenSeq) : undefined;
  return (
    <button
      type="button"
      className="zh-jump"
      data-shown={on ? "1" : undefined}
      tabIndex={on ? undefined : -1}
      aria-hidden={on ? undefined : true}
      aria-label={badge && badge !== "dot" ? t("ui.zoomHistory.jumpLatestNew", { count: badge.count }) : t("ui.zoomHistory.jumpLatest")}
      title={t("ui.zoomHistory.jumpLatest")}
      onClick={onJump}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 3.5v12M4.5 10l5.5 5.5 5.5-5.5" />
      </svg>
      {badge === "dot" ? <span className="zh-jump-dot" /> : badge && <span className="zh-jump-n">{badge.count}</span>}
    </button>
  );
});

export const ZoomHistory = forwardRef<ZoomHistoryHandle, Props>(function ZoomHistory(props, ref) {
  const { items, older, onFocusChat, onLevelChange, onZoomTap, renderItem, renderBlock, above, isFresh, decor, onDetail, boxes, onStage, branches, currentBranch } = props;
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
  const detailCb = useRef(onDetail);
  // 阶段框（91 号票）：每条在哪个框里、哪几个框展开着
  const groupOf = useMemo(() => new Map((boxes ?? []).flatMap((g) => g.ids.map((id) => [id, g] as const))), [boxes]);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const groupOfRef = useRef<ReadonlyMap<string, StageGroup>>(groupOf);
  useLayoutEffect(() => {
    focusCb.current = onFocusChat;
    levelCb.current = onLevelChange;
    itemsRef.current = items;
    olderRef.current = older;
    detailCb.current = onDetail;
    groupOfRef.current = groupOf;
  });
  /** 让某条历史在对话层看得见：它在收着的框里，就先同步展开 */
  const openGroupOf = useCallback((chatId: string) => {
    const g = groupOfRef.current.get(chatId);
    if (!g) return;
    flushSync(() => setOpenGroups((s) => (s.has(g.id) ? s : new Set(s).add(g.id))));
  }, []);
  const toggleGroup = useCallback((id: string) => {
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);
  const openBlock = useCallback((id: string) => detailCb.current?.(id), []);
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
      // 对话层里的阶段框：算它最后一件事（91 号票）
      for (const el of content.querySelectorAll<HTMLElement>(".zi[data-chat-id], .sbox[data-focus-id]")) {
        if (el.getBoundingClientRect().bottom >= y) {
          pick = el.dataset.chatId ?? el.dataset.focusId;
          break;
        }
      }
      focusCb.current(pick, atBottom(vp));
    });
  }, []);

  // ── 滚到底（108 号票）：缩小后伸到最后一条下面的标注、卡算进滚动范围；"回到最新"的 ↓ 什么时候出、上面标什么 ──
  /** 缩小后条外的东西最低的下沿（内容坐标）：对话层、一条都没有是 -Infinity */
  const sideBottomRef = useRef(-Infinity);
  /** 按现在的内容高度、条外伸出去的那一截撑滚动范围（原来是 setContentHeight(内容高, 0)） */
  const fitHeight = useCallback(() => {
    const ctl = ctlRef.current;
    const content = contentRef.current;
    if (!ctl || !content) return;
    const h = content.offsetHeight;
    ctl.setContentHeight(h, zoomedOutTail(sideBottomRef.current, h, ctl.s));
  }, []);
  /** 两侧标注重新排版（原来直接调 layoutAnnotations），滚动范围跟着改。先量左侧的卡、内容高，layoutAnnotations 先量后写：只排一次版 */
  const layoutSides = useCallback(() => {
    const ctl = ctlRef.current;
    const content = contentRef.current;
    if (!content) return;
    const h = content.offsetHeight;
    const left = leftCardsBottom(content, ctl);
    sideBottomRef.current = Math.max(left, layoutAnnotations(content, ctl, viewportRef.current), panelsBottom(content, ctl));
    if (ctl) ctl.setContentHeight(h, zoomedOutTail(sideBottomRef.current, h, ctl.s));
  }, []);
  const jumpRef = useRef<JumpHandle>(null);
  /** 滚动、内容变了、可视区变了、缩放停稳之后看一眼：离开了底部就出 ↓；停在底部记下现在的最后一条 */
  const checkJump = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const away = jumpToLatestShown(vp);
    jumpRef.current?.check(away, itemsRef.current.at(-1)?.id, away ? undefined : maxSeq(itemsRef.current));
  }, []);
  /** 点了 ↓、正滑向底部（到了底部、往上滚了、手指或滚轮一动、定位或缩放就不算了：状态层的 afterScroll） */
  const jumpingRef = useRef(false);
  /** 上一次滚动停在哪：看是不是往上滚了 */
  const lastTopRef = useRef(0);
  /** 点 ↓：滚到最新一条，接着跟最新的走（和自己发了消息之后一样）；缩小着的就滚到这一档的底 */
  const jumpToLatest = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    followRef.current = true;
    jumpingRef.current = true;
    lastTopRef.current = vp.scrollTop;
    vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
  }, []);

  // ── 废弃分支（151 号票）：⑂ 展开的预览、切换的双向动画 ──
  const [swap, setSwap] = useState<SwapState | undefined>(undefined);
  const [swapOn, setSwapOn] = useState(false);
  /** 切换已经发出、等新布局：从哪一块之后是要换掉的那一段（anchorId）、量好的当前这一段、切到哪条 */
  const swapPending = useRef<{ anchorId?: string | undefined; node: Rect; from: Rect; cur: SwapCol; branchId: string } | undefined>(undefined);
  const switchToRef = useRef(branches?.switchTo);
  useLayoutEffect(() => {
    switchToRef.current = branches?.switchTo;
  });
  /** 动画收掉：真实的那一段重新露出来 */
  const endSwap = useCallback(() => {
    const content = contentRef.current;
    if (content) for (const el of content.querySelectorAll<HTMLElement>("[data-tail]")) el.removeAttribute("data-tail");
    rootRef.current?.removeAttribute("data-swapping");
    setSwap(undefined);
    setSwapOn(false);
  }, []);
  /** 把某条废弃分支换成当前分支：先量下现在这一段，切换后倒着放动画 */
  const switchBranch = useCallback(
    (branchId: string, node: Rect, from: Rect, itemEl: HTMLElement) => {
      const root = rootRef.current;
      const switchTo = switchToRef.current;
      if (!root || !switchTo) return;
      const rr = root.getBoundingClientRect();
      // 只数主干上的块：展开的分支预览复用了同一套 .zi（全数的话会把预览里的也数进去）
      const all = [...(contentRef.current?.querySelectorAll<HTMLElement>(":scope > .zi") ?? [])].filter(shown);
      const idx = all.indexOf(itemEl);
      const tail = idx >= 0 ? all.slice(idx) : all;
      const cur = measureCol(tail, rr, "c");
      // 切不成（守护进程拒了、秘书没停下来）：动画收掉，原因进顶上的失败提示
      const failed = () => {
        if (swapPending.current?.branchId !== branchId) return;
        swapPending.current = undefined;
        endSwap();
      };
      if (!cur) {
        switchTo(branchId).catch(() => undefined);
        return;
      }
      // 预览条原样量下来：切换前后由它做衔接，不会闪（一处展开了几条时量点的那一条；缩小后藏着的工具调用组那一行不算）
      const panel = itemEl.querySelector<HTMLElement>(`.zd-abandoned[data-branch="${CSS.escape(branchId)}"]`);
      const preview = panel ? measureCol([...panel.querySelectorAll<HTMLElement>(".zd-ab-strip .zi")].filter(shown), rr, "p") : undefined;
      // 先切换、等真实布局出来再倒着放动画，这样动画结束的画面就是最终画面
      const pending = {
        anchorId: idx > 0 ? blockKey(all[idx - 1]!) : undefined,
        node: { left: node.left - rr.left, top: node.top - rr.top, width: node.width },
        from: preview?.box ?? { left: from.left - rr.left, top: from.top - rr.top, width: from.width },
        cur,
        branchId,
      };
      swapPending.current = pending;
      for (const el of tail) el.dataset.tail = "1";
      root.dataset.swapping = "1";
      setSwapOn(false);
      setSwap({ node: pending.node, from: pending.from, cur, next: preview });
      switchTo(branchId).catch(failed);
    },
    [endSwap],
  );

  const pinchRef = useRef({ s0: 1, focalY: 0, contentY: 0 });
  const [level, setLevel] = useState<ZoomLevel>(0);
  /** 点了左边的任务卡、工单卡：弹出这件事的完整情况（55 号票） */
  const [openCard, setOpenCard] = useState<ZoomLeftCard | undefined>(undefined);
  /** 点了哪个 ↶（150 号票）：弹出回退确认 */
  const [rollbackAt, setRollbackAt] = useState<ZoomRollbackPoint | undefined>(undefined);
  const onRollback = props.rollbackIn === undefined ? undefined : setRollbackAt;
  const spines = decor?.spines;
  // 书脊、底色带的上下沿落在哪一块上：收着的框里的事落在框上（91 号票）
  const edge = (id: string, at: "top" | "bottom") => (boxes ? stageBoxEdge(groupOf, openGroups, id, at) : id);
  const shownSpines = useMemo(() => (boxes && spines ? stageBoxSpines(spines, groupOf, openGroups) : (spines ?? [])), [boxes, spines, groupOf, openGroups]);
  // 每个框：展开没有、框里第一行和最后一行（工具调用组拆成每次调用之后的）、第一条、完成情况
  const grpInfo = useMemo(() => {
    const byId = new Map(items.map((it) => [it.id, it]));
    const out = new Map<string, ZGrp>();
    for (const g of boxes ?? []) {
      const rows = stageBoxRows(g.ids.flatMap((id) => byId.get(id) ?? []));
      out.set(g.id, { open: openGroups.has(g.id), start: rows[0], end: rows.at(-1), first: g.ids[0]!, cls: g.status.cls });
    }
    return out;
  }, [boxes, items, openGroups]);
  /** 收着的框条外的标注：说的是一件事进那一件的详情，合起来的好几件进这个阶段的详情 */
  const openNote = useCallback(
    (box: StageBoxView, note: StageNote) => {
      if (note.items.length === 1) onDetail?.(note.items[0]!);
      else if (box.stageId !== undefined && onStage) onStage(box.stageId);
      else if (box.ids[0]) onDetail?.(box.ids[0]);
    },
    [onDetail, onStage],
  );

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
    fitHeight();
    programmaticRef.current = true;
    vp.scrollTop = (el.offsetTop + el.offsetHeight) * ctl.s - a.bottom;
  }, [items, loading, fitHeight]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const content = contentRef.current!;
    const ctl = new ZoomController(viewport, sizerRef.current!, content, rootRef.current!);
    ctlRef.current = ctl;
    // 缩放停稳：两侧标注重新避让排版；缩小状态下停稳时已经在顶上（整页都放得下、滚不动），照样取更早的一页（二狗）
    ctl.onSettle = () => {
      zoomingRef.current = false;
      placeBands(content);
      layoutSides();
      checkJump();
      if (ctl.level > 0 && viewport.scrollTop < LOAD_OLDER_WITHIN_PX) loadOlder();
    };
    // 每一帧排标注，滚动范围跟着改（108 号票：缩小后被挤到最后一条下面的标注算进去）
    ctl.onScale = () => layoutSides();
    // 跨过对话层那一档时布局会变（57 号票：工具调用组对话层一行、缩小后逐次画）：焦点那一点换算到新布局里，内容不在手指下面跳走。
    // 滚动范围先按新的内容高度撑出来，再放焦点
    ctl.onLevelLayout = (contentY) => {
      const anchor = captureAnchor(content, contentY);
      return () => {
        fitHeight();
        // 底色带、书脊的起止落在组上的，跟着换到这一档看得见的那几块（55 号票）
        placeBands(content);
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
      fitHeight();
      programmaticRef.current = true;
      ctl.set(PRESETS[start], viewport.clientHeight, content.offsetHeight);
    }
    // 内容高度变化（新消息、流式输出）→ 更新滚动范围；对话层且在底部时跟随到底
    const ro = new ResizeObserver(() => {
      placeBands(content);
      fitHeight();
      if (followRef.current && !touchingRef.current && ctl.level === 0 && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1) {
        programmaticRef.current = true;
        viewport.scrollTop = viewport.scrollHeight;
      }
      reportFocus();
      // 没跟着到底的（缩小着、手指按着、往上翻着）：新到的在下面，↓ 出来（108 号票）
      checkJump();
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
      checkJump();
    });
    ro2.observe(viewport);
    return () => {
      off();
      ro.disconnect();
      ro2.disconnect();
      ctl.dispose();
    };
  }, [reportFocus, loadOlder, fitHeight, layoutSides, checkJump]);

  // 每次渲染之后（条目变了、换了档、装饰变了）：内容多的条重新量，底色带和书脊重新摆，两侧标注重新避让排版（滚动范围跟着改，108 号票）
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    markLong(content);
    placeBands(content);
    layoutSides();
  });

  // 切换后的新分支渲染出来了：量到真实几何，再把两条条互换（还要等当前分支变成切过去的那条，151 号票）
  useLayoutEffect(() => {
    const p = swapPending.current;
    const content = contentRef.current;
    const root = rootRef.current;
    if (!p || !content || !root || items.length === 0 || currentBranch !== p.branchId) return;
    // 只数主干上的块：展开的分支预览复用了同一套 .zi，必须挡在外面
    const all = [...content.querySelectorAll<HTMLElement>(":scope > .zi")].filter((el) => !el.dataset.tail && shown(el));
    const at = p.anchorId ? all.findIndex((el) => blockKey(el) === p.anchorId) : -1;
    const tail = all.slice(at + 1);
    const next = measureCol(tail, root.getBoundingClientRect(), "n");
    if (!next) return;
    swapPending.current = undefined;
    for (const el of tail) el.dataset.tail = "1";
    setSwap({ node: p.node, from: p.from, cur: p.cur, next });
    requestAnimationFrame(() => requestAnimationFrame(() => setSwapOn(true)));
    // 比动画本身（--zswap-dur 0.9s）略长，免得最后一帧被掐掉
    window.setTimeout(endSwap, 1050);
  }, [items, currentBranch, endSwap]);

  // ⑂ 点开要的（151 号票）：预览按主线同一套 ZItem 画（去掉条外的装饰）；展开收起之后底色带、两侧标注重新摆
  const relayout = useCallback(() => {
    const content = contentRef.current;
    if (content) placeBands(content);
    layoutSides();
  }, [layoutSides]);
  const noCard = useCallback(() => undefined, []);
  /** 阶段框里一条在缩小后的几块（152 号票：挂到框上的回退点、⑂ 从这几块上取）：它自己，工具调用组连同组里每一块（all）或第一块 */
  const memberIds = (id: string, all: boolean) => {
    const member = items.find((x) => x.id === id);
    const blocks = member ? zoomBlocks(member).map((b) => b.id) : [];
    return [id, ...(all ? blocks : blocks.slice(0, 1))];
  };
  const stub = useMemo<StubHost | undefined>(
    () =>
      branches && {
        conversation: branches.conversation,
        renderItems: (list) =>
          list.map((it) => (
            <ZItem key={it.id} item={it} fresh={false} above={null} renderItem={renderItem} renderBlock={renderBlock} decor={undefined} onOpenCard={noCard} onRollback={undefined} bare />
          )),
        onOpen: branches.open,
        onSwitch: branches.switchTo ? switchBranch : undefined,
        onLayout: relayout,
      },
    [branches, renderItem, renderBlock, noCard, switchBranch, relayout],
  );

  // 底色块的竖排标签、书脊的阶段名：每帧摆到露出那一段的中间（rAF 循环；对话层停着时直接跳过）
  const bandLabelsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = rootRef.current;
      const content = contentRef.current;
      const vp = viewportRef.current;
      const layer = bandLabelsRef.current;
      if (root && content && vp && layer) placeLabels(root, content, vp, layer, ctlRef.current?.s ?? 1);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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
      // 换档不算还在往底部滑（108 号票）
      jumpingRef.current = false;
      const focalY = viewportRef.current!.clientHeight / 2;
      ctl.animateTo(PRESETS[l], ctl.contentYAt(focalY), focalY);
    },
    reveal(chatId) {
      // 存的 id 可能是组原来的 id、组里某一步的 id：一律经 locateChatItem 找到现在的那一条
      const found = locateChatItem(itemsRef.current, chatId);
      // 在收着的阶段框里：先同步展开（91 号票）
      if (found) openGroupOf(found.item.id);
      const content = contentRef.current;
      const row = found && content ? content.querySelector<HTMLElement>(`.zi[data-chat-id="${CSS.escape(found.item.id)}"]`) : null;
      if (!found || !content || !row) return;
      // 二狗：组里的某一步（56 号票的详情里点的是一次调用、一段思考）定位到那一步、闪那一步；别的定位到整条、闪整条
      const stepId = found.call?.id ?? (chatId !== found.item.id ? chatId : undefined);
      // 57 号票：缩小着的时候组那一行藏着，组里每一步各是一块——从那一块（找不到就是组里第一块）放大回去，跨档时焦点换算到组那一行
      const block = shown(row)
        ? null
        : (content.querySelector<HTMLElement>(`.zi-step[data-chat-id="${CSS.escape(stepId ?? "")}"]`) ?? content.querySelector<HTMLElement>(`.zi-step[data-group="${CSS.escape(found.item.id)}"]`));
      // 阶段框里的工具调用组（91 号票）：组那一行三档都不画，定位到那一块（没给哪一步的是第一块）
      const boxedBlock = row.classList.contains("zi-boxrow")
        ? (content.querySelector<HTMLElement>(`.zi-step[data-chat-id="${CSS.escape(stepId ?? "")}"]`) ?? content.querySelector<HTMLElement>(`.zi-step[data-group="${CSS.escape(found.item.id)}"]`))
        : null;
      const el = block ?? boxedBlock ?? row;
      const step = stepId === undefined || block || boxedBlock ? null : row.querySelector<HTMLElement>(`.zi-l0 [data-item="${CSS.escape(stepId)}"]`);
      const ctl = ctlRef.current!;
      const vp = viewportRef.current!;
      followRef.current = false;
      // 定位到别处：点过 ↓ 也不算还在往底部滑了（108 号票）
      jumpingRef.current = false;
      const toY = vp.clientHeight * 0.3;
      // 要放到 toY 的那一点在内容里的高度（未缩放）：整条是它的 offsetTop，某一步按屏幕位置换算
      const top = step ? (step.getBoundingClientRect().top - content.getBoundingClientRect().top) / ctl.s : el.offsetTop;
      // 缩小着的：以它为焦点放大回对话层，同时滑到 toY；已在对话层：滚过去
      if (ctl.level === 0) vp.scrollTo({ top: top * ctl.s - toY, behavior: "smooth" });
      else {
        zoomingRef.current = true;
        ctl.animateTo(1, top, top * ctl.s - vp.scrollTop, toY);
      }
      // 闪一下：底色之外加一圈同色外框（56 号票第 10 条，用户认可：二狗的气泡、工具行自己有底色，光闪底色看不见）。
      // 从缩小后的一块放大回去的，闪的是对话层里组那一行
      const flashed = boxedBlock ?? row;
      flashFrame(step ?? flashed.querySelector<HTMLElement>(".zi-l0") ?? flashed);
    },
    followLatest() {
      followRef.current = true;
    },
  }), [openGroupOf]);

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
      // 两侧标注里的按钮自己处理点击；展开的分支预览（151 号票）点了打开分支详情，不放大挂着它的那一条
      if ((e.target as HTMLElement).closest("button, .zd-fork")) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-chat-id], [data-stage]");
      if (!el) return;
      // 放大回去看点的那一块：点过 ↓ 也不算还在往底部滑了（108 号票）
      jumpingRef.current = false;
      // 点的是阶段框那一块（91 号票）：放大回对话层，闪一下
      if (el.dataset.stage) {
        followRef.current = false;
        zoomingRef.current = true;
        const focalY = viewportY(vp, e.clientY);
        ctl.animateTo(1, ctl.contentYAt(focalY), focalY, Math.min(focalY, vp.clientHeight * 0.4));
        flash(el);
        return;
      }
      const id = el.dataset.chatId;
      if (!id) return;
      const group = el.classList.contains("zi-step") ? el.dataset.group : undefined;
      const item = items.find((x) => x.id === (group ?? id));
      if (!item) return;
      followRef.current = false;
      zoomingRef.current = true;
      const focalY = viewportY(vp, e.clientY);
      const contentY = ctl.contentYAt(focalY);
      ctl.animateTo(1, contentY, focalY, Math.min(focalY, vp.clientHeight * 0.4));
      // 阶段框里的组那一行三档都不画（91 号票）：闪点中的那一块
      flash((group && content.querySelector<HTMLElement>(`.zi-grouprow:not(.zi-boxrow)[data-group="${CSS.escape(group)}"]`)) || el);
      onZoomTap?.(id, item.detail !== undefined);
    },
    [items, onZoomTap],
  );

  return (
    <div className="zh" ref={rootRef} data-level={level}>
      {/* 可视区那一块（108 号票）：只为把 ↓ 贴在可视区右下角；输入框和它上面的东西都在下面的 .zh-footer 里，↓ 自然在它们上面 */}
      <div className="zh-main">
        <div
          className="zh-viewport"
          ref={viewportRef}
          onScroll={(e) => {
            reportFocus();
            checkJump();
            const el = e.currentTarget;
            // 往上翻（二狗）：滚到顶附近取更早的一页（任何一档都一样）；程序滚的、缩放中的不算
            const programmatic = programmaticRef.current;
            if (!programmatic && el.scrollTop < LOAD_OLDER_WITHIN_PX && el.scrollHeight > el.clientHeight) loadOlder();
            // 点了 ↓ 正滑过去：一路都算跟着最新的走（中途来了新的，接着跟到底）；到了底部、往上滚了就不算了。
            // 程序滚的也要看（滑的途中内容变高，跟随最新一条一下滚到底），所以放在下面提前返回之前（108 号票，评审）
            const glide = afterScroll(jumpingRef.current, lastTopRef.current, el);
            jumpingRef.current = glide.jumping;
            lastTopRef.current = el.scrollTop;
            if (programmatic) {
              programmaticRef.current = false;
              return;
            }
            followRef.current = glide.follow;
          }}
          onTouchStart={() => {
            touchingRef.current = true;
            jumpingRef.current = false;
          }}
          onTouchMove={() => {
            followRef.current = false;
          }}
          onTouchEnd={(e) => {
            touchingRef.current = false;
            followRef.current = atBottom(e.currentTarget);
          }}
          onWheel={(e) => {
            jumpingRef.current = false;
            if (e.deltaY < 0) followRef.current = false;
          }}
        >
          <div className="zh-sizer" ref={sizerRef}>
            <div className="zh-content" ref={contentRef} data-spine={shownSpines.length > 0 ? "1" : undefined} onClickCapture={level > 0 ? onContentClick : undefined}>
              {props.head}
              {items.length === 0 && props.empty}
              {/* 底色带、书脊：放在内容里跟着一起缩放，起止由 placeBands 摆（55 号票） */}
              {decor?.bands.map((b) => (
                <div key={b.key} className="zh-band" data-band={b.key} data-first={edge(b.firstId, "top")} data-last={edge(b.lastId, "bottom")} data-n={b.index % 2} />
              ))}
              {shownSpines.map((sp) => (
                <div key={sp.key} className={`zh-spine sp-${sp.state}`} data-first={sp.firstId} data-last={sp.lastId} title={t("ui.zoomHistory.spineTitle", { stage: sp.label, state: SPINE_STATE_LABEL[sp.state] })}>
                  <span className="zh-spine-id">{sp.label}</span>
                </div>
              ))}
              {items.map((it, i) => {
                const g = groupOf.get(it.id);
                const gOpen = g !== undefined && openGroups.has(g.id);
                const sep = above?.(it, i);
                const zi = (
                  <ZItem
                    key={it.id}
                    item={it}
                    fresh={isFresh?.(it, i) ?? false}
                    // 框里第一条的日期分隔线画在框上面；收着的框里别的条的不画
                    above={g && (g.ids[0] === it.id || !gOpen) ? null : sep}
                    renderItem={renderItem}
                    renderBlock={renderBlock}
                    decor={decor}
                    onOpenCard={setOpenCard}
                    onRollback={onRollback}
                    grp={g && grpInfo.get(g.id)}
                    onOpenBlock={openBlock}
                    strip={g?.strips.get(it.id)}
                    stub={stub}
                  />
                );
                if (!g || g.ids[0] !== it.id) return zi;
                // 框上挂的左侧卡：展开着的是第一条的，收着的是框里各条的第一张
                const left = (gOpen ? [g.ids[0]!] : g.ids).map((id) => decor?.left.get(id)).find((c) => c !== undefined);
                // 挂在框上的回退点、⑂（152 号票）：收着时框里每一条（连同组里每一块）的，展开时框里第一条（是工具调用组的
                // 连同组里第一块）的；框底部的"撤回到这一阶段开始前"框里哪一条上的都算
                const liftedIds = (gOpen ? [g.ids[0]!] : g.ids).flatMap((id) => memberIds(id, !gOpen));
                const lifted = liftedIds.flatMap((x) => decor?.rollbacks.get(x) ?? []);
                const liftedForks = liftedIds.flatMap((x) => decor?.forks.get(x) ?? []);
                const undo = g.ids
                  .flatMap((id) => memberIds(id, true))
                  .flatMap((x) => decor?.rollbacks.get(x) ?? [])
                  .find((p) => p.stage !== undefined && p.stage.stageId === g.stageId);
                return (
                  <Fragment key={it.id}>
                    <StageZ
                      box={g}
                      open={gOpen}
                      above={sep}
                      left={left}
                      rollbacks={lifted}
                      undo={undo}
                      forks={liftedForks}
                      stub={stub}
                      onRollback={onRollback}
                      onToggle={toggleGroup}
                      onStage={onStage}
                      onNote={openNote}
                      onOpenCard={setOpenCard}
                    />
                    {zi}
                  </Fragment>
                );
              })}
              {props.tail}
              {props.future}
            </div>
          </div>
        </div>
        <JumpToLatest ref={jumpRef} items={items} onJump={jumpToLatest} />
      </div>
      {swap && <SwapOverlay swap={swap} on={swapOn} />}
      {openCard && <LeftCardDialog card={openCard} items={items} onPlan={onDetail} onClose={() => setOpenCard(undefined)} />}
      {rollbackAt && props.rollbackIn !== undefined && <RollbackDialog conversation={props.rollbackIn} point={rollbackAt} onClose={() => setRollbackAt(undefined)} />}
      <div className="zh-band-labels" ref={bandLabelsRef} aria-hidden="true">
        {decor?.bands.map((b) => (
          <div key={b.key} className="zh-band-label" data-band={b.key}>
            <BandLabel band={b} />
          </div>
        ))}
      </div>
      <div className="zh-footer">
        {props.footer}
        <div className="zh-legend">
          {boxes && <StageNoteLegend boxes={boxes} />}
          {shownSpines.length > 0 && (
            <span title={t("ui.zoomHistory.legendSpineTitle")}>
              <i className="sp-ok" />
              <i className="sp-retry" />
              <i className="sp-live" />
              <i className="sp-off" />
              {t("ui.zoomHistory.legendStages")}
            </span>
          )}
          {legendKinds().map(([k, label]) =>
            k === "tool" ? (
              <span key={k} title={t("ui.zoomHistory.legendToolTitle", { natures: naturesText() })}>
                {TOOL_NATURES.map((n) => (
                  <i key={n} className={`bg-tool n-${n}`} />
                ))}
                {t("ui.zoomHistory.legendTool", { label, natures: naturesText() })}
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
