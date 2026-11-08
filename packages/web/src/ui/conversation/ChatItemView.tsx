// 对话层里的一条：会话条目层（ChatItem）的一条怎么画完整内容。
// 照聊天区精简画（长什么样由状态层的 chatLook 给出，state/chat-look.ts）：回复按 Markdown 画（有后文时"收起 ▴ / 展开细节 ▾"
// 和"详情 ›"，AssistantBubble 在 rows.tsx）；用户的消息、排队的消息、语音、附件、分隔线、已删除照旧。
// 过程条目收成一行（rows.tsx 的 ChatLineView：图标、标题、一句话、小签、行尾 ›，整行点开详情）：思考、工具调用组、agent 之间的来信、
// 卡片、时间线记录、系统说明、分支摘要；调用记忆那一行由记忆插件画（网页插件的对话条目插槽，plugins/memory/RecallLine.tsx）。
// 每一行放在个人助理那一列的一格里（.msg.assistant > .msg-part.part-line），这一格和对话气泡最宽的那个宽度一样（pages.css），
// 行尾的 › 在这一格的最右端：几种的 › 在同一条竖线上，窄窗口也不出屏幕。系统说明、记录、分支摘要也放进这一列（和别的行对齐）。
// 工具调用组里的每一步不在对话层画，点整行在详情页里看。
// 卡片收成一行之后按钮不在对话里：点进卡片详情处理（卡片详情画整张卡，"引用"也在那里，ui/detail/DetailPane.tsx）；
// 还没收到这张卡、打不开详情的照旧整张画（卡片下面"引用"）；地图卡片这种要直接看的（chat-look.ts 的 CARD_STAYS_WHOLE）
// 也照旧整张画，下面"引用 · 详情 ›"。
// 插件拥有的条目在插件停用时已经换成占位（state/chat-items.ts 的 maskUnavailable，kind 是 unavailable），
// 画成一行"（X插件没启用，这条内容暂时看不到）"，样子同"已删除"。
// 顺利执行的二狗内部工具不显示（会话里有卡片、记录代表它）；发出了语音气泡的"发语音"调用也不显示（气泡代表它，
// 气泡长按菜单的"详情 ›"里看这次调用）。
// data-mark 标在每张卡、每条记录上：缩小后右侧标注的箭头指到这一行（ZoomHistory 的 layoutAnnotations）。工具调用组只存在于
// 对话层：缩小后组里每次调用、每段思考各画一块（ZoomBlockView 是那一块的对话层内容），标注挂在那一块上。
// 详情入口（onDetail 给的是条目层的 id）：用户气泡点整条，多段的回复点"详情 ›"，收成一行的点整行（行尾 ›），语音在长按菜单里。
// 条目自己的 id 标在外面的矩形上（ZoomHistory 的 .zi 的 data-item）；"在对话中定位"到组里某一步时，那一步不在对话层，闪的是整组。
// 一条消息里连着的文件附件合成一组（state 的 partRuns），画成一横排卡片（parts.tsx 的 FileCards）；
// 运行时跟在任务做完的通知后面放的附件（只有文件的系统消息）画成一排附件卡片。
// 排队的消息（二狗回复时发的）是虚线的用户气泡、标"排队中"，右上角一个叉，长按（电脑上按住）拖动改顺序（queue-drag.tsx）；
// 交出去之后同一个条目 id（发送请求的幂等键）换成正常气泡，原地不动。说到一半被停下的回复标"已停止"。
import type { MouseEvent, ReactNode } from "react";
import {
  browsingLabel,
  type ChatItem,
  chatItemIdOf,
  type ChatLine,
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
import { AssistantBubble, ChatLineView } from "./rows.tsx";
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

/** 连着的一组文件附件：一横排卡片，装不下换行 */
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
 * 收成一行的一条：不是气泡，放在个人助理那一列的一格里（.msg.assistant > .msg-part.part-line，和对话气泡同一列、
 * 同样的最宽宽度）；整行点开详情。mark：缩小后右侧标注的箭头指到这一行（卡片、记录）
 */
export function LineItem({ look, onOpen, mark, kind }: { look: ChatLine; onOpen: (() => void) | undefined; mark?: string | undefined; kind?: string | undefined }) {
  return (
    <div className={`msg assistant msg-line msg-line-${kind ?? look.kind}`} data-mark={mark}>
      <div className="msg-part part-line">
        <ChatLineView look={look} onOpen={onOpen} />
      </div>
    </div>
  );
}

export function ChatItemView({ item, actions }: { item: ChatItem; actions: ChatItemActions }) {
  const { onDetail, onQuote } = actions;
  // 网页插件登记了这种条目的画法（调用记忆）：交给它
  const plugins = usePlugins();
  const Plugged = plugins.get("chatItems", item.kind)?.Item;
  if (Plugged) return <Plugged item={item} actions={actions} />;
  const open = onDetail && ((id: string) => () => onDetail(id));
  const look = chatLook(item);
  /** 这一行点开（整行，行尾 ›）：有详情、会话接了详情才有 */
  const openLine = look.open ? open?.(item.id) : undefined;
  // agent 之间的来信（秘书转达的用户消息、运行时的系统通知）：一行
  if (look.form === "line" && look.kind === "letter") return <LineItem look={look} onOpen={openLine} kind="letter" />;
  switch (item.kind) {
    case "user":
    case "voice": {
      // agent 的语音只画那段语音（这条消息别的 part 各是各的条目）；用户的整条消息一起画（语音连同引用的卡片）
      const agent = item.kind === "voice" && item.speaker === "agent";
      // 排队的：虚线气泡，能叉、能拖
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
          {/* 秘书转达的话折成一行"<名字>转达"（上面的来信那一行），不走到这里 */}
          {partRuns(parts).map((run) =>
            run.kind === "files" ? (
              <Files key={run.index} files={run.files} />
            ) : (
              <Part key={run.index} part={run.part} onDetail={open?.(agent ? item.id : partItemId(item.id, run.part, run.index))} onQuote={onQuote} />
            ),
          )}
          <Meta>
            {/* 在"浏览"里网页的框上说的：写明在哪个网页、哪个框上 */}
            {!agent && item.message.pageCommand ? `${pageCommandLabel(item.message.pageCommand)} · ` : ""}
            {/* 浏览侧边栏里说的：写明在哪个网页上 */}
            {!agent && item.message.browsing ? `${browsingLabel(item.message.browsing)} · ` : ""}
            {/* 在官方 App 里说的（只读跟随补记的） */}
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
    case "thinking":
      return look.form === "line" ? <LineItem look={look} onOpen={openLine} /> : null;
    case "reply": {
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
                {/* 说到一半被停下的：已经说出来的留着，标出来 */}
                {item.stopped && <span className="msg-stopped">{t("ui.chatItemView.stopped")}</span>}
                {item.stopped && item.time ? " · " : ""}
                {/* 在官方 App 里回的（只读跟随补记的） */}
                {item.remote && <span className="msg-remote">{t("ui.chatItemView.remote")}</span>}
                {item.remote && item.time ? " · " : ""}
                {item.time ? clockLabel(item.time) : ""}
              </>
            )}
          </Meta>
        </div>
      );
    }
    case "tool_group":
      // 点整行看组的详情
      return look.form === "line" ? <LineItem look={look} onOpen={openLine} kind="tools" /> : null;
    case "recall": {
      // 调用记忆由网页插件画（上面）；拥有它的插件没在用时占位（会话里一般已经换成了 unavailable，这里兜底）
      const plugin = plugins.unavailable("chatItems", item.kind);
      return plugin === undefined ? null : <UnavailableLine text={t("state.chatItems.unavailable", { plugin })} />;
    }
    case "card":
      // 收到了这张卡的收成一行，点进详情处理；还没收到、打不开详情的照旧整张画；地图卡片这种要直接看的照旧整张画，下面照旧"引用 · 详情"
      if (look.form === "line") return <LineItem look={look} onOpen={openLine} mark={item.id} />;
      return (
        <div className="msg assistant">
          <Part part={{ type: "card_ref", cardId: item.cardId }} mark={item.id} onDetail={look.open === "link" ? open?.(item.id) : undefined} onQuote={onQuote} />
        </div>
      );
    case "system": {
      if (look.form !== "line") return null;
      // 分支摘要（会话回退之后新分支开头那一条）："回退"加摘要的第一句；恢复了哪些文件在详情里
      if (item.branch) return <LineItem look={look} onOpen={openLine} />;
      // 系统说明："说明"加第一行，点整行看全文；运行时放的附件（任务做完时交付的 md）照旧一排卡片，点"预览"去报告页
      const firstText = item.parts.findIndex((p) => p.type === "text");
      return (
        <div className="msg assistant msg-line msg-line-note">
          {partRuns(item.parts).map((run) =>
            run.kind === "files" ? (
              <Files key={run.index} files={run.files} />
            ) : run.part.type === "text" ? (
              run.index === firstText && look.text !== "" ? (
                <div key={run.index} className="msg-part part-line">
                  <ChatLineView look={look} onOpen={openLine} />
                </div>
              ) : null
            ) : (
              <PartView key={run.index} part={run.part} onDetail={open?.(item.id)} />
            ),
          )}
        </div>
      );
    }
    case "record":
      // 时间线记录：种类、摘要、时间，点整行看详细说明
      return look.form === "line" ? <LineItem look={look} onOpen={openLine} mark={item.marks[0]?.key} /> : null;
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
      // 插件没启用：一行占位，样子同"已删除"
      return <UnavailableLine text={item.keyLine} />;
  }
}

/** 插件没启用、这条内容暂时看不到 */
function UnavailableLine({ text }: { text: string }) {
  return (
    <div className="msg msg-system">
      <div className="sys-note msg-unavailable">{text}</div>
    </div>
  );
}

/**
 * 一条排队的消息：用户气泡的样子，虚线边框、淡一点，标"排队中"；右上角的叉点了从队列里拿掉（不用确认）；
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
 * 缩小后组里的一块在对话层那一层的内容：组只在对话层是一行，缩小后每次调用、每段思考各画一块，这一块的对话层内容
 * 只在跨档淡入淡出的那一下看得见，撑出这一块的高度。调用画工具行（ToolRow）的第一行：圆点、说人话的那一句
 * （有模板的是 .tool-said-text，没有的是"中文名 · 参数值"）、›；思考是一行"💭 Agent 的想法（点开看）"（缩小后的样子照旧）。
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
