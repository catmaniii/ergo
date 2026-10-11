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
 * 阶段框折叠、固定计划的"接下来的计划"虚线框属于两种任务的界面。
 * 写法上为了过二狗的 lint（React 的 refs、immutability 规则）改了几处，行为不变：外面传进来的回调渲染完再写进 ref
 * （原文在渲染时写）；"条目变了、换了档、缩放停稳之后重新排标注"原文是一个带 [level, items, settled] 的 effect，
 * 这里是每次渲染后排一次加上停稳时排一次；flash、layoutAnnotations 挪到组件外面。
 *
 * 57 号票：工具调用组只存在于对话层——对话层是一行"调用了 N 个工具 ›"（.zi-grouprow），缩小后照 AgentSense（它没有组，每次调用各是一条）
 * 组里每次调用、每段思考各画一块（.zi-step），性质、小圆点、右侧标注都按这一次算；哪样显示由 data-level 决定，照 AgentSense 同类折叠
 * 的做法（.zh[data-level="0"] .zi-folded 隐藏）。跨过对话层那一档时内容高度会变，焦点按组里的比例换算到新布局（zoom.ts 的
 * onLevelLayout），手指下面的内容不跳走。缩小着点一块：放大回去落在组那一行、闪那一行，打开这一次调用的详情。
 *
 * 55 号票：缩小后条外的装饰照搬（数据由状态层的 zoomDecor 给，state/zoom-decor.ts）——
 * - 右侧标注连着一样的只在第一块标、写 ×N（.zd-repeat）；验收通过的不标（书脊变绿就是通过了，sideMarks）；
 * - 左侧任务卡、工单卡（.zd-left > .zd-task，AgentSense 的 TaskHead），点开看完整情况（decor.tsx，AgentSense 的 TaskDialog）；
 * - 底色带（.zh-band，placeBands 摆到起止两条之间，横向铺满视口）和左缘竖排的标签（.zh-band-labels，每帧摆到露出那一段的中间）；
 * - 书脊（.zh-spine：贴着条左边的窄色条，一轮一段，颜色是这一轮的结果；阶段名每帧摆到这一段露出部分的中间，挤住了往下让）；
 * - 重开之前的那几轮淡一点、标"已废弃"（.zi-stale）；图例补上书脊的颜色。
 * 起止落在工具调用组上时：对话层是组那一行，缩小后是组里第一块、最后一块（edgeEl）；跨档时重新摆。
 * 没搬的：书脊名避让撤回箭头（二狗没有回退点），里程碑会话条外的图标标注（NoteChips，跟着阶段框）。
 *
 * 60 号票：流程的会话照搬固定计划的"接下来的计划"虚线框（future：放在内容最后、跟着一起缩放，样子在 ui/zoom/future.tsx 和 zoom.css）；
 * 它的敏感标注和条右侧的标注一起排版（layoutAnnotations 认 .zd-right，不管它挂在条上还是挂在虚线框的一格上）。
 *
 * 91 号票：长程任务的会话按阶段成框（照 AgentSense bedf5a5 ZoomHistory 的 stageGroups / StageZ / grp 那几处）——
 * - 照常显示的之外，每段后台事项收成一个阶段框（状态层 stageBoxes 给，框的样子在 ui/conversation/StageBox.tsx）；框在三档里是同一块
 *   （.zi-stage：对话层是框，要点层写"第 N 阶段 标题"，全局层是色块），收着的阶段里的每一条三档都不画，条外的标注一类一条、
 *   指向框上那个图标（StageNoteChips）；展开了，这一块只剩框头，下面逐条画每次操作（.zi-grp-open，接着框左边那道颜色）；
 * - 框里的工具调用组照 AgentSense 每次操作一行：三档都画组里每次调用、每段思考那几块（57 号票缩小后的样子），组那一行不画；
 *   对话层里点一块打开那一次调用的详情；
 * - 书脊、底色带的上下沿：收着的框里的事落在框上，一个框里的事上沿从框顶开始（stageBoxEdge、stageBoxSpines）；
 * - 屏幕停在框上时，报给外面的是框里最后一件事（.sbox 的 data-focus-id），标题栏的阶段标签跟着它；
 * - 在对话中定位（reveal）到收着的框里的一条：先把框展开。缩小着点框：放大回对话层，闪一下。
 *
 * 二狗多出来的：往上翻加载更早的一页（AgentSense 整个会话一次进 DOM）。和缩放共存：任何一档滚到顶都取更早的一页，
 * 缩小状态下停稳时已经在顶上也取；取回来之后视口里那一条的下沿留在原处（锚点按条目 id 存，用 locateChatItem 找：
 * 一组调用跨两页时，翻回来之后组的 id 会变，下沿不变）。
 */
