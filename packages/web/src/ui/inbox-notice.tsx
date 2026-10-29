// 待我处理事项的种类名和通知的动作按钮（107 号票从 pages/InboxPage.tsx 抽出来）：待办详情（NoticeView）和会话里的"等你处理"栏
// （ui/conversation/InboxBar.tsx）用同一份——点了哪个动作都是同一个请求（inbox_action handle，choice 是这个动作），两边一起变；
// 去设置里某一页修的动作是去那一页的链接，不算处理。
import { useState } from "react";
import { type MorePage, toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { CARD_TYPE_LABEL } from "../model/cards.ts";
import {
  COMPONENTS_INSTALL_ACTION,
  inboxActionText,
  type InboxItem,
  isCardType,
  type NoticeInboxItem,
  type NoticeType,
  REVERIFY_ACTIONS,
  reverifyNoticeData,
  stageCodeLabel,
  stageCodes,
  t,
  tTable,
  VOICE_REFERENCE_IMPORT_ACTION,
  WATCH_CATEGORIES_REPAIR_ACTION,
} from "../state/index.ts";
import { ReopenDialog } from "./detail/StageDetail.tsx";
import { realStageSource } from "./detail/stage-source.ts";

const NOTICE_LABEL: Readonly<Record<NoticeType, string>> = tTable({
  reminder_due: "ui.inboxNotice.kind.reminderDue",
  missed_reminder: "ui.inboxNotice.kind.missedReminder",
  interrupted: "ui.inboxNotice.kind.interrupted",
  out_of_scope: "ui.inboxNotice.kind.outOfScope",
  backup_failed: "ui.inboxNotice.kind.backupFailed",
  snapshot_check_failed: "ui.inboxNotice.kind.snapshotCheckFailed",
  backup_overdue: "ui.inboxNotice.kind.backupOverdue",
  scheduled_job_auto_paused: "ui.inboxNotice.kind.scheduledJobAutoPaused",
  archive_list: "ui.inboxNotice.kind.archiveList",
  grant_renewal: "ui.inboxNotice.kind.grantRenewal",
  stuck_help: "ui.inboxNotice.kind.stuckHelp",
  over_budget: "ui.inboxNotice.kind.overBudget",
  failure_choice: "ui.inboxNotice.kind.failureChoice",
  embedding_model_missing: "ui.inboxNotice.kind.embeddingModelMissing",
  hand_over: "ui.inboxNotice.kind.handOver",
  holiday_data_missing: "ui.inboxNotice.kind.holidayDataMissing",
  watch_categories_broken: "ui.inboxNotice.kind.watchCategoriesBroken",
  project_delete: "ui.inboxNotice.kind.projectDelete",
  stage_acceptance: "ui.inboxNotice.kind.stageAcceptance",
  holiday_import_problem: "ui.inboxNotice.kind.holidayImportProblem",
  voice_recognizer_unavailable: "ui.inboxNotice.kind.voiceRecognizerUnavailable",
  voice_reference_missing: "ui.inboxNotice.kind.voiceReferenceMissing",
  rollback_wait: "ui.inboxNotice.kind.rollbackWait",
  reverify_failed: "ui.inboxNotice.kind.reverifyFailed",
});

/**
 * 去设置里某一页修的动作：点了是去那一页，不算处理（修好后守护进程自动归档这条）——
 * "关注类别设置文件有问题"的"去设置页修复"、"还没有参考音色"的"去导入参考音色"（32 号票）、"向量模型还没下载"的"去装组件"（323 号票）
 */
const SETTINGS_LINKS: Partial<Record<NoticeType, { action: string; page: MorePage }>> = {
  watch_categories_broken: { action: WATCH_CATEGORIES_REPAIR_ACTION, page: "watch" },
  voice_reference_missing: { action: VOICE_REFERENCE_IMPORT_ACTION, page: "voice" },
  // 323 号票：向量模型还没下载——"去装组件"去设置 · 组件
  embedding_model_missing: { action: COMPONENTS_INSTALL_ACTION, page: "components" },
};

/** 这条通知的这个动作是去设置里的哪一页（不是就是 undefined） */
function settingsLink(notice: string | undefined, action: string): MorePage | undefined {
  const link = notice === undefined ? undefined : SETTINGS_LINKS[notice as NoticeType];
  return link?.action === action ? link.page : undefined;
}

/** 通知的种类名（前端还不认识的种类写"通知"） */
export function noticeLabel(notice: string | undefined): string {
  return notice !== undefined && notice in NOTICE_LABEL ? NOTICE_LABEL[notice as NoticeType] : t("ui.inboxNotice.notice");
}

/** 一项的种类名：通知按种类，卡片按卡的类型（卡还没收到、不认识的写"卡片"） */
export function inboxKindLabel(item: InboxItem, cardType: string | undefined): string {
  if (item.kind === "notice") return noticeLabel(item.notice);
  return cardType && isCardType(cardType) ? CARD_TYPE_LABEL[cardType] : t("ui.inboxNotice.card");
}

/**
 * 通知的动作：处理过的写"✓ 选了哪个"，没处理的一排按钮（第一个是主按钮）。
 * 动作存的、点了交给守护进程的是中文原字（按字认），显示时换成当前语言（inboxActionText，172 号票）。
 * small：会话里的栏用小号按钮；className：按钮那一排的类名（待办详情是卡片底下的 auth-actions）
 */
export function NoticeActions({ item, small = false, className = "auth-actions" }: { item: NoticeInboxItem; small?: boolean; className?: string }) {
  const { inboxAction } = useStore();
  if (item.handled !== undefined) return <div className="auth-result ok card-done-mark">✓ {inboxActionText(item.handled)}</div>;
  if (item.notice === "reverify_failed") return <ReverifyActions item={item} small={small} className={className} />;
  const size = small ? " small" : "";
  return (
    <div className={className}>
      {item.actions.map((a, i) => {
        const look = `btn${size} ${i === 0 ? "primary" : "ghost"}`;
        const page = settingsLink(item.notice, a);
        return page ? (
          <a key={a} className={look} href={toHash({ tab: "more", page })}>
            {inboxActionText(a)}
          </a>
        ) : (
          <button key={a} type="button" className={look} onClick={() => inboxAction([item.id], "handle", a)}>
            {inboxActionText(a)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "重做之后复验没过"的两个动作（274 号票："先不管"、"把 M1 也重开"）：先不管就是处理掉这一条；
 * "把第 N 阶段也重做…"先出重做对话框（写这次要怎么改、看要一起重做的阶段和已经做了的事），确认了才从
 * 第一个还能重做的没过的阶段重做——守护进程重做时把这一条记成"把没过的阶段也重做"。任务不在手里、阶段都重做过了的，这个按钮点不了
 */
function ReverifyActions({ item, small, className }: { item: NoticeInboxItem; small: boolean; className: string }) {
  const { ui, inboxAction, taskAction } = useStore();
  const [reopening, setReopening] = useState(false);
  const data = reverifyNoticeData(item);
  const task = data ? ui.tasks[data.taskId] : undefined;
  const source = task ? realStageSource(ui, task, (action, options) => taskAction(task.id, action, options)) : undefined;
  const first = source && data ? data.failed.find((f) => source.stages.find((s) => s.id === f.stageId)?.status === "accepted" && source.canRework(f.stageId)) : undefined;
  const size = small ? " small" : "";
  return (
    <div className={className}>
      <button type="button" className={`btn${size} ghost`} onClick={() => inboxAction([item.id], "handle", REVERIFY_ACTIONS.ignore)}>
        {inboxActionText(REVERIFY_ACTIONS.ignore)}
      </button>
      <button type="button" className={`btn${size} danger`} disabled={!first} onClick={() => setReopening(true)}>
        {first && source ? t("ui.inboxNotice.reverifyRedo", { stage: stageCodeLabel(stageCodes(source.stages), first.stageId) }) : inboxActionText(REVERIFY_ACTIONS.redo)}
      </button>
      {reopening && source && first && task && (
        <ReopenDialog
          stages={source.stages}
          stageId={first.stageId}
          taskId={task.id}
          onCancel={() => setReopening(false)}
          onConfirm={(note, edit) => {
            setReopening(false);
            source.rework(first.stageId, note, edit);
          }}
        />
      )}
    </div>
  );
}
