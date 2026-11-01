// 对话框的标题栏（90 号票做任务详情时并成一行，368 号票起所有负责人的对话框——项目的、任务的——都是它，只有一套样子）。
// 宽屏、手机都只有一行（标题栏）：
//   宽屏：‹ [档案] 标题 [项目状态] [状态签 ▾] ●活动        [关键按钮] [背后的 agent] [▤] [⚙] [⋯]
//   手机：‹ 标题…  [状态签 ▾] [背后的 agent] [▤] [⚙] [⋯]
// - 状态签点开是小浮层：原来第 3 排的原因说明（守护进程写的：等我的原因、超预算用了多少预算多少、失败的原因……）、种类和进度这些小签、token 数，
//   和这个状态能做的按钮（state/task-menu.ts 的 taskActionItems，和"⋯"下半同一份，最要紧的那个加重）；手机上状态签只写短的
//   （statusChipText：等我的写在等什么，别的写状态），全称在浮层第一行。项目的对话框里没有在做的任务时没有状态签（标题旁边是项目的状态）；
// - 关键按钮只在等我、失败时出一个最要紧的（taskKeyItem），只在宽屏标题栏；手机上在状态签浮层和"⋯"里；
// - "⋯"：上半是档案（手机上，368 号票）、计划、工单 N、工具包、消耗、运行 N（taskPanels：宽屏在右边的详情栏打开，手机整页滑入、‹ 回到会话），下半是任务操作；
// - 标题：手机上点标题打开档案（368 号票，onTitle）；宽屏档案就在左边，左上角的"档案"标签（lead）开合它；
// - 阶段不在标题栏了（368 号票）：对话框顶部的阶段条（ui/conversation/stage-panel.tsx）；
// - 背后的 agent（368 号票，behind）：ui/detail/BackgroundAgents.tsx 的入口；
// - ⚙（114 号票）：负责这个任务的负责人的面板（单独的提示词、清空当前对话、上下文用量），由任务页给。
// - 活动状态上的"等你……"能点（369 号票）：跳到要处理的那张卡；宽屏在标题栏，手机在状态签浮层里（点了浮层收起来），没有状态签时手机也在标题栏。
// 真任务、项目（pages/AgentConversation.tsx）和原型的假任务都用它，菜单项、浮层的内容由页面按各自的数据算好交进来。
import { type ReactNode, useRef, useState } from "react";
import { tokensText } from "../model/labels.ts";
import type { ActivityState } from "../model/types.ts";
import { type ActivityJump, statusChipText, t, type TaskMenuItem, type TaskPanel } from "../state/index.ts";
import { ActivityDot, TopBar } from "./common.tsx";
import { PopupMenu } from "./popup.tsx";
import { TaskMenuItems, TaskMenuPopup } from "./task-menu.tsx";

export interface TaskHeadProps {
  wide: boolean;
  title: string;
  onBack?: (() => void) | undefined;
  /** 标题左边：宽屏开合档案的标签 */
  lead?: ReactNode;
  /** 手机上点标题：打开档案 */
  onTitle?: (() => void) | undefined;
  /** 标题旁边的小签（项目的状态）：宽屏一直有，手机上有状态签时让地方 */
  badge?: ReactNode;
  /** 背后的 agent 的入口 */
  behind?: ReactNode;
  /** 缩放切换（▤ / 💬） */
  zoom?: ReactNode;
  /** 负责它的负责人的 ⚙（114 号票） */
  gear?: ReactNode;
  /** 状态签：写什么、用哪种状态的颜色（st-<状态>）；项目的对话框里没有在做的任务时没有 */
  status?: { text: string; tone: string } | undefined;
  activity: { state: ActivityState; note?: string | undefined; jump?: ActivityJump | undefined };
  /** 状态签浮层：原因说明（守护进程写的那句，超预算的用量也是）、几个小签（种类、项目、第几阶段、定时……） */
  note?: string | undefined;
  meta?: ReactNode;
  tokens: number;
  /** 其中缓存命中的（311 号票：写成"（其中缓存命中 …）"） */
  cacheHitTokens?: number | undefined;
  /** 这个任务现在能做的（浮层的按钮、"⋯"的下半）和最要紧的那个（宽屏标题栏） */
  items: readonly TaskMenuItem[];
  keyItem?: TaskMenuItem | undefined;
  /** "⋯"的上半 */
  panels: ReadonlyArray<{ panel: TaskPanel; label: string }>;
  onPanel(panel: TaskPanel): void;
  onPick(item: TaskMenuItem): void;
  /** "⋯"最上面另加的一项（手机上的档案） */
  moreHead?: { label: string; onPick(): void } | undefined;
  /** "⋯"里任务的那几样是哪个任务的（项目的对话框里写任务名，别的不用写） */
  menuTitle?: string | undefined;
}

