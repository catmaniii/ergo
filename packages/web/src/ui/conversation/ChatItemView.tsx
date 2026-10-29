// 对话层里的一条（54 号票）：会话条目层（52 号票的 ChatItem）的一条怎么画完整内容。
// 57 号票起照聊天区精简画（长什么样由状态层的 chatLook 给出，state/chat-look.ts）：思考一行"💭 Agent 的想法（点开看）"、
// 回复按 Markdown 画（有后文时"收起 ▴ / 展开细节 ▾"和"详情 ›"），ThinkingRow、AssistantBubble 在 rows.tsx；
// 工具调用组一行小字"调用了 N 个工具 ›"（二狗加的汇总行），组里的每一步不在对话层画，点整行在详情页里看。
// 187 号票：调用记忆（检索素材、读素材）不算进那一行，单独一行"回忆了 N 条记忆 ›"，点整行看"这次用到的记忆"。
// 193 号票：这一行由记忆插件画（网页插件的对话条目插槽，plugins/memory/RecallLine.tsx）；插件拥有的条目在插件停用时已经换成
// 占位（state/chat-items.ts 的 maskUnavailable，kind 是 unavailable），画成一行"（X插件没启用，这条内容暂时看不到）"，样子同"已删除"。
// 顺利执行的二狗内部工具不显示（52 号票：会话里有卡片、记录代表它）；发出了语音气泡的"发语音"调用也不显示（87 号票：气泡代表它，
// 气泡长按菜单的"详情 ›"里看这次调用）。
// data-mark 标在每张卡、每条记录上：缩小后右侧标注的箭头指到这一行（ZoomHistory 的 layoutAnnotations）。工具调用组只存在于
// 对话层：缩小后组里每次调用、每段思考各画一块（ZoomBlockView 是那一块的对话层内容），标注挂在那一块上。
// 56 号票的详情入口（onDetail 给的是条目层的 id）：用户气泡点整条，思考、多段的回复点"详情 ›"，工具调用组点整行（行尾 ›），
// 卡片点"详情 ›"，系统说明和记录点整条，语音在长按菜单里。条目自己的 id 标在外面的矩形上（ZoomHistory 的 .zi 的 data-item）；
// "在对话中定位"到组里某一步时，那一步不在对话层，闪的是整组。
// 113 号票：一条消息里连着的文件附件合成一组（state 的 partRuns），画成一横排卡片（parts.tsx 的 FileCards）。
// 115 号票：agent 之间的来信（任务做完、维护者来信、秘书转达、计划检查）只画一行（rows.tsx 的 LetterLine），整行点开看全文；
// 运行时跟在任务做完的通知后面放的附件（只有文件的系统消息）画成一排附件卡片。
// 275 号票（用户 2026-10-25：工具调用、维护者来信那一横条一直顶到最右边，窄窗口看不到、点不到行尾的箭头）：工具调用、来信、
// 回忆记忆这几行照"在想什么"那条，放在个人助理那一列的一格里（.msg-part.part-line），宽度跟着内容、最宽到对话气泡那么宽（pages.css 的 .tool-sum）。
// 144 号票：排队的消息（二狗回复时发的）是虚线的用户气泡、标"排队中"，右上角一个叉，长按（电脑上按住）拖动改顺序（queue-drag.tsx）；
// 交出去之后同一个条目 id（发送请求的幂等键）换成正常气泡，原地不动。说到一半被停下的回复标"已停止"。
import type { MouseEvent, ReactNode } from "react";
import {
  type AgentLetter,
  branchFilesLine,
  browsingLabel,
  type ChatItem,
  chatItemIdOf,
  chatLook,
  type FilePartValue,
  type MessagePart,
  pageCommandLabel,
  partRuns,
  t,
  thinkingLabel,
  type ZoomBlock,
} from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { NamedText } from "../assistant-name.tsx";
import { ClearedDivider, FileCards, PartView } from "./parts.tsx";
import { useQueuedBubble } from "./queue-drag.tsx";
import { RecordRow } from "./RecordRow.tsx";
import { AssistantBubble, LetterLine, ThinkingRow, ToolGroupLine } from "./rows.tsx";
import { usePlugins } from "../../plugins/api.ts";

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
  if (part.type === "tool_call" || part.type === "card_ref" || part.type === "work_order_divider" || part.type === "run_divider" || part.type === "conversation_cleared") return chatItemIdOf(key, i);
  return key;
}

