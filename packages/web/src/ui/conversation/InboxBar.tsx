/**
 * 会话里的"等你处理"栏（107 号票）：项目整页、任务整页、秘书会话在会话和输入框之间列出还没处理、来源是这个会话的待办事项
 * （哪些算由状态层 inboxBarEntries 按 105 号票的 inboxJump 认）。在正常的文档流里（会话组件的页脚、输入框上面），
 * 不跟着对话滚走，也不盖住会话。
 * - 收着时一行："等你处理 N 项" + 第一项的标题（放不下省略）+ 展开键；只有一项时这一行直接带它的动作按钮（卡片是"看卡片"），
 *   窄屏放不下时按钮换到第二行；
 * - 展开后逐项列出：通知带它在待办里的那组动作按钮（ui/inbox-notice.tsx 的 NoticeActions，和待办详情同一份、同一个请求，
 *   待办里那一项同时变成已处理），卡片给"看卡片"，在会话里定位到那张卡（卡上的按钮照旧在卡上）；中断不确定、交给我做多一个
 *   "看那次调用"。卡、调用在还没加载的更早历史里的照 105 号票不定位，提示一句往上翻；
 * - 展开后最高约占会话区的三分之一，多了在栏里滚；处理完的一项从栏里消失，一项都没有了整条栏不显示；
 * - 从待办详情"去任务 ›"这类跳过来的（inbox-bar-focus.ts 记着是哪一项）：默认展开，那一项滚到眼前、闪一下；
 * - 缩小到要点层、全局层时照样在（不跟着输入框淡出），排在图例上面（styles/pages.css）。
 */
import { useEffect, useId, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type ChatItem, type InboxBarEntry, inboxBarEntries, type InboxPlace, revealTargetId, t } from "../../state/index.ts";
import { timeLabel } from "../../util/time.ts";
import { NamedText } from "../assistant-name.tsx";
import { inboxKindLabel, NoticeActions } from "../inbox-notice.tsx";
import { useToast } from "../toast.tsx";
import { clearInboxBarFocus, peekInboxBarFocus } from "./inbox-bar-focus.ts";

/** 展开的栏（连同上面那一行）最高占会话区的多少 */
const BAR_SHARE = 1 / 3;
/** 列表至少这么高：会话区很矮时也看得到一项 */
const LIST_MIN = 96;

interface InboxBarProps {
  place: InboxPlace;
  /** 会话里现在有的条目：看卡片、看那次调用之前先认它在不在 */
  items: readonly ChatItem[];
  /** 在会话里定位到这一条（会话条目层的 id），滚过去、闪一下 */
  onReveal(chatId: string): void;
}

export function InboxBar({ place, items, onReveal }: InboxBarProps) {
  const { ui } = useStore();
  const toast = useToast();
  const listId = useId();
  const entries = inboxBarEntries(ui, place);
  // 从待办跳过来的那一项：默认展开、滚到眼前、闪一下（挂上时认一次）
  const [focus] = useState(() => peekInboxBarFocus(entries.map((e) => e.item.id)));
  const [open, setOpen] = useState(focus !== undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 列表最高多少：按会话区（会话组件的 .zh，含输入框）的高度算，旋转、拖分栏、档案栏开合都跟着重算
  const [limit, setLimit] = useState<number>();
  const shown = entries.length > 0;
  useEffect(() => {
    const zh = rootRef.current?.closest<HTMLElement>(".zh");
    if (!open || !shown || !zh) return;
    const ro = new ResizeObserver(() => setLimit(Math.max(LIST_MIN, Math.round(zh.clientHeight * BAR_SHARE - (headRef.current?.offsetHeight ?? 0)))));
    ro.observe(zh);
    return () => ro.disconnect();
  }, [open, shown]);
  // 跳过来的那一项滚到眼前：等列表的高度量出来再滚（先滚了、高度再变，滚到的地方会被切掉一截）；
  // 只滚一次，之后弹键盘、开合档案栏让高度再变时不再滚回去
  const focusScrolled = useRef(false);
  useEffect(() => {
    if (focus === undefined || limit === undefined || focusScrolled.current) return;
    focusScrolled.current = true;
    clearInboxBarFocus(focus);
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-item="${CSS.escape(focus)}"]`);
    if (list && row) list.scrollTop = row.offsetTop - 8;
  }, [focus, limit]);
  if (entries.length === 0) return null;

  const reveal = (at: string) => {
    const target = revealTargetId(items, at);
    if (target === undefined) toast(t("ui.inboxBar.inEarlier"));
    else onReveal(target);
  };
  const first = entries[0]!;
  const single = entries.length === 1 ? first : undefined;
  return (
    <div ref={rootRef} className={`ibar${open ? " open" : ""}`} role="region" aria-label={t("ui.inboxBar.label")}>
      <div className="ibar-head" ref={headRef}>
        <button type="button" className="ibar-sum" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
          <span className="ibar-n">{t("ui.inboxBar.count", { count: entries.length })}</span>
          <span className="ibar-first">{open ? "" : <NamedText text={first.item.title} />}</span>
          <span className="ibar-caret" aria-hidden="true">
            {open ? t("ui.inboxBar.collapse") : t("ui.inboxBar.expand")}
          </span>
        </button>
        {!open && single && <EntryActions entry={single} onReveal={reveal} />}
      </div>
      {open && (
        <div className="ibar-list" id={listId} ref={listRef} style={limit === undefined ? undefined : { maxHeight: limit }}>
          {entries.map((entry) => (
            <InboxBarRow key={entry.item.id} entry={entry} flash={entry.item.id === focus} cardType={entry.item.kind === "card" ? ui.cards[entry.item.cardId]?.card.type : undefined} onReveal={reveal} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 展开后的一项：种类、标题、时间、通知的正文，下面是动作 */
function InboxBarRow({ entry, flash, cardType, onReveal }: { entry: InboxBarEntry; flash: boolean; cardType: string | undefined; onReveal(at: string): void }) {
  const { item } = entry;
  return (
    <div className={`ibar-item${flash ? " ibar-flash" : ""}`} data-item={item.id}>
      <div className="ibar-item-head">
        <span className="ibar-tag">{inboxKindLabel(item, cardType)}</span>
        <span className="ibar-title">
          <NamedText text={item.title} />
        </span>
        <span className="ibar-time muted">{timeLabel(item.createdAt)}</span>
      </div>
      {item.kind === "notice" && item.body && (
        <div className="ibar-body">
          <NamedText text={item.body} />
        </div>
      )}
      <EntryActions entry={entry} onReveal={onReveal} />
    </div>
  );
}

/** 一项的动作：通知是它在待办里的那组按钮（同一份），卡片是"看卡片"；定位得到那次调用的通知多一个"看那次调用" */
function EntryActions({ entry, onReveal }: { entry: InboxBarEntry; onReveal(at: string): void }) {
  const { item, at } = entry;
  return (
    <div className="ibar-acts">
      {item.kind === "notice" && <NoticeActions item={item} small className="ibar-choices" />}
      {at !== undefined && (
        <button type="button" className={`btn small ${item.kind === "card" ? "primary" : "ghost"}`} onClick={() => onReveal(at)}>
          {item.kind === "card" ? t("ui.inboxBar.viewCard") : t("ui.inboxBar.viewCall")}
        </button>
      )}
    </div>
  );
}
