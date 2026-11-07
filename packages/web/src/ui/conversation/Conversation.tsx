/**
 * 会话组件：秘书聊天、任务和项目的负责人会话共用这一个。
 * 负责人会话多出工单分隔线（work_order_divider part）、阶段抽屉（由外面的任务详情放在会话上方或左侧）
 * 和直接下指令的输入框；输入框左边的"＋"附件菜单（含"作为材料投喂"，见 Composer.tsx）三处都有。
 *
 * 是一镜到底的缩放（ui/zoom/ZoomHistory.tsx）：双指捏合、Ctrl/⌘ + 滚轮、
 * 标题栏的 ▤ / 💬（ZoomToggle），在对话层、要点层、全局层三档之间吸附；缩小后输入框淡出，换成一条图例。取代了
 * 分段按钮和要点层、全局层两套单独的渲染。缩小着的时候，鸿蒙 App 的返回键先放大回对话层（返回栈，
 * level>0 → zoomTo(0)）。档位整页一份（ui/zoom/zoom-level.ts）：换了会话档位照旧——换了会话是重新挂上，
 * 从记着的那一档开始，停在最新一条；往上翻、到达动效这些按会话从头来。
 *
 * 条目来自会话条目层（chatItems），对话层怎么画在 ChatItemView。照旧的：打开时只有最近一页，往上翻经 HTTP 取更早的
 * （锚点保持不动，缩小状态下也一样）；打开后才到的条目播到达动效；日期分隔线；连接断了的提示；输入框（只读时换成说明）。
 * 用语音回复的那一轮，会话末尾标一行"正在回复…"（回复的文字不流式显示）；合成语音时标"正在合成语音…"。
 * 分段合成：第一段到了，"正在合成语音…"换成合成中的语音气泡（时长随已到的段增长，能边收边播），合成完了换成那条语音消息。
 * 挂着时登记"开着这个会话"，新到的 agent 语音只在开着的会话里自动播放（app/voice-autoplay.ts）。
 * 缩小后条外的装饰——右侧标注的 ×N、左侧任务卡或工单卡（点开看完整情况）、底色带（任务的负责人会话按任务、
 * 项目负责人的会话按工单段、秘书主线按天）、长程任务每个阶段一轮一段的书脊；数据由状态层的 zoomDecor 给，画法在 ZoomHistory。
 * 长程任务的会话（stageChat）按阶段成框——你说的、Agent 说的、计划和出错照常显示，其余每个阶段收成一个框
 * （状态层 stageBoxes 给，框怎么画在 StageBox.tsx，三档里怎么摆在 ZoomHistory），框上"验收和规则 ›"
 * 经 onStage 打开阶段详情。
 * 流程的会话（workflowTaskId）在历史底部画"接下来的计划"虚线框（固定计划的 zh-future，ui/zoom/future.tsx；
 * 定时触发的流程按这一次运行算）。
 * 每一条都能点开详情（onDetail，给的是会话条目层的条目 id）；"在对话中定位"由详情页经 ref 调 reveal(条目 id)
 * （缩小着的先放大回对话层，闪一下带外框）；宽屏上缩小着点一条，放大回去的同时打开它的详情。
 * 看到哪了（onSeen，秘书页的已读位置）——对话层报的那一条（视口 40% 高处）和是不是停在最底部，换成看过了的最后一个序号
 * （状态层的 seenThrough），条目变了（定稿的回复替换了正在生成的、高度没变）也按上一次的位置再算一遍；输入框上面可以再放栏
 * （aboveComposer：秘书页的"不在时念的语音"），排在"等你处理"栏下面、连接提示上面，缩小时和输入框一起淡出。
 *
 * 页面给了 inbox（这个会话是哪个任务、项目、秘书的）就在输入框上面挂一条"等你处理"栏（InboxBar.tsx）——还没处理、
 * 来源是这个会话的待办事项在这里直接处理（通知点动作，卡片定位到会话里的那张卡）；只读的会话照样有。
 *
 * 缩小后 ⑂ 点得开（废弃分支按主线同一套样子画出来，点分支经 showDetail 打开它的详情），"切换到这条分支"交给守护进程
 * （只读的会话不能切）；切换带进来的条目不播到达动效（切换有自己的双向动画，ZoomHistory）。
 *
 * 二狗在回复时输入框上有"停止"、发送钮写"追加"；回复中发的话排队，在聊天区最下面显示成虚线气泡（排队中），能叉掉、
 * 长按（电脑上按住）拖动改顺序（QueueDragProvider，queue-drag.tsx），这一轮做完交出去时原地换成正常气泡。
 *
 * 页面接一个会话：const [conversationRef, detail] = useConversationPane(wide, 会话)；标题栏放 <ZoomToggle handle={conversationRef} />
 * （任务会话加 onlyZoomedOut），会话组件接 <Conversation ref={conversationRef} wide={wide} onDetail={detail.open} … />，
 * 外面包 <DetailLayout wide detail={detail} conversation={会话}>。
 */
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { useOpenConversation } from "../../app/page-voice.ts";
import { useRevealHistory } from "../../app/reveal-history.ts";
import { onRevealAgain } from "./reveal-again.ts";
import { useStore } from "../../app/store.tsx";
import {
  asksOffIn,
  agentVoicePhase,
  assistantNameOf,
  branchEpochStart,
  currentBranch,
  type BrowsingContext,
  type ChatItem,
  chatItems,
  maskUnavailable,
  modelRetryIn,
  type ModelRetryLine,
  type ConnectionStatus,
  type ConversationId,
  conversationRuntime,
  type DetailTarget,
  type InboxPlace,
  olderHistory,
  queuedMessages,
  quotedCards,
  replyingIn,
  revealTargetId,
  runtimeSupports,
  seenThrough,
  stageBoxes,
  type StageBoxStage,
  streamingAgentVoices,
  t,
  tTable,
  type ZoomBlock,
  workflowFuture,
  workflowProgress,
  zoomDecor,
} from "../../state/index.ts";
import { type DetailController, useDetail } from "../detail/DetailLayout.tsx";
import { Icon } from "../icons.tsx";
import { useRuntimes } from "../runtimes.tsx";
import { useToast } from "../toast.tsx";
import { type BranchActions, type OlderHistory, ZoomHistory, type ZoomHistoryHandle } from "../zoom/ZoomHistory.tsx";
import { currentZoomLevel, setZoomLevel, useZoomLevel } from "../zoom/zoom-level.ts";
import { zoomOutHint } from "../zoom/hint.ts";
import { WorkflowFutureBox } from "../zoom/future.tsx";
import { StageFocus } from "../cards/PlanStages.tsx";
import { ChatItemView, ZoomBlockView } from "./ChatItemView.tsx";
import { type ComposerMode, ComposerSlot } from "./Composer.tsx";
import { conversationRootProps } from "./conversation-root.ts";
import { InboxBar } from "./InboxBar.tsx";
import { QueueDragProvider } from "./queue-drag.tsx";
import { StreamingAgentVoiceBubble } from "./VoiceBubble.tsx";
import { useUnavailable } from "../../plugins/react.tsx";

