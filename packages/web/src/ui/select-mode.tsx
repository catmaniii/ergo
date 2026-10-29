// 多选模式的共用部件（157 号票，看板、待办、已配对设备共用）。用户 2026-10-18：多选模式要有明显的"退出多选"按钮，
// 原来只是标题栏的"多选"亮起来，不容易意识到自己在多选模式里。
// - SelectToggle：标题栏的"多选"，进了多选模式换成写着字的"退出多选"（实色），点了退出、勾的清空；
// - SelectExit：底部操作栏上"已选 N 个"那一行右边的"✕ 退出多选"（原来写"完成"，和提醒、任务的"完成"分不清）；
// - useSelectingBack：多选时鸿蒙的返回键先退出多选（原来就有），电脑上按 Esc 也一样——Esc 走同一个返回栈，
//   开着弹窗、菜单时先关最上面那个，没有了再退出多选。
// 操作栏、勾选框醒目的样子在 styles/manage.css（.sel-bar、.bsel、.picked）。
import { useEffect } from "react";
import { pageBack, useBackLayer } from "../app/page-back.ts";
import { t } from "../state/index.ts";

/** 标题栏的"多选"按钮：多选时写"退出多选" */
export function SelectToggle({ selecting, onStart, onStop, disabled, className }: { selecting: boolean; onStart(): void; onStop(): void; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      className={`btn small ${selecting ? "primary sel-toggle-on" : "ghost"}${className ? ` ${className}` : ""}`}
      aria-pressed={selecting}
      disabled={disabled}
      onClick={() => (selecting ? onStop() : onStart())}
    >
      {selecting ? t("ui.selectMode.exit") : t("ui.selectMode.start")}
    </button>
  );
}

/** 操作栏上的"✕ 退出多选"（写字，不只是图标） */
export function SelectExit({ onExit }: { onExit(): void }) {
  return (
    <button type="button" className="btn small primary sel-done" onClick={onExit}>
      <span className="sel-x" aria-hidden="true">
        ✕
      </span>
      {t("ui.selectMode.exit")}
    </button>
  );
}

/** 多选时：返回键先退出多选；Esc 和返回键一样（先关最上面开着的弹窗、菜单，没有再退出多选） */
export function useSelectingBack(selecting: boolean, onExit: () => void): void {
  useBackLayer("overlay", selecting, onExit);
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      // 别处已经接住的 Esc（输入框收起候选这类）、输入法还在拼的不算
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      pageBack().back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);
}

/** 多选时卡片左上的勾选框（看板的任务卡、提醒卡共用；193 号票起提醒卡在提醒插件里，挪到这里） */
export function CardCheck({ checked }: { checked: boolean }) {
  return (
    <span className={`bsel${checked ? " on" : ""}`} aria-hidden="true">
      {checked ? "✓" : ""}
    </span>
  );
}
