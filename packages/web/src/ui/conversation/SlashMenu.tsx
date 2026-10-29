/**
 * 输入框里打 / 弹出的候选（82 号票）：二狗自己的命令（/workflow、/task，310 号票起一律英文）和这个会话能用的 skill，边打边过滤（state/slash-commands.ts）。
 * - 浮在最上层：用 ui/popup.tsx 的 PopupMenu（经 portal 画在应用框最上面的一层），不被输入栏、标题栏挡住；贴着输入框，下面放不下就翻到上面；
 * - 方向键、点按选中（键盘由输入框接着管，这里只画；点按时不抢输入框的焦点）；
 * - 选中的那一行滚进可见范围。
 * 310 号票（每个候选都看得到完整的说明）：
 * - 一行是两层：上面"写法  参数提示  显示的名字  集合名"（显示的名字和写法一样时不重复；参数提示只显示、不插），下面是说明；
 * - 选中的那一行（默认第一行；方向键、鼠标悬停换）说明完整展开、折行不截短，说明换成了用户语言的（Claude Code 内置命令查表的、
 *   二狗的模型翻的）原文小字跟在下面；其余行的说明最多两行（样式截）；
 * - 手机上"选中插入"和"只看说明"分开：点一行的主体是选中插入；点右边的"说明"小按钮只把这一行展开（变成选中的那一行）、不插入。
 *   手指按上去不算悬停（滑动列表时不跟着展开收起、不跳）；电脑上（能悬停的精确指针）这个小按钮藏起来，悬停就展开；
 * - 分组：二狗的命令 / 二狗工具包里的 skill / 运行时（Claude Code）的命令，各一个小标题；只有一组时不写。二狗自己的命令、运行时的
 *   命令不再另挂"命令""Claude Code"的小标（组名说了），skill 的集合名照旧作小标。
 */
import { type RefObject, useEffect, useRef } from "react";
import { type SlashCommandEntry, type SlashGroup, slashShownName, t } from "../../state/index.ts";
import { AssistantName } from "../assistant-name.tsx";
import { T } from "../i18n.tsx";
import { Icon } from "../icons.tsx";
import { PopupMenu } from "../popup.tsx";

/** 候选里一行的 id（输入框的 aria-activedescendant 指向它） */
export const slashItemId = (index: number) => `slash-item-${index}`;

/** 一组的小标题 */
function GroupTitle({ group }: { group: SlashGroup }) {
  switch (group.kind) {
    case "command":
      return <T k="ui.slashMenu.group.command" params={{ name: <AssistantName /> }} />;
    case "skill":
      return <T k="ui.slashMenu.group.skill" params={{ name: <AssistantName /> }} />;
    case "runtime":
      return <>{group.runtime ? t("ui.slashMenu.group.runtime", { runtime: group.runtime }) : t("ui.slashMenu.group.runtimeAny")}</>;
  }
}

/**
 * 候选列表本身（不带弹出层，测试直接渲染它）：groups 是分好组的候选（state/slash-commands.ts 的 slashGroups），active 是按分好组的先后数的
 * 第几行；onActivate 是换选中的那一行（鼠标悬停、点"说明"小按钮），onPick 是选中插入
 */
export function SlashList({
  groups,
  active,
  onPick,
  onActivate,
  listRef,
}: {
  groups: readonly SlashGroup[];
  active: number;
  onPick(entry: SlashCommandEntry): void;
  onActivate(index: number): void;
  listRef?: RefObject<HTMLDivElement | null>;
}) {
  const titled = groups.length > 1;
  let index = 0;
  // 点按、按下时焦点留在输入框里（选中之后接着打正文；点"说明"之后也能接着打字过滤）
  const keepFocus = { onPointerDown: (e: { preventDefault(): void }) => e.preventDefault(), onMouseDown: (e: { preventDefault(): void }) => e.preventDefault() };
  return (
    <div ref={listRef} className="slash-list" aria-label={t("ui.slashMenu.label")}>
      {groups.map((group) => (
        <div key={group.kind} className="slash-group" role="group" aria-labelledby={titled ? `slash-group-${group.kind}` : undefined}>
          {titled && (
            <div className="slash-group-title" id={`slash-group-${group.kind}`}>
              <GroupTitle group={group} />
            </div>
          )}
          {group.entries.map((entry) => {
            const i = index++;
            const on = i === active;
            const shown = slashShownName(entry);
            return (
              <div
                className="slash-item"
                key={entry.text}
                data-active={on ? "" : undefined}
                // 鼠标悬停换选中的那一行；手指按上去不算（滑动列表时不跟着展开收起）
                onPointerEnter={(e) => {
                  if (e.pointerType === "mouse") onActivate(i);
                }}
              >
                <button id={slashItemId(i)} type="button" role="menuitem" tabIndex={-1} className="slash-main" aria-current={on ? "true" : undefined} {...keepFocus} onClick={() => onPick(entry)}>
                  <span className="slash-head">
                    <span className="slash-cmd">{entry.text}</span>
                    {entry.argumentHint && <span className="slash-hint">{entry.argumentHint}</span>}
                    {shown && <span className="slash-name">{shown}</span>}
                    {entry.kind === "skill" && entry.collection && <span className="chip slash-tag">{entry.collection}</span>}
                  </span>
                  {entry.description && <span className="slash-desc">{entry.description}</span>}
                  {on && entry.originalDescription && <span className="slash-original">{t("ui.slashMenu.original", { text: entry.originalDescription })}</span>}
                </button>
                {entry.description && (
                  <button
                    type="button"
                    className="slash-more"
                    tabIndex={-1}
                    aria-pressed={on}
                    aria-label={t("ui.slashMenu.explain", { command: entry.text })}
                    title={t("ui.slashMenu.explain", { command: entry.text })}
                    {...keepFocus}
                    onClick={() => onActivate(i)}
                  >
                    <Icon name="info" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function SlashMenu({
  anchor,
  groups,
  active,
  onPick,
  onActivate,
  onClose,
}: {
  /** 贴着哪个元素弹（输入框外面那一层） */
  anchor: RefObject<HTMLElement | null>;
  /** 过滤、分好组的候选 */
  groups: readonly SlashGroup[];
  /** 选中的是第几行（按分好组的先后） */
  active: number;
  onPick(entry: SlashCommandEntry): void;
  onActivate(index: number): void;
  onClose(): void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // 选中的那一行（挪了、过滤后换了一行、点了"说明"展开）滚进可见范围
  const activeText = groups.flatMap((g) => g.entries)[active]?.text;
  useEffect(() => {
    if (activeText === undefined) return;
    listRef.current?.querySelector<HTMLElement>(`#${slashItemId(active)}`)?.closest(".slash-item")?.scrollIntoView({ block: "nearest" });
  }, [active, activeText]);

  return (
    <PopupMenu anchor={anchor} align="start" className="slash-menu" onClose={onClose}>
      <SlashList groups={groups} active={active} onPick={onPick} onActivate={onActivate} listRef={listRef} />
    </PopupMenu>
  );
}
