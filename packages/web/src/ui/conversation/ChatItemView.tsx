// 对话层里的一条（54 号票）：会话条目层（52 号票的 ChatItem）的一条怎么画完整内容，相当于 AgentSense 的 ChatItemView。
// 每条画自己那几个 part（parts.tsx 的 PartView）：一条消息在条目层拆成几条之后，各画各的。
// 工具调用组先把每次调用照原来的样子列出来（中间的思考也在），聊天区精简（"调用了 N 个工具 ›"）是 57 号票的事；
// 顺利执行的二狗内部工具不显示（52 号票：会话里有卡片、记录代表它）。
// data-mark 标在每次调用、每张卡、每条记录上：缩小后右侧标注的箭头指到这一行（ZoomHistory 的 layoutAnnotations）。
// 56 号票的详情入口（onDetail 给的是条目层的 id）：用户气泡点整条，思考、多段的回复点"详情 ›"，
// 工具调用点整行（行尾 ›），卡片点"详情 ›"，系统说明和记录点整条，语音在长按菜单里。条目自己的 id 标在外面的矩形上
// （ZoomHistory 的 .zi 的 data-item），组里的每一步另标 data-item（"在对话中定位"定位到那一步）。
import type { MouseEvent, ReactNode } from "react";
import { type ChatItem, chatItemIdOf, type MessagePart } from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { NamedText } from "../assistant-name.tsx";
import { PartView } from "./parts.tsx";
import { RecordRow } from "./RecordRow.tsx";

export interface ChatItemActions {
  /** 打开某一条的详情（条目层的 id：条目、组里某一步） */
  onDetail?: ((id: string) => void) | undefined;
  onQuote?: ((cardId: string) => void) | undefined;
}

/** 点在这些东西上的不算点了整条（链接、按钮、播放器、菜单各有各的用处） */
const OWN_CLICK = "a, button, audio, video, input, textarea, [role=menu]";

/** 回复有没有第二段（AgentSense 的 AssistantBubble：按 indexOf("\n\n") 切，后面有内容才给"详情 ›"） */
function hasMore(text: string): boolean {
  const cut = text.indexOf("\n\n");
  return cut > 0 && text.slice(cut + 2).trim().length > 0;
}

/**
 * 一条消息里某一部分在条目层的 id（state/chat-items.ts 的 chatItemIdOf）：思考、工具调用、卡片、分隔线各是一条，
 * 其余（文字、附件、语音）属于消息的主体。用户消息、回复这类条目的 id 就是消息的 key
 */
function partItemId(key: string, part: MessagePart, i: number): string {
  if (part.type === "reasoning") return chatItemIdOf(key, "thinking");
  if (part.type === "tool_call" || part.type === "card_ref" || part.type === "work_order_divider") return chatItemIdOf(key, i);
  return key;
}