export type ConversationMode = ComposerMode;

/**
 * 会话组件对外的句柄：标题栏的 ▤ / 💬 缩放（zoomTo），详情页的"在对话中定位"（reveal：缩小着的先放大回对话层，
 * 滚到视口 30% 高处，闪一下），自己发了消息之后接着跟最新的走（followLatest）
 */
export type ConversationHandle = ZoomHistoryHandle;

/** 从待办跳过来定位之前，等开场的排版稳下来（毫秒） */
const REVEAL_SETTLE_MS = 300;

/** 用语音回复时会话末尾的提示 */
const VOICE_PHASE_LABEL = tTable({ replying: "ui.conversation.voicePhase.replying", synthesizing: "ui.conversation.voicePhase.synthesizing" });

/** 模型出错、正在自动重试时会话末尾那一行（按出错的种类说）：第几次 */
const MODEL_RETRY_KEY = { busy: "ui.conversation.modelRetry.busy", timeout: "ui.conversation.modelRetry.timeout", error: "ui.conversation.modelRetry.error" } as const;

function ModelRetryNote({ retry }: { retry: ModelRetryLine }) {
  return (
    <div className="msg assistant zh-tail">
      <div className="model-retry muted" role="status">
        <Icon name="reload" />
        <span>{t(MODEL_RETRY_KEY[retry.kind], { attempt: retry.attempt })}</span>
      </div>
    </div>
  );
}

