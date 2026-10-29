// 插件开发手册（docs/guides/plugin-development.md，215 号票）里的例子"笔记"：对外的接口。照真插件的 reminders/api.ts——
// 内核和别的插件只从这里拿笔记的东西：服务名（经插件宿主按名字取，插件没启用时取到 undefined）和它的类型。
// 例子放在测试里（plugin-guide.test.ts 把它装上、停用、启用、移除），不进插件清单。
import { serviceKey } from "../../../src/plugins/host.ts";

/** 一条笔记 */
export interface Note {
  id: string;
  text: string;
  /** 记下的时间（协议时间） */
  time: string;
}

/** 笔记插件提供的服务 */
export interface NoteService {
  /** 记一条；同一个幂等键重发拿到同一条 */
  add(text: string, idempotencyKey: string): Note;
  /** 全部笔记，先记的在前 */
  list(): Note[];
}

/** 笔记插件提供的服务名：别的模块写进 needs / wants，用 ctx.use / ctx.optional 取 */
export const NOTES = serviceKey<NoteService>("notes");
