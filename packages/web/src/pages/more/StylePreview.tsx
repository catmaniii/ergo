// 设置 · 外观 · 风格里的一张预览（39 号票）：一套风格在浅色或深色下，现场画一小段固定的场景。
// 怎么做到"用这套风格自己的 token 和规则"见 src/visual-styles/preview.ts 开头：容器挂 data-style、data-theme，
// 场景放在容器的 shadow root 里，用页面样式表复制出来的那份（挂 shadow root、复制样式表在 app/style-preview.ts）。
// 场景用真界面的类名和组件（消息、卡片、按钮、导航的 NavTab），界面的样子改了预览跟着变。
// 预览只是图：读屏跳过（aria-hidden），点不到、Tab 键也到不了里面（inert；不认 inert 的老浏览器上，里面能拿到焦点的
// 都挂 tabindex="-1"），点它就是点外面的风格选项。
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pageStylePreviews } from "../../app/page-style-preview.ts";
import { pageTheme } from "../../app/page-theme.ts";
import { PREVIEW_HOST_CLASS, PREVIEW_PAGE_CLASS, PREVIEW_SCENE, type Theme } from "../../visual-styles/index.ts";
import { PartView } from "../../ui/conversation/parts.tsx";
import { type NavBadge, type NavEntry, NavTab } from "../../ui/main-nav.tsx";

/** 那排导航图标：秘书那一项选中，待办亮着未读的小红点（只画图标，字藏着；89 号票起秘书那一项也是普通的"秘书"两个字） */
const NAV: readonly NavEntry[] = ["secretary", "tasks", "inbox", "calendar"];
const NAV_BADGE: NavBadge = { unread: 1, seenPending: 0 };
const NO_BADGE: NavBadge = { unread: 0, seenPending: 0 };

function Scene() {
  const t = PREVIEW_SCENE;
  return (
    <div className={PREVIEW_PAGE_CLASS}>
      <div className="conv-scroll">
        <div className="msg user">
          <div className="msg-part part-text">
            <PartView part={{ type: "text", text: t.ask }} />
          </div>
        </div>
        <div className="msg assistant">
          <div className="msg-part part-text">
            <PartView part={{ type: "text", text: t.reply }} />
          </div>
        </div>
        <div className="card xcard">
          <div className="xcard-head">
            <span className="xcard-tag">{t.cardTag}</span>
            <span className="xcard-title">{t.cardTitle}</span>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost">
              {t.decline}
            </button>
            <button type="button" className="btn primary">
              {t.confirm}
            </button>
          </div>
        </div>
      </div>
      <div className="tabbar">
        <div className="nav-list">
          {NAV.map((entry) => (
            <NavTab key={entry} entry={entry} on={entry === "secretary"} badge={entry === "inbox" ? NAV_BADGE : NO_BADGE} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 预览场景里的字用风格自己的字体：挂上只收了这几个字的 @font-face 的那份样式表（整个页面挂一次，离开设置也留着） */
export function usePreviewFonts(): void {
  useLayoutEffect(() => pageTheme().showPreviewFonts(), []);
}

/** accent：这套风格的主色（119 号票，只有经典有），容器挂上 data-accent，换掉的 token 照样从容器继承进场景 */
export function StylePreview({ styleId, theme, accent }: { styleId: string; theme: Theme; accent?: string | undefined }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [root, setRoot] = useState<ShadowRoot>();
  useLayoutEffect(() => {
    if (hostRef.current) setRoot(pageStylePreviews().open(hostRef.current));
  }, []);
  // 场景画进 shadow root 之后（同一次提交里，这时已经在里面了）
  useLayoutEffect(() => {
    if (root) pageStylePreviews().unfocus(root);
  }, [root]);
  return (
    <span ref={hostRef} className={PREVIEW_HOST_CLASS} data-style={styleId} data-theme={theme} data-accent={accent} aria-hidden="true" inert>
      {root && createPortal(<Scene />, root)}
    </span>
  );
}