interface ConversationProps {
  conversation: ConversationId;
  mode: ConversationMode;
  /** 宽屏：缩小着点一条时同时打开它的详情 */
  wide: boolean;
  /** 打开某一条的详情（会话条目层的条目 id：条目、组里某一步） */
  onDetail?: ((id: string) => void) | undefined;
  /** 会话历史的句柄（useConversationPane 给的）：标题栏的 ▤ / 💬、详情页的"在对话中定位"经它 */
  ref: RefObject<ConversationHandle | null>;
  /** 只读（比如已归档项目的负责人会话）：不显示输入框 */
  readOnly?: boolean;
  /** 只读时在输入框的位置显示的说明 */
  readOnlyNote?: string;
  /**
   * 在哪个任务的详情里：发的话带上它——项目的负责人的会话里同时有几件事，项目内部的普通任务做完了在它的详情里接着说，
   * 守护进程据此认出说的是这件事、让它接着做。别的会话不用给
   */
  taskId?: string | undefined;
  /** 输入框的占位（不给就用输入框默认的） */
  composerPlaceholder?: string | undefined;
  /** 流程的会话：这个流程任务——历史底部画"接下来的计划"虚线框 */
  workflowTaskId?: string | undefined;
  /** 对话层滚动时屏幕上正在看的那一条（视口 40% 高处）、是不是停在最新一条（长程任务标题栏的阶段标签跟着它变） */
  onFocusChat?: ((chatId: string | undefined, atBottom: boolean) => void) | undefined;
  /** 长程任务的会话：这个任务——会话按阶段成框（原型的假任务连同假阶段、假的活动状态） */
  stageChat?: { taskId: string; list?: readonly StageBoxStage[] | undefined; running?: boolean | undefined; shared?: boolean | undefined } | undefined;
  /** 阶段框上的"验收和规则 ›"：打开这一阶段的详情 */
  onStage?: ((stageId: string) => void) | undefined;
  /** 聊天里计划卡的提纲点了某一阶段：左边图上高亮它 */
  onStep?: ((stageId: string) => void) | undefined;
  /** 计划卡的提纲里"这一阶段的详情 ›""更多在详情里 ›"：打开这张卡的计划详情、定位到这一阶段 */
  onPlan?: ((cardId: string, stageId?: string) => void) | undefined;
  /** 从待办跳过来要定位的那一条（卡片 id 或工具调用 id，地址里 /at/ 后面的）；会话里有了它就定位过去、闪一下，只定位一次 */
  revealAt?: string | undefined;
  /**
   * 这个会话是哪个任务、项目、秘书的：给了就在输入框上面挂"等你处理"栏，列出还没处理、来源是这个会话的待办事项。
   * 已归档项目这种只读的会话照样挂（删除项目的确认还要点）
   */
  inbox?: InboxPlace | undefined;
  /** 对话层看到了哪个序号（秘书页的已读位置；停在最底部是会话收到的最后一个序号） */
  onSeen?: ((seq: number) => void) | undefined;
  /** 输入框上面的栏（秘书页的"不在时念的语音"）：排在"等你处理"栏下面、连接提示上面 */
  aboveComposer?: ReactNode;
  /** 浏览侧边栏里：发的每条消息带上这时的网页上下文（网址、标题、选中的框） */
  browsing?: (() => BrowsingContext) | undefined;
  /** 打开会话外的一页详情（页面的 detail.show）：点了展开的废弃分支打开它的详情；不给（没有详情栏的地方）点了没反应 */
  showDetail?: ((target: DetailTarget) => void) | undefined;
}

