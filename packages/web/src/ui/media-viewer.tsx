// 看大图、放视频共用的外壳：聊天里的图片、视频点开，在页面上盖一层（ui/image-viewer.tsx 填图片，ui/video-viewer.tsx 填播放器）。
// 深色底；右上角 ×；下面一行写文件名和"下载"（App 里走原生下载，浏览器里存成文件）；挂到 body 上（createPortal），
// 不受消息列表的滚动和裁切影响。关掉的办法：×、点空白（深色底）、返回手势（挂一层返回栈 overlay，和弹窗一样）、电脑上按 Esc。
// 视频全屏着时 Esc 归浏览器（退出全屏），不关播放器。
// 查看器挂在 body 上，React 的事件还会顺着组件树冒到聊天那边（用户气泡点整条会打开详情）：点击、按下都在这里截住。
import { type MouseEvent as ReactMouseEvent, type PointerEventHandler, type ReactNode, type Ref, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../app/page-back.ts";
import { t } from "../state/index.ts";

/** × 和下面一行：自己管自己的点击，不算点空白、不参与图片的缩放手势 */
export const isViewerControl = (target: EventTarget | null) => target instanceof Element && target.closest(".media-viewer-close, .media-viewer-bar") !== null;

export interface MediaViewerProps {
  /** 文件名：下面一行写它，读屏也读它 */
  name: string;
  /** "下载"的地址；没有时（原型的假附件）不给"下载" */
  download: string | undefined;
  /** 根上再挂的类名：image-viewer、video-viewer 和它们的状态 */
  className: string;
  onClose(): void;
  /** 点在查看器上（不是 × 和下面一行）时关不关；不给就是点在深色底上（根本身）才关 */
  closeOnClick?: (e: ReactMouseEvent<HTMLDivElement>) => boolean;
  rootRef?: Ref<HTMLDivElement>;
  /** 根上的指针事件（图片查看器自己做缩放、拖动） */
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  children: ReactNode;
}

export function MediaViewer({ name, download, className, onClose, closeOnClick, rootRef, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, children }: MediaViewerProps) {
  useBackLayer("overlay", true, onClose);
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 视频全屏着：Esc 是浏览器退出全屏的，不关播放器
      if (document.fullscreenElement) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    // × 自己关；下面一行（文件名、下载）点了不关
    if (isViewerControl(e.target)) return;
    if (closeOnClick ? closeOnClick(e) : e.target === e.currentTarget) latest.current();
  };

  return createPortal(
    <div
      ref={rootRef}
      className={`media-viewer ${className}`}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown?.(e);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
    >
      {children}
      <button type="button" className="media-viewer-close" onClick={onClose} aria-label={t("common.close")} title={t("ui.mediaViewer.closeHint")}>
        ×
      </button>
      <div className="media-viewer-bar">
        <span className="media-viewer-name">{name}</span>
        {download && (
          <a href={download} download={name}>
            {t("ui.mediaViewer.download")}
          </a>
        )}
      </div>
    </div>,
    document.body,
  );
}
