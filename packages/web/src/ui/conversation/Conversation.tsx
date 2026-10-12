/**
 * 会话组件：秘书聊天、任务和项目的维护者会话共用这一个。
 * 维护者会话多出工单分隔线（work_order_divider part）、阶段抽屉（由外面的任务详情放在会话上方或左侧）
 * 和直接下指令的输入框；秘书的输入框多一个附件菜单（含"作为材料投喂"，见 Composer.tsx）。
 *
 * 54 号票起是一镜到底的缩放（规格第 19 节"会话区照搬 AgentSense"，ui/zoom/ZoomHistory.tsx）：双指捏合、Ctrl/⌘ + 滚轮、
 * 标题栏的 ▤ / 💬（ZoomToggle），在对话层、要点层、全局层三档之间吸附；缩小后输入框淡出，换成一条图例。取代了 25 号票的
 * 分段按钮和要点层、全局层两套单独的渲染。缩小着的时候，鸿蒙 App 的返回键先放大回对话层（62 号票的返回栈，照搬 AgentSense 的
 * level>0 → zoomTo(0)）。档位整页一份（ui/zoom/zoom-level.ts）：照 AgentSense，换了会话档位照旧——二狗换了会话是重新挂上，
 * 从记着的那一档开始，停在最新一条；往上翻、到达动效这些按会话从头来。
 *
 * 条目来自 52 号票的会话条目层（chatItems），对话层怎么画在 ChatItemView。照旧的：打开时只有最近一页，往上翻经 HTTP 取更早的
 * （锚点保持不动，缩小状态下也一样）；打开后才到的条目播到达动效；日期分隔线；连接断了的提示；输入框（只读时换成说明）。
 * 32 号票起：用语音回复的那一轮，会话末尾标一行"正在回复…"（回复的文字不流式显示）；合成语音时标"正在合成语音…"。
 * 38 号票起分段合成：第一段到了，"正在合成语音…"换成合成中的语音气泡（时长随已到的段增长，能边收边播），合成完了换成那条语音消息。
 * 36 号票起：挂着时登记"开着这个会话"，新到的 agent 语音只在开着的会话里自动播放（app/voice-autoplay.ts）。
 * 55 号票起：缩小后条外的装饰照搬 AgentSense——右侧标注的 ×N、左侧任务卡或工单卡（点开看完整情况）、底色带（任务的维护者会话按任务、
 * 项目维护者的会话按工单段、秘书主线按天）、长程任务每个阶段一轮一段的书脊；数据由状态层的 zoomDecor 给，画法在 ZoomHistory。
 * 91 号票起：长程任务的会话（stageChat）按阶段成框——你说的、Agent 说的、计划和出错照常显示，其余每个阶段收成一个框
 * （照搬 AgentSense stageBox.tsx；状态层 stageBoxes 给，框怎么画在 StageBox.tsx，三档里怎么摆在 ZoomHistory），框上"验收和规则 ›"
 * 经 onStage 打开阶段详情。
 * 60 号票起：流程的会话（workflowTaskId）在历史底部画"接下来的计划"虚线框（照搬 AgentSense 固定计划的 zh-future，ui/zoom/future.tsx；
 * 定时触发的流程按这一次运行算）。
 * 56 号票起：每一条都能点开详情（onDetail，给的是会话条目层的条目 id）；"在对话中定位"由详情页经 ref 调 reveal(条目 id)
 * （缩小着的先放大回对话层，闪一下带外框）；宽屏上缩小着点一条，放大回去的同时打开它的详情（照 AgentSense 的 onZoomTap）。
 *
 * 页面接一个会话：const [conversationRef, detail] = useConversationPane(wide, 会话)；标题栏放 <ZoomToggle handle={conversationRef} />
 * （任务会话加 onlyZoomedOut），会话组件接 <Conversation ref={conversationRef} wide={wide} onDetail={detail.open} … />，
 * 外面包 <DetailLayout wide detail={detail} conversation={会话}>。
 */
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { useOpenConversation } from "../../app/page-voice.ts";
import { useStore } from "../../app/store.tsx";
import {
  agentVoicePhase,
  assistantNameOf,
  type ChatItem,
  chatItems,
  type ConnectionStatus,
  type ConversationId,
  olderHistory,
  quotedCards,
  revealTargetId,
  stageBoxes,
  type StageBoxStage,
  streamingAgentVoices,
  type ZoomBlock,
  workflowFuture,
  workflowProgress,
  zoomDecor,
} from "../../state/index.ts";
import { type DetailController, useDetail } from "../detail/DetailLayout.tsx";
import { useToast } from "../toast.tsx";
import { type OlderHistory, ZoomHistory, type ZoomHistoryHandle } from "../zoom/ZoomHistory.tsx";
import { currentZoomLevel, setZoomLevel, useZoomLevel } from "../zoom/zoom-level.ts";
import { zoomOutHint } from "../zoom/hint.ts";
import { WorkflowFutureBox } from "../zoom/future.tsx";
import { StageFocus } from "../cards/PlanStages.tsx";
import { ChatItemView, ZoomBlockView } from "./ChatItemView.tsx";
import { Composer, type ComposerMode } from "./Composer.tsx";
import { conversationRootProps } from "./conversation-root.ts";
import { StreamingAgentVoiceBubble } from "./VoiceBubble.tsx";

