// 插件开发手册（docs/guides/plugin-development.md，215 号票）里的例子"笔记"：网页这一半。守护进程那一半是
// packages/daemon/test/plugins/notes-example/plugin.ts（同名 notes，一起启停）。登记的：
// - 页面"笔记"（#/more/notes）：导航里排在消耗（70）后面，放不下时收进"更多"；
// - 卡片类型 note 的画法（聊天、待办、任务详情里同一张）。
// 停用时：导航、"更多"里没有笔记，地址写"笔记插件没启用"；以前的笔记卡显示"（笔记插件没启用，这条内容暂时看不到）"。
// 真插件放在 packages/web/src/plugins/<名字>/，给人看的字走 t()（key 放 ui.plugins.<名字>.*，取值函数）；例子在测试里，没有语言文件，直接写中文。
import type { CardProps } from "../../../src/ui/cards/CardShell.tsx";
import { Section } from "../../../src/ui/common.tsx";
import type { PageColumnProps, PageSectionProps, WebPluginDefinition } from "../../../src/plugins/api.ts";

/** 直接显示在导航里时的整页 */
function NotesSection(_props: PageSectionProps) {
  return <Section title="笔记">还没有笔记</Section>;
}

/** 收进"更多"时右边那一栏 */
function NotesColumn(_props: PageColumnProps) {
  return <Section title="笔记">还没有笔记</Section>;
}

/** 一张笔记卡：守护进程写的纯文字 */
function NoteCard({ state }: CardProps<never>) {
  return <div className="card">{state.card.text}</div>;
}

export const notesWebPlugin: WebPluginDefinition = {
  name: "notes", // 和守护进程的插件名一样：守护进程报的状况按它对上
  title: "笔记", // 占位那句里写它
  owns: { pages: ["notes"], cards: ["note"] }, // 数据契约：拥有的位置，装配时一一登记
  brings: ["导航里的「笔记」页"], // 设置 · 插件里列的网页上的页面、栏目
  setup(ctx) {
    ctx.register("pages", { id: "notes", order: 75, icon: "layers", navLabel: "笔记", title: "笔记", sub: "你让二狗记下的话", Section: NotesSection, Column: NotesColumn });
    ctx.register("cards", { type: "note", Card: NoteCard });
  },
};
