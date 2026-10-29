/**
 * 网页候选卡（147 号票，browse_pick）：秘书在浏览侧边栏或悬浮按钮（149 号票）那一轮替上传框找文件、拿不准交哪个时放进会话的候选——
 * 一格一格的缩略图，单张的框点一张选一张（单选），多张的框每张能勾能取消，秘书推荐的预先选上（照 145 号票的候选面板）。
 * "交"（多张的写"交 N 个"）经守护进程交给发消息的那台设备，交进建卡时选中的那个框；"都不要"关掉卡。网页上同时弹着一个挑图片窗口
 * （149 号票），两边只认第一次的选择：在那边交了、都不要了，这张卡跟着变成处理过。没交进去（浏览器关了、换了网页）原因记在卡上
 * （failed，两边都看得到），还能再点。处理完了格子里标着选了哪几个。
 * 缩略图（149 号票）凭取件码取守护进程缩好的小图，不下原图；缩略图做不出来的（不是图片、坏图、过期了）画文件图标和名字。
 */
import { useState } from "react";
import { useStore } from "../../app/store.tsx";
import { fileSizeText } from "./page-commands.ts";
import { type BrowsePickCardPayload, initialPick, type PageCommandFile, t, togglePick } from "../../state/index.ts";
import { Icon } from "../../ui/icons.tsx";
import { type CardProps, CardShell } from "../../ui/cards/CardShell.tsx";

/** 一格：缩略图（守护进程缩好的小图），取不到的画文件图标和名字 */
function PickThumb({ file, src }: { file: PageCommandFile; src: string }) {
  const [broken, setBroken] = useState(false);
  if (file.image && !broken) return <img src={src} alt={file.name} loading="lazy" onError={() => setBroken(true)} />;
  return (
    <span className="xcard-pick-doc">
      <Icon name="file" />
      <span>{file.name}</span>
    </span>
  );
}

export function BrowsePickCard({ state, payload: p, done, act }: CardProps<BrowsePickCardPayload>) {
  const { http } = useStore();
  const [selected, setSelected] = useState<string[]>(() => initialPick(p));
  const shown = done ? (p.picked ?? []) : selected;
  const order = p.files.map((f) => f.token);
  const page = p.page.title || p.page.url;
  return (
    <CardShell
      state={state}
      title={t("ui.browsePickCard.title", { page, field: p.field })}
      actions={
        <>
          <span className={`xcard-pick-note${p.failed ? " failed" : ""}`}>{p.failed ? t("ui.browsePickCard.failed", { reason: p.failed }) : p.multiple ? t("ui.browsePickCard.pickMany") : t("ui.browsePickCard.pickOne")}</span>
          <button type="button" className="btn" onClick={() => act("dismiss")}>
            {t("ui.browsePickCard.none")}
          </button>
          <button type="button" className="btn primary" disabled={selected.length === 0} onClick={() => act("confirm", undefined, { tokens: selected })}>
            {p.multiple ? t("ui.browsePickCard.submitCount", { count: selected.length }) : t("ui.browsePickCard.submit")}
          </button>
        </>
      }
    >
      <ul className="xcard-pick" role={p.multiple ? "group" : "radiogroup"} aria-label={p.multiple ? t("ui.browsePickCard.groupMany") : t("ui.browsePickCard.groupOne")}>
        {p.files.map((file) => {
          const checked = shown.includes(file.token);
          return (
            <li key={file.token}>
              <button
                type="button"
                role={p.multiple ? "checkbox" : "radio"}
                aria-checked={checked}
                title={t("ui.browsePickCard.fileTitle", { name: file.name, size: fileSizeText(file.size) })}
                className={`xcard-pick-item${checked ? " checked" : ""}`}
                disabled={done}
                onClick={() => setSelected((now) => togglePick(now, file.token, p.multiple, order))}
              >
                <PickThumb file={file} src={http.pageFileThumbUrl(file.token)} />
                <span className="xcard-pick-mark" aria-hidden="true">
                  {checked ? "✓" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
}
