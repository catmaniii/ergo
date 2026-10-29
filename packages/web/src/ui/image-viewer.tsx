// 图片放大预览（用户 2026-10-17 提）：聊天里的图片点开，在页面上盖一层全屏看大图。原来是新窗口打开图片地址，
// 鸿蒙 App 里会整页跳到图片上，没有关闭的地方，返回手势也回不来。
// 关掉的办法：右上角的 ×、点图片以外的地方、鸿蒙的返回手势（挂一层返回栈 overlay，和弹窗一样）、电脑上按 Esc。
// 下面一行写文件名和"下载"（App 里走原生下载，浏览器里存成文件），不再在新窗口打开原图。
// 挂到 body 上（createPortal），不受消息列表的滚动和裁切影响。
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../app/page-back.ts";
import { t } from "../state/index.ts";

export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose(): void }) {
  useBackLayer("overlay", true, onClose);
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <img src={src} alt={name} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="image-viewer-close" onClick={onClose} aria-label={t("common.close")} title={t("ui.imageViewer.closeHint")}>
        ×
      </button>
      <div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="image-viewer-name">{name}</span>
        <a href={src} download={name}>
          {t("ui.imageViewer.download")}
        </a>
      </div>
    </div>,
    document.body,
  );
}
