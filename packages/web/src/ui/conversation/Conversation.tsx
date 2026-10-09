/**
 * 会话组件：秘书聊天和维护者会话共用这一个。
 * 维护者会话多出工单分隔线（work_order_divider part）、阶段抽屉（由外面的任务详情放在会话上方或左侧）
 * 和直接下指令的输入框；秘书的输入框多一个附件菜单（含"作为材料投喂"，见 Composer.tsx）。
 * 打开时只有最近一页，往上滚到顶时经 HTTP 加载更早的历史，加载后视口停在原来看的那条上。
 * 25 号票起：上方的缩放控件在完整、要点、全局三层之间切换（Timeline.tsx）；完整视图里还有消息之外的记录
 * （偏离、范围变更、越界、快速动作的操作记录）。在要点层、全局层点收起的行或色块，回到完整视图并跳到那一条。
 * 32 号票起：用语音回复的那一轮，会话末尾标一行"正在回复…"（回复的文字不流式显示）；合成语音时标"正在合成语音…"。
 * 38 号票起分段合成：第一段到了，"正在合成语音…"换成合成中的语音气泡（时长随已到的段增长，能边收边播），合成完了换成那条语音消息。
 * 36 号票起：挂着时登记"开着这个会话"，新到的 agent 语音只在开着的会话里自动播放（app/voice-autoplay.ts）。
 * 56 号票起：每一条都能点开详情（onDetail，给的是会话条目层的条目 id，见 state/chat-items.ts）——用户气泡点整条，思考、
 * 多段的回复点"详情 ›"，工具调用点整行（行尾 ›），卡片点"详情 ›"，系统说明和记录点整条，语音在长按菜单里；
 * "在对话中定位"由详情页经 ref 调 reveal(条目 id)：滚到那一条、闪一下。
 */
import { type MouseEvent, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBackLayer } from "../../app/page-back.ts";
import { useOpenConversation } from "../../app/page-voice.ts";
import { useStore } from "../../app/store.tsx";
import { useToast } from "../toast.tsx";
import { NamedText } from "../assistant-name.tsx";
import { clockLabel } from "../../util/time.ts";
import {
  agentVoicePhase,
  chatItemIdOf,
  chatItems,
  type ConnectionStatus,
  type ConversationId,
  type ConversationItem,
  gistView,
  globalView,
  locateChatItem,
  olderHistory,
  quotedCards,
  streamingAgentVoices,
  type TimelineItem,
  timelineItemKey,
  timelineItems,
  timelineItemTime,
  type ZoomLevel,
} from "../../state/index.ts";
import { Composer, type ComposerMode } from "./Composer.tsx";
import { PartView } from "./parts.tsx";
import { StreamingAgentVoiceBubble } from "./VoiceBubble.tsx";
import { GistLayer, GlobalLayer, RecordRow, ZoomBar } from "./Timeline.tsx";

export type ConversationMode = ComposerMode;

/** 用语音回复时会话末尾的提示 */
const VOICE_PHASE_LABEL = { replying: "正在回复…", synthesizing: "正在合成语音…" } as const;

/** 离顶部不到这么多像素就加载更早的 */
const LOAD_OLDER_WITHIN_PX = 80;

/** 会话组件对外的句柄：详情页的"在对话中定位" */
export interface ConversationHandle {
  /** 定位到这一条（会话条目层的条目 id，用 locateChatItem 找）：滚到视口 30% 高处，闪一下（AgentSense ZoomHistory 的 reveal） */
  reveal(id: string): void;
}

