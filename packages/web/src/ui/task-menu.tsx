// 任务操作菜单的界面那一半（90 号票）：菜单项由状态层的 taskMenu / taskActionItems 算（state/task-menu.ts），这里只管画和做。
// - TaskMenuItems：一串菜单项（看板卡的长按 / 右键菜单、任务详情的"⋯"、状态签浮层的按钮共用）；
// - TaskMenuPopup：贴着卡片、按钮弹出的菜单（ui/popup.tsx 的 PopupMenu，画在应用框最上面一层），样子用待办行菜单的 .row-menu；
// - useTaskActs：点了一项之后做什么。要多问一句的先弹对话框——取消先确认（收不回；定时触发的连同触发一起取消）、
//   退回写原因（原来状态行下面那个输入框改成点了按钮弹出的对话框）、返工 / 从某阶段重做先选阶段，再照 84 号票的
//   ReopenDialog 写这次要怎么改；改时间（98 号票）弹出改时间的对话框（ui/reschedule-dialog.tsx），保存后提示改成了什么、下次什么时候；
//   别的直接做（100 号票的立即运行一次、跑完自动播报：做完按守护进程回的提示一句）。"打开""多选"由用的地方自己接。
// - 141 号票：项目在用时运营方案里的一条，取消、归档换成一行说明（menu-note，字小、能折行），点了进项目维护者的会话。
// - 186 号票：删除先确认（写清删掉什么、本人的话作为素材保留、没结束的先停下），删了以后详情页回到看板（TaskActsTarget.deleted）；
//   不能删的是一行说明（同样的 menu-note，点不了）；没结束的任务归档也先确认（会先取消再归档）。
import { type ReactNode, type RefObject, useState } from "react";
import { toHash } from "../app/route.ts";
import type { Stage } from "../model/types.ts";
import {
  announceToast,
  type PopupAlign,
  type ReminderSchedule,
  type RescheduleJobResult,
  rescheduledToast,
  type RunJobNowResult,
  runNowToast,
  type ScheduledJobAction,
  type SetVoiceAnnounceResult,
  stageCodeLabel,
  stageCodes,
  t,
  taskArchiveConfirm,
  taskDeleteConfirm,
  type TaskAction,
  type TaskActOptions,
  type TaskMenuItem,
} from "../state/index.ts";
import { NamedText } from "./assistant-name.tsx";
import { Sheet } from "./common.tsx";
import { ReopenDialog, type StageDetailSource } from "./detail/StageDetail.tsx";
import { PopupMenu } from "./popup.tsx";
import { RescheduleDialog } from "./reschedule-dialog.tsx";
import { useToast } from "./toast.tsx";

/** 要动手的那个任务：落到任务上的动作、落到触发上的动作（定时触发的任务运营中时）、长程任务的阶段（返工要选） */
export interface TaskActsTarget {
  readonly title: string;
  act(action: TaskAction, options?: TaskActOptions): void;
  trigger?: ((action: ScheduledJobAction) => void) | undefined;
  /** 改时间（98 号票，运营中的定时任务）：换它的触发登记的时间表，等到守护进程回的结果 */
  reschedule?: ((schedule: ReminderSchedule) => Promise<RescheduleJobResult>) | undefined;
  /** 立即运行一次（100 号票，定时、事件触发的任务）：等到起了哪一次运行 */
  runNow?: (() => Promise<RunJobNowResult>) | undefined;
  /** 开关跑完自动播报（100 号票）：on 是要换成的样子 */
  announce?: ((on: boolean) => Promise<SetVoiceAnnounceResult>) | undefined;
  /** 长程任务的阶段（返工、从某阶段重做选阶段；退回写第几阶段），和阶段详情同一份 */
  stages?: StageDetailSource | undefined;
  /** 删除交出去之后（186 号票）：任务详情回到看板（删掉的任务没有详情了）；看板上不用 */
  deleted?: (() => void) | undefined;
}

/** 一串菜单项：取消这类收不回的标红，最要紧的（验收通过）加重 */
export function TaskMenuItems({ items, onPick }: { items: readonly TaskMenuItem[]; onPick(item: TaskMenuItem): void }) {
  return items.map((item) =>
    // 不能删的说明（186 号票）：点不了，只是说明为什么
    item.kind === "delete_note" ? (
      <button key="delete_note" type="button" role="menuitem" className="menu-note" disabled aria-disabled="true">
        {item.label}
      </button>
    ) : (
    <button
      key={`${item.kind}:${"action" in item ? item.action : ""}:${"stageId" in item ? item.stageId : ""}`}
      type="button"
      role="menuitem"
      className={item.kind === "operations_note" ? "menu-note" : "tone" in item && item.tone === "danger" ? "danger-text" : "tone" in item && item.tone === "primary" ? "menu-primary" : undefined}
      onClick={() => onPick(item)}
    >
      {item.label}
    </button>
    ),
  );
}

