/**
 * 宽屏（用户 2026-11-01）：阶段标签在标题栏上，点了整张阶段图开在左边栏，和项目档案共用这个栏位、不同时显示（side，AgentDialog 摆）。下面说的阶段条是手机上的。
 * 对话框顶部的阶段条（368 号票，用户 2026-11-01："阶段条就是显示在我点击卡片之后进去的那个聊天窗口，而不要再展开一层"；91 号票的计划栏、88 号票的阶段标签并进来）：
 * 真任务、项目的对话框、原型的假任务共用，任务详情只管把依赖图、出过的状况、详情的开法交进来，把返回的阶段条放到会话上面。宽屏、手机一样：
 * - 第一行：阶段标签 + 这一阶段的名字（项目的对话框还写是哪个任务）。写的是哪一阶段：你手动点的 > 聊天里正在看的那一段（滚动时跟着变；停在最新一条时是
 *   正在做的那一阶段）> 正在做的 > 最后一条那一段 > 第一个（state 的 shownStage）。点标签：展开成阶段条、收成一行（这台设备记住，默认展开；收起时手动点过的阶段不再停着）；
 * - 下面是阶段条（抽屉半开）：一个阶段一列，点一个选中它（阶段条上高亮、标签停在它上面），同时在详情栏打开它的详情（手机整页滑入）——交付件和验收标准在那里；
 *   把手往下拉、点一下是整个计划的依赖图（抽屉全开，下面一行是出过的状况），全开时点聊天区缩回阶段条，返回键也是；
 * - 任务做完了（done 给了那句话，比如"首版已完成"）：默认收成一行，能点开看，不记进设置；
 * - 计划还没确认（左边画的是等你确认的计划卡、计划变更）时点一个阶段打开那张卡的详情，定位到这一阶段；新交上来一份等你确认的计划：把阶段条打开；
 * - 聊天里的计划提纲点了某一阶段（onStep）：高亮它，收着就打开。
 * - 会话按阶段成框：返回的 chat 直接摊到会话组件上——报正在看哪一条、计划提纲点阶段、
 *   框上"验收和规则 ›"打开阶段详情、成框要的阶段来源。
 */
