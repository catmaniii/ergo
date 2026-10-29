// 维护者执行任务时的"提议并行"工具（守护进程代为执行，20 号票）：绑定在一个任务上。
// 只产生一张并行确认卡（不落入任何关注类别，照样先经守卫）；用户确认之前不拉起任何子 agent，维护者照常按顺序做。
// @i18n-ignore-file model：工具的说明、参数说明和结果给维护者（模型）看（174 号票）；工具的名字走 t()
import { t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { RequestRejected } from "../errors.ts";
import { TOOL } from "../guard/index.ts";
import type { MaintainerScope } from "../tasks/execution.ts";
import { PROPOSE_PARALLEL_TOOL } from "../tasks/tool-names.ts";
import type { SubAgents } from "./sub-agents.ts";
import { proposeResultText } from "./texts.ts";

const ProposeParallel = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 1000, description: "为什么能并行：这几个阶段（或步骤）互不依赖，同时做省多少事" }),
    agents: Type.Array(
      Type.Object(
        {
          stageId: Type.String({ minLength: 1, description: "这个子 agent 做的阶段 id（正在做或能开始的：前置阶段都验收了）" }),
          step: Type.Optional(Type.String({ minLength: 1, description: "定步阶段里交给它的那一步（只并行几步时写，照计划里的步骤原样写）" })),
          instructions: Type.String({ minLength: 1, maxLength: 4000, description: "给它的工作说明：做什么、交付什么、注意什么（它只看得到这段话、阶段的交付件和授权）" }),
          workDir: Type.Optional(
            Type.String({ minLength: 1, description: "它干活的目录：开发类写你在工作目录里为它建好的 git worktree（相对工作目录或绝对路径）；不写就和你在同一个工作目录里" }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 8, description: "要派的子 agent，每个一项" },
    ),
  },
  { additionalProperties: false },
);

export function proposeParallelTool(subAgents: Pick<SubAgents, "propose">, scope: MaintainerScope): HostTool {
  return defineHostTool({
    name: PROPOSE_PARALLEL_TOOL,
    title: t("subAgents.tool.propose"),
    description: [
      "阶段图里有可以同时做的阶段（互不依赖、前置阶段都验收了）或一个定步阶段里互不依赖的几步时，提议派子 agent 同时做。",
      "运行时生成一张并行确认卡放进用户的待我处理；只有用户同意才真正拉起子 agent，用户不同意（或还没处理）就照常一件一件做。",
      "每个子 agent 占一个子进程，工具包和授权不超过你，不能写项目档案，做完即解散，结果作为一条消息回到你的会话里。",
      `开发类（项目按立项书的项目类型；不属于项目的任务看工作目录是不是 git 仓库）：必须先在工作目录里为每个子 agent 各建一个 git worktree（${TOOL.bash}：git worktree add <目录> -b <分支>），写进 workDir，彼此不重叠；` +
        `它们各自提交，结果回来后你用 ${TOOL.git_merge} 合并。`,
    ].join(""),
    parameters: ProposeParallel,
    readOnlyOrIdempotent: false,
    run: (input) => {
      try {
        const result = subAgents.propose(scope, input);
        return { text: proposeResultText(result), cardIds: [result.cardId] };
      } catch (err) {
        if (err instanceof RequestRejected) return { text: `没提出并行：${err.message}`, isError: true };
        throw err;
      }
    },
  });
}