export type ConversationMode = ComposerMode;

/**
 * 会话组件对外的句柄：标题栏的 ▤ / 💬 缩放（zoomTo），详情页的"在对话中定位"（reveal：缩小着的先放大回对话层，
 * 滚到视口 30% 高处，闪一下），自己发了消息之后接着跟最新的走（followLatest）
 */
export type ConversationHandle = ZoomHistoryHandle;

/** 从待办跳过来定位之前，等开场的排版稳下来（毫秒） */
const REVEAL_SETTLE_MS = 300;

/** 用语音回复时会话末尾的提示 */
const VOICE_PHASE_LABEL = { replying: "正在回复…", synthesizing: "正在合成语音…" } as const;

interface ConversationProps {
  conversation: ConversationId;
  mode: ConversationMode;
  /** 宽屏：缩小着点一条时同时打开它的详情 */
  wide: boolean;
  /** 打开某一条的详情（会话条目层的条目 id：条目、组里某一步） */
  onDetail?: ((id: string) => void) | undefined;
  /** 会话历史的句柄（useConversationPane 给的）：标题栏的 ▤ / 💬、详情页的"在对话中定位"经它 */
  ref: RefObject<ConversationHandle | null>;
  /** 只读（比如已归档项目的维护者会话）：不显示输入框 */
  readOnly?: boolean;
  /** 只读时在输入框的位置显示的说明 */
  readOnlyNote?: string;
  /**
   * 在哪个任务的详情里（75 号票）：发的话带上它——项目的维护者的会话里同时有几件事，项目内部的普通任务做完了在它的详情里接着说，
   * 守护进程据此认出说的是这件事、让它接着做。别的会话不用给
   */
  taskId?: string | undefined;
  /** 输入框的占位（不给就用输入框默认的） */
  composerPlaceholder?: string | undefined;
  /** 流程的会话（60 号票）：这个流程任务——历史底部画"接下来的计划"虚线框 */
  workflowTaskId?: string | undefined;
  /** 对话层滚动时屏幕上正在看的那一条（视口 40% 高处）、是不是停在最新一条（91 号票：长程任务标题栏的阶段标签跟着它变） */
  onFocusChat?: ((chatId: string | undefined, atBottom: boolean) => void) | undefined;
  /** 长程任务的会话（91 号票）：这个任务——会话按阶段成框（原型的假任务连同假阶段、假的活动状态） */
  stageChat?: { taskId: string; list?: readonly StageBoxStage[] | undefined; running?: boolean | undefined } | undefined;
  /** 阶段框上的"验收和规则 ›"：打开这一阶段的详情 */
  onStage?: ((stageId: string) => void) | undefined;
  /** 聊天里计划卡的提纲点了某一阶段（91 号票）：左边图上高亮它 */
  onStep?: ((stageId: string) => void) | undefined;
  /** 计划卡的提纲里"这一阶段的详情 ›""更多在详情里 ›"（93 号票）：打开这张卡的计划详情、定位到这一阶段 */
  onPlan?: ((cardId: string, stageId?: string) => void) | undefined;
  /** 从待办跳过来要定位的那一条（105 号票：卡片 id 或工具调用 id，地址里 /at/ 后面的）；会话里有了它就定位过去、闪一下，只定位一次 */
  revealAt?: string | undefined;
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
  readOnlyNote = "这个会话只读",
  taskId,
  composerPlaceholder,
  workflowTaskId,
  onFocusChat,
  stageChat,
  onStage,
  onStep,
  onPlan,
  revealAt,
}: ConversationProps) {
  const { sendMessage, loadOlder, quoteCard, unquoteCard, ui } = useStore();
  // 开着这个会话：新到的 agent 语音只在开着的会话里自动播放（36 号票）
  useOpenConversation(conversation);
  const items = useMemo(() => chatItems(ui, conversation), [ui, conversation]);
  // 缩小后条外的装饰（55 号票）：×N、左侧任务卡或工单卡、底色带、书脊、重开之前的那几轮
  const decor = useMemo(() => zoomDecor(ui, conversation, items), [ui, conversation, items]);
  // 长程任务的会话按阶段成框（91 号票）：重开之前那几轮的框写已作废
  const boxes = useMemo(
    () => (stageChat === undefined ? undefined : stageBoxes(ui, items, stageChat.taskId, { stale: decor.stale, list: stageChat.list, running: stageChat.running })),
    [ui, items, stageChat, decor],
  );
  // 流程的"接下来的计划"（60 号票）：还没做完的步骤；定时触发的流程按这一次运行
  const future = useMemo(() => (workflowTaskId === undefined ? undefined : workflowFuture(ui, workflowTaskId, items)), [ui, workflowTaskId, items]);
  const futureRun = workflowTaskId === undefined ? undefined : workflowProgress(ui, workflowTaskId)?.run?.no;
  const voicePhase = agentVoicePhase(ui, conversation);
  const streamingVoices = streamingAgentVoices(ui, conversation);
  const toast = useToast();
  // 缩小着时挂一层返回：鸿蒙的返回键先放大回对话层
  const level = useZoomLevel();
  useBackLayer("overlay", level > 0, () => ref.current?.zoomTo(0));
  // 宽屏上缩小着点一条：放大回去的同时打开它的详情（AgentSense 的 onZoomTap：wide && precise && showDetail）
  // 点的是缩小后组里的一块（57 号票）：id 是那次调用的，打开的就是这一次调用的详情
  const onZoomTap = useCallback((id: string, precise: boolean) => {
    if (wide && precise) onDetail?.(id);
  }, [wide, onDetail]);

  // 105 号票：从待办跳过来的，定位到那张卡、那次调用。条目还没到（历史还在补发）就等它第一次出现在列表里再定位；
  // 等开场的排版稳一稳再滚过去，免得被"跟着最新一条"滚回底部。计时只跟着"目标在不在"走，别的频道来事件、agent 一直在出字
  // 都不重来；同一个地址只定位一次（之后用户自己滚）
  const targetId = useMemo(() => (revealAt ? revealTargetId(items, revealAt) : undefined), [items, revealAt]);
  const revealed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!revealAt || targetId === undefined || revealed.current === revealAt) return;
    const t = setTimeout(() => {
      revealed.current = revealAt;
      ref.current?.reveal(targetId);
    }, REVEAL_SETTLE_MS);
    return () => clearTimeout(t);
  }, [revealAt, targetId, ref]);

  // 打开时已经有的、以及打开后一小会儿陆续补发进来的，都算历史，不播到达动效（look.css 第 4 条）
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  const [history, setHistory] = useState<Set<string> | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setHistory(new Set(itemsRef.current.map((it) => it.id))), 600);
    return () => clearTimeout(t);
  }, []);
  // 打开之后才到的、排在历史最后一条之后的条目才播到达动效；往上翻插进来的更早的不播
  const lastHistoryIndex = history === null ? -1 : items.findLastIndex((it) => history.has(it.id));
  const isFresh = (it: ChatItem, i: number) => history !== null && i > lastHistoryIndex && !history.has(it.id);

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
    return day ? <div className="day-sep zh-sep">{day.slice(5).replace("-", " 月 ")} 日</div> : undefined;
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
        .catch((err: unknown) => toast(`加载更早的消息失败：${err instanceof Error ? err.message : String(err)}`))
        .finally(() => setLoadingOlder(false));
    },
  };

  // 卡片可以"引用"到输入框（21 号票）：只读的会话没有输入框，也就不能引用
  // 画一条的函数尽量不变：没变的条目不重画（ZoomHistory 里条目是 memo 的）
  const actions = useMemo(
    () => ({ onDetail, onQuote: readOnly ? undefined : (cardId: string) => quoteCard(conversation, cardId) }),
    [onDetail, readOnly, quoteCard, conversation],
  );
  const renderItem = useCallback((it: ChatItem) => <ChatItemView item={it} actions={actions} />, [actions]);
  const stepFocus = useMemo(() => ({ ...(onStep ? { onStep } : {}), ...(onStage ? { onStage } : {}), ...(onPlan ? { openPlan: onPlan } : {}) }), [onStep, onStage, onPlan]);
  // 缩小后组里的一块（57 号票）：只在跨档淡入淡出时看得见，不用接点击
  const renderBlock = useCallback((block: ZoomBlock) => <ZoomBlockView block={block} />, []);
  return (
    // 给风格用的 data-mode、--assistant-initial（40 号票，不改样子），见 conversation-root.ts
    <div className="conv" {...conversationRootProps(mode, assistantNameOf(ui))}>
      {/* 聊天里计划卡的提纲点了某一阶段：左边图上高亮它（91 号票，StageFocus 见 cards/PlanStages.tsx） */}
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
        onFocusChat={onFocusChat}
        decor={decor}
        onDetail={onDetail}
        boxes={boxes}
        onStage={onStage}
        future={future && <WorkflowFutureBox future={future} run={futureRun} />}
        empty={<div className="page-placeholder">还没有消息。有了消息之后，{zoomOutHint()}可以缩小看整个过程的全貌。</div>}
        head={
          older.canLoadOlder && (
            <button type="button" className="link older-btn zh-older" disabled={loadingOlder} onClick={olderHistoryState.load}>
              {loadingOlder ? "正在加载更早的消息…" : "加载更早的消息"}
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
          </>
        }
        footer={
          <>
            <ConnectionNote status={ui.connection} />
            {readOnly ? (
              <div className="composer composer-note muted">{readOnlyNote}</div>
            ) : (
              <Composer
                conversation={conversation}
                mode={mode}
                quoted={quotedCards(ui, conversation)}
                onUnquote={(cardId) => unquoteCard(conversation, cardId)}
                {...(composerPlaceholder === undefined ? {} : { placeholder: composerPlaceholder })}
                onSend={(parts) => {
                  ref.current?.followLatest();
                  sendMessage(conversation, parts, taskId);
                }}
              />
            )}
          </>
        }
      />
      </StageFocus.Provider>
    </div>
  );
}