import { type ReactNode, useMemo, useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { pageProjectSide } from "../../app/page-project-wall.ts";
import { pageStageSide, useStageSidePref } from "../../app/page-stage-side.ts";
import { type DetailTarget, type GuardPingKind, type StageBoxStage, type StageGraph, shownStage, t } from "../../state/index.ts";
import { type DrawerMode, StageChip, StageDrawer, StageSideBody } from "./StageDrawer.tsx";

/** 宽屏左边栏里的阶段进展 */
export interface StageSidePanel {
  /** 标题栏上的阶段标签：点了在左边栏打开、关上 */
  readonly chip: ReactNode;
  /** 现在该不该占左边栏 */
  readonly open: boolean;
  /** 关上：左边栏空出来，不自动换成项目档案（换成项目档案的调用方接着打开它） */
  close(): void;
  readonly title: ReactNode;
  readonly body: ReactNode;
}

export interface StagePanel {
  /** 阶段条：手机上放在对话框标题栏下面、会话上面；宽屏没有（见 side）；没有阶段的任务没有 */
  readonly bar: ReactNode;
  /** 宽屏左边栏里的阶段进展；手机上、没有阶段的任务没有 */
  readonly side?: StageSidePanel | undefined;
  /** 整个计划开着时点聊天区：缩回阶段条（挂在会话外面那一层的 onPointerDownCapture 上） */
  readonly onChatPointerDown: (() => void) | undefined;
  /** 会话报来屏幕上正在看的那一条（视口 40% 高处）、是不是停在最新一条：阶段标签跟着变 */
  onFocusChat(chatId: string | undefined, atBottom: boolean): void;
  /** 聊天里的计划提纲点了某一阶段：高亮它，收着就打开 */
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
  stageChat?: { taskId: string; list?: readonly StageBoxStage[] | undefined; running?: boolean | undefined; shared?: boolean | undefined } | undefined;
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
  done,
  caption,
}: {
  wide: boolean;
  taskId: string;
  /** 依赖图（state 的 taskStageGraph，原型的从假阶段排）；没有阶段的任务没有 */
  graph: StageGraph | undefined;
  /** 整份计划验收了几个（阶段标签后面的"· 几/几"） */
  progress: { done: number; total: number };
  /** 打开一页详情（任务详情的 DetailController.show） */
  show(target: DetailTarget): void;
  /** 整个计划最下面一行：执行中出过的状况 */
  counts: ReactNode;
  /** 刚被拉回、拦下、你拒绝时阶段标签闪一下 */
  ping: GuardPingKind | undefined;
  /** 聊天里每一条属于哪个阶段（state 的 stageAtItems）、会话最后一条 */
  stepAt: ReadonlyMap<string, string>;
  lastItemId: string | undefined;
  /** 会话按阶段成框要的阶段、负责人在不在干活：真任务不给（按看板上的），原型给假的 */
  chatStages?: { list?: readonly StageBoxStage[] | undefined; running?: boolean | undefined; shared?: boolean | undefined } | undefined;
  /** 任务做完了时收起来那一行写什么（比如"首版已完成"）：给了就默认收起，能点开看；没做完的不给 */
  done?: { text: string; ok: boolean } | undefined;
  /** 第一行上另写的（项目的对话框里是哪个任务） */
  caption?: string | undefined;
}): StagePanel {
  /** 你点过的：展开到哪一档；没点过的按默认（做完了收起，别的按这台设备记住的） */
  const [chosen, setChosen] = useState<{ taskId: string; mode: DrawerMode }>();
  /** 手动点的那一阶段：停在那里，收起后恢复跟随 */
  const [pinned, setPinned] = useState<string>();
  const [focus, setFocus] = useState<{ id?: string | undefined; bottom: boolean }>({ bottom: true });
  const pref = useStageSidePref();
  const hasStages = graph !== undefined && graph.nodes.length > 0;

  // 会话按阶段成框要的阶段来源（不变就不重算框）
  const list = chatStages?.list;
  const running = chatStages?.running;
  const shared = chatStages?.shared;
  const stageChat = useMemo(() => ({ taskId, list, running, shared }), [taskId, list, running, shared]);
  // 换了任务（项目的对话框里定位到别的任务）：手动点的阶段不再停着，展开到哪一档从默认来
  const [seenTask, setSeenTask] = useState(taskId);
  if (seenTask !== taskId) {
    setSeenTask(taskId);
    setPinned(undefined);
    setChosen(undefined);
  }
  const defaulted: DrawerMode = done !== undefined || pref === "closed" ? "closed" : "half";
  const mode: DrawerMode = chosen?.taskId === taskId ? chosen.mode : defaulted;
  const setMode = (next: DrawerMode) => setChosen({ taskId, mode: next });
  // 新交上来一份等你确认的计划（计划卡、计划变更卡）：把阶段条打开，手动点过的阶段不再停着（渲染时比着上一次记下的那张卡）。
  // 不写进这台设备的设置：你收起的、别的任务的都不跟着变
  const pendingCard = graph?.kind === "live" ? undefined : graph?.cardId;
  const [seenPending, setSeenPending] = useState<string>();
  if (pendingCard !== seenPending) {
    setSeenPending(pendingCard);
    if (pendingCard) {
      setPinned(undefined);
      if (mode === "closed") setMode("half");
    }
  }
  // 整个计划开着时，返回键先缩回阶段条
  useBackLayer("overlay", !wide && hasStages && mode === "full", () => setMode("half"));
  const live = graph?.nodes.filter((n) => n.state !== "removed") ?? [];
  const selected = shownStage({ pinned, focus, current: graph?.current, stepAt, lastItemId, first: live[0]?.id });
  const onFocusChat = setFocusIfChanged(setFocus);

  if (!graph || !hasStages) {
    return { bar: null, onChatPointerDown: undefined, onFocusChat, onStep: () => {}, selected: undefined, chat: { onFocusChat } };
  }

  const onStep = (stageId: string) => {
    setPinned(stageId);
    if (mode === "closed") setMode("half");
  };
  /** 点了某一阶段：还没确认的看那张卡里这一阶段，确认了的看这一阶段的详情 */
  const openStage = (stageId: string) => show(graph.kind === "live" || !graph.cardId ? { type: "stage", taskId, stageId } : { type: "plan", cardId: graph.cardId, focus: stageId });
  const onTap = () => {
    const next: DrawerMode = mode === "closed" ? "half" : "closed";
    if (next === "closed") setPinned(undefined);
    setMode(next);
    // 做完了的展开只算这一次；没做完的记到这台设备上
    if (done === undefined) pageStageSide().set(next === "closed" ? "closed" : "open");
  };
  const chat: StageChatProps = {
    onFocusChat,
    onStep,
    onStage: (stageId) => show({ type: "stage", taskId, stageId }),
    onPlan: (cardId, stageId) => show({ type: "plan", cardId, ...(stageId === undefined ? {} : { focus: stageId }) }),
    stageChat,
  };
  if (wide) {
    const close = () => {
      setPinned(undefined);
      setMode("closed");
      if (done === undefined) pageStageSide().set("closed");
      pageProjectSide().set("closed");
    };
    return {
      bar: null,
      side: {
        open: mode !== "closed",
        close,
        chip: (
          <span className="stage-head-chip" data-stage-bar={done !== undefined ? "done" : "live"}>
            <StageChip
              graph={graph}
              selected={selected}
              progress={progress}
              open={mode !== "closed"}
              ping={ping}
              done={done}
              onTap={() => {
                if (mode !== "closed") {
                  close();
                  return;
                }
                setMode("half");
                if (done === undefined) pageStageSide().set("open");
              }}
            />
          </span>
        ),
        title: (
          <>
            {t("ui.stageDrawer.sideTitle")}
            {graph.kind !== "live" && <span className="md-side-wait">{t("ui.stageDrawer.sideAwaiting")}</span>}
            {caption !== undefined && <span className="md-side-wait">{caption}</span>}
          </>
        ),
        body: <StageSideBody graph={graph} selected={selected} onSelect={setPinned} onDetail={openStage} counts={counts} />,
      },
      onChatPointerDown: undefined,
      onFocusChat,
      onStep,
      selected,
      chat,
    };
  }
  const shown = live.find((n) => n.id === selected) ?? live[0];
  return {
    bar: (
      <>
        <div className={`stage-bar-line${done !== undefined ? " stage-bar-done" : ""}`} data-stage-bar={done !== undefined ? "done" : "live"}>
          <StageChip graph={graph} selected={selected} progress={progress} open={mode !== "closed"} ping={ping} done={done} onTap={onTap} />
          {done === undefined && graph.kind === "live" && shown && <span className="stage-bar-name">{shown.title}</span>}
          {caption !== undefined && <span className="stage-bar-task">{caption}</span>}
        </div>
        <StageDrawer
          graph={graph}
          mode={mode}
          onMode={(m) => {
            setMode(m);
            if (m === "closed") {
              setPinned(undefined);
              if (done === undefined) pageStageSide().set("closed");
            }
          }}
          selected={selected}
          onSelect={setPinned}
          onDetail={openStage}
          counts={counts}
        />
      </>
    ),
    onChatPointerDown: mode === "full" ? () => setMode("half") : undefined,
    onFocusChat,
    onStep,
    selected,
    chat,
  };
}

/** 会话报来正在看的那一条：没变就不重画 */
function setFocusIfChanged(set: (f: (prev: { id?: string | undefined; bottom: boolean }) => { id?: string | undefined; bottom: boolean }) => void) {
  return (id: string | undefined, bottom: boolean) => set((f) => (f.id === id && f.bottom === bottom ? f : { id, bottom }));
}
