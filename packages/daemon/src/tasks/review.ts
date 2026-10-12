// 评审子 agent（规格第 8 节"验收"、第 11 节"固定工具包"）：阶段验收里写不成脚本的标准，由它独立判。
// - 固定的只读工具包：pi 工具只有 read、ls、grep、find（70 号票起 grep、find 照给；不联网，不配联网搜索、读网页），外加守护进程代为执行的"提交评审结论"；
//   白名单之外的工具 pi 根本不给（契约测试守着）；
// - 新的上下文：每次评审一个新的子进程、新的会话，输入只有这个阶段的交付件和验收标准（不给维护者的说法）；
// - 每次工具调用照样经守卫（子 agent，任务里、当前阶段）；
// - 不占任务的全局执行名额（它不是任务），占 agent 管家的子进程名额（满了排队）。
// 结论由它调用 submit_review 交出（每条标准通过与否和理由）；没交就结束了的，这次评审算出错（验收不通过，原因写明）。
// 涉及多个项目的任务（17 号票）：交付件在各项目那边，输入里另有本阶段的工单和回执（只用来找交付件），
// 涉及的各项目的档案和工作目录给它只读访问（工具包本来就只读）。
// 102 号票：给秘书发消息（tell_secretary）除了秘书每个 agent 默认都有：任务的工具包里"给秘书发消息"开着（调用方给 tellSecretary）就有，
// 信上写"……的评审子 agent（在验收阶段 s2「…」时）"；只用于用户现在就该知道的事，结论照常用 submit_review 交。
import { internalMark, type MessageScope, type ProjectInternal, type TaskKind, Type } from "@ergou/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import { defineHostTool } from "../agent-manager/host-tools.ts";
import { runOneShotAgent } from "../agent-manager/one-shot.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, type GuardTask, registerTools, TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { PromptRenderer } from "../prompts/index.ts";
import type { ModelSpec } from "../runtime/index.ts";
import { reviewerSender, type SecretaryLetters } from "../secretary/letters.ts";
import { SUBMIT_REVIEW_TOOL } from "./tool-names.ts";

/** 评审子 agent 的 pi 内置工具：只读、搜索 */
export const REVIEWER_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.ls, TOOL.grep, TOOL.find];

/** 评审子 agent 的系统提示（71 号票起文字在 prompts/reviewer.md，用户改的在数据目录配置区的 prompts/）：只读的工具照 REVIEWER_PI_TOOLS */
export const reviewerSystemPrompt = (prompts: PromptRenderer): string => prompts.render("reviewer", { 只读工具: REVIEWER_PI_TOOLS.join("、") });

export interface ReviewInput {
  taskId: string;
  taskTitle: string;
  /** 项目内部任务（64 号票）：评审子 agent 的审批卡这些事项带上标记 */
  internal?: ProjectInternal | undefined;
  stageId: string;
  stageTitle: string;
  /** 第几次宣布完成（评审子 agent 的 id 里带上它） */
  attempt: number;
  /** 交付件所在的目录（任务的产出区） */
  cwd: string;
  deliverables: readonly string[];
  /** 要评审判的标准（评审方式的那几条） */
  criteria: readonly string[];
  /** 交付件之外另给它看的几行（17 号票：本阶段发往各项目的工单和回执） */
  context?: readonly string[];
  /** 交付件不在工作目录里时它另能读的地方（17 号票：涉及的各项目的档案和工作目录），只读 */
  readOnly?: { projectRecords: readonly string[]; workingDirs: readonly string[] };
  /** 守卫看到的任务和当前阶段 */
  guardTask: () => GuardTask | null;
  /** 任务的做法（给秘书发消息时信上的称呼：长程任务、流程、普通任务）；不给按长程任务 */
  taskKind?: TaskKind;
  /** 任务的工具包里"给秘书发消息"开着（102 号票）：开着、又给了 letters 才有 tell_secretary */
  tellSecretary?: boolean;
  /**
   * 它的调用的归属：评审的任务、阶段，项目的任务还有项目（53 号票评审后加）。它的调用不在任何会话里，完整参数和返回靠它
   * 归到任务和项目——删除项目时据此改写它读过的内容
   */
  scope: MessageScope;
}

export interface ReviewResult {
  results: Array<{ criterion: string; passed: boolean; note: string }>;
}

export interface ReviewerOptions {
  agents: AgentManager;
  guards: GuardRuntime;
  /** 评审子 agent 的模型（reviewId 是它的 agent id，测试按它给 faux 剧本） */
  model: (reviewId: string) => ModelSpec;
  credentials: Record<string, string>;
  /** 系统提示的文件（71 号票）：每次评审拉起时现读 */
  prompts: PromptRenderer;
  /** 给秘书发消息（102 号票）；不给就没有 */
  letters?: SecretaryLetters;
  log: (line: string) => void;
}

