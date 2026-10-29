// 待我处理：汇集所有要我注意或确认的事。按紧急度三档排序，到点的简单提醒置顶；可标已读、归档、删除。
// 卡片在这里处理和在聊天里处理是同一张，状态同步。06 号票起接真数据（前端状态层的 inbox，排序和计数见 state/inbox.ts）；
// 卡着任务的事项处理之前归档或删除会被守护进程拒绝，原因由页面底部的提示说明（App.tsx 的 FailureToasts）。
// 90 号票：多选。标题栏"多选"、行的长按 / 右键菜单（和行尾"⋯"同一个菜单）里"多选"进入；点一行就是勾选，底部操作栏
// "已选 N 条 · 全选（当前页签） · 标已读 · 标未读 · 归档 · 删除 · 一起处理 · 完成"。守护进程的 inbox_action 是全部生效或全部不生效，
// 做不了的先剔掉（state/inbox-select.ts：卡着任务、还没处理的不能归档或删除；卡片要一张张处理），跳过了几条、为什么在页面底部说一声。
// 105 号票：详情里"去任务 ›""去项目 ›"……跳到这一项从哪来的地方（state/inbox-jump.ts），能定位的定位到那张卡、那次调用。
// 107 号票：通知的种类名和动作按钮抽到 ui/inbox-notice.tsx，会话里的"等你处理"栏用同一份；点"去任务 ›"这类跳过去时记下是哪一项，
// 那个会话的栏里这一项默认展开、闪一下（ui/conversation/inbox-bar-focus.ts）。
// 157 号票：多选时标题栏的"多选"换成"退出多选"，操作栏右边原来的"完成"换成"✕ 退出多选"，Esc 和返回键一样先退出多选（ui/select-mode.tsx）。
import { type ReactNode, useEffect, useRef, useState } from "react";
import { inboxJumpRoute, type Navigate, toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { URGENCY_LABEL } from "../model/labels.ts";
import { useRouteAvailable } from "../plugins/api.ts";
import type { ArchiveListData } from "../model/types.ts";
import { timeLabel } from "../util/time.ts";
import {
  allSelected,
  automatedAccessHint,
  automatedPairingReason,
  type InboxAction,
  inboxActionText,
  inboxBatchCounts,
  inboxBatchHandle,
  inboxBatchTargets,
  type InboxEntry,
  type InboxFilter,
  inboxCounts,
  inboxEntries,
  inboxItemProcessed,
  inboxJump,
  inboxJumpLabel,
  inboxPageSub,
  toggleSelected,
  type NoticeInboxItem,
  selectInboxItem,
  t,
  tTable,
  type Urgency,
} from "../state/index.ts";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ListDetail, Segmented, Sheet, TopBar } from "../ui/common.tsx";
import { T } from "../ui/i18n.tsx";
import { useLongPress } from "../ui/long-press.ts";
import { PopupMenu } from "../ui/popup.tsx";
import { useToast } from "../ui/toast.tsx";
import { NotificationPermission } from "../ui/alerts.tsx";
import { AssistantName, NamedText } from "../ui/assistant-name.tsx";
import { markInboxBarFocus } from "../ui/conversation/inbox-bar-focus.ts";
import { inboxKindLabel, NoticeActions, noticeLabel } from "../ui/inbox-notice.tsx";
import { SelectExit, SelectToggle, useSelectingBack } from "../ui/select-mode.tsx";

export function InboxPage({ wide, itemId, navigate }: { wide: boolean; itemId?: string; navigate: Navigate }) {
  return (
    <ListDetail
      wide={wide}
      listWidth={380}
      list={<InboxList selected={itemId} onOpen={(id) => navigate({ tab: "inbox", itemId: id })} />}
      detail={itemId ? <InboxDetail key={itemId} itemId={itemId} onBack={wide ? undefined : () => navigate({ tab: "inbox" })} /> : undefined}
    />
  );
}

function kindLabel(entry: InboxEntry): string {
  return inboxKindLabel(entry.item, entry.card?.card.type);
}

