/**
 * 报告页（113 号票）：文本类附件渲染着看（#/report/<媒体 id>），不用下载。每次打开现取内容（守护进程的内容接口只回 JSON，
 * 不让浏览器直接渲染文件），可刷新、可收藏，链接发给同一前端的另一台已配对设备也能打开。
 * - 标题栏是文件名和"下载"；正文上面一行写类型、大小、什么时候发的；
 * - Markdown 用和聊天、详情页同一套 react-markdown + remarkGfm（不开 raw HTML），纯文本按原文显示；
 * - 表格放进能横向滚动的框里；外链在新窗口打开（rel="noopener noreferrer"）；页内锚点（#…）在这里会被当成页面路由，只显示文字；
 * - 不加载远程图片：Markdown 里的图片一律不请求，画成占位，有地址的给一个链接（免得报告页变成会往外发请求的窗口）；
 * - 截断了顶上一条提示；取不到（文件不在了、不能预览、解不出来、连不上）说清楚怎么办，不白屏；
 * - 大报告分段画（状态层的 markdownChunks）：先画第一段，其余每段各占一个任务接着画，1 MB 的报告也不会把页面卡住一两秒。
 * - HTML（117 号票）：正文是一个 <iframe sandbox>（协议包的 HTML_PREVIEW_SANDBOX：页面的功能都给，只不给 allow-same-origin、
 *   allow-top-navigation），指向守护进程的 HTML 接口（响应头里同一份沙箱和 CSP），铺满报告页、在框里滚动；页面能从外网取数据
 *   （用户 2026-10-13 定一阶段不加限制），但它是陌生来源，拿不到二狗的 cookie、本地存储，连二狗的接口被网关拒（Origin: null），
 *   也不能把整页导航走；里面的链接在新窗口打开（鸿蒙 App 里交给系统浏览器）；
 * - SVG（117 号票）：用 <img> 显示（<img> 里的 SVG 不跑脚本），放在浅色底上（深色主题里透明底的线条也看得清）。
 * 显示什么由状态层的 reportPageView 推（state/attachments.ts）；标题栏的 ‹ 回到点进来的那个会话，直接打开的回秘书页。
 */
