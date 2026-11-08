// 聊天区精简：对话层里回复和收成一行的那几种怎么画。长什么样由状态层的 chatLook（state/chat-look.ts）给出。
// 回复是 AssistantBubble（Markdown）；思考、工具调用组、调用记忆、agent 之间的来信、卡片、时间线记录、系统说明、分支摘要
// 都是一行（ChatLineView）：图标、标题、一句话、句子后面的小签和时间、行尾 ›。样子借工具调用那一行（.tool-sum），
// 11 套风格里跟着各自的 .tool-sum 走。调用记忆那一行在记忆插件里（plugins/memory/RecallLine.tsx），也用 ChatLineView。
import type { ReactNode } from "react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type ChatLine, type ChatLook, REPLY_OPEN_BY_DEFAULT, t } from "../../state/index.ts";
import { clockLabel } from "../../util/time.ts";
import { NamedText } from "../assistant-name.tsx";
import { Icon } from "../icons.tsx";

/**
 * 回复里的图片（![名字](地址)）：没有演示图，只写名字（MD_PARTS），
 * 聊天里不去加载外面的图片（详情页里按地址加载）
 */
const MD_PARTS = {
  img: ({ alt }: { alt?: string | undefined }) => <span>{alt}</span>,
};

/**
 * 回复：Markdown，按第一个空行切成第一段和后文；有后文时气泡里给"收起 ▴ / 展开细节 ▾"和"详情 ›"，只有一段的两个都没有。
 * 默认整段展开（REPLY_OPEN_BY_DEFAULT）
 */
export function AssistantBubble({ text, look, onDetail }: { text: string; look: Extract<ChatLook, { form: "reply" }>; onDetail?: (() => void) | undefined }) {
  const [open, setOpen] = useState(REPLY_OPEN_BY_DEFAULT);
  return (
    <div className="bubble md">
      <Markdown remarkPlugins={[remarkGfm]} components={MD_PARTS}>
        {open ? text : look.head}
      </Markdown>
      {look.more && (
        <div className="bubble-more">
          <button type="button" className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? t("ui.rows.collapse") : t("ui.rows.expand")}
          </button>
          {onDetail && (
            <button type="button" className="link-btn" onClick={onDetail}>
              {t("ui.rows.details")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 一行最前面的图标：调用记忆是记忆的图标，来信是它的种类图标，分支摘要是回退的图标，别的是一个圆点（颜色按种类） */
function LineIcon({ look }: { look: ChatLine }) {
  if (look.kind === "recall") return <Icon name="layers" />;
  if (look.kind === "branch") return <Icon name="reload" />;
  if (look.kind === "letter" && look.icon) return <>{look.icon}</>;
  return <span className="tool-dot" />;
}

/** 来信、调用记忆那两行原来的类名（风格、测试按它认），别的种类没有 */
function kindClass(look: ChatLine): string {
  if (look.kind === "recall") return ` recall-line${look.dim ? " recall-none" : ""}`;
  if (look.kind === "letter") return " letter-line";
  return "";
}

/**
 * 收成一行的一条：图标、标题（有最小宽度，常见的短标题后面的句子对齐）、一句话（放不下省略，不换行）、
 * 句子后面的"等 N 步"、小签、时间（句子先省略，它们留着），行尾 ›（整行一样宽，› 在最右端，几种的 › 在同一条竖线上）。
 * 整行点开这一条的详情（宽屏右边的详情栏、手机上的详情页）；打不开详情的不画 ›、点不了。
 * 出了状况的醒目（被拦下一类 / 跟你有关的一类）；工具调用还有在执行的圆点一闪一闪，正在想的思考字轻轻明暗。
 * text：界面另外取到的说法（调用记忆取到第一条的标题之后），不给就是 look.text。名字占位按现在的名字显示
 */
export function ChatLineView({ look, onOpen, text }: { look: ChatLine; onOpen?: (() => void) | undefined; text?: string | undefined }) {
  const cls = [
    "tool-sum chat-line",
    `line-${look.kind}`,
    kindClass(look).trim(),
    look.alert ? `tool-sum-${look.alert}` : "",
    look.live && look.kind === "tool" ? "tool-running" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const tail: ReactNode[] = [];
  if (look.steps !== undefined) tail.push(<span key="steps" className="line-steps">{t("state.chatLook.steps", { count: look.steps })}</span>);
  for (const tag of look.tags)
    tail.push(
      <span key={tag.key} className={`tool-sum-tag tst-${tag.level}`}>
        · {tag.text}
      </span>,
    );
  if (look.time !== undefined) tail.push(<span key="time" className="line-time">· {clockLabel(look.time)}</span>);
  return (
    <button type="button" className={cls} onClick={onOpen} disabled={!onOpen} {...(look.cardType ? { "data-card-type": look.cardType } : {})}>
      <span className="line-icon" aria-hidden="true">
        <LineIcon look={look} />
      </span>
      <span className="line-title">
        <NamedText text={look.title} />
      </span>
      {/* 一句话和后面的"等 N 步"、小签、时间：句子先省略，缩没了后面那一段才省略（pages.css 的 .line-body） */}
      <span className="line-body">
        <span className={`tool-sum-text${look.live && look.kind === "thinking" ? " think-live" : ""}`}>
          <NamedText text={text ?? look.text} />
        </span>
        {tail.length > 0 && <span className="line-tail">{tail.flatMap((node, i) => (i === 0 ? [node] : [" ", node]))}</span>}
      </span>
      {onOpen && <span className="tool-more">›</span>}
    </button>
  );
}
