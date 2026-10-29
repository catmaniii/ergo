// 插件开发手册（docs/guides/plugin-development.md，215 号票）里的例子"笔记"：守护进程这一半的插件定义。
// 一个插件三部分里的两部分在这里（网页那一半是 packages/web/test/plugins/notes-example/plugin.tsx）：
// - 守护进程里的：派生视图、笔记的服务、彻底删除的改写函数和"连数据删"（数据契约，停用也登记）；
// - 给二狗的：秘书的"记笔记"工具、每轮醒来时的"最近的笔记"上下文块、系统提示里的条件"笔记"和工具名占位符（经 agent 贡献缝，不写 pi 扩展）。
// 给人看的名字在真插件里写成取值函数走 t()（get title() { return t("notes.plugin.title"); }，语言文件 packages/protocol/locales/<语言>/notes.json）；
// 例子在测试里，没有语言文件，直接写中文。
import type { PluginPrompts } from "../../../src/prompts/index.ts";
import type { PluginDefinition } from "../../../src/plugins/host.ts";
import { KERNEL } from "../../../src/plugins/kernel.ts";
import { clockIso } from "../../../src/scheduler/clock.ts";
import { NOTES } from "./api.ts";
import { ADD_NOTE_TOOL, createNoteService, NOTE_EVENT, notePurge, notesView, NOTES_CHANNEL, noteTools } from "./notes.ts";

/** 系统提示里的：条件"笔记"（插件在运行时成立）、工具名的占位符；没有片段 */
const notesPrompts: PluginPrompts = {
  plugin: "notes",
  flag: { name: "笔记", description: "笔记插件在运行" },
  placeholders: [{ name: ADD_NOTE_TOOL, value: ADD_NOTE_TOOL, description: "记笔记的工具名" }],
  fragments: [],
};

export const notesPlugin: PluginDefinition = {
  name: "notes", // 配置 plugins.disabled 里写的就是它，定了别改
  title: "笔记", // 日志、"笔记插件没启用"里用
  summary: "记下你让二狗记的话", // 设置 · 插件里的一句话
  brings: { tools: ["记笔记"] }, // 设置 · 插件里列的"它带来了什么"，工具个数和实际登记的对上
  needs: [KERNEL.store, KERNEL.clock],
  provides: [NOTES],
  views: [notesView],
  prompts: notesPrompts,
  contracts(ctx) {
    // 数据契约：不管开没开、装没装上都登记，停用不撤
    ctx.purge.register(notePurge);
    ctx.removal.declare({
      deletes: ["全部笔记"],
      keeps: ["聊天里提到过的笔记内容", "备份快照里的一份"],
      events: [{ channel: NOTES_CHANNEL, type: NOTE_EVENT }],
    });
  },
  setup(ctx) {
    // 装配：每次登记都返回撤销函数、记在插件名下，停用时倒着撤
    const store = ctx.use(KERNEL.store);
    const clock = ctx.use(KERNEL.clock);
    const notes = createNoteService({ store, now: () => clockIso(clock) });
    ctx.provide(NOTES, notes);
    const tools = noteTools(notes);
    ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => tools });
    ctx.agent.context.register({
      to: { agents: ["secretary"] },
      when: "wake",
      id: "recent",
      text: () => {
        const recent = notes.list().slice(-3);
        return recent.length === 0 ? undefined : `用户最近记的笔记：\n${recent.map((n) => `- ${n.text}`).join("\n")}`;
      },
    });
  },
};
