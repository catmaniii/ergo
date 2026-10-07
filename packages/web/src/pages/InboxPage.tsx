// 待我处理：汇集所有要我注意或确认的事。按紧急度三档排序，到点的简单提醒置顶；可标已读、归档、删除。
// 卡片在这里处理和在聊天里处理是同一张，状态同步。06 号票起接真数据（前端状态层的 inbox，排序和计数见 state/inbox.ts）；
// 卡着任务的事项处理之前归档或删除会被守护进程拒绝，原因由页面底部的提示说明（App.tsx 的 FailureToasts）。
import { useEffect, useRef, useState } from "react";
import type { Navigate } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { CARD_TYPE_LABEL } from "../model/cards.ts";
import { URGENCY_LABEL } from "../model/labels.ts";
import type { ArchiveListData } from "../model/types.ts";
import { timeLabel } from "../util/time.ts";
import { type InboxEntry, type InboxFilter, inboxCounts, inboxEntries, type InboxItem, isCardType, isInboxItemProcessed, type NoticeType, selectInboxItem, type Urgency } from "../state/index.ts";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ListDetail, Segmented, TopBar } from "../ui/common.tsx";
import { NotificationPermission } from "../ui/alerts.tsx";

const NOTICE_LABEL: Record<NoticeType, string> = {
  reminder_due: "提醒",
  missed_reminder: "错过的提醒",
  interrupted: "中断不确定",
  out_of_scope: "越界通知",
  backup_failed: "备份失败",
  snapshot_check_failed: "快照校验失败",
  scheduled_job_auto_paused: "定时作业被自动暂停",
  archive_list: "归档清单",
  grant_renewal: "授权到期续期",
  stuck_help: "卡住求助",
  failure_choice: "失败后的抉择",
};

function noticeLabel(notice: string | undefined): string {
  return notice !== undefined && notice in NOTICE_LABEL ? NOTICE_LABEL[notice as NoticeType] : "通知";
}

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
  const { item, card } = entry;
  if (item.kind === "notice") return noticeLabel(item.notice);
  const type = card?.card.type;
  return type && isCardType(type) ? CARD_TYPE_LABEL[type] : "卡片";
}

function InboxList({ selected, onOpen }: { selected?: string; onOpen(id: string): void }) {
  const { ui, inboxAction } = useStore();
  const [filter, setFilter] = useState<InboxFilter>("open");
  const [menu, setMenu] = useState<string>();
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
  const act = (item: InboxItem, action: Parameters<typeof inboxAction>[1]) => {
    inboxAction([item.id], action);
    setMenu(undefined);
  };
  return (
    <div className="chat-col">
      <TopBar title="待我处理">
        <button type="button" className="link" disabled={unread.length === 0} onClick={() => inboxAction(unread, "read")}>
          全部标已读
        </button>
      </TopBar>
      <Segmented<InboxFilter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: "open", label: `待处理 ${counts.open}` },
          { value: "done", label: `已处理 ${counts.done}` },
          { value: "archived", label: `已归档 ${counts.archived}` },
        ]}
      />
      <div className="scroll inbox-list" onClick={() => setMenu(undefined)}>
        <NotificationPermission />
        {shown.length === 0 && <div className="page-placeholder">这里没有事项</div>}
        {shown.map((entry) => {
          const { item } = entry;
          const head = heads.get(item.id);
          return (
            <div key={item.id}>
              {head && <div className={`inbox-group ig-${item.pinned ? "pinned" : item.urgency}`}>{head}</div>}
              <div className={`inbox-row${selected === item.id ? " on" : ""}${item.read ? "" : " unread"}`}>
                <button type="button" className="inbox-main" onClick={() => onOpen(item.id)}>
                  <span className="inbox-dot" aria-label={item.read ? undefined : "未读"} />
                  <span className="inbox-text">
                    <span className="inbox-title">{item.title}</span>
                    <span className="muted">
                      <UrgencyMark u={item.urgency} /> {kindLabel(entry)} · {item.source} · {timeLabel(item.createdAt)}
                    </span>
                  </span>
                </button>
                <div className="row-menu-wrap" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="icon-btn" aria-label="更多操作" aria-expanded={menu === item.id} onClick={() => setMenu(menu === item.id ? undefined : item.id)}>
                    ⋯
                  </button>
                  {menu === item.id && (
                    <div className="row-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => act(item, item.read ? "unread" : "read")}>
                        {item.read ? "标未读" : "标已读"}
                      </button>
                      <button type="button" role="menuitem" onClick={() => act(item, item.archived ? "unarchive" : "archive")}>
                        {item.archived ? "取消归档" : "归档"}
                      </button>
                      <button type="button" role="menuitem" className="danger-text" onClick={() => act(item, "delete")}>
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div className="hint inbox-hint">进了这里的事，秘书不主动转述。卡着任务的事项要先处理，才能归档或删除。紧急度第一阶段只在 Web 里体现（小红点和排序），手机推送是第二阶段。</div>
      </div>
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
  const processed = isInboxItemProcessed(ui, item);
  return (
    <div className="chat-col">
      <TopBar title={item.title} onBack={onBack}>
        <button type="button" className="link" onClick={() => inboxAction([item.id], item.archived ? "unarchive" : "archive")}>
          {item.archived ? "取消归档" : "归档"}
        </button>
        <button type="button" className="link danger-text" onClick={() => inboxAction([item.id], "delete")}>
          删除
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <div className="muted">
          <UrgencyMark u={item.urgency} /> {URGENCY_LABEL[item.urgency]} · {item.source} · {timeLabel(item.createdAt)}
          {item.archived ? " · 已归档" : processed ? " · 已处理" : ""}
        </div>
        {item.kind === "card" && item.cardId ? <CardPanel cardId={item.cardId} /> : <NoticeView item={item} onAction={(choice) => inboxAction([item.id], "handle", choice)} />}
        {item.kind === "notice" && item.cardId && <CardPanel cardId={item.cardId} />}
      </div>
    </div>
  );
}

const ARCHIVE_CHOICES = { archive: "归档", rework: "继续改（返工）", keep: "先留着" } as const;
type ArchiveChoice = keyof typeof ARCHIVE_CHOICES;

function NoticeView({ item, onAction }: { item: InboxItem; onAction(choice: string): void }) {
  const archiveList = (item.data as Partial<ArchiveListData> | undefined)?.archiveList;
  // 归档清单每一项的选择先留在页面上，点"完成"时一起交（归档清单的正式处理在产生它的票里）
  const [choices, setChoices] = useState<Record<number, ArchiveChoice>>({});
  return (
    <div className="card xcard">
      <div className="xcard-head">
        <span className="xcard-tag xt-notice">{noticeLabel(item.notice)}</span>
        <span className="xcard-title">{item.title}</span>
      </div>
      <div className="xcard-body">
        {item.body && <div>{item.body}</div>}
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
      {item.handled !== undefined ? (
        <div className="auth-result ok card-done-mark">✓ {item.handled}</div>
      ) : (
        <div className="auth-actions">
          {(item.actions ?? []).map((a, i) => (
            <button key={a} type="button" className={`btn ${i === 0 ? "primary" : "ghost"}`} onClick={() => onAction(a)}>
              {a}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
