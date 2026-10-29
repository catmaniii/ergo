// 任务详情的顶部并成一行（90 号票，用户 2026-10-11：顶部四排太占地方，并成一行或收进管理菜单，关键信息留在标题栏）。
// 宽屏、手机都只有一行（标题栏）：
//   宽屏：‹ [阶段标签] 标题  [状态签 ▾] ●活动        [关键按钮] [流程进度] [▤] [⚙] [⋯]
//   手机：‹ 标题…  [状态签 ▾] [阶段标签 / 流程进度] [▤] [⚙] [⋯]
// - 状态签点开是小浮层：原来第 3 排的原因说明（守护进程写的：等我的原因、超预算用了多少预算多少、失败的原因……）、种类和进度这些小签、token 数，
//   和这个状态能做的按钮（state/task-menu.ts 的 taskActionItems，和"⋯"下半同一份，最要紧的那个加重）；手机上状态签只写短的
//   （statusChipText：等我的写在等什么，别的写状态），全称在浮层第一行；
// - 关键按钮只在等我、失败时出一个最要紧的（taskKeyItem），只在宽屏标题栏；手机上在状态签浮层和"⋯"里；
// - "⋯"：上半是计划、工单 N、工具包、消耗、运行 N（taskPanels：宽屏在右边的详情栏打开，手机整页滑入、‹ 回到会话），下半是任务操作；
// - 阶段标签的位置、开合阶段栏的做法照 88 号票（宽屏在左 lead、窄屏在右），由任务页给；页签那一排去掉了，会话占满。
// - ⚙（114 号票）：负责这个任务的维护者的面板（单独的提示词、清空当前对话、上下文用量），由任务页给。
// 真任务（RealTaskDetail）和原型的假任务（ProtoTaskDetail）都用它，菜单项、浮层的内容由任务页按各自的数据算好交进来。
import { type ReactNode, useRef, useState } from "react";
import { tokensText } from "../model/labels.ts";
import type { ActivityState } from "../model/types.ts";
import { statusChipText, t, type TaskMenuItem, type TaskPanel } from "../state/index.ts";
import { ActivityDot, TopBar } from "./common.tsx";
import { PopupMenu } from "./popup.tsx";
import { TaskMenuItems, TaskMenuPopup } from "./task-menu.tsx";

export interface TaskHeadProps {
  wide: boolean;
  title: string;
  onBack?: (() => void) | undefined;
  /** 阶段标签（长程任务）和它放哪头：宽屏在左（‹ 之后、标题之前），窄屏在右（88 号票） */
  chip?: ReactNode;
  chipPlace: "lead" | "trail";
  /** 流程标题栏的进度（做完几步，点它看计划台账，60 号票照旧） */
  progress?: ReactNode;
  /** 缩放切换（▤ / 💬） */
  zoom?: ReactNode;
  /** 负责它的维护者的 ⚙（114 号票） */
  gear?: ReactNode;
  /** 状态签：写什么、用哪种状态的颜色（st-<状态>） */
  status: { text: string; tone: string };
  activity: { state: ActivityState; note?: string | undefined };
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
}

export function TaskHead(props: TaskHeadProps) {
  const { wide, title, onBack, chip, chipPlace, progress, zoom, gear, keyItem, onPick } = props;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState(false);
  return (
    <TopBar
      title={
        <span className="th-line">
          <span className="th-name">{title}</span>
          <StatusChip {...props} />
          {wide && <ActivityDot state={props.activity.state} note={props.activity.note} />}
        </span>
      }
      onBack={onBack}
      lead={chipPlace === "lead" && chip}
    >
      {chipPlace === "trail" && chip}
      {wide && keyItem && (
        <button type="button" className="btn small primary th-key" onClick={() => onPick(keyItem)}>
          {keyItem.label}
        </button>
      )}
      {progress}
      {zoom}
      {gear}
      <button ref={moreRef} type="button" className="icon-btn th-more" aria-label={t("ui.taskHead.manage")} aria-expanded={more} aria-haspopup="menu" onClick={() => setMore(!more)}>
        ⋯
      </button>
      {more && (
        <TaskMenuPopup
          anchor={moreRef}
          align="end"
          items={props.items}
          head={
            props.panels.length > 0 &&
            props.panels.map((p) => (
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
            ))
          }
          onPick={onPick}
          onClose={() => setMore(false)}
        />
      )}
    </TopBar>
  );
}

/** 状态签：点开是小浮层（原因、用量、小签、这个状态能做的按钮） */
function StatusChip({ wide, status, activity, note, meta, tokens, cacheHitTokens, items, keyItem, onPick }: TaskHeadProps) {
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
            {!wide && <ActivityDot state={activity.state} note={activity.note} />}
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
