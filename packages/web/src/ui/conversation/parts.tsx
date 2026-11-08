// 消息按 part 渲染：文本、推理（一行"思考"加第一句）、图片、文件、语音（VoiceBubble.tsx）、agent 的语音（同一个气泡）、
// 卡片引用、工单分隔；视频 part 只预留（作为文件附件发的视频像图片一样直接显示，见 VideoView）。
// 有详情的都能点开（onDetail：这一部分所属的那一条的详情，由会话组件按条目 id 绑好）：用户消息里引用的卡片、还没收到的卡片
// 下面"引用 · 详情 ›"，语音在长按菜单里。会话里的思考、回复、工具调用组、卡片按聊天区精简画（rows.tsx：
// 回复是 Markdown 的 AssistantBubble，别的收成一行 ChatLineView），每次工具调用不再单独画一行，在详情页里看。
// 文件附件画成卡片（FileCards：类型图标、标题、"预览""下载"，一组排成一横排），能预览的点图标去报告页；
// 视频附件不画卡片，直接显示第一帧、播放键和时长，点开大播放器（VideoView）。
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { pushHash } from "../../app/history-nav.ts";
import { toHash } from "../../app/route-hash.ts";
import { useStore } from "../../app/store.tsx";
import {
  clearedDividerText,
  type FileCard,
  fileCards,
  type FilePartValue,
  isChatVideo,
  type MessagePart,
  t,
  thinkingLine,
  unplayableVideoCard,
  VIDEO_THUMB_IDLE,
  VIDEO_THUMB_UNPLAYABLE,
  type VideoThumb,
  videoDurationLabel,
  videoThumbOf,
  videoThumbSrc,
} from "../../state/index.ts";
import { useAssistantName } from "../assistant-name.tsx";
import { CardPanel } from "../cards/CardPanel.tsx";
import { T } from "../i18n.tsx";
import { Icon } from "../icons.tsx";
import { ImageViewer } from "../image-viewer.tsx";
import { useNearScreen } from "../near-screen.ts";
import { VideoViewer } from "../video-viewer.tsx";
import { ChatLineView } from "./rows.tsx";
import { AgentVoiceBubble, VoiceBubble } from "./VoiceBubble.tsx";