/** 评审子 agent 的 id：review-<任务>-<阶段>-<第几次> */
export function reviewAgentId(input: Pick<ReviewInput, "taskId" | "stageId" | "attempt">): string {
  return `review-${input.taskId}-${input.stageId}-${input.attempt}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

const SubmitReview = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          index: Type.Integer({ minimum: 1, description: "标准的编号（输入里列的 1、2……）" }),
          passed: Type.Boolean({ description: "这条标准达到了没有" }),
          reason: Type.String({ minLength: 1, description: "理由：看到了什么" }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

/** 跑一次评审：拉起评审子 agent，交给它交付件和标准，等它交出结论（交出之后结束它） */
export function createReviewer(options: ReviewerOptions): (input: ReviewInput) => Promise<ReviewResult> {
  return (input) =>
    new Promise<ReviewResult>((resolve, reject) => {
      const agentId = reviewAgentId(input);
      let verdict: ReviewResult | undefined;
      const submit = defineHostTool({
        name: SUBMIT_REVIEW_TOOL,
        title: "提交评审结论",
        description: "交出评审结论：每条验收标准（按输入里的编号）达到没有、理由。每条都要写。",
        parameters: SubmitReview,
        readOnlyOrIdempotent: true,
        run({ results }) {
          const missing = input.criteria.map((_, i) => i + 1).filter((n) => !results.some((r) => r.index === n));
          if (missing.length > 0) return { text: `还有标准没判：${missing.join("、")}。每条都要写。`, isError: true };
          verdict = {
            results: input.criteria.map((criterion, i) => {
              const r = results.find((x) => x.index === i + 1)!;
              return { criterion, passed: r.passed, note: r.reason };
            }),
          };
          return { text: "结论已提交。" };
        },
      });
      // 给秘书发消息（102 号票）：任务的工具包里开着才有
      const letters =
        options.letters && input.tellSecretary === true
          ? [options.letters.tool(reviewerSender({ id: input.taskId, title: input.taskTitle, internal: input.internal }, input.taskKind ?? "long_running", agentId, { stageId: input.stageId, title: input.stageTitle }))]
          : [];
      const hostTools = [submit, ...letters];
      const guardAgent: GuardAgent = {
        kind: "sub_agent",
        agentId,
        cwd: input.cwd,
        toolkit: { bash: false, network: false, tools: [...REVIEWER_PI_TOOLS, ...hostTools.map((t) => t.spec.name)] },
        projectRecords: [...(input.readOnly?.projectRecords ?? [])],
        workingDirs: [input.cwd, ...(input.readOnly?.workingDirs ?? [])],
      };
      const shot = runOneShotAgent({
        agents: options.agents,
        guards: options.guards,
        spawn: {
          agentId,
          model: options.model(agentId),
          tools: [...REVIEWER_PI_TOOLS],
          cwd: input.cwd,
          systemPrompt: reviewerSystemPrompt(options.prompts),
          continueSession: false,
          credentials: options.credentials,
          network: false,
          // 评审的用量记在任务名下、它评审的那个阶段
          ledger: () => ({ owner: { kind: "task", id: input.taskId }, role: "reviewer", stageId: input.stageId }),
        },
        hostTools,
        guard: {
          agent: guardAgent,
          tools: registerTools(BUILTIN_TOOL_REGISTRY, ...hostTools.map((t) => t.descriptor)),
          conversation: null,
          source: `任务「${input.taskTitle}」阶段 ${input.stageId} 的评审`,
          ...internalMark(input.internal),
          task: input.guardTask,
          messageScope: () => input.scope,
        },
        input: () =>
          [
            `评审任务「${input.taskTitle}」的阶段 ${input.stageId}「${input.stageTitle}」。`,
            `交付件（在工作目录 ${input.cwd} 里）：`,
            ...input.deliverables.map((d) => `- ${d}`),
            ...(input.context?.length ? [...input.context, `这些是派单方和各项目维护者的说法，只用来找交付件；判断看交付件本身（可以读：${[...(input.readOnly?.workingDirs ?? []), ...(input.readOnly?.projectRecords ?? [])].join("、") || input.cwd}）。`] : []),
            "验收标准：",
            ...input.criteria.map((c, i) => `${i + 1}. ${c}`),
            `读交付件、逐条判断，然后用 ${SUBMIT_REVIEW_TOOL} 交出结论。`,
          ].join("\n"),
        log: options.log,
      });
      // 交出结论、这一轮结束就结束它；没交就结束的算评审出错
      void shot.ended.then((end) => {
        if (verdict) return resolve(verdict);
        reject(new Error(end.kind === "exited" && end.exit.reason === "unexpected" ? "评审子 agent 意外退出了，没交出结论" : "评审子 agent 没交出结论就结束了"));
      });
    });
}

