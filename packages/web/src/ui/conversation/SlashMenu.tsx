/**
 * 输入框里打 / 弹出的候选（82 号票）：二狗自己的命令（/流程、/任务）和这个会话能用的 skill，边打边过滤（state/slash-commands.ts）。
 * - 浮在最上层：用 ui/popup.tsx 的 PopupMenu（经 portal 画在应用框最上面的一层），不被输入栏、标题栏挡住；贴着输入框，下面放不下就翻到上面；
 * - 一行是"写法  显示的名字 · 一句说明"（/poteto-mode  Poteto Mode · …），显示的名字和写法一样时不重复；集合名作小标，二狗自己的命令标"命令"；
 * - 方向键、点按选中（键盘由输入框接着管，这里只画；点按时不抢输入框的焦点）；
 * - 选中的那一行滚进可见范围。
 */
import { type RefObject, useEffect, useRef } from "react";
import { type SlashCommandEntry, slashShownName } from "../../state/index.ts";
import { PopupMenu } from "../popup.tsx";

/** 候选里一行的 id（输入框的 aria-activedescendant 指向它） */
export const slashItemId = (index: number) => `slash-item-${index}`;

export function SlashMenu({
  anchor,
  items,
  active,
  onPick,
  onHover,
  onClose,
}: {
  /** 贴着哪个元素弹（输入框外面那一层） */
  anchor: RefObject<HTMLElement | null>;
  /** 过滤后的候选 */
  items: readonly SlashCommandEntry[];
  /** 选中的是第几行 */
  active: number;
  onPick(entry: SlashCommandEntry): void;
  onHover(index: number): void;
  onClose(): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // 选中的那一行（挪了、过滤后换了一行）滚进可见范围
  const activeText = items[active]?.text;
  useEffect(() => {
    if (activeText === undefined) return;
    listRef.current?.querySelector<HTMLElement>(`#${slashItemId(active)}`)?.scrollIntoView({ block: "nearest" });
  }, [active, activeText]);

  return (
    <PopupMenu anchor={anchor} align="start" className="slash-menu" onClose={onClose}>
      <div ref={listRef} className="slash-list" aria-label="斜杠命令">
        {items.map((entry, i) => {
          const shown = slashShownName(entry);
          return (
            <button
              key={entry.text}
              id={slashItemId(i)}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="slash-item"
              data-active={i === active ? "" : undefined}
              aria-current={i === active ? "true" : undefined}
              title={entry.description}
              // 点按时焦点留在输入框里（选中之后接着打正文）
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onPointerEnter={() => onHover(i)}
              onClick={() => onPick(entry)}
            >
              <span className="slash-cmd">{entry.text}</span>
              {shown && <span className="slash-name">{shown}</span>}
              {entry.kind === "command" ? <span className="chip slash-tag">命令</span> : entry.collection && <span className="chip slash-tag">{entry.collection}</span>}
              <span className="slash-desc">· {entry.description}</span>
            </button>
          );
        })}
      </div>
    </PopupMenu>
  );
}
