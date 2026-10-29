/**
 * 内置浏览器里的文件渲染层（160 号票）：markdown 这类能渲染的文件不显示原始文本、不下载，用二狗的渲染看——照 113 号票报告页的画法，
 * 用报告页同一套组件和样式（Markdown 是 ReportPage 的 MarkdownBody，表格、纯文本是 .report-* 的样子），不另起一套。
 * 网页的内置浏览器（ui/in-app-browser.tsx，132 号票）、鸿蒙 App 的"浏览"页签（pages/BrowsePage.tsx，134 号票）都用它。
 * - 上面一行：文件名、类型、大小；右边"看原文"（渲染出来和原文不一样时：Markdown、格式化过的 JSON、表格）、"下载"、"在新窗口打开"
 *   （App 里是"用系统浏览器打开"）、拦下的下载多一个"关闭"；
 * - 正文：Markdown 照报告页画（不加载图片），里面的链接按文件的地址解析、交给内置浏览器跟过去（页内锚点只显示文字）；纯文本自动换行；
 *   代码、格式化过的 JSON 等宽、不换行、横向滚动；CSV、TSV 画成表格（太长的只画前 500 行）。"看原文"是原文等宽显示；
 * - 截断了、表格太长、JSON 认不出顶上一条提示；取不到说清楚怎么了，"下载"、"在新窗口打开"照样在。
 * 怎么画由状态层推（state/file-view.ts 的 fileViewOf）；取内容由调用方给（load），取到的不是能渲染的文本（网页）调 onPage。
 * 换了文件、刷新由调用方换 key 重新挂。
 */
import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Components } from "react-markdown";
import { MarkdownBody } from "../pages/ReportPage.tsx";
import { type FileBody, fileRenderOf, type FileRenderKind, type FileTextResult, fileViewOf, t } from "../state/index.ts";
import { T } from "./i18n.tsx";

/** 下载：同源的地址（<a download>），或交给别人做（App 里经原生浏览器） */
export type FileDownload = { readonly href: string } | { run(): void };

export interface FileViewProps {
  /** 文件的地址（完整的）：里面的相对链接按它解析 */
  readonly url: string;
  readonly name: string;
  /** 怎么画已经定了（App 报来的文件）就给；不给按取到的类型定 */
  readonly kind?: FileRenderKind | undefined;
  /** 取内容（挂上时取一次） */
  load(signal: AbortSignal): Promise<FileTextResult>;
  /** 取到的不是能渲染的文本（.md 地址回的网页）：调用方照旧当网页开 */
  onPage?(): void;
  /** 正文里点了链接（已经解析成完整地址，只给 http(s) 的） */
  onLink(href: string): void;
  readonly download: FileDownload | undefined;
  /** 在别处打开：网页里"在新窗口打开"，App 里"用系统浏览器打开" */
  readonly outside?: { readonly label: string; run(): void } | undefined;
  /** 关闭渲染层（App 里拦下的下载才有） */
  readonly onClose?: (() => void) | undefined;
  readonly style?: CSSProperties | undefined;
}

/** 普通的左键单击（按着修饰键的、别人处理过的照浏览器的默认） */
function plainClick(e: MouseEvent): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/**
 * 正文里的链接、图片怎么画：链接按文件的地址解析（解析好的地址记在 data-follow 上，点了由渲染层统一交给 onLink）；
 * 图片照报告页不加载，给一个"打开"的链接
 */
