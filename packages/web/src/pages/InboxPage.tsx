// 待我处理：汇集所有要我注意或确认的事。按紧急度三档排序，到点的简单提醒置顶；可标已读、归档、删除。
// 卡片在这里处理和在聊天里处理是同一张，状态同步。
import { useEffect, useState } from "react";
import type { Navigate } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { CARD_TYPE_LABEL } from "../model/cards.ts";
import { URGENCY_LABEL } from "../model/labels.ts";
import { timeLabel } from "../util/time.ts";
import type { InboxItem, NoticeInboxItem, NoticeType } from "../model/types.ts";
import { useProto } from "../prototype/proto-store.tsx";
import { useToast } from "../ui/toast.tsx";
import { isCardType, selectCard, type Urgency } from "../state/index.ts";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { ListDetail, Segmented, TopBar } from "../ui/common.tsx";
import { isProcessed, sortInbox } from "./inbox-logic.ts";

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

type Filter = "open" | "done" | "archived";

export function InboxPage({ wide, itemId, navigate }: { wide: boolean; itemId?: string; navigate: Navigate }) {
  return (
    <ListDetail
      wide={wide}
      listWidth={380}
      list={<InboxList selected={itemId} onOpen={(id) => navigate({ tab: "inbox", itemId: id })} />}
      detail={itemId ? <InboxDetail key={itemId} itemId={itemId} onBack={wide ? undefined : () => navigate({ tab: "inbox" })} onGone={() => navigate({ tab: "inbox" })} /> : undefined}
    />
  );
}

function useInboxActions() {
  const { update } = useProto();
  const toast = useToast();
  const patch = (id: string, p: Partial<InboxItem>) => update((s) => ({ ...s, inbox: s.inbox.map((x) => (x.id === id ? ({ ...x, ...p } as InboxItem) : x)) }));
  return {
    patch,
    markAllRead: () => update((s) => ({ ...s, inbox: s.inbox.map((x) => ({ ...x, read: true })) })),
    archive: (id: string) => {
      patch(id, { archived: true, read: true });
      toast("已归档");
    },
    remove: (id: string) => {
      patch(id, { deleted: true });
      toast("已删除");
    },
  };
}

function kindLabel(item: InboxItem, type?: string): string {
  if (item.kind === "notice") return NOTICE_LABEL[item.notice];
  return type && isCardType(type) ? CARD_TYPE_LABEL[type] : "卡片";
}