import { memo, useEffect, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { backToHash, cameFrom } from "../app/history-nav.ts";
import { toHash } from "../app/route-hash.ts";
import { useLocale } from "../app/locale.ts";
import { useStore } from "../app/store.tsx";
import { type FramePreview, HTML_PREVIEW_SANDBOX, markdownChunks, type MediaTextResult, reportPageView, t } from "../state/index.ts";
import { TopBar } from "../ui/common.tsx";
import { T } from "../ui/i18n.tsx";

/** 报告里的链接、图片、表格怎么画（其余照 react-markdown 默认） */
const REPORT_MD: Components = {
  a: ({ href, children }) =>
    !href || href.startsWith("#") ? (
      <span className="report-anchor">{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  img: ({ src, alt }) => (
    <span className="report-img">
      <span aria-hidden="true">▧</span> {alt ? t("pages.report.imageNamed", { alt }) : t("pages.report.image")}
      {typeof src === "string" && src ? (
        <T
          k="pages.report.imageNotLoadedLink"
          params={{
            link: (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {t("pages.report.openInNewWindow")}
              </a>
            ),
          }}
        />
      ) : (
        t("pages.report.imageNotLoaded")
      )}
    </span>
  ),
  table: ({ children }) => (
    <div className="report-table">
      <table>{children}</table>
    </div>
  ),
};

/** 一段 Markdown：内容不变就不再解析、不再画（接上下一段时前面的不跟着重画） */
const MarkdownChunk = memo(function MarkdownChunk({ text, components }: { text: string; components: Components }) {
  // 图片的占位按当前语言写：换了语言也重画（memo 挡住了外面的重画）
  useLocale();
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </Markdown>
  );
});

/**
 * Markdown 正文：分段的一段段接着画（每段单独解析，画完一段让出主线程再画下一段）。124 号票起关于页的更新日志也用它。
 * components：换掉报告页的哪几样画法（160 号票内置浏览器渲染文件时，链接按文件的地址解析、在内置浏览器里跟过去）；要稳定（useMemo）
 */
export function MarkdownBody({ text, components }: { text: string; components?: Components }) {
  const merged = useMemo(() => (components ? { ...REPORT_MD, ...components } : REPORT_MD), [components]);
  const chunks = useMemo(() => markdownChunks(text), [text]);
  const [shown, setShown] = useState({ text, count: 1 });
  const count = shown.text === text ? shown.count : 1;
  useEffect(() => {
    if (count >= chunks.length) return;
    const timer = setTimeout(() => setShown({ text, count: count + 1 }), 0);
    return () => clearTimeout(timer);
  }, [text, count, chunks.length]);
  return (
    <div className="report-body">
      {chunks.slice(0, count).map((chunk, i) => (
        <MarkdownChunk key={i} text={chunk} components={merged} />
      ))}
    </div>
  );
}

/** HTML、SVG 的正文（117 号票）：HTML 在沙箱框里，SVG 在 <img> 里；没有地址（原型里没有内容的假附件）时说一声 */
function FramedBody({ src, frame, name }: { src: string | undefined; frame: FramePreview; name: string }) {
  if (!src) return <div className="page-placeholder">{t("pages.report.noPrototypeContent")}</div>;
  if (frame === "svg") {
    return (
      <div className="report-svg">
        <img src={src} alt={name} />
      </div>
    );
  }
  // 不给 allow-same-origin：框里的页面是陌生来源；referrerPolicy 不带出二狗的地址
  return <iframe className="report-frame" src={src} sandbox={HTML_PREVIEW_SANDBOX} referrerPolicy="no-referrer" title={name} />;
}

/** 回到点进来的那一页（经附件卡片 pushHash 记下的来处）；直接打开的（刷新、收藏、别的设备）回秘书页 */
function back(): void {
  backToHash(window, cameFrom(window) ?? toHash({ tab: "secretary" }));
}

export function ReportPage({ mediaId }: { mediaId: string }) {
  const { http } = useStore();
  // 取到的结果记着是哪个媒体的；换了媒体就还没取到（加载中）
  const [got, setGot] = useState<{ mediaId: string; result: MediaTextResult }>();
  useEffect(() => {
    const abort = new AbortController();
    void http.mediaText(mediaId, abort.signal).then((result) => {
      if (!abort.signal.aborted) setGot({ mediaId, result });
    });
    return () => abort.abort();
  }, [http, mediaId]);
  const page = reportPageView(got?.mediaId === mediaId ? got.result : undefined);
  const shown = page.kind === "ready" || page.kind === "frame";
  const download = shown ? http.mediaUrl(mediaId, page.name, { download: true }) : undefined;
  return (
    <div className={`chat-col report-page${page.kind === "frame" ? ` report-page-${page.frame}` : ""}`}>
      <TopBar title={shown ? page.name : t("pages.report.title")} onBack={back}>
        {shown &&
          (download ? (
            <a className="btn ghost small report-dl" href={download} download={page.name}>
              {t("pages.report.download")}
            </a>
          ) : (
            <button type="button" className="btn ghost small" disabled title={t("pages.report.noPrototypeFile")}>
              {t("pages.report.download")}
            </button>
          ))}
      </TopBar>
      <div className="scroll">
        {page.kind === "loading" && <div className="page-placeholder">{t("pages.report.loading")}</div>}
        {page.kind === "error" && (
          <div className="report report-error" role="alert">
            <div className="report-error-title">{page.title}</div>
            <div>{page.detail}</div>
            <div className="muted dt-note">{page.note}</div>
          </div>
        )}
        {page.kind === "ready" && (
          <article className="report">
            <div className="report-facts muted">{page.facts}</div>
            {page.notice && (
              <div className="report-notice" role="note">
                {page.notice}
              </div>
            )}
            {page.render === "markdown" ? (
              <MarkdownBody text={page.text} />
            ) : (
              <pre className="report-body report-plain">{page.text}</pre>
            )}
          </article>
        )}
        {page.kind === "frame" && (
          <article className="report report-framed">
            <div className="report-facts muted">{page.facts}</div>
            {page.notice && (
              <div className="report-notice report-sandbox-note" role="note">
                {page.notice}
              </div>
            )}
            <FramedBody src={http.mediaFrameUrl(mediaId, page.frame)} frame={page.frame} name={page.name} />
          </article>
        )}
      </div>
    </div>
  );
}
