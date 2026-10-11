/**
 * 长程任务详情里的计划栏（91 号票，照 AgentSense bedf5a5 App.tsx 里程碑会话那一段：drawer、pinnedStep、sideOpen、sideW、focusChat、
 * stepAt、followStep、shownStep、openStage、onStep）：真任务、原型的假任务共用，任务详情只管把依赖图、出过的状况、详情的开法交进来，
 * 把返回的阶段标签、抽屉、阶段栏放到页面上。
 * - 阶段标签（标题栏，90 号票起放在 TaskHead 那一行里）：宽屏在左边（‹ 之后、标题之前，正在阶段栏上方），点它开合阶段栏；
 *   窄屏在右边，点它开合抽屉（抽屉开着时点它，手动点过的阶段不再停着、恢复跟着聊天）。写的是哪一阶段：你手动点的 >
 *   聊天里正在看的那一段（滚动时跟着变；停在最新一条时是正在做的那一阶段）> 正在做的 > 最后一条那一段 > 第一个（state 的 shownStage）；
 * - 窄屏：标题栏下面的抽屉（收起 / 半开 / 全开）；抽屉全开时点聊天区缩回半开；返回键先收起抽屉；
 * - 宽屏：会话左边的阶段栏 + 能左右拖的分界线（默认 320，最窄 200，最宽外框的 60%；拖到的宽度这台设备记住——AgentSense 不记，
 *   刷新回 320，是主会话建议的偏离，合并前要用户点头）；栏顶 × 整栏藏掉（88 号票，这台设备记住）；
 * - 点一个阶段：选中它（图上高亮、阶段标签停在它上面），同时在详情栏打开它的详情（竖屏整页滑入）；再点同一个详情不关，‹ 一层层退。
 *   计划还没确认（左边画的是等你确认的计划卡、计划变更）时打开那张卡的详情，定位到这一阶段（AgentSense openStage）；
 * - 新交上来一份等你确认的计划：把计划图打开（宽屏阶段栏打开——只在这一次打开这个任务时，不写进设备设置；竖屏拉出半开的抽屉）；
 * - 聊天里的计划提纲点了某一阶段（onStep）：图上高亮它，宽屏阶段栏藏着就打开（AgentSense App.tsx:707）。点左边的卡片不动聊天。
 * - 会话按阶段成框（AgentSense collapse={milestoneMode}）：返回的 chat 直接摊到会话组件上——报正在看哪一条、计划提纲点阶段、
 *   框上"验收和规则 ›"打开阶段详情、成框要的阶段来源。
 */
