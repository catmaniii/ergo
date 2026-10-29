// 测试用的快速动作（替身）：本票只登记了记忆命令。"按关注类别判处置"要几种别的动作来测：
// - send_note：把一段话发给某人（落入"以我的名义对外发送或发布"，对话里默认先问我）；收件人登记成收件人类参数
//   （自定义类别可以按收件人匹配）；收件人和那段话都原样出现在用户这条消息里才算点明；
// - tidy_note：整理一条笔记（不落入任何内置类别，推断出来也直接做、只记录）；笔记标题原样出现才算点明。
// 执行时不碰任何外部东西，只给出结果说明（操作记录由快速动作模块追加）。正式的发消息动作在 27 号票。
import { Type } from "@ergo/protocol";
import { defineQuickAction, foundIn } from "../../src/quick-actions/index.ts";

export const sendNoteFixture = defineQuickAction({
  type: "send_note",
  title: "发消息",
  usage: "把一段话发给某人",
  params: Type.Object({ to: Type.String({ minLength: 1, description: "收件人" }), text: Type.String({ minLength: 1, description: "要发的原话" }) }, { additionalProperties: false }),
  watch: { categories: ["external_send"], args: { to: { kind: "recipient" }, text: { kind: "content" } }, outbound: true },
  normalize: ({ to, text }) => ({ params: { to, text }, title: `发给${to}：${text}`, target: to, content: text }),
  explicit: (action, turn) => (foundIn(turn, action.target ?? "") ? foundIn(turn, action.content ?? "") : undefined),
  execute(params) {
    const p = params as { to: string };
    return { events: [], summary: `已发给${p.to}（测试替身，没有真的发）` };
  },
});

export const tidyNoteFixture = defineQuickAction({
  type: "tidy_note",
  title: "整理笔记",
  usage: "整理一条笔记",
  params: Type.Object({ title: Type.String({ minLength: 1, description: "笔记的标题" }) }, { additionalProperties: false }),
  watch: { categories: [] },
  normalize: ({ title }) => ({ params: { title }, title: `整理笔记：${title}`, content: title }),
  explicit: (action, turn) => foundIn(turn, action.content ?? ""),
  execute(params) {
    return { events: [], summary: `已整理「${(params as { title: string }).title}」` };
  },
});