import { Fragment, forwardRef, type MouseEvent, memo, type ReactNode, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
  type ZoomDecor,
  type ZoomLeftCard,
  sideMarks,
  STAGE_BOX_EDGE,
  type StageBoxView,
  type StageGroup,
  type StageNote,
  stageBoxEdge,
  stageBoxRows,
  stageBoxSpines,
  zoomBlocks,
} from "../../state/index.ts";
import { NamedText } from "../assistant-name.tsx";
import { StageBox, StageNoteChips, StageNoteLegend } from "../conversation/StageBox.tsx";
import { LeftCardDialog, LeftCardHead } from "./decor.tsx";
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
  /** 流程的"接下来的计划"虚线框（60 号票）：在内容最后，跟着一起缩放 */
  future?: ReactNode;
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
  /** 缩小后条外的装饰（55 号票：×N、左侧的卡、底色带、书脊、已废弃），状态层的 zoomDecor 给 */
  decor?: ZoomDecor | undefined;
  /** 打开某一条的详情（左侧任务卡点开后"看计划详情"；阶段框里点一次操作、点收着的框的标注） */
  onDetail?: ((id: string) => void) | undefined;
  /** 长程任务的会话按阶段成框（91 号票）：状态层 stageBoxes 给的每个框；不给就照旧逐条画 */
  boxes?: readonly StageBoxView[] | undefined;
  /** 框上的"验收和规则 ›"、收着的框上合起来好几件的标注：打开这个阶段的详情 */
  onStage?: ((stageId: string) => void) | undefined;
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

/** 一块矩形条外的东西（55 号票）：右侧标注的 ×N（0 是并进了前面那一块）、左边的卡、重开之前的（已废弃） */
interface ZSide {
  repeat: number | undefined;
  left: ZoomLeftCard | undefined;
  stale: boolean;
  onOpenCard(card: ZoomLeftCard): void;
}

