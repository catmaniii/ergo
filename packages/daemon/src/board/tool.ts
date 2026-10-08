// 秘书的"查看板"工具（规格第 7 节"只读工具"，22 号票）：任务看板的当前内容（看板种类表 kinds.ts 里的各种东西），
// 按看板的五组列出。只读，不落入任何关注类别。说进展时以它为准，不靠对话记忆。
import { Type } from "@ergou/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { EventStore } from "../events/event-store.ts";
import { boardText } from "./board.ts";
import { BOARD_EMPTY_TEXT, BOARD_TOOL_DESCRIPTION, currentBoard } from "./kinds.ts";
import { VIEW_BOARD_TOOL } from "./tool-names.ts";

export function viewBoardTool(store: EventStore): HostTool {
  return defineHostTool({
    name: VIEW_BOARD_TOOL,
    title: "查看板",
    description: BOARD_TOOL_DESCRIPTION,
    parameters: Type.Object({}, { additionalProperties: false }),
    readOnlyOrIdempotent: true,
    run: () => ({ text: boardText(currentBoard(store), BOARD_EMPTY_TEXT) }),
  });
}
