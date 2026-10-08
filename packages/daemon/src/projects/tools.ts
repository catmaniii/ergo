// 项目的两个代为执行的工具（规格第 7、11 节）：
// - 秘书的 suggest_project：只产生一张"建议立项"卡（名字、一句话目标），不建项目；用户点"立项"才诞生。
//   用户在消息里明说要立项、或者点了"新建项目"时，秘书不判断"是不是项目"，直接用它收口；
// - 项目维护者的 submit_charter：立项问答的结论（范围、目标、首版程度、项目类型、是否绑定外部工作目录）和提议的工具包，
//   运行时据此生成立项书卡放进待我处理。工具绑定在一个项目上：维护者只能给它维护的那个项目交。
// 两个都只产生卡片，不落入任何关注类别。
import { Charter, PROJECT_GOAL_MAX, PROJECT_NAME_MAX, toolkitBashWording, Type } from "@ergou/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { RequestRejected } from "../errors.ts";
import type { ProjectService } from "./projects.ts";
import { SUBMIT_CHARTER_TOOL, SUGGEST_PROJECT_TOOL } from "./tool-names.ts";

const SuggestProjectParams = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX, description: "项目名（短）" }),
    goal: Type.String({ minLength: 1, maxLength: PROJECT_GOAL_MAX, description: "一句话目标" }),
  },
  { additionalProperties: false },
);

const SubmitCharterParams = Type.Object(
  {
    ...Charter.properties,
    toolkit: Type.Optional(
      Type.Object(
        {
          skills: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "要用的 skill" })),
          mcp: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "要用的 MCP" })),
          bash: Type.Optional(Type.Boolean({ description: "能不能用 bash；不写时开发类默认带，其他默认不带" })),
          network: Type.Optional(Type.Boolean({ description: "能不能联网；不写默认不联网" })),
        },
        { additionalProperties: false, description: "提议的工具包" },
      ),
    ),
  },
  { additionalProperties: false },
);

/** 秘书的"建议立项" */
export function suggestProjectTool(cards: CardService): HostTool {
  return defineHostTool({
    name: SUGGEST_PROJECT_TOOL,
    title: "建议立项",
    description:
      "一件事更像一个要长期用、长期维护的功能模块时，给用户一张“建议立项”卡（名字、一句话目标）。它不建项目：用户点卡上的“立项”项目才诞生，维护者随之产生，接着和用户做立项问答。用户明说要立项、或者点了“新建项目”时，不用判断是不是项目，直接用它收口。",
    parameters: SuggestProjectParams,
    readOnlyOrIdempotent: false,
    run: (args) => {
      const card = cards.create({ type: "suggest_project", payload: { name: args.name, goal: args.goal } });
      return { text: "已在聊天里放了一张“建议立项”卡（项目还没建）。用户点“立项”项目才诞生，到时你会收到通知；立项问答由项目的维护者做。", cardIds: [card.id] };
    },
  });
}

/** 项目维护者的"提交立项书" */
export function submitCharterTool(projects: ProjectService, scope: { projectId: string; maintainerId: string }): HostTool {
  return defineHostTool({
    name: SUBMIT_CHARTER_TOOL,
    title: "提交立项书",
    description:
      "立项问答问清之后，把立项书（范围、目标、首版要做到什么程度、项目类型、是否把工作目录绑定到一个外部路径）和你提议的工具包以结构化数据交出。运行时据此生成立项书卡放进用户的待我处理；用户确认（确认并开工，或只确认、稍后开工）时项目类型、工作目录、工具包就生效。再交一次会换掉上一版。",
    parameters: SubmitCharterParams,
    readOnlyOrIdempotent: false,
    run(args) {
      const { toolkit, ...charter } = args;
      try {
        const { cardId, revision, toolkit: proposed } = projects.submitCharter(scope.projectId, scope.maintainerId, { charter, ...(toolkit === undefined ? {} : { toolkit }) });
        return {
          text: `立项书已提交（第 ${revision} 版，提议的${toolkitBashWording(proposed.bash)}），立项书卡放进了用户的待我处理。用户确认之前项目留在筹备中；用户有意见会直接和你说。`,
          cardIds: [cardId],
        };
      } catch (err) {
        if (err instanceof RequestRejected) return { text: err.message, isError: true };
        throw err;
      }
    },
  });
}
