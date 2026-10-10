// 消息按 part 渲染：文本、推理（一行，点开看）、图片、文件、语音（31 号票，VoiceBubble.tsx）、agent 的语音（32 号票，同一个气泡）、
// 卡片引用、工单分隔；视频只预留。
// 56 号票起有详情的都能点开（onDetail：这一部分所属的那一条的详情，由会话组件按条目 id 绑好）：思考旁边"详情 ›"，
// 卡片旁边"详情 ›"，语音在长按菜单里。57 号票起会话里的思考、回复、工具调用组按聊天区精简画（rows.tsx：
// 回复是 Markdown 的 AssistantBubble，工具调用组是一行"调用了 N 个工具 ›"），每次工具调用不再单独画一行，在详情页里看。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type MessagePart, sizeLabel, THINKING_LABEL } from "../../state/index.ts";
import { useAssistantName } from "../assistant-name.tsx";
import { CardPanel } from "../cards/CardPanel.tsx";
import { ThinkingRow } from "./rows.tsx";
import { AgentVoiceBubble, VoiceBubble } from "./VoiceBubble.tsx";

export function PartView({ part, onDetail, onQuote }: { part: MessagePart; onDetail?: (() => void) | undefined; onQuote?: ((cardId: string) => void) | undefined }) {
  switch (part.type) {
    case "text":
      return <div className="bubble">{part.text}</div>;
    case "reasoning":
      return <ThinkingRow text={part.text} label={THINKING_LABEL} live={false} onDetail={onDetail} />;
    case "image":
      return <ImageView part={part} />;
    case "file":
      return <FileView part={part} />;
    case "voice":
      return <VoiceBubble part={part} onDetail={onDetail} />;
    case "tts_audio":
      return <AgentVoiceBubble part={part} onDetail={onDetail} />;
    case "video":
      return <div className="part-reserved muted">（视频 · 第二阶段）</div>;
    case "tool_call":
      // 工具调用不单独画：会话里成组画成一行"调用了 N 个工具 ›"（rows.tsx），每一次在详情页里看
      return null;
    case "card_ref":
      return <CardRef cardId={part.cardId} onQuote={onQuote} onDetail={onDetail} />;
    case "work_order_divider":
      return (
        <div className="wo-divider" role="separator">
          <span>
            {part.workOrderId ? <b>工单 {part.workOrderId}</b> : <b>对话段</b>} · {part.title}
            <span className="muted"> · 来自{part.from}</span>
          </span>
        </div>
      );
    case "run_divider":
      // 定时触发的任务的一次运行（76 号票）：各次运行接着同一段会话，每次开始时一条分隔线
      return (
        <div className="wo-divider run-divider" role="separator">
          <span>
            <b>{part.title.split(" · ")[0]}</b>
            {part.title.includes(" · ") && <span className="muted"> · {part.title.split(" · ").slice(1).join(" · ")}</span>}
          </span>
        </div>
      );
  }
}

/** 聊天里的卡片，加一个"引用"（把卡片引用到输入框）和"详情 ›" */
function CardRef({ cardId, onQuote, onDetail }: { cardId: string; onQuote?: ((cardId: string) => void) | undefined; onDetail?: (() => void) | undefined }) {
  const name = useAssistantName();
  return (
    <>
      <CardPanel cardId={cardId} />
      {(onQuote || onDetail) && (
        <div className="card-more">
          {onQuote && (
            <button type="button" className="link quote-btn" title={`把这张卡引用到输入框，和你的话一起发给${name}`} onClick={() => onQuote(cardId)}>
              引用
            </button>
          )}
          {onDetail && (
            <button type="button" className="link" onClick={onDetail}>
              详情 ›
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** 聊天里的图片直接显示，点开看原图；没有真媒体（原型的假数据）时画占位图 */
function ImageView({ part }: { part: Extract<MessagePart, { type: "image" }> }) {
  const { http } = useStore();
  const url = http.mediaUrl(part.mediaId, part.name);
  const [broken, setBroken] = useState(false);
  return (
    <figure className="part-image">
      {url && !broken ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title={`${part.name}（点开看原图）`}>
          <img
            src={url}
            alt={part.name}
            loading="lazy"
            decoding="async"
            // 先占好位置（有尺寸时），图片加载出来时消息列表不跳
            {...(part.width && part.height ? { width: part.width, height: part.height } : {})}
            onError={() => setBroken(true)}
          />
        </a>
      ) : (
        <FakeImage name={part.name} />
      )}
      <figcaption>
        {part.name}
        {part.asMaterial && <span className="chip chip-data">作为材料投喂</span>}
      </figcaption>
    </figure>
  );
}

/** 文件附件：名字、类型、大小，点了下载 */
function FileView({ part }: { part: Extract<MessagePart, { type: "file" }> }) {
  const { http } = useStore();
  const url = http.mediaUrl(part.mediaId, part.name, { download: true });
  const body = (
    <>
      <span className="part-file-icon" aria-hidden="true">
        📄
      </span>
      <span className="part-file-name">{part.name}</span>
      <span className="muted">
        {part.mime} · {sizeLabel(part.size)}
      </span>
      {part.asMaterial && <span className="chip chip-data">作为材料投喂</span>}
    </>
  );
  return url ? (
    <a className="part-file part-file-link" href={url} download={part.name} title={`下载 ${part.name}`}>
      {body}
      <span className="part-file-dl" aria-hidden="true">
        ⤓
      </span>
    </a>
  ) : (
    <div className="part-file">{body}</div>
  );
}

/** 原型没有真图片：画一张占位图 */
function FakeImage({ name }: { name: string }) {
  return (
    <svg className="fake-image" viewBox="0 0 120 160" role="img" aria-label={name}>
      <rect width="120" height="160" rx="6" fill="var(--bg)" stroke="var(--border)" />
      <rect x="16" y="18" width="70" height="8" rx="2" fill="var(--border)" />
      <rect x="16" y="34" width="88" height="5" rx="2" fill="var(--border)" />
      <rect x="16" y="45" width="80" height="5" rx="2" fill="var(--border)" />
      <rect x="16" y="56" width="84" height="5" rx="2" fill="var(--border)" />
      <rect x="16" y="120" width="50" height="10" rx="2" fill="var(--muted)" opacity="0.5" />
    </svg>
  );
}