/**
 * 一条在哪个阶段框里（91 号票，AgentSense ZItem 的 grp）：open = 框展开着；start / end = 框里第一行、最后一行的 id
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
  children: ReactNode;
}) {
  const layer = `bg-${view.content}${view.nature ? ` n-${view.nature}` : ""}${view.error ? " zi-err" : ""}`;
  const { group } = view;
  const { repeat, left, stale } = side;
  // 连着一样的标注：第一块标出、写 ×N，后面的不标（AgentSense：repeat === 0 时 risks 为空；小圆点照旧）
  const risks = repeat === 0 ? [] : view.marks;
  return (
    <>
      {above}
      {/* data-item：条目层的 id（56 号票的详情页按它打开、定位）；data-group：工具调用组（57 号票，对话层一行、缩小后逐次画） */}
      <div
        className={`zi k-${view.content} ck-${view.kind}${view.tone ? ` t-${view.tone}` : ""}${group ? ` zi-${group.role === "row" ? "grouprow" : "step"}` : ""}${stale ? " zi-stale" : ""}${extra}`}
        data-chat-id={view.id}
        data-item={view.id}
        data-group={group?.id}
      >
        {stale && <span className="zi-stale-tag">已废弃</span>}
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
          {/* 有关注（右侧标注）就有的小圆点，有高的用高亮色（AgentSense 的 zi-risk-dot；二狗的标注就是它的 risks） */}
          {view.marks.length > 0 && <div className={`zi-risk-dot${view.marks.some((m) => markLevel(m) === "high") ? " high" : ""}`} />}
        </div>
        <div className={`zi-l2 ${layer}`} />
        {(risks.length > 0 || (repeat ?? 0) > 1) && (
          <div className="zd-right">
            {risks.map((m) => (
              <MarkChip key={m.key} mark={m} />
            ))}
            {(repeat ?? 0) > 1 && <span className="zd-repeat">×{repeat}</span>}
          </div>
        )}
        {left && (
          <div className="zd-left">
            <LeftCardHead card={left} onOpen={side.onOpenCard} />
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
  decor,
  onOpenCard,
  grp,
  onOpenBlock,
}: {
  item: ChatItem;
  fresh: boolean;
  above: ReactNode;
  renderItem(item: ChatItem): ReactNode;
  renderBlock(block: ZoomBlock): ReactNode;
  decor: ZoomDecor | undefined;
  onOpenCard(card: ZoomLeftCard): void;
  /** 在哪个阶段框里（91 号票） */
  grp?: ZGrp | undefined;
  /** 阶段框里点一次调用、一段思考：打开它的详情 */
  onOpenBlock?: ((id: string) => void) | undefined;
}) {
  const blocks = zoomBlocks(item);
  // 阶段框里的工具调用组（91 号票）：三档都画组里每一块，组那一行不画（.zi-boxrow / .zi-boxstep）
  const boxed = grp !== undefined && blocks.length > 0;
  // 左边的卡挂在这一条上；工具调用组缩小后那一行藏着，挂到组里第一块（卡只在缩小后看得见）。
  // 阶段框里的：框收着时、框里第一条的，挂在框上（AgentSense：阶段的第一条的、收着的阶段里每一条的都挂在框上）
  const left = grp && (!grp.open || grp.first === item.id) ? undefined : decor?.left.get(item.id);
  const sideOf = (id: string, withLeft: boolean): ZSide => ({ repeat: decor?.repeats.get(id), left: withLeft ? left : undefined, stale: decor?.stale.has(id) ?? false, onOpenCard });
  const view: ZView = {
    id: item.id,
    content: item.content,
    kind: item.kind,
    tone: item.tone,
    keyLine: item.keyLine,
    // 验收通过的不在右侧标、也没有小圆点（照 AgentSense，书脊变绿就是通过了）
    marks: sideMarks(item.marks),
    error: item.error,
    nature: chatItemNature(item),
    group: blocks.length > 0 ? { id: item.id, role: "row" } : undefined,
  };
  return (
    <>
      <ZItemView view={view} fresh={fresh} above={above} side={sideOf(item.id, blocks.length === 0)} extra={`${grpClass(grp, item.id)}${boxed ? " zi-boxrow" : ""}`}>
        {renderItem(item)}
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
        >
          {renderBlock(b)}
        </ZItemView>
      ))}
    </>
  );
});

/**
 * 阶段框在三档里是同一块（91 号票，AgentSense StageZ）：收着的阶段在三档里都只画这一块，条外的标注一类一条、指向框上那个图标；
 * 展开了，这一块只剩框头（对话层），要点层、全局层是写着"第 N 阶段 标题"的色块，下面逐条画每次操作
 */
