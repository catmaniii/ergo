// 待我处理：汇集所有要我注意或确认的事。按紧急度三档排序，到点的简单提醒置顶；可标已读、归档、删除。
// 卡片在这里处理和在聊天里处理是同一张，状态同步。06 号票起接真数据（前端状态层的 inbox，排序和计数见 state/inbox.ts）；
// 卡着任务的事项处理之前归档或删除会被守护进程拒绝，原因由页面底部的提示说明（App.tsx 的 FailureToasts）。
// 90 号票：多选。标题栏"多选"、行的长按 / 右键菜单（和行尾"⋯"同一个菜单）里"多选"进入；点一行就是勾选，底部操作栏
// "已选 N 条 · 全选（当前页签） · 标已读 · 标未读 · 归档 · 删除 · 一起处理 · 完成"。守护进程的 inbox_action 是全部生效或全部不生效，
// 做不了的先剔掉（state/inbox-select.ts：卡着任务、还没处理的不能归档或删除；卡片要一张张处理），跳过了几条、为什么在页面底部说一声。
// 105 号票：详情里"去任务 ›""去项目 ›"……跳到这一项从哪来的地方（state/inbox-jump.ts），能定位的定位到那张卡、那次调用。
// 107 号票：通知的种类名和动作按钮抽到 ui/inbox-notice.tsx，会话里的"等你处理"栏用同一份；点"去任务 ›"这类跳过去时记下是哪一项，
// 那个会话的栏里这一项默认展开、闪一下（ui/conversation/inbox-bar-focus.ts）。
import { type ReactNode, useEffect, useRef, useState } from "react";
import { inboxJumpRoute, type Navigate, toHash } from "../app/route.ts";
import { useBackLayer } from "../app/page-back.ts";
import { useStore } from "../app/store.tsx";
import { URGENCY_LABEL } from "../model/labels.ts";
import type { ArchiveListData } from "../model/types.ts";
import { timeLabel } from "../util/time.ts";
import {
  allSelected,
  type InboxAction,
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
  toggleSelected,
  type NoticeInboxItem,
  selectInboxItem,
  type Urgency,
} from "../state/index.ts";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ListDetail, Segmented, Sheet, TopBar } from "../ui/common.tsx";
import { useLongPress } from "../ui/long-press.ts";
import { PopupMenu } from "../ui/popup.tsx";
import { useToast } from "../ui/toast.tsx";
import { NotificationPermission } from "../ui/alerts.tsx";
import { AssistantName, NamedText } from "../ui/assistant-name.tsx";
import { markInboxBarFocus } from "../ui/conversation/inbox-bar-focus.ts";
import { inboxKindLabel, NoticeActions, noticeLabel } from "../ui/inbox-notice.tsx";

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
  // 多选时返回键（鸿蒙）先退出多选
  useBackLayer("overlay", selecting, stopSelecting);
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
      const group = item.pinned ? "置顶：到点的提醒" : URGENCY_LABEL[item.urgency];
      if (group !== last) heads.set(item.id, group);
      last = group;
    }
  }
  return (
    <div className="chat-col">
      <TopBar title="待办" joined>
        <button type="button" className="link" disabled={unread.length === 0} onClick={() => inboxAction(unread, "read")}>
          全部标已读
        </button>
        <button type="button" className={`btn small ${selecting ? "primary" : "ghost"}`} aria-pressed={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
          多选
        </button>
      </TopBar>
      <Segmented<InboxFilter>
        head
        value={filter}
        onChange={(f) => {
          setFilter(f);
          setPicked(new Set());
        }}
        options={[
          { value: "open", label: `待处理 ${counts.open}` },
          { value: "done", label: `已处理 ${counts.done}` },
          { value: "archived", label: `已归档 ${counts.archived}` },
        ]}
      />
      <div className={`scroll inbox-list${selecting ? " selecting" : ""}`}>
        <NotificationPermission />
        {shown.length === 0 && <div className="page-placeholder">这里没有事项</div>}
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
          进了这里的事，<AssistantName />不主动转述。卡着任务的事项要先处理，才能归档或删除。紧急度第一阶段只在 Web 里体现（小红点和排序），手机推送是第二阶段。
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
        <span className="inbox-dot" aria-label={item.read ? undefined : "未读"} />
        <span className="inbox-text">
          <span className="inbox-title">
            <NamedText text={item.title} />
          </span>
          <span className="muted">
            <UrgencyMark u={item.urgency} /> {kindLabel(entry)} · <NamedText text={item.source} /> · {timeLabel(item.createdAt)}
          </span>
        </span>
      </button>
      {!selecting && (
        <button ref={moreRef} type="button" className="icon-btn" aria-label="更多操作" aria-expanded={menu !== undefined} onClick={() => setMenu(menu ? undefined : "more")}>
          ⋯
        </button>
      )}
      {menu && (
        <PopupMenu anchor={menu === "row" ? rowRef : moreRef} align="end" className="row-menu" onClose={() => setMenu(undefined)}>
          <button type="button" role="menuitem" onClick={() => act(item.read ? "unread" : "read")}>
            {item.read ? "标未读" : "标已读"}
          </button>
          <button type="button" role="menuitem" onClick={() => act(item.archived ? "unarchive" : "archive")}>
            {item.archived ? "取消归档" : "归档"}
          </button>
          <button type="button" role="menuitem" className="danger-text" onClick={() => act("delete")}>
            删除
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              onSelect();
            }}
          >
            多选
          </button>
        </PopupMenu>
      )}
    </div>
  );
}