export function TaskHead(props: TaskHeadProps) {
  const { wide, title, onBack, lead, onTitle, badge, behind, zoom, gear, keyItem, onPick, status, activity, moreHead, menuTitle, panels, items } = props;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState(false);
  const hasMore = moreHead !== undefined || panels.length > 0 || items.length > 0;
  return (
    <>
      <TopBar
        title={
          <span className="th-line">
            {onTitle ? (
              <button type="button" className="th-name th-name-link" onClick={onTitle}>
                {title}
              </button>
            ) : (
              <span className="th-name">{title}</span>
            )}
            {(wide || !status) && badge}
            {status && <StatusChip {...props} status={status} />}
            {(wide || !status) && <ActivityDot state={activity.state} note={activity.note} jump={activity.jump} />}
          </span>
        }
        onBack={onBack}
        lead={lead}
      >
        {wide && keyItem && (
          <button type="button" className="btn small primary th-key" onClick={() => onPick(keyItem)}>
            {keyItem.label}
          </button>
        )}
        {behind}
        {zoom}
        {gear}
        {hasMore && (
          <button ref={moreRef} type="button" className="icon-btn th-more" aria-label={t("ui.taskHead.manage")} aria-expanded={more} aria-haspopup="menu" onClick={() => setMore(!more)}>
            ⋯
          </button>
        )}
        {more && (
          <TaskMenuPopup
            anchor={moreRef}
            align="end"
            items={items}
            head={
              (moreHead !== undefined || panels.length > 0) && (
                <>
                  {moreHead && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMore(false);
                        moreHead.onPick();
                      }}
                    >
                      {moreHead.label}
                      <span className="menu-go" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  )}
                  {menuTitle !== undefined && (panels.length > 0 || items.length > 0) && <div className="menu-empty muted th-menu-title">{menuTitle}</div>}
                  {panels.map((p) => (
                    <button
                      key={p.panel}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMore(false);
                        props.onPanel(p.panel);
                      }}
                    >
                      {p.label}
                      <span className="menu-go" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  ))}
                </>
              )
            }
            onPick={onPick}
            onClose={() => setMore(false)}
          />
        )}
      </TopBar>
      {!wide && status && activity.jump && (
        <div className="th-jump">
          <ActivityDot state={activity.state} note={activity.note} jump={activity.jump} />
        </div>
      )}
    </>
  );
}

/** 状态签：点开是小浮层（原因、用量、小签、这个状态能做的按钮） */
function StatusChip({ wide, status, activity, note, meta, tokens, cacheHitTokens, items, keyItem, onPick }: TaskHeadProps & { status: NonNullable<TaskHeadProps["status"]> }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // 浮层里最要紧的那个按钮加重（宽屏标题栏上的关键按钮，手机上它只在这里和"⋯"里）
  // 不能删的那行说明（186 号票）只在"⋯"里，浮层里不占地方
  const shown = items
    .filter((item) => item.kind !== "delete_note")
    .map((item): TaskMenuItem => (keyItem && item.kind === "act" && item.label === keyItem.label ? { ...item, tone: "primary" } : item));
  return (
    <>
      <button ref={ref} type="button" className={`th-st st ${status.tone}`} aria-expanded={open} aria-haspopup="dialog" aria-label={t("ui.taskHead.statusLabel", { status: status.text })} onClick={() => setOpen(!open)}>
        {statusChipText(status.text, wide)}
        <span className="th-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <PopupMenu anchor={ref} align="start" className="th-pop" role="dialog" label={status.text} onClose={() => setOpen(false)}>
          <div className={`th-pop-status st ${status.tone}`}>{status.text}</div>
          {/* 原因照守护进程写的那句（超预算的用了多少、预算多少也是：追加预算后工具调用重新计数，前端自己算的对不上） */}
          {note && <div className="th-pop-note">{note}</div>}
          <div className="th-pop-meta">
            {meta}
            {/* 手机上活动状态不在标题栏，放这里 */}
            {!wide && <ActivityDot state={activity.state} note={activity.note} jump={activity.jump} onJump={() => setOpen(false)} />}
            <span className="muted">{tokensText(tokens, cacheHitTokens)}</span>
          </div>
          {items.length > 0 && (
            <div className="th-pop-acts">
              <TaskMenuItems
                items={shown}
                onPick={(item) => {
                  setOpen(false);
                  onPick(item);
                }}
              />
            </div>
          )}
        </PopupMenu>
      )}
    </>
  );
}