import { type ReactNode, useContext, useMemo, useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { pageStageSide, pageStageSideWidth, useStageSidePref, useStageSideWidth } from "../../app/page-stage-side.ts";
import { type DetailTarget, dragStageSideWidth, type GuardPingKind, type StageBoxStage, type StageGraph, type StageSidePref, shownStage, stageSideLayout } from "../../state/index.ts";
import { Splitter } from "../common.tsx";
import { FrameWidth } from "../detail/DetailLayout.tsx";
import { type DrawerMode, StageChip, StageDrawer, StageSide } from "./StageDrawer.tsx";

export interface StagePanel {
  /** 标题栏的阶段标签：交给 TaskHead 的 chip（放哪头由 stageChipPlace 定：宽屏左边，窄屏右边） */
  readonly chip: ReactNode;
  /** 窄屏：标题栏下面的抽屉（只在会话栏上放） */
  readonly drawer: ReactNode;
  /** 宽屏：会话左边的阶段栏和分界线（放在 .chat-row 里、会话前面） */
  readonly side: ReactNode;
  /** 窄屏抽屉全开时点聊天区：缩回半开（挂在 .chat-row-main 的 onPointerDownCapture 上） */
  readonly onChatPointerDown: (() => void) | undefined;
  /** 会话报来屏幕上正在看的那一条（视口 40% 高处）、是不是停在最新一条：阶段标签跟着变 */
  onFocusChat(chatId: string | undefined, atBottom: boolean): void;
  /** 聊天里的计划提纲点了某一阶段：图上高亮它，宽屏阶段栏藏着就打开 */
  onStep(stageId: string): void;
  /** 现在高亮的那一阶段 */
  readonly selected: string | undefined;
  /** 摊到会话组件上的（91 号票：会话按阶段成框、和计划栏联动） */
  readonly chat: StageChatProps;
}

/** 会话组件要的：报正在看哪一条、计划提纲点了某一阶段、框上"验收和规则 ›"、成框要的阶段来源（没有阶段的任务没有） */
export interface StageChatProps {
  onFocusChat(chatId: string | undefined, atBottom: boolean): void;
  onStep?: ((stageId: string) => void) | undefined;
  onStage?: ((stageId: string) => void) | undefined;
  onPlan?: ((cardId: string, stageId?: string) => void) | undefined;
  stageChat?: { taskId: string; list?: readonly StageBoxStage[] | undefined; running?: boolean | undefined } | undefined;
}

export function useStagePanel({
  wide,
  taskId,
  graph,
  progress,
  show,
  counts,
  ping,
  stepAt,
  lastItemId,
  chatStages,
}: {
  wide: boolean;
  taskId: string;
  /** 依赖图（state 的 taskStageGraph，原型的从假阶段排）；没有阶段的任务没有 */
  graph: StageGraph | undefined;
  /** 整份计划验收了几个（阶段标签后面的"· 几/几"） */
  progress: { done: number; total: number };
  /** 打开一页详情（任务详情的 DetailController.show） */
  show(target: DetailTarget): void;
  /** 阶段栏、抽屉全开最下面一行：执行中出过的状况 */
  counts: ReactNode;
  /** 刚被拉回、拦下、你拒绝时阶段标签闪一下 */
  ping: GuardPingKind | undefined;
  /** 聊天里每一条属于哪个阶段（state 的 stageAtItems）、会话最后一条 */
  stepAt: ReadonlyMap<string, string>;
  lastItemId: string | undefined;
  /** 会话按阶段成框要的阶段、维护者在不在干活：真任务不给（按看板上的），原型给假的 */
  chatStages?: { list?: readonly StageBoxStage[] | undefined; running?: boolean | undefined } | undefined;
}): StagePanel {
  const frameWidth = useContext(FrameWidth);
  const [drawer, setDrawer] = useState<DrawerMode>("closed");
  // 竖屏的阶段抽屉拉开时，返回键先收起它
  useBackLayer("overlay", !wide && drawer !== "closed", () => setDrawer("closed"));
  /** 手动点的那一阶段：停在那里，收起抽屉后恢复跟随 */
  const [pinned, setPinned] = useState<string>();
  const [focus, setFocus] = useState<{ id?: string | undefined; bottom: boolean }>({ bottom: true });
  const remembered = useStageSideWidth();
  /** 拖着的时候的宽度（松手才记到这台设备上） */
  const [dragging, setDragging] = useState<number>();
  const width = dragging ?? remembered;
  const hasStages = graph !== undefined && graph.nodes.length > 0;

  // 会话按阶段成框要的阶段来源（不变就不重算框）
  const list = chatStages?.list;
  const running = chatStages?.running;
  const stageChat = useMemo(() => ({ taskId, list, running }), [taskId, list, running]);
  // 新交上来一份等你确认的计划（计划卡、计划变更卡）：把计划图打开（AgentSense App.tsx 的 pendingPlanId）——手动点过的阶段不再停着，
  // 竖屏拉出半开的抽屉，宽屏打开阶段栏（渲染时比着上一次记下的那张卡）。宽屏只在这一次打开这个任务时开着（openedFor 记着是哪个任务），
  // 不写进这台设备的设置：你点 × 收起的、别的长程任务的都不跟着变；你自己点阶段标签、× 时才写
  const pendingCard = graph?.kind === "live" ? undefined : graph?.cardId;
  const [seenPending, setSeenPending] = useState<string>();
  const [openedFor, setOpenedFor] = useState<string>();
  if (pendingCard !== seenPending) {
    setSeenPending(pendingCard);
    if (pendingCard) {
      setPinned(undefined);
      setOpenedFor(taskId);
      if (!wide) setDrawer((d) => (d === "closed" ? "half" : d));
    }
  }
  const rememberedPref = useStageSidePref();
  const sidePref = openedFor === taskId ? "open" : rememberedPref;
  /** 你自己开合阶段栏：写进这台设备的设置，这一次为等你确认的计划开着的那一下不再算 */
  const setSide = (pref: StageSidePref) => {
    setOpenedFor(undefined);
    pageStageSide().set(pref);
  };
  const layout = stageSideLayout({ wide, hasStages, pref: sidePref });
  const live = graph?.nodes.filter((n) => n.state !== "removed") ?? [];
  const selected = shownStage({ pinned, focus, current: graph?.current, stepAt, lastItemId, first: live[0]?.id });

  if (!graph || !hasStages) {
    const onFocusChat = setFocusIfChanged(setFocus);
    return { chip: null, drawer: null, side: null, onChatPointerDown: undefined, onFocusChat, onStep: () => {}, selected: undefined, chat: { onFocusChat } };
  }

  const onFocusChat = setFocusIfChanged(setFocus);
  const onStep = (stageId: string) => {
    setPinned(stageId);
    if (wide) setSide("open");
  };
  /** 左边图上点了某一阶段：还没确认的看那张卡里这一阶段，确认了的看这一阶段的详情（AgentSense openStage） */
  const openStage = (stageId: string) => show(graph.kind === "live" || !graph.cardId ? { type: "stage", taskId, stageId } : { type: "plan", cardId: graph.cardId, focus: stageId });
  const chip = (
    <StageChip
      graph={graph}
      selected={selected}
      progress={progress}
      open={wide ? sidePref === "open" : drawer !== "closed"}
      ping={ping}
      compact={!wide}
      onTap={() => {
        // 宽屏：开合阶段栏（90 号票起没有页签那一排，会话一直在）
        if (wide) return setSide(sidePref === "open" ? "closed" : "open");
        if (drawer !== "closed") setPinned(undefined);
        setDrawer(drawer === "closed" ? "half" : "closed");
      }}
    />
  );
  return {
    chip,
    drawer:
      layout === "drawer" ? (
        <StageDrawer
          graph={graph}
          mode={drawer}
          onMode={(m) => {
            setDrawer(m);
            if (m === "closed") setPinned(undefined);
          }}
          selected={selected}
          onSelect={setPinned}
          onDetail={openStage}
          counts={counts}
        />
      ) : null,
    side:
      layout === "side" ? (
        <>
          <StageSide graph={graph} selected={selected} onSelect={setPinned} onDetail={openStage} counts={counts} width={width} onClose={() => setSide("closed")} />
          <Splitter
            label="拖动调整阶段栏宽度"
            onDrag={(dx) => setDragging((w) => dragStageSideWidth(w ?? remembered, dx, frameWidth))}
            onDragEnd={() => {
              if (dragging !== undefined) pageStageSideWidth().set(dragging);
              setDragging(undefined);
            }}
          />
        </>
      ) : null,
    onChatPointerDown: !wide && drawer === "full" ? () => setDrawer("half") : undefined,
    onFocusChat,
    onStep,
    selected,
    chat: {
      onFocusChat,
      onStep,
      onStage: (stageId) => show({ type: "stage", taskId, stageId }),
      onPlan: (cardId, stageId) => show({ type: "plan", cardId, ...(stageId === undefined ? {} : { focus: stageId }) }),
      stageChat,
    },
  };
}

/** 会话报来正在看的那一条：没变就不重画 */
function setFocusIfChanged(set: (f: (prev: { id?: string | undefined; bottom: boolean }) => { id?: string | undefined; bottom: boolean }) => void) {
  return (id: string | undefined, bottom: boolean) => set((f) => (f.id === id && f.bottom === bottom ? f : { id, bottom }));
}