/**
 * 贴着某个元素弹出的任务菜单。head 是菜单上半（任务详情"⋯"的计划、工单、工具包、消耗、运行），和下半之间一条分隔线；
 * 点了一项菜单先关掉再做
 */
export function TaskMenuPopup({
  anchor,
  align,
  items,
  head,
  onPick,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  align: PopupAlign;
  items: readonly TaskMenuItem[];
  head?: ReactNode;
  onPick(item: TaskMenuItem): void;
  onClose(): void;
}) {
  return (
    <PopupMenu anchor={anchor} align={align} className="row-menu task-menu" onClose={onClose}>
      {head}
      {head && items.length > 0 && <div className="menu-sep" role="separator" />}
      <TaskMenuItems
        items={items}
        onPick={(item) => {
          onClose();
          onPick(item);
        }}
      />
      {!head && items.length === 0 && <div className="menu-empty muted">{t("ui.taskMenu.empty")}</div>}
    </PopupMenu>
  );
}

type Asking =
  | { kind: "cancel"; target: TaskActsTarget; viaTrigger: boolean }
  | { kind: "archive"; target: TaskActsTarget; cancelsFirst: "task" | "trigger" }
  | { kind: "delete"; target: TaskActsTarget; cancelsFirst: boolean; archived: boolean }
  | { kind: "back"; target: TaskActsTarget; stageId: string }
  | { kind: "pick"; target: TaskActsTarget; stages: StageDetailSource; label: string }
  | { kind: "reopen"; target: TaskActsTarget; stages: StageDetailSource; stageId: string }
  | { kind: "reschedule"; target: TaskActsTarget; schedule: ReminderSchedule; paused: boolean };

/** 页面上的一个阶段是第几阶段（找不到写 ?） */
const stageNo = (stages: readonly Stage[], stageId: string) => {
  const i = stages.findIndex((s) => s.id === stageId);
  return i < 0 ? "?" : String(i + 1);
};

/**
 * 点了菜单里的一项之后做什么（"打开""多选"除外）：run(要动手的任务, 菜单项)；要多问一句的弹出对话框（dialogs 放在页面里）
 */
export function useTaskActs(): { run(target: TaskActsTarget, item: TaskMenuItem): void; dialogs: ReactNode } {
  const [asking, setAsking] = useState<Asking>();
  const toast = useToast();
  const close = () => setAsking(undefined);
  const run = (target: TaskActsTarget, item: TaskMenuItem) => {
    switch (item.kind) {
      case "act":
        if (item.action === "cancel") return setAsking({ kind: "cancel", target, viaTrigger: false });
        // 186 号票：没结束的归档先确认（会先取消再归档）
        if (item.action === "archive" && item.cancelsFirst) return setAsking({ kind: "archive", target, cancelsFirst: item.cancelsFirst });
        return target.act(item.action);
      case "delete":
        return setAsking({ kind: "delete", target, cancelsFirst: item.cancelsFirst, archived: item.archived });
      case "delete_note":
        return;
      case "accept":
        return target.act("accept_stage", { stageId: item.stageId });
      case "back":
        return setAsking({ kind: "back", target, stageId: item.stageId });
      case "rework": {
        const stages = target.stages;
        if (!stages) return;
        const can = stages.stages.filter((s) => stages.canRework(s.id));
        // 只有一个能重做的阶段：直接写这次要怎么改
        if (can.length === 1) return setAsking({ kind: "reopen", target, stages, stageId: can[0]!.id });
        return setAsking({ kind: "pick", target, stages, label: item.label.replace(/…$/, "") });
      }
      case "trigger":
        if (item.action === "cancel") return setAsking({ kind: "cancel", target, viaTrigger: true });
        return target.trigger?.(item.action);
      case "reschedule":
        return setAsking({ kind: "reschedule", target, schedule: item.schedule, paused: item.paused });
      // 立即运行一次、跑完自动播报（100 号票）：直接做，按守护进程回的提示一句；被拒的原因由页面底部的提示说（ui.failures）
      case "run_now":
        return void target.runNow?.().then(
          (result) => toast(runNowToast(result)),
          () => undefined,
        );
      case "announce":
        return void target.announce?.(!item.on).then(
          (result) => toast(announceToast(result.on)),
          () => undefined,
        );
      // 运营方案里的一条（141 号票）：进项目维护者的会话，请它改运营方案
      case "operations_note":
        window.location.hash = toHash({ tab: "projects", projectId: item.projectId, chat: true });
        return;
      case "open":
      case "select":
        return;
    }
  };
  return { run, dialogs: asking && <TaskActDialog asking={asking} onClose={close} onPick={(stageId) => asking.kind === "pick" && setAsking({ kind: "reopen", target: asking.target, stages: asking.stages, stageId })} /> };
}