function Part({ part, mark, onDetail, onQuote }: { part: MessagePart; mark?: string; onDetail?: (() => void) | undefined; onQuote?: ((cardId: string) => void) | undefined }) {
  return (
    <div className={`msg-part part-${part.type}`} data-mark={mark}>
      <PartView part={part} onDetail={onDetail} onQuote={onQuote} />
    </div>
  );
}

/** 连着的一组文件附件：一横排卡片，装不下换行（113 号票） */
function Files({ files }: { files: readonly FilePartValue[] }) {
  return (
    <div className="msg-part part-files">
      <FileCards files={files} />
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <div className="msg-meta">{children}</div>;
}

/**
 * 一封来信（115 号票）：一行，不是气泡；整行点开看全文。
 * 275 号票：和工具调用那一行一样放在个人助理那一列的一格里（.msg.assistant > .msg-part.part-line，和"在想什么"那条同一列）
 */
function Letter({ letter, time, onOpen }: { letter: AgentLetter; time: string | undefined; onOpen: (() => void) | undefined }) {
  return (
    <div className="msg assistant msg-letter">
      <div className="msg-part part-line">
        <LetterLine letter={letter} time={time ? clockLabel(time) : undefined} onOpen={onOpen} />
      </div>
    </div>
  );
}

export function ChatItemView({ item, actions }: { item: ChatItem; actions: ChatItemActions }) {
  const { onDetail, onQuote } = actions;
  // 网页插件登记了这种条目的画法（193 号票：调用记忆）：交给它
  const plugins = usePlugins();
  const Plugged = plugins.get("chatItems", item.kind)?.Item;
  if (Plugged) return <Plugged item={item} actions={actions} />;
  const open = onDetail && ((id: string) => () => onDetail(id));
  // agent 之间的来信（秘书转达的用户消息、运行时的系统通知）：一行
  const shape = chatLook(item);
  if (shape.form === "letter") return <Letter letter={shape.letter} time={item.time} onOpen={shape.open ? open?.(item.id) : undefined} />;
  switch (item.kind) {
    case "user":
    case "voice": {
      // agent 的语音只画那段语音（这条消息别的 part 各是各的条目）；用户的整条消息一起画（语音连同引用的卡片）
      const agent = item.kind === "voice" && item.speaker === "agent";
      // 排队的（144 号票）：虚线气泡，能叉、能拖
      if (!agent && item.queued) return <QueuedBubble item={item} onQuote={onQuote} />;
      const parts = agent ? [item.part] : item.message.parts;
      const { pending } = item;
      // 用户气泡点整条：点在链接、按钮、播放器上的除外
      const onUserClick =
        !agent && onDetail
          ? (e: MouseEvent) => {
              if (!(e.target as HTMLElement).closest(OWN_CLICK)) onDetail(item.id);
            }
          : undefined;
      return (
        <div className={`msg ${agent ? "assistant" : "user"}${pending ? ` msg-pending msg-${pending.status}` : ""}${onUserClick ? " has-detail" : ""}`} onClick={onUserClick}>
          {/* 秘书转达的话（103 号票）115 号票起折成一行"<名字>转达"（上面的 Letter），不走到这里 */}
          {partRuns(parts).map((run) =>
            run.kind === "files" ? (
              <Files key={run.index} files={run.files} />
            ) : (
              <Part key={run.index} part={run.part} onDetail={open?.(agent ? item.id : partItemId(item.id, run.part, run.index))} onQuote={onQuote} />
            ),
          )}
          <Meta>
            {/* 在"浏览"里网页的框上说的（134 号票）：写明在哪个网页、哪个框上 */}
            {!agent && item.message.pageCommand ? `${pageCommandLabel(item.message.pageCommand)} · ` : ""}
            {/* 浏览侧边栏里说的（147 号票）：写明在哪个网页上 */}
            {!agent && item.message.browsing ? `${browsingLabel(item.message.browsing)} · ` : ""}
            {/* 在官方 App 里说的（292 号票：只读跟随补记的） */}
            {item.message.remote && (
              <>
                <span className="msg-remote">{t("ui.chatItemView.remote")}</span>
                {" · "}
              </>
            )}
            {pending ? (pending.status === "sending" ? t("ui.chatItemView.sending") : t("ui.chatItemView.sendFailed", { error: pending.error })) : clockLabel(item.message.time)}
          </Meta>
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
      // 文字合成一个气泡，放在第一段文字的位置；附件（图片、文件）照原来的先后排
      const firstText = item.parts.findIndex((p) => p.type === "text");
      return (
        <div className={`msg assistant${item.streaming ? " msg-streaming" : ""}`}>
          {/* 漏了中间增量的回复不拼残缺的文字，等定稿消息 */}
          {!item.broken &&
            partRuns(item.parts).map((run) =>
              run.kind === "files" ? (
                <Files key={run.index} files={run.files} />
              ) : run.part.type !== "text" ? (
                <Part key={run.index} part={run.part} onDetail={open?.(item.id)} onQuote={onQuote} />
              ) : run.index === firstText ? (
                <div key={run.index} className="msg-part part-text">
                  <AssistantBubble text={item.text} look={look} onDetail={look.open ? open?.(item.id) : undefined} />
                </div>
              ) : null,
            )}
          <Meta>
            {item.streaming ? (
              t("ui.chatItemView.replying")
            ) : (
              <>
                {/* 说到一半被停下的（144 号票）：已经说出来的留着，标出来 */}
                {item.stopped && <span className="msg-stopped">{t("ui.chatItemView.stopped")}</span>}
                {item.stopped && item.time ? " · " : ""}
                {/* 在官方 App 里回的（292 号票：只读跟随补记的） */}
                {item.remote && <span className="msg-remote">{t("ui.chatItemView.remote")}</span>}
                {item.remote && item.time ? " · " : ""}
                {item.time ? clockLabel(item.time) : ""}
              </>
            )}
          </Meta>
        </div>
      );
    }
    case "tool_group": {
      const look = chatLook(item);
      if (look.form !== "tool_line") return null;
      // 一行小字，不是气泡（用户要的汇总行）：点整行看组的详情。275 号票：和"在想什么"那条一样放在一格里（同一列、同样的宽度上限）
      return (
        <div className="msg assistant msg-tools">
          <div className="msg-part part-line">
            <ToolGroupLine look={look} onOpen={look.open ? open?.(item.id) : undefined} />
          </div>
        </div>
      );
    }
    case "recall": {
      // 调用记忆（187 号票）由网页插件画（上面）；拥有它的插件没在用时占位（会话里一般已经换成了 unavailable，这里兜底）
      const plugin = plugins.unavailable("chatItems", item.kind);
      return plugin === undefined ? null : <UnavailableLine text={t("state.chatItems.unavailable", { plugin })} />;
    }
    case "card":
      return (
        <div className="msg assistant">
          <Part part={{ type: "card_ref", cardId: item.cardId }} mark={item.id} onDetail={item.detail ? open?.(item.id) : undefined} onQuote={onQuote} />
        </div>
      );
    case "system":
      // 分支摘要（150 号票，会话回退之后新分支开头那一条）：context-note 的样子，🧭 加摘要，点整条看详情；
      // 293 号票：运行时把文件恢复到撤回点的（Claude Code），下面一行写恢复了哪些（Bash 改的追不到）
      if (item.branch)
        return (
          <div className={`msg msg-system msg-branch${onDetail ? " has-detail" : ""}`}>
            <div className="context-note" onClick={open?.(item.id)}>
              🧭 {item.branch.summary}
              {item.branch.files && <div className="branch-files">{branchFilesLine(item.branch.files)}</div>}
            </div>
          </div>
        );
      return (
        <div className={`msg msg-system${onDetail ? " has-detail" : ""}`}>
          {partRuns(item.parts).map((run) =>
            // 运行时放的附件（115 号票：任务做完时交付的 md）：一排卡片，点"预览"去报告页
            run.kind === "files" ? (
              <Files key={run.index} files={run.files} />
            ) : run.part.type === "text" ? (
              // 系统说明点整条看详情
              <div key={run.index} className="sys-note" onClick={open?.(item.id)}>
                {/* 守护进程写的说明：里面的名字占位按现在的名字显示（43 号票） */}
                <NamedText text={run.part.text} />
              </div>
            ) : (
              <PartView key={run.index} part={run.part} onDetail={open?.(item.id)} />
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
          {item.divider.type === "conversation_cleared" ? <ClearedDivider time={item.time} /> : <PartView part={item.divider} />}
        </div>
      );
    case "deleted":
      // 被彻底删除的消息：原来的位置只留一行"已删除"，原话不在了
      return (
        <div className="msg msg-system">
          <div className="sys-note msg-deleted">
            {t("ui.chatItemView.deleted")}
            {item.time ? ` · ${clockLabel(item.time)}` : ""}
          </div>
        </div>
      );
    case "unavailable":
      // 插件没启用（193 号票）：一行占位，样子同"已删除"
      return <UnavailableLine text={item.keyLine} />;
  }
}

/** 插件没启用、这条内容暂时看不到（193 号票） */
function UnavailableLine({ text }: { text: string }) {
  return (
    <div className="msg msg-system">
      <div className="sys-note msg-unavailable">{text}</div>
    </div>
  );
}

/**
 * 一条排队的消息（144 号票）：用户气泡的样子，虚线边框、淡一点，标"排队中"；右上角的叉点了从队列里拿掉（不用确认）；
 * 长按（电脑上按住）拖动改顺序，拖着时落点有虚线占位；只剩一条时不能拖。会话没挂拖动（比如详情页里）时照样画，只是不能拖
 */
function QueuedBubble({ item, onQuote }: { item: Extract<ChatItem, { kind: "user" | "voice" }>; onQuote: ((cardId: string) => void) | undefined }) {
  const queued = useQueuedBubble(item.message.id);
  return (
    <div
      className={`msg user msg-queued${queued?.dragging ? " queued-dragging" : ""}${queued && !queued.single ? " queued-movable" : ""}`}
      style={queued?.style}
      {...queued?.attrs}
      onPointerDown={queued?.onPointerDown}
      onContextMenu={queued?.onContextMenu}
      onClickCapture={queued?.onClickCapture}
    >
      {partRuns(item.message.parts).map((run) =>
        run.kind === "files" ? <Files key={run.index} files={run.files} /> : <Part key={run.index} part={run.part} onQuote={onQuote} />,
      )}
      <Meta>
        <span className="queued-tag" title={t("ui.chatItemView.queuedHint")}>
          {t("ui.chatItemView.queued")}
        </span>
      </Meta>
      {queued && (
        <button type="button" className="queued-x" aria-label={t("ui.chatItemView.unqueueLabel")} title={t("ui.chatItemView.unqueue")} onClick={queued.remove}>
          ×
        </button>
      )}
    </div>
  );
}

/** 工具调用的状态类（工具行的 tool-error / tool-running，被拦下、你拒绝了的 tc-*，look.css 划掉参数） */
const CALL_CLASS = { done: "", running: "tool-running", error: "tool-error", blocked: "tc-blocked", denied: "tc-denied" } as const;

/**
 * 缩小后组里的一块在对话层那一层的内容（57 号票）：组只在对话层是一行，缩小后每次调用、每段思考各画一块，这一块的对话层内容
 * 只在跨档淡入淡出的那一下看得见，撑出这一块的高度。调用画工具行（ToolRow）的第一行：圆点、说人话的那一句
 * （67 号票；有模板的是 .tool-said-text，没有的是"中文名 · 参数值"）、›；思考照 ThinkingRow 收着的那一行。
 * 只是图，不接点击（缩小着点它由会话历史处理）
 */
export function ZoomBlockView({ block }: { block: ZoomBlock }) {
  if (block.kind === "thinking")
    return (
      <div className="msg assistant">
        <div className="thinking">{thinkingLabel()}</div>
      </div>
    );
  const { part, sentence } = block.call;
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