/** 连接断了或页面过旧时，在输入框上方提示一行 */
function ConnectionNote({ status }: { status: ConnectionStatus }) {
  if (status === "offline") return <div className="conn-note">连接断开，正在重连…（发出的消息连上后会自动补发）</div>;
  if (status === "outdated") return <div className="conn-note conn-outdated">页面版本过旧，请刷新页面</div>;
  return null;
}

/**
 * 页面接一个会话：会话历史的句柄和这个会话的详情页（56 号票）。句柄给会话组件（ref）、标题栏的 ZoomToggle；
 * 详情页的"在对话中定位"也经它
 */
export function useConversationPane(wide: boolean, conversation: ConversationId | undefined): [RefObject<ConversationHandle | null>, DetailController] {
  const ref = useRef<ConversationHandle | null>(null);
  const detail = useDetail(wide, conversation, ref);
  return [ref, detail];
}

/**
 * 标题栏的 ▤ / 💬（照搬 AgentSense）：对话层显示 ▤，点了缩到全局层；缩小后显示 💬，点了回到对话层。
 * onlyZoomedOut：任务的维护者会话在对话层不显示，缩小后才出现（AgentSense 的里程碑会话，用户 2026-10-09 定）；秘书和项目会话一直显示
 */
export function ZoomToggle({ handle, onlyZoomedOut = false }: { handle: RefObject<ConversationHandle | null>; onlyZoomedOut?: boolean | undefined }) {
  const level = useZoomLevel();
  if (onlyZoomedOut && level === 0) return null;
  return (
    <button type="button" className="icon-btn" onClick={() => handle.current?.zoomTo(level === 0 ? 2 : 0)} aria-label={level === 0 ? "缩到全局" : "回到对话"}>
      {level === 0 ? "▤" : "💬"}
    </button>
  );
}