function InboxList({ selected, onOpen }: { selected?: string; onOpen(id: string): void }) {
  const { ui, inboxAction } = useStore();
  const [filter, setFilter] = useState<InboxFilter>("open");
  // 多选（90 号票）：勾上了哪几条；换页签时清掉（全选只管当前页签）
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  // 多选时返回键（鸿蒙）、Esc 先退出多选（157 号票）
  useSelectingBack(selecting, stopSelecting);
  const shown = inboxEntries(ui, filter);
  const counts = inboxCounts(ui);
  const unread = Object.values(ui.inbox)
    .filter((it) => !it.read)
    .map((it) => it.id);

  // 待处理按紧急度分组：每组第一项前面放组名
  const heads = new Map<string, string>();
  if (filter === "open") {
    let last = "";
    for (const { item } of shown) {
      const group = item.pinned ? t("pages.inbox.pinned") : URGENCY_LABEL[item.urgency];
      if (group !== last) heads.set(item.id, group);
      last = group;
    }
  }
  return (
    <div className="chat-col">
      {/* 副标题（249 号票）：设了"我的名字"是"<名字>的待办"，没设没有副标题（照旧） */}
      <TopBar title={t("pages.inbox.title")} sub={inboxPageSub(ui)} joined>
        <button type="button" className="link" disabled={unread.length === 0} onClick={() => inboxAction(unread, "read")}>
          {t("pages.inbox.markAllRead")}
        </button>
        <SelectToggle selecting={selecting} onStart={() => setSelecting(true)} onStop={stopSelecting} />
      </TopBar>
      <Segmented<InboxFilter>
        head
        value={filter}
        onChange={(f) => {
          setFilter(f);
          setPicked(new Set());
        }}
        options={[
          { value: "open", label: t("pages.inbox.tab.open", { count: counts.open }) },
          { value: "done", label: t("pages.inbox.tab.done", { count: counts.done }) },
          { value: "archived", label: t("pages.inbox.tab.archived", { count: counts.archived }) },
        ]}
      />
      <div className={`scroll inbox-list${selecting ? " selecting" : ""}`}>
        <NotificationPermission />
        {shown.length === 0 && <div className="page-placeholder">{t("pages.inbox.empty")}</div>}
        {shown.map((entry) => {
          const head = heads.get(entry.item.id);
          return (
            <div key={entry.item.id}>
              {head && <div className={`inbox-group ig-${entry.item.pinned ? "pinned" : entry.item.urgency}`}>{head}</div>}
              <InboxRow
                entry={entry}
                on={selected === entry.item.id}
                selecting={selecting}
                checked={picked.has(entry.item.id)}
                onOpen={() => onOpen(entry.item.id)}
                onToggle={() => setPicked((s) => toggleSelected(s, entry.item.id))}
                onSelect={() => {
                  setSelecting(true);
                  setPicked(new Set([entry.item.id]));
                }}
              />
            </div>
          );
        })}
        <div className="hint inbox-hint">
          <T k="pages.inbox.hint" params={{ name: <AssistantName /> }} />
        </div>
      </div>
      {selecting && (
        <InboxSelectBar
          entries={shown.filter((e) => picked.has(e.item.id))}
          archived={filter === "archived"}
          all={allSelected(picked, shown.map((e) => e.item))}
          onAll={() => setPicked(allSelected(picked, shown.map((e) => e.item)) ? new Set() : new Set(shown.map((e) => e.item.id)))}
          onDone={stopSelecting}
        />
      )}
    </div>
  );
}

/**
 * 待办的一行：点开看详情（多选时是勾选）；行尾"⋯"和长按 / 右键是同一个菜单（标已读 / 未读、归档 / 取消归档、删除、多选），
 * 贴着按的地方弹出（ui/popup.tsx，画在应用框最上面一层）
 */