export function Conversation(props: ConversationProps) {
  // 换了会话：往上翻、到达动效从头来；档位照旧（整页一份）
  return <ConversationView key={props.conversation} {...props} />;
}

function ConversationView({
  conversation,
  mode,
  wide,
  onDetail,
  ref,
  readOnly = false,
  readOnlyNote = t("ui.conversation.readOnly"),
  taskId,
  composerPlaceholder,
  workflowTaskId,
  onFocusChat,
  stageChat,
  onStage,
  onStep,
  onPlan,
  revealAt,
  inbox,
  onSeen,
  aboveComposer,
  browsing,
  showDetail,
}: ConversationProps) {
  const { sendMessage, loadOlder, quoteCard, unquoteCard, stopReply, removeQueued, reorderQueued, switchBranch, ui } = useStore();
  // 排队的消息：叉掉、拖完的顺序交给守护进程；拖动时在会话里量气泡的位置
  const rootRef = useRef<HTMLDivElement>(null);
  const queue = queuedMessages(ui, conversation);
  const queuedIds = useMemo(() => queue.map((q) => q.message.id), [queue]);
  const replying = replyingIn(ui, conversation);
  const onRemoveQueued = useCallback((id: string) => removeQueued(conversation, id), [removeQueued, conversation]);
  const onReorderQueued = useCallback((ids: string[]) => reorderQueued(conversation, ids), [reorderQueued, conversation]);
  // 开着这个会话：新到的 agent 语音只在开着的会话里自动播放
  useOpenConversation(conversation);
  // 负责人用的运行时不支持的（Claude Code 还不能撤回、切换分支）：不放这些按钮
  const runtimes = useRuntimes();
  const runtime = conversationRuntime(ui, conversation);
  const canRollback = runtimeSupports(runtimes, runtime, "rollback");
  const canSwitchBranch = runtimeSupports(runtimes, runtime, "branch_switch");
  // 停用的网页插件拥有的条目（调用记忆、提醒卡……）换成一行占位，各层都照它画
  const unavailable = useUnavailable();
  const items = useMemo(() => maskUnavailable(chatItems(ui, conversation), unavailable), [ui, conversation, unavailable]);
  // 缩小后条外的装饰：×N、左侧任务卡或工单卡、底色带、书脊、重开之前的那几轮
  const decor = useMemo(() => zoomDecor(ui, conversation, items), [ui, conversation, items]);
  // 长程任务的会话按阶段成框：重开之前那几轮的框写已作废
  const boxes = useMemo(
    () => (stageChat === undefined ? undefined : stageBoxes(ui, items, stageChat.taskId, { stale: decor.stale, list: stageChat.list, running: stageChat.running, shared: stageChat.shared })),
    [ui, items, stageChat, decor],
  );
  // 流程的"接下来的计划"：还没做完的步骤；定时触发的流程按这一次运行
  const future = useMemo(() => (workflowTaskId === undefined ? undefined : workflowFuture(ui, workflowTaskId, items)), [ui, workflowTaskId, items]);
  const futureRun = workflowTaskId === undefined ? undefined : workflowProgress(ui, workflowTaskId)?.run?.no;
  const voicePhase = agentVoicePhase(ui, conversation);
  const modelRetry = modelRetryIn(ui, conversation);
  const streamingVoices = streamingAgentVoices(ui, conversation);
  const toast = useToast();
  // 缩小着时挂一层返回：鸿蒙的返回键先放大回对话层
  const level = useZoomLevel();
  useBackLayer("overlay", level > 0, () => ref.current?.zoomTo(0));
  // 宽屏上缩小着点一条：放大回去的同时打开它的详情（wide && precise && showDetail）
  // 点的是缩小后组里的一块：id 是那次调用的，打开的就是这一次调用的详情
  const onZoomTap = useCallback((id: string, precise: boolean) => {
    if (wide && precise) onDetail?.(id);
  }, [wide, onDetail]);

  // 从待办跳过来的，定位到那张卡、那次调用。条目还没到（历史还在补发）就等它第一次出现在列表里再定位；
  // 等开场的排版稳一稳再滚过去，免得被"跟着最新一条"滚回底部。计时只跟着"目标在不在"走，别的频道来事件、agent 一直在出字
  // 都不重来；同一个地址只定位一次（之后用户自己滚）
  const targetId = useMemo(() => (revealAt ? revealTargetId(items, revealAt) : undefined), [items, revealAt]);
  // 还不在手里（在更早的历史里：素材出处的那条消息）：往前取几页直到它出现
  useRevealHistory(conversation, revealAt, targetId !== undefined);
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    // 离开了这个地址再回来算新的一次（标题上的"等你……"点过一次，切走再点）
    if (!revealAt) revealed.current = undefined;
    if (!revealAt || targetId === undefined || revealed.current === revealAt) return;
    const timer = setTimeout(() => {
      revealed.current = revealAt;
      ref.current?.reveal(targetId);
    }, REVEAL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [revealAt, targetId, ref]);

  // 打开时已经有的、以及打开后一小会儿陆续补发进来的，都算历史，不播到达动效（look.css 第 4 条）
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  // 地址没变、又点了一次标题上的"等你……"：再滚过去、闪一下
  useEffect(
    () =>
      onRevealAgain((at) => {
        if (at !== revealAt) return;
        const again = revealTargetId(itemsRef.current, at);
        if (again !== undefined) ref.current?.reveal(again);
      }),
    [revealAt, ref],
  );

  // 看到哪了：对话层报的位置换成序号；条目、会话收到的最后一个序号变了，按上一次报的位置再算一遍
  // （定稿的回复替换正在生成的那条时高度可能没变，对话层不会再报）
  const cursor = ui.cursors[conversation];
  const focus = useRef<{ chatId: string | undefined; atBottom: boolean } | undefined>(undefined);
  const seenRef = useRef(onSeen);
  const cursorRef = useRef(cursor);
  useEffect(() => {
    seenRef.current = onSeen;
    cursorRef.current = cursor;
  });
  const reportSeen = useCallback(() => {
    const f = focus.current;
    if (!f || !seenRef.current) return;
    const seq = seenThrough(itemsRef.current, f.chatId, f.atBottom, cursorRef.current);
    if (seq !== undefined) seenRef.current(seq);
  }, []);
  const onFocus = useCallback(
    (chatId: string | undefined, atBottom: boolean) => {
      onFocusChat?.(chatId, atBottom);
      focus.current = { chatId, atBottom };
      reportSeen();
    },
    [onFocusChat, reportSeen],
  );
  useEffect(() => {
    const f = focus.current;
    if (!f || !onSeen) return;
    const seq = seenThrough(items, f.chatId, f.atBottom, cursor);
    if (seq !== undefined) onSeen(seq);
  }, [items, cursor, onSeen]);
  const [history, setHistory] = useState<Set<string> | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setHistory(new Set(itemsRef.current.map((it) => it.id))), 600);
    return () => clearTimeout(timer);
  }, []);
  // 打开之后才到的、排在历史最后一条之后的条目才播到达动效；往上翻插进来的更早的不播；
  // 切换分支带进来的（序号在这次切换之前）也不播——切换有自己的双向动画
  const lastHistoryIndex = history === null ? -1 : items.findLastIndex((it) => history.has(it.id));
  const epochStart = branchEpochStart(ui, conversation);
  const isFresh = (it: ChatItem, i: number) => history !== null && i > lastHistoryIndex && !history.has(it.id) && (it.seq === undefined || it.seq >= epochStart);

  // 废弃分支：⑂ 展开、点分支打开详情；只读的会话不能切
  const branches = useMemo<BranchActions>(
    () => ({
      conversation,
      open: showDetail && ((branchId: string) => showDetail({ type: "branch", branchId })),
      switchTo: readOnly || !canSwitchBranch ? undefined : (branchId: string) => switchBranch(conversation, branchId),
    }),
    [conversation, showDetail, readOnly, switchBranch, canSwitchBranch],
  );

  // 日期分隔线：正在生成的回复还没有时间，不单独分天
  const days = useMemo(() => {
    const out = new Map<string, string>();
    let prev: string | undefined;
    for (const it of items) {
      const day = it.time?.slice(0, 10) ?? prev;
      if (day !== undefined && day !== prev) out.set(it.id, day);
      prev = day;
    }
    return out;
  }, [items]);
  const above = (it: ChatItem) => {
    const day = days.get(it.id);
    return day ? <div className="day-sep zh-sep">{t("ui.conversation.daySep", { month: day.slice(5, 7), day: day.slice(8, 10) })}</div> : undefined;
  };

  // 往上翻：更早的一页
  const older = olderHistory(ui, conversation);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderHistoryState: OlderHistory = {
    canLoad: older.canLoadOlder,
    loading: loadingOlder,
    load: () => {
      setLoadingOlder(true);
      loadOlder(conversation)
        .catch((err: unknown) => toast(t("ui.conversation.loadOlderFailed", { error: err instanceof Error ? err.message : String(err) })))
        .finally(() => setLoadingOlder(false));
    },
  };

  // 卡片可以"引用"到输入框：只读的会话没有输入框，也就不能引用
  // 画一条的函数尽量不变：没变的条目不重画（ZoomHistory 里条目是 memo 的）
  const actions = useMemo(
    () => ({ onDetail, onQuote: readOnly ? undefined : (cardId: string) => quoteCard(conversation, cardId) }),
    [onDetail, readOnly, quoteCard, conversation],
  );
  const renderItem = useCallback((it: ChatItem) => <ChatItemView item={it} actions={actions} />, [actions]);
  const stepFocus = useMemo(() => ({ ...(onStep ? { onStep } : {}), ...(onStage ? { onStage } : {}), ...(onPlan ? { openPlan: onPlan } : {}) }), [onStep, onStage, onPlan]);
  // 缩小后组里的一块：只在跨档淡入淡出时看得见，不用接点击
  const renderBlock = useCallback((block: ZoomBlock) => <ZoomBlockView block={block} />, []);
  return (
    // 给风格用的 data-mode、--assistant-initial（不改样子），见 conversation-root.ts
    <div className="conv" ref={rootRef} {...conversationRootProps(mode, assistantNameOf(ui))}>
      {/* 聊天里计划卡的提纲点了某一阶段：左边图上高亮它（StageFocus 见 cards/PlanStages.tsx） */}
      <QueueDragProvider ids={queuedIds} root={rootRef} onRemove={onRemoveQueued} onReorder={onReorderQueued}>
      <StageFocus.Provider value={stepFocus}>
      <ZoomHistory
        ref={ref}
        initialLevel={currentZoomLevel()}
        items={items}
        renderItem={renderItem}
        renderBlock={renderBlock}
        above={above}
        isFresh={isFresh}
        older={olderHistoryState}
        onLevelChange={setZoomLevel}
        onZoomTap={onZoomTap}
        onFocusChat={onFocusChat || onSeen ? onFocus : undefined}
        decor={decor}
        onDetail={onDetail}
        boxes={boxes}
        onStage={onStage}
        // 会话回退：只读的会话（详情页里看的）不能回退；负责人用的运行时不能撤回的也不放
        rollbackIn={readOnly || !canRollback ? undefined : conversation}
        branches={branches}
        currentBranch={currentBranch(ui, conversation)}
        future={future && <WorkflowFutureBox future={future} run={futureRun} asksOff={asksOffIn(ui)} />}
        empty={<div className="page-placeholder">{t("ui.conversation.empty", { hint: zoomOutHint() })}</div>}
        head={
          older.canLoadOlder && (
            <button type="button" className="link older-btn zh-older" disabled={loadingOlder} onClick={olderHistoryState.load}>
              {loadingOlder ? t("ui.conversation.loadingOlder") : t("ui.conversation.loadOlder")}
            </button>
          )
        }
        tail={
          <>
            {streamingVoices.map((voice) => (
              <div key={`agent-voice:${voice.id}`} className="msg assistant zh-tail">
                <div className="msg-part part-tts_audio">
                  <StreamingAgentVoiceBubble voice={voice} />
                </div>
              </div>
            ))}
            {voicePhase && (
              <div className="msg assistant zh-tail">
                <div className="voice-synth muted">{VOICE_PHASE_LABEL[voicePhase]}</div>
              </div>
            )}
            {/* 模型出错、正在自动重试：一行小字，接着回出字来、这一轮结束就收起 */}
            {modelRetry && <ModelRetryNote retry={modelRetry} />}
          </>
        }
        footer={
          <>
            {/* 等你处理：在连接提示、输入框上面，正常占位，不盖住会话 */}
            {inbox && <InboxBar place={inbox} items={items} onReveal={(id) => ref.current?.reveal(id)} />}
            {/* 不在时念的语音：和"等你处理"栏上下排着，各占一行 */}
            {aboveComposer}
            <ConnectionNote status={ui.connection} caughtUp={ui.caughtUp} />
            <ComposerSlot
              readOnly={readOnly}
              readOnlyNote={readOnlyNote}
              conversation={conversation}
              mode={mode}
              quoted={quotedCards(ui, conversation)}
              onUnquote={(cardId) => unquoteCard(conversation, cardId)}
              {...(composerPlaceholder === undefined ? {} : { placeholder: composerPlaceholder })}
              replying={replying}
              onStop={() => stopReply(conversation)}
              onSend={(parts) => {
                ref.current?.followLatest();
                sendMessage(conversation, parts, taskId, browsing?.());
              }}
            />
          </>
        }
      />
      </StageFocus.Provider>
      </QueueDragProvider>
    </div>
  );
}