/** 一起做的几件事在按钮上、提示里怎么说 */
const BULK_LABEL: Readonly<Record<Exclude<InboxAction, "handle">, string>> = { read: "标已读", unread: "标未读", archive: "归档", unarchive: "取消归档", delete: "删除" };

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
    if (skipped > 0) toast(`${action === "handle" ? `一起选「${choice}」` : BULK_LABEL[action]} ${ids.length} 条；跳过 ${skipped} 条：${why ?? ""}`);
  };
  const bulk = (action: Exclude<InboxAction, "handle">): ReactNode => (
    <button key={action} type="button" className={`btn small ghost${action === "delete" ? " sel-danger" : ""}`} disabled={counts[action] === 0} onClick={() => (action === "delete" ? setConfirmDelete(true) : go(action))}>
      {BULK_LABEL[action]}
      {counts[action] > 0 && <span className="sel-count">（{counts[action]}）</span>}
    </button>
  );
  const handleable = choices.length > 0 ? inboxBatchTargets(entries, "handle", choices[0]).ids.length : 0;
  return (
    <div className="sel-bar" role="toolbar" aria-label="多选的操作">
      <span className="sel-n">已选 {entries.length} 条</span>
      <button type="button" className="link sel-all" onClick={onAll}>
        {all ? "取消全选" : "全选"}
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
          一起处理
          {choices.length > 0 && <span className="sel-count">（{handleable}）</span>}
        </button>
        {handleWhy && (
          <span id="sel-handle-why" className="sel-why muted">
            {handleWhy}
          </span>
        )}
      </div>
      <button type="button" className="btn small primary sel-done" onClick={onDone}>
        完成
      </button>
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
              都选「{c}」
            </button>
          ))}
        </PopupMenu>
      )}
      {confirmDelete && (
        <Sheet title={`删除 ${counts.delete} 条？`} onClose={() => setConfirmDelete(false)} center>
          <div className="modal-body">
            <p>删了之后待办里不再有它们，不能恢复（卡片本身还在聊天里）。{entries.length > counts.delete ? `另外 ${entries.length - counts.delete} 条卡着任务、还没处理，跳过。` : ""}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>
              先不删
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirmDelete(false);
                go("delete");
              }}
            >
              删除
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
  const item = selectInboxItem(ui, itemId);
  // 打开就算看过了（只发一次）
  const marked = useRef(false);
  useEffect(() => {
    if (item && !item.read && !marked.current) {
      marked.current = true;
      inboxAction([item.id], "read");
    }
  }, [item, inboxAction]);
  if (!item) return <div className="page-placeholder">这一项已经删掉了</div>;
  const processed = inboxItemProcessed(ui, item);
  // 105 号票：跳到这一项从哪来的地方（任务、项目、秘书会话、日历、设置……）；没有去处的不出按钮
  const jump = inboxJump(ui, item);
  return (
    <div className="chat-col">
      <TopBar title={<NamedText text={item.title} />} onBack={onBack}>
        <button type="button" className="link" onClick={() => inboxAction([item.id], item.archived ? "unarchive" : "archive")}>
          {item.archived ? "取消归档" : "归档"}
        </button>
        <button type="button" className="link danger-text" onClick={() => inboxAction([item.id], "delete")}>
          删除
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <div className="muted">
          <UrgencyMark u={item.urgency} /> {URGENCY_LABEL[item.urgency]} · <NamedText text={item.source} /> · {timeLabel(item.createdAt)}
          {item.archived ? " · 已归档" : processed ? " · 已处理" : ""}
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

const ARCHIVE_CHOICES = { archive: "归档", rework: "继续改（返工）", keep: "先留着" } as const;
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
          <div>
            <NamedText text={item.body} />
          </div>
        )}
        {archiveList && (
          <div className="archive-list">
            {archiveList.map((x, i) => (
              <div key={x.task} className="archive-row">
                <div>
                  {x.task}
                  <span className="muted"> · 结束于 {timeLabel(x.endedAt)}</span>
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
