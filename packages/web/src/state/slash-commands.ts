// 输入框里打 / 弹出的候选（82 号票，纯函数；界面在 ui/conversation/SlashMenu.tsx，数据是守护进程给的这个会话能用的斜杠命令）。
// - 什么时候弹：输入框的文字以 / 开头、还没打空白（命令名里没有空白：/ 后面到第一个空白就是命令名）；语音模式下不弹（界面管）；
// - 边打边过滤（不分大小写）：命令的写法以打的字开头的排前面，其次是写法、显示的名字里含有它的，再次是集合名里含有它的；
//   同一档里照守护进程给的先后（二狗自己的命令在 skill 前面）；
// - 选中插入"写法 + 一个空格"，接着打正文；
// - 显示：写法（/poteto-mode），显示的名字和写法不一样时跟在后面（Poteto Mode），然后是一句说明；集合名作小标。
// - 310 号票：按"二狗的命令 / 工具包里的 skill / 运行时的命令"分组（slashGroups：组的先后固定，组内照过滤的先后；方向键按分好组的
//   先后挪，slashOrder）；参数提示（argumentHint）只显示、不插；说明还在翻（translating）时界面隔一会儿再取（slashTranslating）。
import type { SlashCommandEntry } from "./protocol.ts";

/** 输入框里现在打的是不是斜杠命令：是的话给出 / 后面打的那段（可能是空的），不是时 undefined */
export function slashQuery(text: string): string | undefined {
  return /^\/\S*$/.test(text) ? text.slice(1) : undefined;
}

/** 写法里去掉 / 的部分（/skill:流程 → skill:流程） */
const bare = (entry: SlashCommandEntry) => entry.text.slice(1);

/** 按打的那段过滤、排序候选 */
export function filterSlashCommands(list: readonly SlashCommandEntry[], query: string): SlashCommandEntry[] {
  const q = query.toLowerCase();
  const rank = (entry: SlashCommandEntry): number => {
    const text = bare(entry).toLowerCase();
    if (text.startsWith(q)) return 0;
    if (text.includes(q) || entry.name.toLowerCase().includes(q)) return 1;
    if (entry.collection?.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return list
    .map((entry, i) => ({ entry, i, r: rank(entry) }))
    .filter((x) => x.r >= 0)
    .toSorted((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.entry);
}

/** 选中之后输入框里的文字：写法加一个空格，接着打正文 */
export const slashInsertText = (entry: SlashCommandEntry): string => `${entry.text} `;

/** 候选一行上显示的名字：和写法最后一截（/pstack:tdd 的 tdd、/skill:流程 的 流程）一样时不重复显示 */
export function slashShownName(entry: SlashCommandEntry): string | undefined {
  const tail = bare(entry).split(":").at(-1) ?? "";
  return entry.name === tail ? undefined : entry.name;
}

/** 方向键挪选中的那一行：到头接着从另一头来 */
export function nextSlashIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (((current + delta) % count) + count) % count;
}

/** 候选的一组（310 号票）：二狗自己的命令、工具包里的 skill、维护者用的运行时自己的命令 */
export interface SlashGroup {
  kind: SlashCommandEntry["kind"];
  /** 运行时那一组：运行时的名字（"Claude Code"，守护进程写在 collection 里） */
  runtime?: string;
  entries: SlashCommandEntry[];
}

/** 组的先后 */
const GROUP_ORDER: readonly SlashCommandEntry["kind"][] = ["command", "skill", "runtime"];

/** 过滤好的候选分组：组按固定的先后，组内照过滤的先后；空的组不要（界面上只有一组时不写组名） */
export function slashGroups(entries: readonly SlashCommandEntry[]): SlashGroup[] {
  return GROUP_ORDER.flatMap((kind): SlashGroup[] => {
    const inGroup = entries.filter((e) => e.kind === kind);
    if (inGroup.length === 0) return [];
    const runtime = kind === "runtime" ? inGroup.find((e) => e.collection)?.collection : undefined;
    return [{ kind, ...(runtime ? { runtime } : {}), entries: inGroup }];
  });
}

/** 分好组之后一行一行的先后（方向键按它挪，第几行按它数） */
export const slashOrder = (groups: readonly SlashGroup[]): SlashCommandEntry[] => groups.flatMap((g) => g.entries);

/** 还有说明在翻（守护进程标了 translating）：开着候选时隔一会儿再取，翻好的换上 */
export const slashTranslating = (list: readonly SlashCommandEntry[]): boolean => list.some((e) => e.translating === true);

