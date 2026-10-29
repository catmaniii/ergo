// 手册里的例子"笔记"（215 号票）：事件、派生视图、服务、彻底删除的改写函数、给秘书的工具。插件的定义在 plugin.ts。
// 真插件的事件类型和频道写进共享协议包（packages/protocol/src/constants.ts 的 EVENT_TYPES、CHANNELS，负载的类型也放协议包）；
// 例子在测试里，就地写成常量。
// @i18n-ignore-file model：工具的说明、参数说明和结果给秘书（模型）看
import { PURGED_TEXT, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../../../src/agent-manager/host-tools.ts";
import type { DerivedView, EventStore } from "../../../src/events/event-store.ts";
import type { PurgeRewriter } from "../../../src/events/purge.ts";
import type { ReadonlyDatabase } from "../../../src/storage/sqlite.ts";
import type { Note, NoteService } from "./api.ts";

/** 笔记的频道和事件类型 */
export const NOTES_CHANNEL = "notes";
export const NOTE_EVENT = "note";

/** note 事件的负载 */
export interface NoteEventPayload {
  note: Note;
}

/** 派生视图：每条笔记一行。插件停用时它停着、不再更新；再启用时宿主整表按事件日志补一遍 */
export const notesView: DerivedView = {
  name: "notes",
  channels: [NOTES_CHANNEL],
  create: (db) => db.exec("CREATE TABLE IF NOT EXISTS notes (note_id TEXT PRIMARY KEY, note TEXT NOT NULL, seq INTEGER NOT NULL)"),
  clear: (db) => db.exec("DELETE FROM notes"),
  apply(db, event) {
    if (event.channel !== NOTES_CHANNEL || event.type !== NOTE_EVENT) return;
    const { note } = event.payload as NoteEventPayload;
    db.run("INSERT INTO notes (note_id, note, seq) VALUES (?, ?, ?) ON CONFLICT (note_id) DO UPDATE SET note = excluded.note", note.id, JSON.stringify(note), event.globalSeq);
  },
};

/** 视图里的全部笔记，先记的在前 */
export function listNotes(db: ReadonlyDatabase): Note[] {
  return db.all<{ note: string }>("SELECT note FROM notes ORDER BY seq").map((row) => JSON.parse(row.note) as Note);
}

/** 笔记的服务：写一律经事件存储追加，读走视图 */
export function createNoteService(options: { store: EventStore; now: () => string }): NoteService {
  const { store } = options;
  return {
    add(text, idempotencyKey) {
      const note: Note = { id: `note-${listNotes(store.reader).length + 1}`, text, time: options.now() };
      const { event } = store.append({ channel: NOTES_CHANNEL, type: NOTE_EVENT, payload: { note } satisfies NoteEventPayload, idempotencyKey });
      return (event.payload as NoteEventPayload).note;
    },
    list: () => listNotes(store.reader),
  };
}

/** 彻底删除时 note 事件怎么改写（ADR-0008）：笔记的原文换成删除标记，编号、时间留着 */
export const notePurge: PurgeRewriter = {
  eventType: NOTE_EVENT,
  rewrite(event) {
    const { note } = event.payload as NoteEventPayload;
    return { note: { ...note, text: PURGED_TEXT } } satisfies NoteEventPayload;
  },
};

/** 工具名（系统提示里的占位符也用它） */
export const ADD_NOTE_TOOL = "add_note";

/** 给秘书的工具：记一条笔记 */
export function noteTools(notes: NoteService): HostTool[] {
  return [
    defineHostTool({
      name: ADD_NOTE_TOOL,
      title: "记笔记",
      description: "把用户要记下的一句话存成笔记。用户说\"记一下……\"时用",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 500, description: "要记的话，照用户的原话" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: true,
      run(args, call) {
        const note = notes.add(args.text, `add-note:${call.toolCallId}`);
        return { text: `记好了（${note.id}）。` };
      },
    }),
  ];
}
