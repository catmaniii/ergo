// 秘书的"查看板"工具（规格第 7 节"只读工具"，22 号票）：任务看板的当前内容（看板种类表 kinds.ts 里的各种东西），
// 按看板的五组列出；项目内部任务不上看板，只列每个项目里进行中的有几个（64 号票；141 号票起运营方案建的那几条例外，列在看板上、写明属于哪个项目）。
// 只读，不落入任何关注类别。说进展时以它为准，不靠对话记忆。
// 看板上有哪几种按登记表现取（126 号票：停用的插件那一种不在）；工具的说明按建工具时登记着的那几种写。
// 133 号票起后面多一节（extra）：项目的服务在不在线、入口（project-services/secretary-tool.ts 的 serviceBoardSection）。
import { t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { EventStore } from "../events/event-store.ts";
import { boardToolDescription, type BoardKinds, boardToolText } from "./kinds.ts";
import { VIEW_BOARD_TOOL } from "./tool-names.ts";

export function viewBoardTool(store: EventStore, kinds: BoardKinds, extra?: () => string | undefined): HostTool {
  return defineHostTool({
    name: VIEW_BOARD_TOOL,
    title: t("board.tool.viewBoard"),
    description: boardToolDescription(kinds),
    parameters: Type.Object({}, { additionalProperties: false }),
    readOnlyOrIdempotent: true,
    nature: "look",
    run: () => ({ text: [boardToolText(store, kinds), extra?.()].filter(Boolean).join("\n\n") }),
  });
}