/** 打开、重连上之后补了这么久还没补完，才提示"正在同步"（很快补完的不闪一下） */
const SYNCING_NOTE_DELAY_MS = 800;

/**
 * 连接断了或页面过旧时，在输入框上方提示一行；打开、重连上之后还在补（补完之前界面照上一次的样子，不画中间状态），
 * 补了一会儿还没补完时轻轻提示一行"正在同步"
 */
function ConnectionNote({ status, caughtUp }: { status: ConnectionStatus; caughtUp: boolean }) {
  const syncing = (status === "connecting" || status === "online") && !caughtUp;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!syncing) return;
    const timer = setTimeout(() => setSlow(true), SYNCING_NOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [syncing]);
  if (status === "offline") return <div className="conn-note">{t("ui.conversation.offline")}</div>;
  if (status === "outdated") return <div className="conn-note conn-outdated">{t("ui.conversation.outdated")}</div>;
  if (syncing && slow) return <div className="conn-note conn-syncing">{t("ui.conversation.syncing")}</div>;
  return null;
}

/**
 * 页面接一个会话：会话历史的句柄和这个会话的详情页。句柄给会话组件（ref）、标题栏的 ZoomToggle；
 * 详情页的"在对话中定位"也经它
 */
export function useConversationPane(wide: boolean, conversation: ConversationId | undefined): [RefObject<ConversationHandle | null>, DetailController] {
  const ref = useRef<ConversationHandle | null>(null);
  const detail = useDetail(wide, conversation, ref);
  return [ref, detail];
}

/**
 * 标题栏的 ▤ / 💬：对话层显示 ▤，点了缩到全局层；缩小后显示 💬，点了回到对话层。
 * 两个符号换成共用的线条图标（ui/icons.tsx 的 overview、chat），按钮照旧靠 aria-label 说清是什么。
 * onlyZoomedOut：任务的负责人会话在对话层不显示，缩小后才出现；秘书和项目会话一直显示
 */
export function ZoomToggle({ handle, onlyZoomedOut = false }: { handle: RefObject<ConversationHandle | null>; onlyZoomedOut?: boolean | undefined }) {
  const level = useZoomLevel();
  if (onlyZoomedOut && level === 0) return null;
  return (
    <button type="button" className="icon-btn" onClick={() => handle.current?.zoomTo(level === 0 ? 2 : 0)} aria-label={level === 0 ? t("ui.conversation.zoomOut") : t("ui.conversation.zoomIn")}>
      <Icon name={level === 0 ? "overview" : "chat"} />
    </button>
  );
}
