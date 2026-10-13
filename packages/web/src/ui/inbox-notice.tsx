// 待我处理事项的种类名和通知的动作按钮（107 号票从 pages/InboxPage.tsx 抽出来）：待办详情（NoticeView）和会话里的"等你处理"栏
// （ui/conversation/InboxBar.tsx）用同一份——点了哪个动作都是同一个请求（inbox_action handle，choice 是这个动作），两边一起变；
// 去设置里某一页修的动作是去那一页的链接，不算处理。
import { type MorePage, toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { CARD_TYPE_LABEL } from "../model/cards.ts";
import { type InboxItem, isCardType, type NoticeInboxItem, type NoticeType, VOICE_REFERENCE_IMPORT_ACTION, WATCH_CATEGORIES_REPAIR_ACTION } from "../state/index.ts";

const NOTICE_LABEL: Record<NoticeType, string> = {
  reminder_due: "提醒",
  missed_reminder: "错过的提醒",
  interrupted: "中断不确定",
  out_of_scope: "越界通知",
  backup_failed: "备份失败",
  snapshot_check_failed: "快照校验失败",
  scheduled_job_auto_paused: "定时触发的任务被自动暂停",
  archive_list: "归档清单",
  grant_renewal: "授权到期续期",
  stuck_help: "卡住求助",
  over_budget: "超预算",
  failure_choice: "失败后的抉择",
  embedding_model_missing: "向量模型未下载",
  hand_over: "交给我做",
  holiday_data_missing: "节假日数据缺失",
  watch_categories_broken: "关注类别设置有问题",
  project_delete: "删除项目的确认",
  stage_acceptance: "等你验收",
  holiday_import_problem: "节假日数据导入有问题",
  voice_recognizer_unavailable: "语音识别不可用",
  voice_reference_missing: "还没有参考音色",
};

/**
 * 去设置里某一页修的动作：点了是去那一页，不算处理（修好后守护进程自动归档这条）——
 * "关注类别设置文件有问题"的"去设置页修复"、"还没有参考音色"的"去导入参考音色"（32 号票）
 */
const SETTINGS_LINKS: Partial<Record<NoticeType, { action: string; page: MorePage }>> = {
  watch_categories_broken: { action: WATCH_CATEGORIES_REPAIR_ACTION, page: "watch" },
  voice_reference_missing: { action: VOICE_REFERENCE_IMPORT_ACTION, page: "voice" },
};

/** 这条通知的这个动作是去设置里的哪一页（不是就是 undefined） */
function settingsLink(notice: string | undefined, action: string): MorePage | undefined {
  const link = notice === undefined ? undefined : SETTINGS_LINKS[notice as NoticeType];
  return link?.action === action ? link.page : undefined;
}

/** 通知的种类名（前端还不认识的种类写"通知"） */
export function noticeLabel(notice: string | undefined): string {
  return notice !== undefined && notice in NOTICE_LABEL ? NOTICE_LABEL[notice as NoticeType] : "通知";
}

/** 一项的种类名：通知按种类，卡片按卡的类型（卡还没收到、不认识的写"卡片"） */
export function inboxKindLabel(item: InboxItem, cardType: string | undefined): string {
  if (item.kind === "notice") return noticeLabel(item.notice);
  return cardType && isCardType(cardType) ? CARD_TYPE_LABEL[cardType] : "卡片";
}

/**
 * 通知的动作：处理过的写"✓ 选了哪个"，没处理的一排按钮（第一个是主按钮）。
 * small：会话里的栏用小号按钮；className：按钮那一排的类名（待办详情是卡片底下的 auth-actions）
 */
export function NoticeActions({ item, small = false, className = "auth-actions" }: { item: NoticeInboxItem; small?: boolean; className?: string }) {
  const { inboxAction } = useStore();
  if (item.handled !== undefined) return <div className="auth-result ok card-done-mark">✓ {item.handled}</div>;
  const size = small ? " small" : "";
  return (
    <div className={className}>
      {item.actions.map((a, i) => {
        const look = `btn${size} ${i === 0 ? "primary" : "ghost"}`;
        const page = settingsLink(item.notice, a);
        return page ? (
          <a key={a} className={look} href={toHash({ tab: "more", page })}>
            {a}
          </a>
        ) : (
          <button key={a} type="button" className={look} onClick={() => inboxAction([item.id], "handle", a)}>
            {a}
          </button>
        );
      })}
    </div>
  );
}