function Part({ part, mark, item, onDetail, onQuote }: { part: MessagePart; mark?: string; item?: string; onDetail?: (() => void) | undefined; onQuote?: ((cardId: string) => void) | undefined }) {
  return (
    <div className={`msg-part part-${part.type}`} data-mark={mark} data-item={item}>
      <PartView part={part} onDetail={onDetail} onQuote={onQuote} />
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <div className="msg-meta">{children}</div>;
}

export function ChatItemView({ item, actions }: { item: ChatItem; actions: ChatItemActions }) {
  const { onDetail, onQuote } = actions;
  const open = onDetail && ((id: string) => () => onDetail(id));
  switch (item.kind) {
    case "user":
    case "voice": {
      // agent 的语音只画那段语音（这条消息别的 part 各是各的条目）；用户的整条消息一起画（语音连同引用的卡片）
      const agent = item.kind === "voice" && item.speaker === "agent";
      const parts = agent ? [item.part] : item.message.parts;
      const { pending } = item;
      // 用户气泡点整条（AgentSense 的 .user）：点在链接、按钮、播放器上的除外
      const onUserClick =
        !agent && onDetail
          ? (e: MouseEvent) => {
              if (!(e.target as HTMLElement).closest(OWN_CLICK)) onDetail(item.id);
            }
          : undefined;
      return (
        <div className={`msg ${agent ? "assistant" : "user"}${pending ? ` msg-pending msg-${pending.status}` : ""}${onUserClick ? " has-detail" : ""}`} onClick={onUserClick}>
          {parts.map((p, i) => (
            <Part key={i} part={p} onDetail={open?.(agent ? item.id : partItemId(item.id, p, i))} onQuote={onQuote} />
          ))}
          <Meta>{pending ? (pending.status === "sending" ? "发送中…" : `发送失败：${pending.error}`) : clockLabel(item.message.time)}</Meta>
        </div>
      );
    }
    case "thinking":
      return (
        <div className={`msg assistant${item.streaming ? " msg-streaming" : ""}`}>
          <Part part={{ type: "reasoning", text: item.text }} onDetail={open?.(item.id)} />
        </div>
      );
    case "reply": {
      // 回复有第二段时，最后一段文字下面给"详情 ›"
      const lastText = item.parts.findLastIndex((p) => p.type === "text");
      return (
        <div className={`msg assistant${item.streaming ? " msg-streaming" : ""}`}>
          {/* 漏了中间增量的回复不拼残缺的文字，等定稿消息 */}
          {!item.broken &&
            item.parts.map((p, i) => (
              <div key={i} className={`msg-part part-${p.type}`}>
                <PartView part={p} onDetail={open?.(item.id)} onQuote={onQuote} />
                {i === lastText && open && hasMore(item.text) && (
                  <div className="bubble-more">
                    <button type="button" className="link-btn" onClick={open(item.id)}>
                      详情 ›
                    </button>
                  </div>
                )}
              </div>
            ))}
          <Meta>{item.streaming ? "正在回复…" : item.time ? clockLabel(item.time) : ""}</Meta>
        </div>
      );
    }
    case "tool_group":
      return (
        <div className="msg assistant">
          {item.steps.map((step) =>
            step.kind === "thinking" ? (
              <Part key={step.id} part={{ type: "reasoning", text: step.text }} item={step.id} onDetail={open?.(step.id)} />
            ) : step.call.counted ? (
              <Part key={step.call.id} part={step.call.part} mark={step.call.id} item={step.call.id} onDetail={open?.(step.call.id)} />
            ) : null,
          )}
        </div>
      );
    case "card":
      return (
        <div className="msg assistant">
          <Part part={{ type: "card_ref", cardId: item.cardId }} mark={item.id} onDetail={item.detail ? open?.(item.id) : undefined} onQuote={onQuote} />
        </div>
      );
    case "system":
      return (
        <div className={`msg msg-system${onDetail ? " has-detail" : ""}`}>
          {item.parts.map((p, i) =>
            p.type === "text" ? (
              // 系统说明点整条看详情（AgentSense 的 .context-note）
              <div key={i} className="sys-note" onClick={open?.(item.id)}>
                {/* 守护进程写的说明：里面的名字占位按现在的名字显示（43 号票） */}
                <NamedText text={p.text} />
              </div>
            ) : (
              <PartView key={i} part={p} onDetail={open?.(item.id)} />
            ),
          )}
        </div>
      );
    case "record":
      return (
        <div data-mark={item.marks[0]?.key}>
          <RecordRow record={item.record} time={item.time} itemId={item.id} onDetail={onDetail} />
        </div>
      );
    case "divider":
      return (
        <div className="msg msg-system">
          <PartView part={item.divider} />
        </div>
      );
    case "deleted":
      // 被彻底删除的消息：原来的位置只留一行"已删除"，原话不在了
      return (
        <div className="msg msg-system">
          <div className="sys-note msg-deleted">这条消息已彻底删除{item.time ? ` · ${clockLabel(item.time)}` : ""}</div>
        </div>
      );
  }
}
