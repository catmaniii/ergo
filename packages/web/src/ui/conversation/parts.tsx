// 消息按 part 渲染：文本、推理（一行，点开看）、图片、文件、语音（31 号票，VoiceBubble.tsx）、agent 的语音（32 号票，同一个气泡）、
// 卡片引用、工单分隔；视频只预留。
// 56 号票起有详情的都能点开（onDetail：这一部分所属的那一条的详情，由会话组件按条目 id 绑好）：思考旁边"详情 ›"，
// 卡片旁边"详情 ›"，语音在长按菜单里。57 号票起会话里的思考、回复、工具调用组按聊天区精简画（rows.tsx：
// 回复是 Markdown 的 AssistantBubble，工具调用组是一行"调用了 N 个工具 ›"），每次工具调用不再单独画一行，在详情页里看。
// 113 号票：文件附件画成卡片（FileCards：类型图标、标题、"预览""下载"，一组排成一横排），能预览的点图标去报告页。
import { type MouseEvent, useState } from "react";
import { pushHash } from "../../app/history-nav.ts";
import { toHash } from "../../app/route-hash.ts";
import { useStore } from "../../app/store.tsx";
import { clearedDividerText, type FileCard, fileCards, type FilePartValue, type MessagePart, t, thinkingLabel } from "../../state/index.ts";
import { useAssistantName } from "../assistant-name.tsx";
import { CardPanel } from "../cards/CardPanel.tsx";
import { T } from "../i18n.tsx";
import { ImageViewer } from "../image-viewer.tsx";
import { ThinkingRow } from "./rows.tsx";
import { AgentVoiceBubble, VoiceBubble } from "./VoiceBubble.tsx";