export function Conversation({
  conversation,
  mode,
  onDetail,
  ref,
  readOnly = false,
  readOnlyNote = "这个会话只读",
}: {
  conversation: ConversationId;
  mode: ConversationMode;
  /** 打开某一条的详情（会话条目层的条目 id：条目、组里某一步、挂着的内部调用） */
  onDetail?: ((id: string) => void) | undefined;
  ref?: Ref<ConversationHandle> | undefined;
  /** 只读（比如已归档项目的维护者会话）：不显示输入框 */
  readOnly?: boolean;
  /** 只读时在输入框的位置显示的说明 */
  readOnlyNote?: string;
}) {
  const { sendMessage, loadOlder, quoteCard, unquoteCard, ui } = useStore();
  // 开着这个会话：新到的 agent 语音只在开着的会话里自动播放（36 号票）
  useOpenConversation(conversation);
  const items = useMemo(() => timelineItems(ui, conversation), [ui, conversation]);
  const voicePhase = agentVoicePhase(ui, conversation);
  const streamingVoices = streamingAgentVoices(ui, conversation);
  // 缩放：完整、要点、全局（要点层、全局层的数据由状态层算）
  const [level, setLevel] = useState<ZoomLevel>("full");
  // 鸿蒙 App 的系统返回键（62 号票，照搬 AgentSense 的 level>0 → zoomTo(0)）：缩到要点层、全局层时先回完整视图
  useBackLayer("overlay", level !== "full", () => setLevel("full"));
  const gist = useMemo(() => (level === "gist" ? gistView(ui, conversation) : []), [ui, conversation, level]);
  const blocks = useMemo(() => (level === "global" ? globalView(ui, conversation) : []), [ui, conversation, level]);
  /** 回到完整视图后要跳到的那一条 */
  const jumpTo = useRef<string | undefined>(undefined);
  // 卡片可以"引用"到输入框（21 号票）：只读的会话没有输入框，也就不能引用
  const onQuote = readOnly ? undefined : (cardId: string) => quoteCard(conversation, cardId);
  const toast = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  // 打开时已经有的、以及打开后一小会儿陆续补发进来的，都算历史，不播到达动效（look.css 第 4 条）
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  const [history, setHistory] = useState<Set<string> | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setHistory(new Set(itemsRef.current.map(timelineItemKey))), 600);
    return () => clearTimeout(t);
  }, []);

  // 打开时滚到底；新消息到达、正在生成的回复变长时，人在底部附近就跟着滚
  const stick = useRef(true);
  const growth = items.length + streamingLength(items) + streamingVoices.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current && growth > 0 && level === "full" && jumpTo.current === undefined) el.scrollTop = el.scrollHeight;
  }, [growth, level]);
  // 从要点层、全局层跳回完整视图：滚到那一条，闪一下
  useLayoutEffect(() => {
    const key = jumpTo.current;
    if (level !== "full" || key === undefined) return;
    jumpTo.current = undefined;
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (!target) return;
    stick.current = false;
    target.scrollIntoView({ block: "center" });
    target.classList.add("tl-flash");
    setTimeout(() => target.classList.remove("tl-flash"), 1200);
  }, [level]);
  const jump = (itemKey: string) => {
    jumpTo.current = itemKey;
    setLevel("full");
  };

  // "在对话中定位"（56 号票，照 AgentSense ZoomHistory 的 reveal）：缩小着的先回到完整视图，滚到视口 30% 高处，闪一下。
  // 会话现在按消息画，元素上标着条目 id（data-item）；组没有自己的元素，取组里第一个看得见的一步
  const revealing = useRef<string | undefined>(undefined);
  const uiRef = useRef(ui);
  useEffect(() => {
    uiRef.current = ui;
  });
  const revealNow = (id: string) => {
    const vp = scrollRef.current;
    const found = locateChatItem(chatItems(uiRef.current, conversation), id);
    if (!vp || !found) return;
    const { item, call } = found;
    const steps = item.kind === "tool_group" ? item.steps.map((s) => (s.kind === "thinking" ? s.id : s.call.id)) : [];
    const el = [call?.id, item.id, ...steps]
      .filter((x): x is string => x !== undefined)
      .map((x) => vp.querySelector<HTMLElement>(`[data-item="${CSS.escape(x)}"]`))
      .find((x) => x !== null);
    if (!el) return;
    stick.current = false;
    const top = el.getBoundingClientRect().top - vp.getBoundingClientRect().top + vp.scrollTop;
    vp.scrollTo({ top: top - vp.clientHeight * 0.3, behavior: "smooth" });
    el.classList.remove("dp-flash");
    // 重新挂上才会再播一次
    void el.offsetWidth;
    el.classList.add("dp-flash");
    setTimeout(() => el.classList.remove("dp-flash"), 1600);
  };
  useImperativeHandle(ref, () => ({
    reveal(id: string) {
      if (level === "full") return revealNow(id);
      revealing.current = id;
      setLevel("full");
    },
  }));
  useLayoutEffect(() => {
    const id = revealing.current;
    if (level !== "full" || id === undefined) return;
    revealing.current = undefined;
    revealNow(id);
  });

  // 往上翻：滚到顶附近时加载更早的一页；加载前记下离底部的距离，插进来之后按它把视口放回原处
  const older = olderHistory(ui, conversation);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<{ fromBottom: number; firstKey: string | undefined } | null>(null);
  const firstKey = items[0] ? timelineItemKey(items[0]) : undefined;
  const tryLoadOlder = () => {
    const el = scrollRef.current;
    if (loadingOlder || !older.canLoadOlder || !el) return;
    anchor.current = { fromBottom: el.scrollHeight - el.scrollTop, firstKey };
    setLoadingOlder(true);
    loadOlder(conversation)
      .catch((err: unknown) => toast(`加载更早的消息失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setLoadingOlder(false));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    if (firstKey !== a.firstKey) {
      el.scrollTop = el.scrollHeight - a.fromBottom;
      anchor.current = null;
    } else if (!loadingOlder) {
      anchor.current = null;
    }
  }, [firstKey, loadingOlder]);
  // 打开之后才到的、排在历史最后一条之后的条目才播到达动效；往上翻插进来的更早的不播
  const lastHistoryIndex = history === null ? -1 : items.findLastIndex((it) => history.has(timelineItemKey(it)));

  return (
    <div className="conv">
      <ZoomBar
        level={level}
        onLevel={(l) => {
          if (l === "full") stick.current = true;
          setLevel(l);
        }}
      />
      <div
        className={`scroll conv-scroll zoom-${level}`}
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < LOAD_OLDER_WITHIN_PX && el.scrollHeight > el.clientHeight) tryLoadOlder();
        }}
      >
        {older.canLoadOlder && (
          <button type="button" className="link older-btn" disabled={loadingOlder} onClick={tryLoadOlder}>
            {loadingOlder ? "正在加载更早的消息…" : "加载更早的消息"}
          </button>
        )}
        {level === "gist" && <GistLayer rows={gist} onDetail={onDetail} onJump={jump} />}
        {level === "global" && <GlobalLayer blocks={blocks} onJump={jump} />}
        {level === "full" && items.length === 0 && <div className="page-placeholder">还没有消息</div>}
        {level === "full" &&
          items.map((it, i) => {
            // 正在生成的回复还没有时间，不单独分天
            const prevDay = i > 0 ? dayOf(items, i - 1) : undefined;
            const day = it.kind === "streaming" ? prevDay : dayOf(items, i);
            const key = timelineItemKey(it);
            const fresh = history !== null && i > lastHistoryIndex && !history.has(key);
            return (
              <div key={key} data-key={key} className={fresh ? "fx-new" : undefined}>
                {day !== undefined && day !== prevDay && <div className="day-sep">{day.slice(5).replace("-", " 月 ")} 日</div>}
                {it.kind === "record" ? (
                  <RecordRow record={it.record} time={it.time} itemId={chatItemIdOf(key)} onDetail={onDetail} />
                ) : (
                  <MessageRow item={it} onDetail={onDetail} onQuote={onQuote} />
                )}
              </div>
            );
          })}
        {level === "full" &&
          streamingVoices.map((voice) => (
            <div key={`agent-voice:${voice.id}`} className="msg assistant">
              <div className="msg-part part-tts_audio">
                <StreamingAgentVoiceBubble voice={voice} />
              </div>
            </div>
          ))}
        {level === "full" && voicePhase && (
          <div className="msg assistant">
            <div className="voice-synth muted">{VOICE_PHASE_LABEL[voicePhase]}</div>
          </div>
        )}
      </div>
      <ConnectionNote status={ui.connection} />
      {readOnly ? (
        <div className="composer composer-note muted">{readOnlyNote}</div>
      ) : (
        <Composer
          mode={mode}
          quoted={quotedCards(ui, conversation)}
          onUnquote={(cardId) => unquoteCard(conversation, cardId)}
          onSend={(parts) => {
            stick.current = true;
            sendMessage(conversation, parts);
          }}
        />
      )}
    </div>
  );
}

/** 往前找最近一条有时间的条目所在的日期 */
function dayOf(items: readonly TimelineItem[], index: number): string | undefined {
  for (let i = index; i >= 0; i--) {
    const time = timelineItemTime(items[i]!);
    if (time) return time.slice(0, 10);
  }
  return undefined;
}

function streamingLength(items: readonly TimelineItem[]): number {
  const last = items.findLast((it) => it.kind === "streaming");
  return last ? last.message.parts.reduce((n, p) => n + (p.type === "text" || p.type === "reasoning" ? p.text.length : 0), 0) : 0;
}

/** 连接断了或页面过旧时，在输入框上方提示一行 */
function ConnectionNote({ status }: { status: ConnectionStatus }) {
  if (status === "offline") return <div className="conn-note">连接断开，正在重连…（发出的消息连上后会自动补发）</div>;
  if (status === "outdated") return <div className="conn-note conn-outdated">页面版本过旧，请刷新页面</div>;
  return null;
}

// 每条的 key 用状态层的 timelineItemKey：自己发的消息从乐观显示换成权威消息时 key 不变，React 原地更新，不重播到达动效；
// 正在生成的回复用的是定稿后那条消息的 id，定稿时同样原地换掉。

/** 点在这些东西上的不算点了整条（链接、按钮、播放器、菜单各有各的用处） */
const OWN_CLICK = "a, button, audio, video, input, textarea, [role=menu]";

/** 这一部分在条目层的 id：思考、工具调用、卡片、分隔线各是一条，其余（文字、附件、语音）属于消息的主体 */
function partItemId(key: string, part: { type: string }, i: number): string {
  if (part.type === "reasoning") return chatItemIdOf(key, "thinking");
  if (part.type === "tool_call" || part.type === "card_ref" || part.type === "work_order_divider") return chatItemIdOf(key, i);
  return chatItemIdOf(key);
}

/**
 * 回复有没有第二段（AgentSense 的 AssistantBubble：按 indexOf("\n\n") 切，后面有内容才给"详情 ›"）。
 * 57 号票把回复收成只显示第一段、加"展开细节 ▾"
 */
function hasMore(text: string): boolean {
  const cut = text.indexOf("\n\n");
  return cut > 0 && text.slice(cut + 2).trim().length > 0;
}

function MessageRow({ item, onDetail, onQuote }: { item: ConversationItem; onDetail?: ((id: string) => void) | undefined; onQuote?(cardId: string): void }) {
  // 被彻底删除的消息：原来的位置只留一行"已删除"，原话不在了
  if (item.kind === "deleted") {
    return (
      <div className="msg msg-system">
        <div className="sys-note msg-deleted">这条消息已彻底删除{item.time ? ` · ${clockLabel(item.time)}` : ""}</div>
      </div>
    );
  }
  const { message } = item;
  const key = timelineItemKey(item);
  const main = chatItemIdOf(key);
  const open = onDetail && ((id: string) => () => onDetail(id));
  if (message.speaker === "system") {
    return (
      <div className={`msg msg-system${onDetail ? " has-detail" : ""}`} data-item={main}>
        {message.parts.map((p, i) =>
          p.type === "text" ? (
            // 系统说明点整条看详情（AgentSense 的 .context-note）
            <div key={i} className="sys-note" onClick={open?.(main)}>
              {/* 守护进程写的说明：里面的名字占位按现在的名字显示（43 号票） */}
              <NamedText text={p.text} />
            </div>
          ) : (
            <div key={i} data-item={partItemId(key, p, i)}>
              <PartView part={p} onDetail={open?.(partItemId(key, p, i))} />
            </div>
          ),
        )}
      </div>
    );
  }
  const side = message.speaker === "user" ? "user" : "assistant";
  const streaming = item.kind === "streaming";
  // 漏了中间增量的回复不拼残缺的文字，等定稿消息
  const parts = streaming && item.broken ? [] : message.parts;
  // 回复有第二段时，最后一段文字下面给"详情 ›"
  const lastText = parts.findLastIndex((p) => p.type === "text");
  const replyText = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  // 用户气泡点整条（AgentSense 的 .user）：点在链接、按钮、播放器上的除外
  const onUserClick =
    side === "user" && onDetail
      ? (e: MouseEvent) => {
          if (!(e.target as HTMLElement).closest(OWN_CLICK)) onDetail(main);
        }
      : undefined;
  return (
    <div
      className={`msg ${side}${item.kind === "pending" ? ` msg-pending msg-${item.status}` : ""}${streaming ? " msg-streaming" : ""}${onUserClick ? " has-detail" : ""}`}
      data-item={main}
      onClick={onUserClick}
    >
      {parts.map((p, i) => (
        <div key={i} className={`msg-part part-${p.type}`} data-item={partItemId(key, p, i)}>
          <PartView part={p} onDetail={open?.(partItemId(key, p, i))} onQuote={onQuote} />
          {side === "assistant" && i === lastText && open && hasMore(replyText) && (
            <div className="bubble-more">
              <button type="button" className="link-btn" onClick={open(main)}>
                详情 ›
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="msg-meta">
        {item.kind === "pending" ? (item.status === "sending" ? "发送中…" : `发送失败：${item.error ?? ""}`) : streaming ? "正在回复…" : clockLabel(message.time)}
      </div>
    </div>
  );
}
