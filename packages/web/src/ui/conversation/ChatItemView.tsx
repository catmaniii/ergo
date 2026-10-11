// 对话层里的一条（54 号票）：会话条目层（52 号票的 ChatItem）的一条怎么画完整内容，相当于 AgentSense 的 ChatItemView。
// 57 号票起照聊天区精简画（长什么样由状态层的 chatLook 给出，state/chat-look.ts）：思考一行"💭 Agent 的想法（点开看）"、
// 回复按 Markdown 画（有后文时"收起 ▴ / 展开细节 ▾"和"详情 ›"），照搬 AgentSense 的 ThinkingRow、AssistantBubble（rows.tsx）；
// 工具调用组一行小字"调用了 N 个工具 ›"（二狗加的汇总行），组里的每一步不在对话层画，点整行在详情页里看。
// 顺利执行的二狗内部工具不显示（52 号票：会话里有卡片、记录代表它）；发出了语音气泡的"发语音"调用也不显示（87 号票：气泡代表它，
// 气泡长按菜单的"详情 ›"里看这次调用）。
// data-mark 标在每张卡、每条记录上：缩小后右侧标注的箭头指到这一行（ZoomHistory 的 layoutAnnotations）。工具调用组只存在于
// 对话层：缩小后组里每次调用、每段思考各画一块（ZoomBlockView 是那一块的对话层内容），标注挂在那一块上。
// 56 号票的详情入口（onDetail 给的是条目层的 id）：用户气泡点整条，思考、多段的回复点"详情 ›"，工具调用组点整行（行尾 ›），
// 卡片点"详情 ›"，系统说明和记录点整条，语音在长按菜单里。条目自己的 id 标在外面的矩形上（ZoomHistory 的 .zi 的 data-item）；
// "在对话中定位"到组里某一步时，那一步不在对话层，闪的是整组。
import type { MouseEvent, ReactNode } from "react";
import { callSentence, type ChatItem, chatItemIdOf, chatLook, type MessagePart, THINKING_LABEL, type ZoomBlock } from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { NamedText } from "../assistant-name.tsx";
import { PartView } from "./parts.tsx";
import { RecordRow } from "./RecordRow.tsx";
import { AssistantBubble, ThinkingRow, ToolGroupLine } from "./rows.tsx";

export interface ChatItemActions {
  /** 打开某一条的详情（条目层的 id：条目、组里某一步） */
  onDetail?: ((id: string) => void) | undefined;
  onQuote?: ((cardId: string) => void) | undefined;
}

/** 点在这些东西上的不算点了整条（链接、按钮、播放器、菜单各有各的用处） */
const OWN_CLICK = "a, button, audio, video, input, textarea, [role=menu]";

/**
 * 一条消息里某一部分在条目层的 id（state/chat-items.ts 的 chatItemIdOf）：思考、工具调用、卡片、分隔线各是一条，
 * 其余（文字、附件、语音）属于消息的主体。用户消息、回复这类条目的 id 就是消息的 key
 */
function partItemId(key: string, part: MessagePart, i: number): string {
  if (part.type === "reasoning") return chatItemIdOf(key, "thinking");
  if (part.type === "tool_call" || part.type === "card_ref" || part.type === "work_order_divider" || part.type === "run_divider") return chatItemIdOf(key, i);
  return key;
}

function Part({ part, mark, onDetail, onQuote }: { part: MessagePart; mark?: string; onDetail?: (() => void) | undefined; onQuote?: ((cardId: string) => void) | undefined }) {
  return (
    <div className={`msg-part part-${part.type}`} data-mark={mark}>
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
    case "thinking": {
      const look = chatLook(item);
      if (look.form !== "thinking") return null;
      return (
        <div className={`msg assistant${item.streaming ? " msg-streaming" : ""}`}>
          <div className="msg-part part-reasoning">
            <ThinkingRow text={item.text} label={look.label} live={look.live} onDetail={look.open ? open?.(item.id) : undefined} />
          </div>
        </div>
      );
    }
    case "reply": {
      const look = chatLook(item);
      if (look.form !== "reply") return null;
      // 文字合成一个气泡（AgentSense 的 AssistantBubble），放在第一段文字的位置；附件（图片、文件）照原来的先后排
      const firstText = item.parts.findIndex((p) => p.type === "text");
      return (
        <div className={`msg assistant${item.streaming ? " msg-streaming" : ""}`}>
          {/* 漏了中间增量的回复不拼残缺的文字，等定稿消息 */}
          {!item.broken &&
            item.parts.map((p, i) =>
              p.type !== "text" ? (
                <Part key={i} part={p} onDetail={open?.(item.id)} onQuote={onQuote} />
              ) : i === firstText ? (
                <div key={i} className="msg-part part-text">
                  <AssistantBubble text={item.text} look={look} onDetail={look.open ? open?.(item.id) : undefined} />
                </div>
              ) : null,
            )}
          <Meta>{item.streaming ? "正在回复…" : item.time ? clockLabel(item.time) : ""}</Meta>
        </div>
      );
    }
    case "tool_group": {
      const look = chatLook(item);
      if (look.form !== "tool_line") return null;
      // 一行小字，不是气泡（用户要的汇总行）：点整行看组的详情
      return (
        <div className="msg assistant msg-tools">
          <ToolGroupLine look={look} onOpen={look.open ? open?.(item.id) : undefined} />
        </div>
      );
    }
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

/** 工具调用的状态类（AgentSense 工具行的 tool-error / tool-running，被拦下、你拒绝了的 tc-*，look.css 划掉参数） */
const CALL_CLASS = { done: "", running: "tool-running", error: "tool-error", blocked: "tc-blocked", denied: "tc-denied" } as const;

/**
 * 缩小后组里的一块在对话层那一层的内容（57 号票）：组只在对话层是一行，缩小后每次调用、每段思考各画一块，这一块的对话层内容
 * 只在跨档淡入淡出的那一下看得见，撑出这一块的高度。调用照 AgentSense 工具行（ToolRow）的第一行：圆点、说人话的那一句
 * （67 号票；有模板的是 .tool-said-text，没有的是"中文名 · 参数值"）、›；思考照 ThinkingRow 收着的那一行。
 * 只是图，不接点击（缩小着点它由会话历史处理）
 */
export function ZoomBlockView({ block }: { block: ZoomBlock }) {
  if (block.kind === "thinking")
    return (
      <div className="msg assistant">
        <div className="thinking">{THINKING_LABEL}</div>
      </div>
    );
  const { part } = block.call;
  const sentence = callSentence(part);
  return (
    <div className="msg assistant">
      <div className={`tool ${CALL_CLASS[part.outcome]}${sentence.said ? " tool-said" : ""}`}>
        <div className="tool-head">
          <span className="tool-dot" />
          <span className={sentence.said ? "tool-said-text" : "tool-brief"}>
            <NamedText text={sentence.text} />
          </span>
          <span className="tool-more">›</span>
        </div>
      </div>
    </div>
  );
}
