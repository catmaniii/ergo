// 看板种类的登记表（126 号票）：内核的任务、定时触发的任务两行先登记，插件登记自己的那一行（按 order 排），撤销后不在；
// 空看板的说法、"查看板"工具的说明跟着登记表走。
import { EVENT_TYPES } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { boardEmptyText, boardKind, BoardKindRegistry, boardToolDescription } from "../../src/board/kinds.ts";

const notes = boardKind<{ id: string }>({
  label: "笔记",
  order: 20,
  describes: "每条笔记",
  eventType: "test_note",
  fromEvent: (p) => p as { id: string },
  list: () => [],
  toEntry: (n) => ({ key: n.id, name: n.id, status: "", group: undefined }),
});

describe("看板种类的登记表", () => {
  it("内核的两行先在；插件的按 order 插在中间；撤销后不在；同一类事件只能一行", () => {
    const kinds = new BoardKindRegistry();
    expect(kinds.list().map((k) => k.label)).toEqual(["任务", "定时触发的任务"]);
    expect(boardEmptyText(kinds)).toBe("看板是空的：没有任务、定时触发的任务。");
    const undo = kinds.register(notes);
    expect(kinds.list().map((k) => k.label)).toEqual(["任务", "笔记", "定时触发的任务"]);
    expect(boardEmptyText(kinds)).toBe("看板是空的：没有任务、笔记、定时触发的任务。");
    expect(boardToolDescription(kinds)).toMatch(/^查看任务看板的现状：每个任务（.*）、每条笔记、每个定时触发的任务（/);
    expect(() => kinds.register({ ...notes, eventType: EVENT_TYPES.task })).toThrow(/已经登记过了/);
    undo();
    expect(kinds.list().map((k) => k.label)).toEqual(["任务", "定时触发的任务"]);
  });
});