function InboxRow({
  entry,
  on,
  selecting,
  checked,
  onOpen,
  onToggle,
  onSelect,
}: {
  entry: InboxEntry;
  on: boolean;
  selecting: boolean;
  checked: boolean;
  onOpen(): void;
  onToggle(): void;
  onSelect(): void;
}) {
  const { inboxAction } = useStore();
  const { item } = entry;
  const botReason = automatedPairingReason(entry.card?.card);
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<"row" | "more">();
  const press = useLongPress(() => setMenu("row"), { disabled: selecting });
  const act = (action: InboxAction) => {
    setMenu(undefined);
    inboxAction([item.id], action);
  };
  return (
    <div ref={rowRef} className={`inbox-row${on || checked ? " on" : ""}${item.read ? "" : " unread"}${checked ? " picked" : ""}`} {...press}>
      <button type="button" className="inbox-main" aria-pressed={selecting ? checked : undefined} onClick={selecting ? onToggle : onOpen}>
        {selecting && (
          <span className={`bsel${checked ? " on" : ""}`} aria-hidden="true">
            {checked ? "✓" : ""}
          </span>
        )}
        <span className="inbox-dot" aria-label={item.read ? undefined : t("pages.inbox.unread")} />
        <span className="inbox-text">
          <span className="inbox-title">
            <NamedText text={item.title} />
          </span>
          <span className="muted">
            <UrgencyMark u={item.urgency} /> {kindLabel(entry)} · <NamedText text={item.source} /> · {timeLabel(item.createdAt)}
          </span>
          {/* 137 号票：像网络上的自动访问的配对请求，行上标一句（原因在详情的卡上） */}
          {botReason && (
            <span className="pair-bot-tag" title={automatedAccessHint(botReason)}>
              {t("pages.inbox.botTag")}
            </span>
          )}
        </span>
      </button>
      {!selecting && (
        <button ref={moreRef} type="button" className="icon-btn" aria-label={t("pages.inbox.moreActions")} aria-expanded={menu !== undefined} onClick={() => setMenu(menu ? undefined : "more")}>
          ⋯
        </button>
      )}
      {menu && (
        <PopupMenu anchor={menu === "row" ? rowRef : moreRef} align="end" className="row-menu" onClose={() => setMenu(undefined)}>
          <button type="button" role="menuitem" onClick={() => act(item.read ? "unread" : "read")}>
            {item.read ? BULK_LABEL.unread : BULK_LABEL.read}
          </button>
          <button type="button" role="menuitem" onClick={() => act(item.archived ? "unarchive" : "archive")}>
            {item.archived ? BULK_LABEL.unarchive : BULK_LABEL.archive}
          </button>
          <button type="button" role="menuitem" className="danger-text" onClick={() => act("delete")}>
            {BULK_LABEL.delete}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              onSelect();
            }}
          >
            {t("pages.inbox.select")}
          </button>
        </PopupMenu>
      )}
    </div>
  );
}

/** 一起做的几件事在按钮上、提示里怎么说 */
const BULK_LABEL: Readonly<Record<Exclude<InboxAction, "handle">, string>> = tTable({
  read: "pages.inbox.action.read",
  unread: "pages.inbox.action.unread",
  archive: "pages.inbox.action.archive",
  unarchive: "pages.inbox.action.unarchive",
  delete: "pages.inbox.action.delete",
});

/**
 * 待办多选的操作栏：每个按钮写能对几条做（一条都不能时灰掉）；交上去的只有会变的，跳过的在页面底部说几条、为什么。
 * 删除先确认一次（删了不能恢复）；"一起处理"只给"知道了"这类只是确认收到的选项，所选里有要做决定的通知时灰掉、写明要一条条处理
 */