export function PartView({ part, onDetail, onQuote }: { part: MessagePart; onDetail?: (() => void) | undefined; onQuote?: ((cardId: string) => void) | undefined }) {
  switch (part.type) {
    case "text":
      return <div className="bubble">{part.text}</div>;
    case "reasoning":
      return <ChatLineView look={thinkingLine(part.text, false, onDetail ? "row" : undefined)} onOpen={onDetail} />;
    case "image":
      return <ImageView part={part} />;
    case "file":
      // 视频附件单独成一块（state 的 partRuns）：直接显示第一帧；别的单独画时是一张卡片
      return isChatVideo(part) ? <VideoView part={part} /> : <FileCards files={[part]} />;
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
            {/* 工单写"工单 wo-3「标题」"，和别处的 t-3「标题」同一种写法 */}
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
      // 清空当前对话：会话里由 ChatItemView 带着时间画（ClearedDivider），这里只在别处单独画这个 part 时用
      return <ClearedDivider time={undefined} />;
    case "branch_summary":
      // 分支摘要：会话里由 ChatItemView 画，这里只在别处单独画这个 part 时用
      return <div className="context-note">🧭 {part.summary}</div>;
    case "run_divider":
      // 定时触发的任务的一次运行：各次运行接着同一段会话，每次开始时一条分隔线
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
 * 清空当前对话的分隔线：上面一行小字"更早的对话"（清空前的，它已经不记得，往上翻照样能看），
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

/**
 * 整张画的卡片（用户消息里引用的、还没收到的），加一个"引用"（把卡片引用到输入框）和"详情 ›"。
 * 二狗那边收到了的卡片在对话里收成一行，不走这里（引用在卡片详情里）
 */
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
 * 聊天里的视频附件：像图片一样直接显示第一帧（按比例，限宽限高和图片一样）、中间播放键、角上时长；点开盖一层大播放器
 * （ui/video-viewer.tsx，自动放、有声音）。第一帧滚到附近才取（ui/near-screen.ts）：<video preload="metadata" muted playsinline>，
 * 地址带 #t=0.1 停在开头那一帧，只取元数据和开头一小段，不在守护进程截图。
 * 取不到、解不了（播放器报错，或者元数据里没有画面宽高）：退回文件卡片，写"网页里放不了，下载看"（state/chat-video.ts）。
 * 没有地址（原型里没有内容的假录像）照旧画卡片，报告页说原型里没有内容
 */
function VideoView({ part }: { part: FilePartValue }) {
  const { http } = useStore();
  const src = http.mediaPlayUrl(part.mediaId, part.name);
  const download = http.mediaUrl(part.mediaId, part.name, { download: true });
  const boxRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const near = useNearScreen(boxRef, src !== undefined);
  const [thumb, setThumb] = useState<VideoThumb>(VIDEO_THUMB_IDLE);
  const [viewing, setViewing] = useState(false);
  // 滚到附近了挂上取第一帧的地址；卸下时（会话切走、消息被换掉）拿掉地址再 load()，不接着下载。
  // 地址在这里挂、拿（不写成 src 属性）：开发时 StrictMode 把 effect 跑两遍也能再挂回来
  useEffect(() => {
    const video = videoRef.current;
    if (!near || !video || !src) return;
    video.src = videoThumbSrc(src);
    return () => {
      video.removeAttribute("src");
      video.load();
    };
  }, [near, src]);
  if (!src) return <FileCards files={[part]} />;
  if (thumb.kind === "unplayable") return <UnplayableVideo part={part} />;
  const ready = thumb.kind === "ready" ? thumb : undefined;
  const duration = videoDurationLabel(ready?.duration);
  return (
    <figure className="part-video">
      {viewing && <VideoViewer src={src} name={part.name} download={download} ratio={ready && ready.width / ready.height} onClose={() => setViewing(false)} />}
      <button
        ref={boxRef}
        type="button"
        className={`video-thumb${ready ? " video-thumb-ready" : ""}`}
        title={t("ui.parts.videoPlayHint", { name: part.name })}
        aria-label={t("ui.parts.videoPlayHint", { name: part.name })}
        onClick={() => setViewing(true)}
      >
        {near && (
          <video
            ref={videoRef}
            preload="metadata"
            muted
            playsInline
            disablePictureInPicture
            tabIndex={-1}
            aria-hidden="true"
            onLoadedMetadata={(e) => setThumb(videoThumbOf(e.currentTarget))}
            onError={() => setThumb(VIDEO_THUMB_UNPLAYABLE)}
          />
        )}
        <span className="video-play">
          <Icon name="play" />
        </span>
        {duration && <span className="video-duration">{duration}</span>}
      </button>
      <figcaption>
        {part.name}
        {part.asMaterial && <span className="chip chip-data">{t("ui.parts.fedAsMaterial")}</span>}
      </figcaption>
    </figure>
  );
}

/** 放不了的视频：退回原来的文件卡片（不给"预览"，点了下载），卡片上写"网页里放不了，下载看" */
function UnplayableVideo({ part }: { part: FilePartValue }) {
  const card = fileCards([part])[0]!;
  return (
    <div className="att-row">
      <AttachmentCard card={unplayableVideoCard(card)} />
    </div>
  );
}

/**
 * 一组文件附件（一条消息里连着的几个由 state 的 partRuns 合成一组）：每个一张卡片，排成一横排，装不下换行。
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
 * 一张附件卡片。能预览的（Markdown、纯文本、表格、JSON、代码和配置，1 MB 以内的 HTML、SVG，音频、视频）点图标或"预览"去报告页
 * （经 pushHash 记下来处，报告页的 ‹ 回到这里）；
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
      {card.note && <div className="att-note">{card.note}</div>}
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