export function PartView({ part, onDetail, onQuote }: { part: MessagePart; onDetail?: (() => void) | undefined; onQuote?: ((cardId: string) => void) | undefined }) {
  switch (part.type) {
    case "text":
      return <div className="bubble">{part.text}</div>;
    case "reasoning":
      return <ThinkingRow text={part.text} label={thinkingLabel()} live={false} onDetail={onDetail} />;
    case "image":
      return <ImageView part={part} />;
    case "file":
      return <FileCards files={[part]} />;
    case "voice":
      return <VoiceBubble part={part} onDetail={onDetail} />;
    case "tts_audio":
      return <AgentVoiceBubble part={part} onDetail={onDetail} />;
    case "video":
      return <div className="part-reserved muted">{t("ui.parts.videoReserved")}</div>;
    case "tool_call":
      // 工具调用不单独画：会话里成组画成一行"调用了 N 个工具 ›"（rows.tsx），每一次在详情页里看
      return null;
    case "card_ref":
      return <CardRef cardId={part.cardId} onQuote={onQuote} onDetail={onDetail} />;
    case "work_order_divider":
      return (
        <div className="wo-divider" role="separator">
          <span>
            {/* 163 号票：工单写"工单 wo-3「标题」"，和别处的 t-3「标题」同一种写法 */}
            {part.workOrderId ? (
              <T k="ui.parts.workOrderDivider" params={{ label: <b>{t("ui.parts.workOrder", { id: part.workOrderId })}</b>, title: part.title }} />
            ) : (
              <>
                <b>{t("ui.parts.segment")}</b> · {part.title}
              </>
            )}
            <span className="muted">{t("ui.parts.from", { from: part.from })}</span>
          </span>
        </div>
      );
    case "conversation_cleared":
      // 清空当前对话（114 号票）：会话里由 ChatItemView 带着时间画（ClearedDivider），这里只在别处单独画这个 part 时用
      return <ClearedDivider time={undefined} />;
    case "branch_summary":
      // 分支摘要（150 号票）：会话里由 ChatItemView 画，这里只在别处单独画这个 part 时用
      return <div className="context-note">🧭 {part.summary}</div>;
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

/**
 * 清空当前对话的分隔线（114 号票）：上面一行小字"更早的对话"（清空前的，它已经不记得，往上翻照样能看），
 * 下面"以下是新对话 · 10-13 14:02 清空"
 */
export function ClearedDivider({ time }: { time: string | undefined }) {
  return (
    <div className="cleared-divider">
      <div className="cleared-earlier muted">{t("ui.parts.clearedEarlier")}</div>
      <div className="wo-divider" role="separator">
        <span>
          <b>{clearedDividerText(time).split(" · ")[0]}</b>
          {time && <span className="muted"> · {clearedDividerText(time).split(" · ")[1]}</span>}
        </span>
      </div>
    </div>
  );
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
            <button type="button" className="link quote-btn" title={t("ui.parts.quoteHint", { name })} onClick={() => onQuote(cardId)}>
              {t("ui.parts.quote")}
            </button>
          )}
          {onDetail && (
            <button type="button" className="link" onClick={onDetail}>
              {t("ui.parts.details")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * 聊天里的图片直接显示，点开在页面上放大看（ui/image-viewer.tsx：×、点空白、返回手势、Esc 都能关）；
 * 电脑上按住 Ctrl / ⌘ 或中键点，照旧在新窗口打开原图。没有真媒体（原型的假数据）时画占位图
 */
function ImageView({ part }: { part: Extract<MessagePart, { type: "image" }> }) {
  const { http } = useStore();
  const url = http.mediaUrl(part.mediaId, part.name);
  const [broken, setBroken] = useState(false);
  const [viewing, setViewing] = useState(false);
  return (
    <figure className="part-image">
      {url && viewing && <ImageViewer src={url} name={part.name} onClose={() => setViewing(false)} />}
      {url && !broken ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={t("ui.parts.imageZoomHint", { name: part.name })}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            setViewing(true);
          }}
        >
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
        {part.asMaterial && <span className="chip chip-data">{t("ui.parts.fedAsMaterial")}</span>}
      </figcaption>
    </figure>
  );
}

/**
 * 一组文件附件（113 号票，一条消息里连着的几个由 state 的 partRuns 合成一组）：每个一张卡片，排成一横排，装不下换行。
 * 卡片竖排三层：类型图标（方块里写类型，按类别上色）、标题（同类多个时带序号）、"预览""下载"
 */
export function FileCards({ files }: { files: readonly FilePartValue[] }) {
  return (
    <div className="att-row">
      {fileCards(files).map((card, i) => (
        <AttachmentCard key={`${i}:${card.part.mediaId}`} card={card} />
      ))}
    </div>
  );
}

/**
 * 一张附件卡片。能预览的（Markdown、纯文本，117 号票起还有 1 MB 以内的 HTML、SVG）点图标或"预览"去报告页（经 pushHash 记下来处，报告页的 ‹ 回到这里）；
 * 不能预览的只有"下载"，点图标也是下载，图标上写明"仅下载"。原型里没有真文件时"下载"灰着
 */
function AttachmentCard({ card }: { card: FileCard }) {
  const { http } = useStore();
  const { part } = card;
  const download = http.mediaUrl(part.mediaId, part.name, { download: true });
  const report = toHash({ tab: "report", mediaId: part.mediaId });
  const openReport = (e: MouseEvent) => {
    e.preventDefault();
    pushHash(window, report);
  };
  const iconClass = `att-icon att-${card.category}`;
  const icon = (
    <>
      <span className="att-type">{card.label}</span>
      {!card.preview && <span className="att-only">{t("ui.parts.downloadOnly")}</span>}
    </>
  );
  return (
    <div className="att-card" title={card.tooltip}>
      {card.iconAction === "preview" ? (
        <a className={iconClass} href={report} onClick={openReport} title={card.iconHint} aria-label={card.iconHint}>
          {icon}
        </a>
      ) : download ? (
        <a className={iconClass} href={download} download={part.name} title={card.iconHint} aria-label={card.iconHint}>
          {icon}
        </a>
      ) : (
        <span className={iconClass} title={card.iconHint}>
          {icon}
        </span>
      )}
      <div className="att-title">
        {card.seq && <b className="att-seq">{card.seq}</b>}
        {card.title}
      </div>
      {part.asMaterial && <span className="chip chip-data">{t("ui.parts.fedAsMaterial")}</span>}
      <div className="att-btns">
        {card.preview && (
          <a className="att-btn" href={report} onClick={openReport}>
            {t("ui.parts.preview")}
          </a>
        )}
        {download ? (
          <a className="att-btn" href={download} download={part.name}>
            {t("ui.parts.download")}
          </a>
        ) : (
          <span className="att-btn" aria-disabled="true" title={t("ui.parts.noRealFile")}>
            {t("ui.parts.download")}
          </span>
        )}
      </div>
    </div>
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
