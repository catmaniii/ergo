/**
 * 会话组件：秘书聊天和维护者会话共用这一个。
 * 维护者会话多出工单分隔线（work_order_divider part）、阶段抽屉（由外面的任务详情放在会话上方或左侧）
 * 和直接下指令的输入框；秘书的输入框多一个附件菜单（含"作为材料投喂"，见 Composer.tsx）。
 * 打开时只有最近一页，往上滚到顶时经 HTTP 加载更早的历史，加载后视口停在原来看的那条上。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useConversation, useStore } from "../../app/store.tsx";
import { useToast } from "../toast.tsx";
import { clockLabel } from "../../util/time.ts";
import { type ConnectionStatus, type ConversationId, type ConversationItem, olderHistory, quotedCards } from "../../state/index.ts";
import { Composer, type ComposerMode } from "./Composer.tsx";
import { PartView, type ToolCallPart } from "./parts.tsx";

export type ConversationMode = ComposerMode;

/** 离顶部不到这么多像素就加载更早的 */
const LOAD_OLDER_WITHIN_PX = 80;

export function Conversation({
  conversation,
  mode,
  onToolDetail,
  readOnly = false,
  readOnlyNote = "这个会话只读",
}: {
  conversation: ConversationId;
  mode: ConversationMode;
  onToolDetail?(p: ToolCallPart): void;
  /** 只读（比如已归档项目的维护者会话）：不显示输入框 */
  readOnly?: boolean;
  /** 只读时在输入框的位置显示的说明 */
  readOnlyNote?: string;
}) {
  const items = useConversation(conversation);
  const { sendMessage, loadOlder, quoteCard, unquoteCard, ui } = useStore();
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
    const t = setTimeout(() => setHistory(new Set(itemsRef.current.map(keyOf))), 600);
    return () => clearTimeout(t);
  }, []);

  // 打开时滚到底；新消息到达、正在生成的回复变长时，人在底部附近就跟着滚
  const stick = useRef(true);
  const growth = items.length + streamingLength(items);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current && growth > 0) el.scrollTop = el.scrollHeight;
  }, [growth]);

  // 往上翻：滚到顶附近时加载更早的一页；加载前记下离底部的距离，插进来之后按它把视口放回原处
  const older = olderHistory(ui, conversation);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<{ fromBottom: number; firstKey: string | undefined } | null>(null);
  const firstKey = items[0] ? keyOf(items[0]) : undefined;
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
  const lastHistoryIndex = history === null ? -1 : items.findLastIndex((it) => history.has(keyOf(it)));

  return (
    <div className="conv">
      <div
        className="scroll conv-scroll"
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
        {items.length === 0 && <div className="page-placeholder">还没有消息</div>}
        {items.map((it, i) => {
          // 正在生成的回复还没有时间，不单独分天
          const prevDay = i > 0 ? dayOf(items, i - 1) : undefined;
          const day = it.kind === "streaming" ? prevDay : dayOf(items, i);
          const fresh = history !== null && i > lastHistoryIndex && !history.has(keyOf(it));
          return (
            <div key={keyOf(it)} className={fresh ? "fx-new" : undefined}>
              {day !== undefined && day !== prevDay && <div className="day-sep">{day.slice(5).replace("-", " 月 ")} 日</div>}
              <MessageRow item={it} onToolDetail={onToolDetail} onQuote={onQuote} />
            </div>
          );
        })}
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
function dayOf(items: readonly ConversationItem[], index: number): string | undefined {
  for (let i = index; i >= 0; i--) {
    const item = items[i]!;
    const time = item.kind === "deleted" ? item.time : item.message.time;
    if (time) return time.slice(0, 10);
  }
  return undefined;
}

function streamingLength(items: readonly ConversationItem[]): number {
  const last = items.findLast((it) => it.kind === "streaming");
  return last ? last.message.parts.reduce((n, p) => n + (p.type === "text" || p.type === "reasoning" ? p.text.length : 0), 0) : 0;
}

/** 连接断了或页面过旧时，在输入框上方提示一行 */
function ConnectionNote({ status }: { status: ConnectionStatus }) {
  if (status === "offline") return <div className="conn-note">连接断开，正在重连…（发出的消息连上后会自动补发）</div>;
  if (status === "outdated") return <div className="conn-note conn-outdated">页面版本过旧，请刷新页面</div>;
  return null;
}

/**
 * 自己发的消息从乐观显示换成权威消息时 key 不变，React 原地更新，不重播到达动效；
 * 正在生成的回复用的是定稿后那条消息的 id，定稿时同样原地换掉。
 */
function keyOf(it: ConversationItem): string {
  if (it.kind === "deleted") return it.key;
  return it.idempotencyKey ? `k:${it.idempotencyKey}` : it.message.id;
}

function MessageRow({ item, onToolDetail, onQuote }: { item: ConversationItem; onToolDetail?(p: ToolCallPart): void; onQuote?(cardId: string): void }) {
  // 被彻底删除的消息：原来的位置只留一行"已删除"，原话不在了
  if (item.kind === "deleted") {
    return (
      <div className="msg msg-system">
        <div className="sys-note msg-deleted">这条消息已彻底删除{item.time ? ` · ${clockLabel(item.time)}` : ""}</div>
      </div>
    );
  }
  const { message } = item;
  if (message.speaker === "system") {
    return (
      <div className="msg msg-system">
        {message.parts.map((p, i) =>
          p.type === "text" ? (
            <div key={i} className="sys-note">
              {p.text}
            </div>
          ) : (
            <PartView key={i} part={p} />
          ),
        )}
      </div>
    );
  }
  const side = message.speaker === "user" ? "user" : "assistant";
  const streaming = item.kind === "streaming";
  // 漏了中间增量的回复不拼残缺的文字，等定稿消息
  const parts = streaming && item.broken ? [] : message.parts;
  return (
    <div className={`msg ${side}${item.kind === "pending" ? ` msg-pending msg-${item.status}` : ""}${streaming ? " msg-streaming" : ""}`}>
      {parts.map((p, i) => (
        <div key={i} className={`msg-part part-${p.type}`}>
          <PartView part={p} onToolDetail={onToolDetail} onQuote={onQuote} />
        </div>
      ))}
      <div className="msg-meta">
        {item.kind === "pending" ? (item.status === "sending" ? "发送中…" : `发送失败：${item.error ?? ""}`) : streaming ? "正在回复…" : clockLabel(message.time)}
      </div>
    </div>
  );
}
