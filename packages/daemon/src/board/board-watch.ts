// 秘书的看板感知（规格第 7 节"看板变化消息"，22 号票）：秘书掌握任务靠看板，不靠对话记忆。
// - 现在的看板：看板种类表（kinds.ts）里各种东西的派生视图（和看板频道推给前端的是同一批事件归并出来的）；
// - "上次看到的样子"：上一条交到秘书手里的用户消息开始处理（turn_start）那一刻的看板。交给秘书下一条用户消息时，
//   两者有差别（新出现的、状态变了的、换了阶段的）就写成一条"看板变化"上下文消息，跟在这条用户消息后面
//   （宿主协议的 user_input.context），系统提示不动；没变就不加。运行时给秘书的通知（系统消息）不带，变化攒到下一条用户消息
//   （任务做完另有马上给的通知，secretary/task-done.ts，99 号票；做完的那一行下一条用户消息时照旧再报一次）；
// - 重启后、秘书子进程崩溃后对一遍（resync）：从事件日志找最后一条处理完的用户消息的 turn_start，把那之前的看板事件
//   归并成"上次看到的样子"（处理到一半被打断的那条没交到秘书手里，它带的变化下次再说）。被打断的那条可能已经连同
//   看板变化进了秘书的会话文件，这时下一条会把同样的变化再报一次：宁可重报，不能丢。
// 待我处理不在这里：新增事项不进秘书的模型输入（不主动转述）。
import { CHANNELS, type ConversationId, EVENT_TYPES, type TurnEndEventPayload, type TurnStartEventPayload } from "@ergou/protocol";
import { getMessage } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { type BoardEntry, type BoardSnapshot, boardChanges } from "./board.ts";
import { currentBoard, entryOfEvent } from "./kinds.ts";
import { VIEW_BOARD_TOOL } from "./tool-names.ts";

/** 看板变化消息的开头（秘书的系统提示里说明它） */
export const BOARD_CHANGE_TAG = "【看板变化】";

export interface BoardWatch {
  /** 交给秘书一条用户消息之前：自上次以来的变化写成一条上下文消息（没变化是 undefined），并记下这次看到的样子 */
  changesForInput(): string | undefined;
  /** 从事件日志重新对一遍"上次看到的样子"（启动时、子进程意外退出后） */
  resync(): void;
}

/** 看板变化消息的正文 */
export function boardChangeText(lines: readonly string[]): string {
  return [`${BOARD_CHANGE_TAG}自你上次收到用户的消息以来，任务看板上有这些变化（运行时附上的，不是用户说的；要看全貌用 ${VIEW_BOARD_TOOL}）：`, ...lines].join("\n");
}

export function createBoardWatch(options: { store: EventStore; conversation: ConversationId }): BoardWatch {
  const { store, conversation } = options;
  let seen: BoardSnapshot = new Map();

  /** 最后一条处理完（不是被打断）的用户消息开始处理时的全局序号；没有是 undefined */
  const lastSeenAt = (): number | undefined => {
    const ended = new Map(store.read(conversation, 0, EVENT_TYPES.turnEnd).map((e) => [(e.payload as TurnEndEventPayload).inputMessageId, (e.payload as TurnEndEventPayload).outcome]));
    const starts = store.read(conversation, 0, EVENT_TYPES.turnStart);
    for (let i = starts.length - 1; i >= 0; i--) {
      const start = starts[i]!;
      const id = (start.payload as TurnStartEventPayload).inputMessageId;
      const outcome = ended.get(id);
      if (outcome === undefined || outcome === "interrupted") continue;
      // 彻底删除过的消息找不到了：只有用户消息会被整条删掉，当它是用户消息
      const speaker = getMessage(store.reader, id)?.speaker ?? "user";
      if (speaker === "user") return start.globalSeq;
    }
    return undefined;
  };

  return {
    changesForInput() {
      const now = currentBoard(store);
      const lines = boardChanges(seen, now);
      seen = now;
      return lines.length > 0 ? boardChangeText(lines) : undefined;
    },
    resync() {
      const before = lastSeenAt();
      const entries = new Map<string, BoardEntry>();
      if (before !== undefined) {
        for (const event of store.read(CHANNELS.board, 0)) {
          if (event.globalSeq >= before) break;
          const entry = entryOfEvent(event);
          if (entry) entries.set(entry.key, entry);
        }
      }
      seen = entries;
    },
  };
}
