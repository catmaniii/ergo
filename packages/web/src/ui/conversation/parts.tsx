// 消息按 part 渲染：文本、推理（默认折叠）、图片、文件、语音（31 号票，VoiceBubble.tsx）、agent 的语音（32 号票，同一个气泡）、
// 工具调用、卡片引用、工单分隔；视频只预留。
// 56 号票起有详情的都能点开（onDetail：这一部分所属的那一条的详情，由会话组件按条目 id 绑好）：思考旁边"详情 ›"，
// 工具调用点整行、行尾 ›，卡片旁边"详情 ›"，语音在长按菜单里；工具调用的详情在详情页（ui/detail/），不再在这里。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { BLOCKED_BY_LABEL, DISPOSITION_LABEL } from "../../model/labels.ts";
import { type MessagePart, sizeLabel } from "../../state/index.ts";
import { useAssistantName } from "../assistant-name.tsx";
import { CardPanel } from "../cards/CardPanel.tsx";
import { AgentVoiceBubble, VoiceBubble } from "./VoiceBubble.tsx";

export type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const OUTCOME_LABEL: Record<ToolCallPart["outcome"], string> = {
  running: "执行中",
  done: "已执行",
  blocked: "被拦下",
  denied: "你拒绝了",
  error: "出错",
};

export function PartView({ part, onDetail, onQuote }: { part: MessagePart; onDetail?: (() => void) | undefined; onQuote?: ((cardId: string) => void) | undefined }) {
  switch (part.type) {
    case "text":
      return <div className="bubble">{part.text}</div>;
    case "reasoning":
      return <Reasoning text={part.text} onDetail={onDetail} />;
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
      return <ToolCallView part={part} onOpen={onDetail} />;
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

/** 思考：原地展开（照旧），旁边"详情 ›"（AgentSense 的 ThinkingRow） */
function Reasoning({ text, onDetail }: { text: string; onDetail?: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="part-reasoning">
      <div className="reasoning-row">
        <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "收起思考过程 ▾" : "思考过程 ▸"}
        </button>
        {onDetail && (
          <button type="button" className="link thinking-more" onClick={onDetail}>
            详情 ›
          </button>
        )}
      </div>
      {open && <div className="thinking fx-open">{text}</div>}
    </div>
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

/** 一次工具调用：工具名、参数摘要、命中的关注类别、判定、是否授权内、是否通用 bash；整行点开详情，行尾 ›（AgentSense 的 ToolRow） */
export function ToolCallView({ part, onOpen }: { part: ToolCallPart; onOpen?: (() => void) | undefined }) {
  const cls = part.outcome === "error" ? "tool-error" : part.outcome === "running" ? "tool-running" : `tc-${part.outcome}`;
  return (
    <button type="button" className={`tool tool-btn ${cls}`} onClick={onOpen} disabled={!onOpen}>
      <div className="tool-head">
        <span className="tool-dot" />
        <span className="tool-name">{part.tool}</span>
        <span className="tool-brief">{part.argsSummary}</span>
        {onOpen && <span className="tool-more">›</span>}
      </div>
      <div className="chips">
        {part.categoryTitles.map((c) => (
          <span key={c} className="chip chip-op">
            {c}
          </span>
        ))}
        {part.blockedBy ? (
          <span className="chip" title="守卫判定">
            {BLOCKED_BY_LABEL[part.blockedBy]}
          </span>
        ) : (
          part.disposition && (
            <span className={`chip ${part.disposition === "do" ? "chip-quiet" : ""}`} title="守卫判定">
              {DISPOSITION_LABEL[part.disposition]}
            </span>
          )
        )}
        {part.withinGrant && <span className="chip chip-ok">授权内</span>}
        {part.genericBash && <span className="chip chip-generic">通用 bash</span>}
        <span className={`chip tc-out tc-out-${part.outcome}`}>{OUTCOME_LABEL[part.outcome]}</span>
      </div>
      {part.resultSummary && <div className="tool-result">{part.resultSummary}</div>}
    </button>
  );
}