function fileMarkdown(base: string): Components {
  // 只跟 http(s) 的（原型直接打开构建产物时文件在 file: 下，同样是 file: 的也跟）
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(base)?.[0].toLowerCase();
  const resolve = (href: string): string | undefined => {
    try {
      const to = new URL(href, base);
      return to.protocol === "http:" || to.protocol === "https:" || to.protocol === scheme ? to.href : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    a: ({ href, children }) => {
      if (!href || href.startsWith("#")) return <span className="report-anchor">{children}</span>;
      const to = resolve(href);
      if (!to) return <span className="report-anchor">{children}</span>;
      return (
        <a href={to} data-follow={to} rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      const to = typeof src === "string" && src ? resolve(src) : undefined;
      const altText = alt ? t("ui.fileView.imageAlt", { alt }) : "";
      return (
        <span className="report-img">
          <span aria-hidden="true">▧</span>{" "}
          {to ? (
            <T
              k="ui.fileView.imageWithLink"
              params={{
                alt: altText,
                open: (
                  <a href={to} data-follow={to} rel="noopener noreferrer">
                    {t("ui.fileView.open")}
                  </a>
                ),
              }}
            />
          ) : (
            t("ui.fileView.image", { alt: altText })
          )}
        </span>
      );
    },
  };
}

/** 正文 */
function Body({ body, components }: { body: FileBody; components: Components }) {
  switch (body.kind) {
    case "markdown":
      return <MarkdownBody text={body.text} components={components} />;
    case "plain":
      return <pre className="report-body report-plain">{body.text}</pre>;
    case "code":
      return <pre className="report-body file-code">{body.text}</pre>;
    case "table":
      return (
        <div className="report-body">
          <div className="report-table file-table">
            <table>
              <thead>
                <tr>
                  {body.head.map((cell, i) => (
                    <th key={i}>{cell}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, i) => (
                      <td key={i}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
  }
}

export function FileView({ url, name, kind, load, onPage, onLink, download, outside, onClose, style }: FileViewProps) {
  const [result, setResult] = useState<FileTextResult>();
  const [raw, setRaw] = useState(false);
  // 回调总用最新的；取内容只在挂上（换了文件、刷新由调用方换 key 重新挂）
  const latest = useRef({ load, onPage });
  useEffect(() => {
    latest.current = { load, onPage };
  });
  useEffect(() => {
    const abort = new AbortController();
    latest.current.load(abort.signal).then(
      (got) => {
        if (abort.signal.aborted) return;
        setResult(got);
        if (got.status === "page") latest.current.onPage?.();
      },
      (e: unknown) => {
        if (!abort.signal.aborted) setResult({ status: "error", title: t("ui.fileView.fetchFailed"), detail: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => abort.abort();
  }, []);
  const components = useMemo(() => fileMarkdown(url), [url]);
  /** 正文里点了链接（data-follow 记着解析好的地址）：普通的左键单击交给 onLink。鸿蒙 App 里外部链接先被页面上的拦截接走（改到"浏览"里打开），那时不再跟一次 */
  const onBodyClick = (e: MouseEvent<HTMLElement>) => {
    if (!plainClick(e)) return;
    const link = e.target instanceof Element ? e.target.closest("a[data-follow]") : null;
    const to = link instanceof HTMLAnchorElement ? link.dataset.follow : undefined;
    if (!to) return;
    e.preventDefault();
    onLink(to);
  };
  const view = result?.status === "text" ? fileViewOf(kind ?? fileRenderOf({ url, mime: result.mime, name }) ?? "plain", name, result) : undefined;

  return (
    <div className="scroll file-view" style={style} onClick={onBodyClick}>
      <article className="report file-doc">
        <div className="file-bar">
          <span className="report-facts muted file-facts">{view?.facts ?? name}</span>
          <span className="file-acts">
            {view?.canRaw && (
              <button type="button" className="btn ghost small" aria-pressed={raw} onClick={() => setRaw(!raw)}>
                {raw ? t("ui.fileView.viewRendered") : t("ui.fileView.viewSource")}
              </button>
            )}
            {download &&
              ("href" in download ? (
                <a className="btn ghost small report-dl" href={download.href} download={name}>
                  {t("ui.fileView.download")}
                </a>
              ) : (
                <button type="button" className="btn ghost small" onClick={() => download.run()}>
                  {t("ui.fileView.download")}
                </button>
              ))}
            {outside && (
              <button type="button" className="btn ghost small" onClick={() => outside.run()}>
                {outside.label}
              </button>
            )}
            {onClose && (
              <button type="button" className="btn ghost small" onClick={onClose}>
                {t("common.close")}
              </button>
            )}
          </span>
        </div>
        {!result && <div className="page-placeholder">{t("ui.fileView.loading")}</div>}
        {result?.status === "page" && <div className="page-placeholder">{t("ui.fileView.isPage")}</div>}
        {result?.status === "error" && (
          <div className="report-error" role="alert">
            <div className="report-error-title">{result.title}</div>
            <div>{result.detail}</div>
          </div>
        )}
        {view?.notice && (
          <div className="report-notice" role="note">
            {view.notice}
          </div>
        )}
        {view && (raw ? <pre className="report-body report-plain file-raw">{view.raw}</pre> : <Body body={view.body} components={components} />)}
      </article>
    </div>
  );
}
