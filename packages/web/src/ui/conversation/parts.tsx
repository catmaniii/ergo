// 消息按 part 渲染：文本、推理（默认折叠）、图片、文件、工具调用、卡片引用、工单分隔；
// 语音、TTS 音频、视频第一阶段只预留。
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { DISPOSITION_LABEL } from "../../model/labels.ts";
import type { MessagePart } from "../../state/index.ts";
import { CardPanel } from "../cards/CardPanel.tsx";

export type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const OUTCOME_LABEL: Record<ToolCallPart["outcome"], string> = {
  running: "执行中",
  done: "已执行",
  blocked: "被拦下",
  denied: "你拒绝了",
  error: "出错",
};

export function PartView({ part, onToolDetail }: { part: MessagePart; onToolDetail?(p: ToolCallPart): void }) {
  switch (part.type) {
    case "text":
      return <div className="bubble">{part.text}</div>;
    case "reasoning":
      return <Reasoning text={part.text} />;
    case "image":
      return <ImageView part={part} />;
    case "file":
      return <FileView part={part} />;
    case "voice":
    case "tts_audio":
    case "video":
      return <div className="part-reserved muted">（{part.type === "video" ? "视频" : part.type === "voice" ? "语音" : "语音回复"} · 第二阶段）</div>;
    case "tool_call":
      return <ToolCallView part={part} onOpen={onToolDetail ? () => onToolDetail(part) : undefined} />;
    case "card_ref":
      return <CardPanel cardId={part.cardId} />;
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

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="part-reasoning">
      <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "收起思考过程 ▾" : "思考过程 ▸"}
      </button>
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
      <figcaption>{part.name}</figcaption>
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

export function sizeLabel(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 一次工具调用：工具名、参数摘要、命中的关注类别、判定、是否授权内、是否通用 bash */
export function ToolCallView({ part, onOpen }: { part: ToolCallPart; onOpen?(): void }) {
  const cls = part.outcome === "error" ? "tool-error" : part.outcome === "running" ? "tool-running" : `tc-${part.outcome}`;
  return (
    <button type="button" className={`tool tool-btn ${cls}`} onClick={onOpen} disabled={!onOpen}>
      <div className="tool-head">
        <span className="tool-dot" />
        <span className="tool-name">{part.tool}</span>
        <span className="tool-brief">{part.argsSummary}</span>
      </div>
      <div className="chips">
        {part.watchCategories.map((c) => (
          <span key={c} className="chip chip-op">
            {c}
          </span>
        ))}
        <span className={`chip ${part.disposition === "do" ? "chip-quiet" : ""}`} title="守卫判定">
          {DISPOSITION_LABEL[part.disposition]}
        </span>
        {part.withinGrant && <span className="chip chip-ok">授权内</span>}
        {part.genericBash && <span className="chip chip-generic">通用 bash</span>}
        <span className={`chip tc-out tc-out-${part.outcome}`}>{OUTCOME_LABEL[part.outcome]}</span>
      </div>
      {part.resultSummary && <div className="tool-result">{part.resultSummary}</div>}
    </button>
  );
}

/** 工具调用的详情：宽屏在右栏，竖屏在底部弹层 */
export function ToolCallDetail({ part }: { part: ToolCallPart }) {
  return (
    <div className="tc-detail">
      <dl className="kv">
        <dt>工具</dt>
        <dd>
          <b>{part.tool}</b>
        </dd>
        <dt>参数</dt>
        <dd>
          <code>{part.argsSummary}</code>
        </dd>
        <dt>关注类别</dt>
        <dd>{part.watchCategories.length ? part.watchCategories.join("、") : "没有命中（直接做只记录）"}</dd>
        <dt>守卫判定</dt>
        <dd>{DISPOSITION_LABEL[part.disposition]}</dd>
        <dt>授权</dt>
        <dd>{part.withinGrant ? "属于计划里的授权项" : part.watchCategories.length ? "不在授权内" : "不需要授权"}</dd>
        <dt>结果</dt>
        <dd>
          {OUTCOME_LABEL[part.outcome]}
          {part.resultSummary ? `：${part.resultSummary}` : ""}
        </dd>
      </dl>
      {part.genericBash && (
        <div className="sys-note tc-note">通用 bash：没有事先规定类型的 bash 调用。守卫照常检查；拆不开的先问你，并在时间线的要点层和全局层单独标出。</div>
      )}
      <div className="hint">原型：效果日志、时序规则的命中和给模型的说明，接上守卫（03 号票）后显示在这里。</div>
    </div>
  );
}