function InboxSelectBar({ entries, archived, all, onAll, onDone }: { entries: readonly InboxEntry[]; archived: boolean; all: boolean; onAll(): void; onDone(): void }) {
  const { inboxAction } = useStore();
  const toast = useToast();
  const counts = inboxBatchCounts(entries);
  const { choices, why: handleWhy } = inboxBatchHandle(entries);
  const handleRef = useRef<HTMLButtonElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const go = (action: InboxAction, choice?: string) => {
    const { ids, skipped, why } = inboxBatchTargets(entries, action, choice);
    if (ids.length > 0) inboxAction(ids, action, choice);
    if (skipped > 0) {
      const tally = { done: ids.length, skipped, why: why ?? "" };
      toast(action === "handle" ? t("pages.inbox.batchSkippedHandle", { choice: choice === undefined ? "" : inboxActionText(choice), ...tally }) : t("pages.inbox.batchSkipped", { action: BULK_LABEL[action], ...tally }));
    }
  };
  const bulk = (action: Exclude<InboxAction, "handle">): ReactNode => (
    <button key={action} type="button" className={`btn small ghost${action === "delete" ? " sel-danger" : ""}`} disabled={counts[action] === 0} onClick={() => (action === "delete" ? setConfirmDelete(true) : go(action))}>
      {BULK_LABEL[action]}
      {counts[action] > 0 && <span className="sel-count">{t("pages.inbox.count", { count: counts[action] })}</span>}
    </button>
  );
  const handleable = choices.length > 0 ? inboxBatchTargets(entries, "handle", choices[0]).ids.length : 0;
  return (
    <div className="sel-bar" role="toolbar" aria-label={t("pages.inbox.selectBar")}>
      <span className="sel-n">{t("pages.inbox.selected", { count: entries.length })}</span>
      <button type="button" className="link sel-all" onClick={onAll}>
        {all ? t("pages.inbox.selectNone") : t("pages.inbox.selectAll")}
      </button>
      <div className="sel-acts">
        {bulk("read")}
        {bulk("unread")}
        {bulk(archived ? "unarchive" : "archive")}
        {bulk("delete")}
        <button
          ref={handleRef}
          type="button"
          className="btn small ghost"
          disabled={choices.length === 0}
          aria-haspopup="menu"
          aria-expanded={choosing}
          aria-describedby={handleWhy ? "sel-handle-why" : undefined}
          onClick={() => setChoosing(!choosing)}
        >
          {t("pages.inbox.handleTogether")}
          {choices.length > 0 && <span className="sel-count">{t("pages.inbox.count", { count: handleable })}</span>}
        </button>
        {handleWhy && (
          <span id="sel-handle-why" className="sel-why muted">
            {handleWhy}
          </span>
        )}
      </div>
      <SelectExit onExit={onDone} />
      {choosing && (
        <PopupMenu anchor={handleRef} align="start" className="row-menu" onClose={() => setChoosing(false)}>
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              role="menuitem"
              onClick={() => {
                setChoosing(false);
                go("handle", c);
              }}
            >
              {t("pages.inbox.chooseAll", { choice: inboxActionText(c) })}
            </button>
          ))}
        </PopupMenu>
      )}
      {confirmDelete && (
        <Sheet title={t("pages.inbox.deleteTitle", { count: counts.delete })} onClose={() => setConfirmDelete(false)} center>
          <div className="modal-body">
            <p>
              {t("pages.inbox.deleteBody")}
              {entries.length > counts.delete ? t("pages.inbox.deleteSkipped", { count: entries.length - counts.delete }) : ""}
            </p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>
              {t("pages.inbox.keep")}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirmDelete(false);
                go("delete");
              }}
            >
              {BULK_LABEL.delete}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function UrgencyMark({ u }: { u: Urgency }) {
  return <span className={`urg urg-${u}`} title={URGENCY_LABEL[u]} aria-label={URGENCY_LABEL[u]} />;
}

