// 任务操作菜单的界面那一半（90 号票）：菜单项由状态层的 taskMenu / taskActionItems 算（state/task-menu.ts），这里只管画和做。
// - TaskMenuItems：一串菜单项（看板卡的长按 / 右键菜单、任务详情的"⋯"、状态签浮层的按钮共用）；
// - TaskMenuPopup：贴着卡片、按钮弹出的菜单（ui/popup.tsx 的 PopupMenu，画在应用框最上面一层），样子用待办行菜单的 .row-menu；
// - useTaskActs：点了一项之后做什么。要多问一句的先弹对话框——取消先确认（收不回；定时触发的连同触发一起取消）、
//   退回写原因（原来状态行下面那个输入框改成点了按钮弹出的对话框）、返工 / 从某阶段重做先选阶段，再照 84 号票的
//   ReopenDialog 写这次要怎么改；别的直接做。"打开""多选"由用的地方自己接。
import { type ReactNode, type RefObject, useState } from "react";
import type { Stage } from "../model/types.ts";
import { type PopupAlign, type ScheduledJobAction, stageCodeLabel, stageCodes, type TaskAction, type TaskMenuItem } from "../state/index.ts";
import { Sheet } from "./common.tsx";
import { ReopenDialog, type StageDetailSource } from "./detail/StageDetail.tsx";
import { PopupMenu } from "./popup.tsx";

/** 要动手的那个任务：落到任务上的动作、落到触发上的动作（定时触发的任务运营中时）、长程任务的阶段（返工要选） */
export interface TaskActsTarget {
  readonly title: string;
  act(action: TaskAction, options?: { stageId?: string; note?: string }): void;
  trigger?: ((action: ScheduledJobAction) => void) | undefined;
  /** 长程任务的阶段（返工、从某阶段重做选阶段；退回写第几阶段），和阶段详情同一份 */
  stages?: StageDetailSource | undefined;
}

/** 一串菜单项：取消这类收不回的标红，最要紧的（验收通过）加重 */
export function TaskMenuItems({ items, onPick }: { items: readonly TaskMenuItem[]; onPick(item: TaskMenuItem): void }) {
  return items.map((item) => (
    <button
      key={`${item.kind}:${"action" in item ? item.action : ""}:${"stageId" in item ? item.stageId : ""}`}
      type="button"
      role="menuitem"
      className={"tone" in item && item.tone === "danger" ? "danger-text" : "tone" in item && item.tone === "primary" ? "menu-primary" : undefined}
      onClick={() => onPick(item)}
    >
      {item.label}
    </button>
  ));
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
      {!head && items.length === 0 && <div className="menu-empty muted">现在没有能做的</div>}
    </PopupMenu>
  );
}

type Asking =
  | { kind: "cancel"; target: TaskActsTarget; viaTrigger: boolean }
  | { kind: "back"; target: TaskActsTarget; stageId: string }
  | { kind: "pick"; target: TaskActsTarget; stages: StageDetailSource; label: string }
  | { kind: "reopen"; target: TaskActsTarget; stages: StageDetailSource; stageId: string };

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
  const close = () => setAsking(undefined);
  const run = (target: TaskActsTarget, item: TaskMenuItem) => {
    switch (item.kind) {
      case "act":
        if (item.action === "cancel") return setAsking({ kind: "cancel", target, viaTrigger: false });
        return target.act(item.action);
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
      case "open":
      case "select":
        return;
    }
  };
  return { run, dialogs: asking && <TaskActDialog asking={asking} onClose={close} onPick={(stageId) => asking.kind === "pick" && setAsking({ kind: "reopen", target: asking.target, stages: asking.stages, stageId })} /> };
}

function TaskActDialog({ asking, onClose, onPick }: { asking: Asking; onClose(): void; onPick(stageId: string): void }) {
  const [note, setNote] = useState("");
  const { target } = asking;
  switch (asking.kind) {
    case "cancel":
      return (
        <Sheet title={`取消「${target.title}」？`} onClose={onClose} center>
          <div className="modal-body">
            <p>
              {asking.viaTrigger
                ? `取消后「${target.title}」不再运行，任务一起取消（在看板的最近结束里）；会话和每次运行的记录保留。想先停一停可以用"暂停"。`
                : '取消后不再执行，会话和记录都留着（在看板的最近结束里）。想先停一停可以用"暂停"。'}
            </p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              先不取消
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
              取消任务
            </button>
          </div>
        </Sheet>
      );
    case "back": {
      const stages = target.stages?.stages ?? [];
      return (
        <Sheet title={`退回第 ${stageNo(stages, asking.stageId)} 阶段`} onClose={onClose} center>
          <label className="field">
            <span>退回的原因（可不写，写了交给维护者）</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="比如：对比表少了价格一栏" autoFocus />
          </label>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                onClose();
                target.act("return_stage", { stageId: asking.stageId, ...(note.trim() ? { note: note.trim() } : {}) });
              }}
            >
              退回
            </button>
          </div>
        </Sheet>
      );
    }
    case "pick": {
      const { stages } = asking;
      const codes = stageCodes(stages.stages);
      return (
        <Sheet title={`${asking.label}：从哪个阶段`} onClose={onClose} center>
          <div className="muted dt-note">只重做这一阶段和依赖它的阶段，不相干的照常保留。开始过的阶段才能重做。</div>
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
    case "reopen":
      return (
        <ReopenDialog
          stages={asking.stages.stages}
          stageId={asking.stageId}
          taskId={asking.stages.taskId}
          onCancel={onClose}
          onConfirm={(text) => {
            onClose();
            asking.stages.rework(asking.stageId, text);
          }}
        />
      );
  }
}