function TaskActDialog({ asking, onClose, onPick }: { asking: Asking; onClose(): void; onPick(stageId: string): void }) {
  const [note, setNote] = useState("");
  const toast = useToast();
  const { target } = asking;
  switch (asking.kind) {
    case "archive": {
      const asked = taskArchiveConfirm({ title: target.title, cancelsFirst: asking.cancelsFirst });
      return (
        <Sheet title={asked.title} onClose={onClose} center>
          <div className="modal-body">
            <p>{asked.body}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t("ui.taskMenu.archive.keep")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onClose();
                target.act("archive");
              }}
            >
              {t("ui.taskMenu.archive.confirm")}
            </button>
          </div>
        </Sheet>
      );
    }
    case "delete": {
      const asked = taskDeleteConfirm({ title: target.title, cancelsFirst: asking.cancelsFirst, archived: asking.archived });
      return (
        <Sheet title={asked.title} onClose={onClose} center>
          <div className="modal-body">
            <p>
              <NamedText text={asked.body} />
            </p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t("ui.taskMenu.delete.keep")}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                onClose();
                target.act("delete");
                toast(t("ui.taskMenu.delete.started", { title: target.title }));
                target.deleted?.();
              }}
            >
              {t("ui.taskMenu.delete.confirm")}
            </button>
          </div>
        </Sheet>
      );
    }
    case "cancel":
      return (
        <Sheet title={t("ui.taskMenu.cancel.title", { title: target.title })} onClose={onClose} center>
          <div className="modal-body">
            <p>{asking.viaTrigger ? t("ui.taskMenu.cancel.viaTrigger", { title: target.title }) : t("ui.taskMenu.cancel.body")}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t("ui.taskMenu.cancel.keep")}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                onClose();
                if (asking.viaTrigger) target.trigger?.("cancel");
                else target.act("cancel");
              }}
            >
              {t("ui.taskMenu.cancel.confirm")}
            </button>
          </div>
        </Sheet>
      );
    case "back": {
      const stages = target.stages?.stages ?? [];
      return (
        <Sheet title={t("ui.taskMenu.back.title", { no: stageNo(stages, asking.stageId) })} onClose={onClose} center>
          <label className="field">
            <span>{t("ui.taskMenu.back.reason")}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder={t("ui.taskMenu.back.placeholder")} autoFocus />
          </label>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              {t("ui.taskMenu.back.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onClose();
                target.act("return_stage", { stageId: asking.stageId, ...(note.trim() ? { note: note.trim() } : {}) });
              }}
            >
              {t("ui.taskMenu.back.confirm")}
            </button>
          </div>
        </Sheet>
      );
    }
    case "pick": {
      const { stages } = asking;
      const codes = stageCodes(stages.stages);
      return (
        <Sheet title={t("ui.taskMenu.pick.title", { action: asking.label })} onClose={onClose} center>
          <div className="muted dt-note">{t("ui.taskMenu.pick.note")}</div>
          <div className="stage-pick">
            {stages.stages.map((s) => (
              <button key={s.id} type="button" className="stage-pick-row" disabled={!stages.canRework(s.id)} onClick={() => onPick(s.id)}>
                {/* 91 号票：第几阶段按依赖图的编号（并行的 4a、4b） */}
                <b>{stageCodeLabel(codes, s.id)}</b>
                <span className="stage-pick-title">{s.title}</span>
                <span className="muted">›</span>
              </button>
            ))}
          </div>
        </Sheet>
      );
    }
    case "reschedule":
      return (
        <RescheduleDialog
          title={target.title}
          current={asking.schedule}
          paused={asking.paused}
          onCancel={onClose}
          onSave={(schedule) => {
            onClose();
            // 被拒的原因由页面底部的提示说（ui.failures），这里不再说一遍
            target.reschedule?.(schedule).then(
              (result) => toast(rescheduledToast(result)),
              () => undefined,
            );
          }}
        />
      );
    case "reopen":
      return (
        <ReopenDialog
          stages={asking.stages.stages}
          stageId={asking.stageId}
          taskId={asking.stages.taskId}
          onCancel={onClose}
          onConfirm={(text, edit) => {
            onClose();
            asking.stages.rework(asking.stageId, text, edit);
          }}
        />
      );
  }
}