function InboxDetail({ itemId, onBack }: { itemId: string; onBack?: () => void }) {
  const { ui, inboxAction } = useStore();
  const routeAvailable = useRouteAvailable();
  const item = selectInboxItem(ui, itemId);
  // 打开就算看过了（只发一次）
  const marked = useRef(false);
  useEffect(() => {
    if (item && !item.read && !marked.current) {
      marked.current = true;
      inboxAction([item.id], "read");
    }
  }, [item, inboxAction]);
  if (!item) return <div className="page-placeholder">{t("pages.inbox.gone")}</div>;
  const processed = inboxItemProcessed(ui, item);
  // 105 号票：跳到这一项从哪来的地方（任务、项目、秘书会话、日历、设置……）；没有去处的不出按钮。
  // 213 号票：去的那一页归停用的插件（日历插件停用时到点、错过的提醒去日历）也不出
  const found = inboxJump(ui, item);
  const jump = found && routeAvailable(inboxJumpRoute(found)) ? found : undefined;
  return (
    <div className="chat-col">
      <TopBar title={<NamedText text={item.title} />} onBack={onBack}>
        <button type="button" className="link" onClick={() => inboxAction([item.id], item.archived ? "unarchive" : "archive")}>
          {item.archived ? BULK_LABEL.unarchive : BULK_LABEL.archive}
        </button>
        <button type="button" className="link danger-text" onClick={() => inboxAction([item.id], "delete")}>
          {BULK_LABEL.delete}
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <div className="muted">
          <UrgencyMark u={item.urgency} /> {URGENCY_LABEL[item.urgency]} · <NamedText text={item.source} /> · {timeLabel(item.createdAt)}
          {item.archived ? t("pages.inbox.detail.archived") : processed ? t("pages.inbox.detail.handled") : ""}
        </div>
        {jump && (
          <div className="inbox-jump">
            {/* 107 号票：跳到的会话里"等你处理"栏把这一项展开、闪一下 */}
            <a className="btn small ghost" href={toHash(inboxJumpRoute(jump))} onClick={() => markInboxBarFocus(item.id)}>
              {inboxJumpLabel(jump)}
            </a>
          </div>
        )}
        {item.kind === "card" ? <CardPanel cardId={item.cardId} /> : <NoticeView item={item} />}
        {item.kind === "notice" && item.cardId && <CardPanel cardId={item.cardId} />}
      </div>
    </div>
  );
}

const ARCHIVE_CHOICES = tTable({ archive: "pages.inbox.archiveList.archive", rework: "pages.inbox.archiveList.rework", keep: "pages.inbox.archiveList.keep" });
type ArchiveChoice = keyof typeof ARCHIVE_CHOICES;

/** 通知的详情：种类、标题、正文（归档清单逐项选），下面是它的动作（NoticeActions，和会话里"等你处理"栏同一份） */
function NoticeView({ item }: { item: NoticeInboxItem }) {
  const archiveList = (item.data as Partial<ArchiveListData> | undefined)?.archiveList;
  // 归档清单每一项的选择先留在页面上，点"完成"时一起交（归档清单的正式处理在产生它的票里）
  const [choices, setChoices] = useState<Record<number, ArchiveChoice>>({});
  return (
    <div className="card xcard">
      <div className="xcard-head">
        <span className="xcard-tag xt-notice">{noticeLabel(item.notice)}</span>
        <span className="xcard-title">
          <NamedText text={item.title} />
        </span>
      </div>
      <div className="xcard-body">
        {item.body && (
          <div className="xcard-text">
            <NamedText text={item.body} />
          </div>
        )}
        {archiveList && (
          <div className="archive-list">
            {archiveList.map((x, i) => (
              <div key={x.task} className="archive-row">
                <div>
                  {x.task}
                  <span className="muted">{t("pages.inbox.archiveList.ended", { time: timeLabel(x.endedAt) })}</span>
                </div>
                <div className="qa-opts">
                  {(Object.keys(ARCHIVE_CHOICES) as ArchiveChoice[]).map((c) => {
                    const on = (choices[i] ?? x.choice) === c;
                    return (
                      <button key={c} type="button" className={`qa-opt${on ? " on" : ""}`} aria-pressed={on} disabled={item.handled !== undefined} onClick={() => setChoices({ ...choices, [i]: c })}>
                        {ARCHIVE_CHOICES[c]}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <NoticeActions item={item} />
    </div>
  );
}