function InboxList({ selected, onOpen }: { selected?: string; onOpen(id: string): void }) {
  const { proto } = useProto();
  const { ui } = useStore();
  const { markAllRead, patch, archive, remove } = useInboxActions();
  const [filter, setFilter] = useState<Filter>("open");
  const [menu, setMenu] = useState<string>();
  const visible = proto.inbox.filter((x) => !x.deleted);
  const shown = sortInbox(
    visible.filter((x) => (filter === "archived" ? x.archived : !x.archived && (filter === "open" ? !isProcessed(x, ui) : isProcessed(x, ui)))),
  );
  const count = (f: Filter) => visible.filter((x) => (f === "archived" ? x.archived : !x.archived && (f === "open" ? !isProcessed(x, ui) : isProcessed(x, ui)))).length;

  // 待处理按紧急度分组：每组第一项前面放组名
  const heads = new Map<string, string>();
  if (filter === "open") {
    let last = "";
    for (const it of shown) {
      const group = it.kind === "notice" && it.pinned ? "置顶：到点的提醒" : URGENCY_LABEL[it.urgency];
      if (group !== last) heads.set(it.id, group);
      last = group;
    }
  }
  return (
    <div className="chat-col">
      <TopBar title="待我处理">
        <button type="button" className="link" onClick={markAllRead}>
          全部标已读
        </button>
      </TopBar>
      <Segmented<Filter>
        value={filter}
        onChange={setFilter}
        options={[
          { value: "open", label: `待处理 ${count("open")}` },
          { value: "done", label: `已处理 ${count("done")}` },
          { value: "archived", label: `已归档 ${count("archived")}` },
        ]}
      />
      <div className="scroll inbox-list" onClick={() => setMenu(undefined)}>
        {shown.length === 0 && <div className="page-placeholder">这里没有事项</div>}
        {shown.map((it) => {
          const head = heads.get(it.id);
          const type = it.kind === "card" ? selectCard(ui, it.cardId)?.card.type : undefined;
          return (
            <div key={it.id}>
              {head && <div className={`inbox-group ig-${it.kind === "notice" && it.pinned ? "pinned" : it.urgency}`}>{head}</div>}
              <div className={`inbox-row${selected === it.id ? " on" : ""}${it.read ? "" : " unread"}`}>
                <button type="button" className="inbox-main" onClick={() => onOpen(it.id)}>
                  <span className="inbox-dot" aria-label={it.read ? undefined : "未读"} />
                  <span className="inbox-text">
                    <span className="inbox-title">{it.title}</span>
                    <span className="muted">
                      <UrgencyMark u={it.urgency} /> {kindLabel(it, type)} · {it.source} · {timeLabel(it.createdAt)}
                    </span>
                  </span>
                </button>
                <div className="row-menu-wrap" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="icon-btn" aria-label="更多操作" aria-expanded={menu === it.id} onClick={() => setMenu(menu === it.id ? undefined : it.id)}>
                    ⋯
                  </button>
                  {menu === it.id && (
                    <div className="row-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => (patch(it.id, { read: !it.read }), setMenu(undefined))}>
                        {it.read ? "标未读" : "标已读"}
                      </button>
                      {!it.archived && (
                        <button type="button" role="menuitem" onClick={() => (archive(it.id), setMenu(undefined))}>
                          归档
                        </button>
                      )}
                      {it.archived && (
                        <button type="button" role="menuitem" onClick={() => (patch(it.id, { archived: false }), setMenu(undefined))}>
                          取消归档
                        </button>
                      )}
                      <button type="button" role="menuitem" className="danger-text" onClick={() => (remove(it.id), setMenu(undefined))}>
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div className="hint inbox-hint">进了这里的事，秘书不主动转述。紧急度第一阶段只在 Web 里体现（小红点和排序），手机推送是第二阶段。</div>
      </div>
    </div>
  );
}

function UrgencyMark({ u }: { u: Urgency }) {
  return <span className={`urg urg-${u}`} title={URGENCY_LABEL[u]} aria-label={URGENCY_LABEL[u]} />;
}

function InboxDetail({ itemId, onBack, onGone }: { itemId: string; onBack?: () => void; onGone(): void }) {
  const { proto } = useProto();
  const toast = useToast();
  const { patch, archive, remove } = useInboxActions();
  const item = proto.inbox.find((x) => x.id === itemId && !x.deleted);
  // 打开就算看过了
  useEffect(() => {
    if (item && !item.read) patch(item.id, { read: true });
  }, [item, patch]);
  if (!item) return <div className="page-placeholder">这一项已经删掉了</div>;
  return (
    <div className="chat-col">
      <TopBar title={item.title} onBack={onBack}>
        <button type="button" className="link" onClick={() => (archive(item.id), onGone())}>
          归档
        </button>
        <button type="button" className="link danger-text" onClick={() => (remove(item.id), onGone())}>
          删除
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <div className="muted">
          <UrgencyMark u={item.urgency} /> {URGENCY_LABEL[item.urgency]} · {item.source} · {timeLabel(item.createdAt)}
        </div>
        {item.kind === "card" ? (
          <CardPanel cardId={item.cardId} />
        ) : (
          <NoticeView
            item={item}
            onAction={(a) => {
              patch(item.id, { handled: a });
              toast(`已处理：${a}`);
            }}
            onListChoice={(i, choice) => patch(item.id, { archiveList: item.archiveList?.map((x, j) => (j === i ? { ...x, choice } : x)) })}
          />
        )}
      </div>
    </div>
  );
}

const ARCHIVE_CHOICES = { archive: "归档", rework: "继续改（返工）", keep: "先留着" } as const;

function NoticeView({ item, onAction, onListChoice }: { item: NoticeInboxItem; onAction(a: string): void; onListChoice(i: number, c: keyof typeof ARCHIVE_CHOICES): void }) {
  return (
    <div className="card xcard">
      <div className="xcard-head">
        <span className="xcard-tag xt-notice">{NOTICE_LABEL[item.notice]}</span>
        <span className="xcard-title">{item.title}</span>
      </div>
      <div className="xcard-body">
        <div>{item.body}</div>
        {item.archiveList && (
          <div className="archive-list">
            {item.archiveList.map((x, i) => (
              <div key={x.task} className="archive-row">
                <div>
                  {x.task}
                  <span className="muted"> · 结束于 {timeLabel(x.endedAt)}</span>
                </div>
                <div className="qa-opts">
                  {(Object.keys(ARCHIVE_CHOICES) as (keyof typeof ARCHIVE_CHOICES)[]).map((c) => (
                    <button key={c} type="button" className={`qa-opt${x.choice === c ? " on" : ""}`} aria-pressed={x.choice === c} disabled={!!item.handled} onClick={() => onListChoice(i, c)}>
                      {ARCHIVE_CHOICES[c]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {item.handled ? (
        <div className="auth-result ok card-done-mark">✓ {item.handled}</div>
      ) : (
        <div className="auth-actions">
          {item.actions.map((a, i) => (
            <button key={a} type="button" className={`btn ${i === 0 ? "primary" : "ghost"}`} onClick={() => onAction(a)}>
              {a}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