function StageZ({
  box,
  open,
  above,
  left,
  onToggle,
  onStage,
  onNote,
  onOpenCard,
}: {
  box: StageBoxView;
  open: boolean;
  above: ReactNode;
  left: ZoomLeftCard | undefined;
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
          <StageBox box={box} open={open} onToggle={() => onToggle(box.id)} onStage={onStage} />
        </div>
        <div className={`zi-l1 bg-${box.kind} n-${box.nature}`}>
          <div className="zi-cap">
            <div className="zi-title">{box.caption}</div>
          </div>
        </div>
        <div className={`zi-l2 bg-${box.kind} n-${box.nature}`} />
        {!open && box.notes.length > 0 && <StageNoteChips notes={box.notes} onOpen={(n) => onNote(box, n)} />}
        {left && (
          <div className="zd-left">
            <LeftCardHead card={left} onOpen={onOpenCard} />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * 底色块左缘的竖排标签（AgentSense："任务 N · 这件事是什么"，编号竖排时正着写）：任务写"任务 N · 标题"（这个会话里的第几个），
 * 工单写"工单 N · 标题"（工单编号里的数），秘书主线的一天写"10月8日"
 */
function BandLabel({ band }: { band: ZoomBand }) {
  if (band.kind === "day")
    return (
      <b>
        <span className="zh-band-no">{band.month}</span>月<span className="zh-band-no">{band.date}</span>日
      </b>
    );
  return (
    <>
      <b>
        {band.kind === "task" ? "任务" : band.kind === "run" ? "运行" : "工单"}
        <span className="zh-band-no">{band.no}</span>
      </b>
      {band.title && ` · ${band.title}`}
    </>
  );
}

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

/**
 * 书脊、底色块的上下沿落在哪一块上（AgentSense 的 edgeEl）：条目 id 对到它的矩形；工具调用组在缩小后那一行藏着，
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
 * 书脊贴着条，从这一段第一条的上沿到最后一条的下沿；段与段之间的缝由 CSS 的透明边框留（AgentSense placeBands 原样）
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
 * 底色块左缘的竖排标签、书脊的阶段名：在屏幕上露出的那一段里居中，所以每帧跟着滚动和缩放重新摆（AgentSense 的那个 rAF 循环原样，
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
  // 书脊的阶段名：写在色条左边、这一段露出部分的中间。从上往下摆：和上一个名字挤住了就往下让；让到离这一段太远还放不下，就不写
  let lastBottom = -Infinity;
  for (const name of content.querySelectorAll<HTMLElement>(":scope > .zh-spine > .zh-spine-id")) {
    const r = name.parentElement!.getBoundingClientRect();
    const top = Math.max(r.top, v.top);
    const bottom = Math.min(r.bottom, v.bottom);
    const lh = name.offsetHeight * s;
    let y = (top + bottom) / 2 - lh / 2;
    const prev = { top: -Infinity, bottom: lastBottom + 2 };
    for (let i = 0; i < 4; i++) {
      if (!(y < prev.bottom && y + lh > prev.top)) break;
      y = prev.bottom;
    }
    // 露不出来、或者被挤得离开这一段一半以上：不写
    if (bottom - top <= 0 || y + lh / 2 > bottom + lh / 2 || (y < prev.bottom && y + lh > prev.top)) {
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

/** 离底部不到 24px 算停在最新一条 */
const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 24;

export const ZoomHistory = forwardRef<ZoomHistoryHandle, Props>(function ZoomHistory(props, ref) {
  const { items, older, onFocusChat, onLevelChange, onZoomTap, renderItem, renderBlock, above, isFresh, decor, onDetail, boxes, onStage } = props;
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
  // 阶段框（91 号票，AgentSense 的 groups、groupOf、openGroups）：每条在哪个框里、哪几个框展开着
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
  /** 让某条历史在对话层看得见：它在收着的框里，就先同步展开（AgentSense openGroupOf） */
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
      // 对话层里的阶段框：算它最后一件事（91 号票，AgentSense 同）
      for (const el of content.querySelectorAll<HTMLElement>(".zi[data-chat-id], .sbox[data-focus-id]")) {
        if (el.getBoundingClientRect().bottom >= y) {
          pick = el.dataset.chatId ?? el.dataset.focusId;
          break;
        }
      }
      focusCb.current(pick, atBottom(vp));
    });
  }, []);
  const pinchRef = useRef({ s0: 1, focalY: 0, contentY: 0 });
  const [level, setLevel] = useState<ZoomLevel>(0);
  /** 点了左边的任务卡、工单卡：弹出这件事的完整情况（55 号票，AgentSense 的 taskInfo） */
  const [openCard, setOpenCard] = useState<ZoomLeftCard | undefined>(undefined);
  const spines = decor?.spines;
  // 书脊、底色带的上下沿落在哪一块上：收着的框里的事落在框上（91 号票，AgentSense edge、shownSpines）
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
  /** 收着的框条外的标注：说的是一件事进那一件的详情，合起来的好几件进这个阶段的详情（AgentSense StageZ 的 onOpen） */
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
      placeBands(content);
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
      ctl.setContentHeight(content.offsetHeight, 0);
      programmaticRef.current = true;
      ctl.set(PRESETS[start], viewport.clientHeight, content.offsetHeight);
    }
    // 内容高度变化（新消息、流式输出）→ 更新滚动范围；对话层且在底部时跟随到底
    const ro = new ResizeObserver(() => {
      placeBands(content);
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

  // 每次渲染之后（条目变了、换了档、装饰变了）：内容多的条重新量，底色带和书脊重新摆，两侧标注重新避让排版
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    markLong(content);
    placeBands(content);
    layoutAnnotations(content, ctlRef.current);
  });

  // 底色块的竖排标签、书脊的阶段名：每帧摆到露出那一段的中间（AgentSense 的 rAF 循环；对话层停着时直接跳过）
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
      const focalY = viewportRef.current!.clientHeight / 2;
      ctl.animateTo(PRESETS[l], ctl.contentYAt(focalY), focalY);
    },
    reveal(chatId) {
      // 存的 id 可能是组原来的 id、组里某一步的 id：一律经 locateChatItem 找到现在的那一条
      const found = locateChatItem(itemsRef.current, chatId);
      // 在收着的阶段框里：先同步展开（91 号票，AgentSense reveal 的 openGroupOf）
      if (found) openGroupOf(found.item.id);
      const content = contentRef.current;
      const row = found && content ? content.querySelector<HTMLElement>(`.zi[data-chat-id="${CSS.escape(found.item.id)}"]`) : null;
      if (!found || !content || !row) return;
      // 二狗：组里的某一步（56 号票的详情里点的是一次调用、一段思考）定位到那一步、闪那一步；别的定位到整条、闪整条（AgentSense）
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
      // 两侧标注里的按钮自己处理点击
      if ((e.target as HTMLElement).closest("button")) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-chat-id], [data-stage]");
      if (!el) return;
      // 点的是阶段框那一块（91 号票，AgentSense）：放大回对话层，闪一下
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
          <div className="zh-content" ref={contentRef} data-spine={shownSpines.length > 0 ? "1" : undefined} onClickCapture={level > 0 ? onContentClick : undefined}>
            {props.head}
            {items.length === 0 && props.empty}
            {/* 底色带、书脊：放在内容里跟着一起缩放，起止由 placeBands 摆（55 号票） */}
            {decor?.bands.map((b) => (
              <div key={b.key} className="zh-band" data-band={b.key} data-first={edge(b.firstId, "top")} data-last={edge(b.lastId, "bottom")} data-n={b.index % 2} />
            ))}
            {shownSpines.map((sp) => (
              <div key={sp.key} className={`zh-spine sp-${sp.state}`} data-first={sp.firstId} data-last={sp.lastId} title={`第 ${sp.label} 阶段 · ${SPINE_STATE_LABEL[sp.state]}`}>
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
                  grp={g && grpInfo.get(g.id)}
                  onOpenBlock={openBlock}
                />
              );
              if (!g || g.ids[0] !== it.id) return zi;
              // 框上挂的左侧卡：展开着的是第一条的，收着的是框里各条的第一张
              const left = (gOpen ? [g.ids[0]!] : g.ids).map((id) => decor?.left.get(id)).find((c) => c !== undefined);
              return (
                <Fragment key={it.id}>
                  <StageZ box={g} open={gOpen} above={sep} left={left} onToggle={toggleGroup} onStage={onStage} onNote={openNote} onOpenCard={setOpenCard} />
                  {zi}
                </Fragment>
              );
            })}
            {props.tail}
            {props.future}
          </div>
        </div>
      </div>
      {openCard && <LeftCardDialog card={openCard} items={items} onPlan={onDetail} onClose={() => setOpenCard(undefined)} />}
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
            <span title="左边的书脊：一个阶段的一轮一段，颜色是这一轮的结果">
              <i className="sp-ok" />
              <i className="sp-retry" />
              <i className="sp-live" />
              <i className="sp-off" />
              阶段（通过 / 退回 / 在做 / 作废）
            </span>
          )}
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
