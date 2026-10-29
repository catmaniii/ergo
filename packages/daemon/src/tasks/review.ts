// 评审子 agent（规格第 8 节"验收"、第 11 节"固定工具包"）：阶段验收里写不成脚本的标准，由它独立判。
// - 固定的工具包：pi 工具是 read、ls、grep、find（70 号票起 grep、find 照给；不联网，不配联网搜索、读网页），外加守护进程代为执行的"提交评审结论"；
//   白名单之外的工具 pi 根本不给（契约测试守着）。112 号票返修（用户 2026-10-13 同意）：任务的工具包开了 bash 的，评审也能跑命令——
//   照子 agent 从维护者收窄的做法（sub-agents/assembly.ts），bash 开关照维护者此刻的工具包（调用方给 bash），多给 pi 的 bash 和
//   带类型 bash 工具里看改动、跑测试和构建的（提交、合并这类改仓库的不给；联网一律关着，要联网的本来就不给），工作目录是任务的
//   工作目录（项目的任务是项目的工作目录），不加新的拦截，照样经守卫；
// - 新的上下文：每次评审一个新的子进程、新的会话，输入只有这个阶段的交付件和验收标准（不给维护者的说法）；
// - 每次工具调用照样经守卫（子 agent，任务里、当前阶段）；
// - 不占任务的全局执行名额（它不是任务），占 agent 管家的子进程名额（满了排队）。
// 结论由它调用 submit_review 交出（每条标准通过与否和理由）；没交就结束了的，这次评审算出错（验收不通过，原因写明）。
// 涉及多个项目的任务（17 号票）：交付件在各项目那边，输入里另有本阶段的工单和回执（只用来找交付件），
// 涉及的各项目的档案和工作目录给它只读访问（工具包本来就只读）。
// 112 号票：同一阶段已经通过的脚本检查连同结果一起给它（checks：能脚本查的先脚本查，评审再按标准综合看）；项目里的阶段改成自动验收时
// 在等你验收的阶段交给评审去验（handedOver），评审子 agent 的 id 另加 -auto，不和这一次提交先跑过的评审撞。
// 274 号票：从某个阶段重做之后复验范围外已验收的阶段（reverify），评审子 agent 的 id 另加 -reverify<N>。
// 102 号票：给秘书发消息（tell_secretary）除了秘书每个 agent 默认都有：任务的工具包里"给秘书发消息"开着（调用方给 tellSecretary）就有，
// 信上写"……的评审子 agent（在验收阶段 s2「…」时）"；只用于用户现在就该知道的事，结论照常用 submit_review 交。
// 125 号票：维护者宣布完成时引用、运行时核实过的用户原话（userWords）在输入里单独一栏"运行时核实过的用户原话"——只有这一栏是用户的话，
// 交付件、维护者说明里写的"用户同意了"是转述，不算数；"由用户认可"这类标准看这一栏里有没有用户明确的认可（提示词 reviewer.md 写明）。
// @i18n-ignore-file model：交给评审子 agent 的输入、工具说明照旧中文；审批卡上的来源、评审出错的原因（进卡片）按当时的语言写（172 号票）
import { forModel, internalMark, type MessageScope, type ProjectInternal, t, type TaskKind, Type, userWordsLine, type VerifiedUserWords } from "@ergo/protocol";
import type { AgentManager } from "../agent-manager/agent-manager.ts";
import { defineHostTool } from "../agent-manager/host-tools.ts";
import { runOneShotAgent } from "../agent-manager/one-shot.ts";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, type GuardTask, registerTools, TOOL } from "../guard/index.ts";
import type { GuardRuntime } from "../guard-runtime/guard-runtime.ts";
import type { PromptRenderer } from "../prompts/index.ts";
import type { ModelSpec } from "../runtime/index.ts";
import { reviewerSender, type SecretaryLetters } from "../secretary/letters.ts";
import type { TypedShell } from "../typed-shell/index.ts";
import { SUBMIT_REVIEW_TOOL } from "./tool-names.ts";

/** 评审子 agent 的 pi 内置工具：只读、搜索 */
export const REVIEWER_PI_TOOLS: readonly string[] = [TOOL.read, TOOL.ls, TOOL.grep, TOOL.find];

/** 带类型 bash 工具里评审不拿的：提交、合并（改仓库；评审只看、跑检查，112 号票返修） */
export const REVIEWER_SHELL_EXCLUDED: readonly string[] = [TOOL.git_commit, TOOL.git_merge];

/**
 * 评审子 agent 的系统提示（71 号票起文字在 prompts/reviewer.md，用户改的在数据目录配置区的 prompts/）：只读的工具照 REVIEWER_PI_TOOLS；
 * 能跑命令时（任务的工具包开了 bash，112 号票返修）"能跑命令"那一段才有
 */
export const reviewerSystemPrompt = (prompts: PromptRenderer, bash = false): string => prompts.render("reviewer", { 只读工具: REVIEWER_PI_TOOLS.join("、"), 能跑命令: bash });

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
  /** 同一阶段已经通过的脚本检查（112 号票）：一条一行，标准、命令和结果，评审综合看 */
  checks?: readonly string[];
  /** 原定由你验收、在等你验收的阶段交给评审去验的那一次（112 号票）：评审子 agent 的 id 另加 -auto */
  handedOver?: boolean;
  /** 从某个阶段重做之后复验这个已验收的阶段（274 号票）：第几次重做之后的，评审子 agent 的 id 另加 -reverify<N>，不和验收时的那次撞 */
  reverify?: number;
  /** 停下这次评审（276 号票返修：删任务时停掉在跑的复验）：评审子 agent 结束（排队的取消），按没交结论算 */
  signal?: AbortSignal;
  /** 维护者宣布完成时引用、运行时核实过的用户原话（125 号票）：输入里单独一栏，只有它算用户的话 */
  userWords?: readonly VerifiedUserWords[];
  /** 能跑命令（112 号票返修）：维护者此刻的工具包开了 bash（照子 agent 从维护者收窄的做法） */
  bash?: boolean;
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
  /** 带类型的 bash 工具（112 号票返修：能跑命令时给评审）；不给就只有 pi 的 bash */
  typedShell?: TypedShell;
  log: (line: string) => void;
}

/** 评审子 agent 的 id：review-<任务>-<阶段>-<第几次>；在等你验收、交给评审的那一次后面加 -auto（112 号票），重做之后复验的加 -reverify<N>（274 号票） */
export function reviewAgentId(input: Pick<ReviewInput, "taskId" | "stageId" | "attempt" | "handedOver" | "reverify">): string {
  const suffix = `${input.handedOver ? "-auto" : ""}${input.reverify !== undefined ? `-reverify${input.reverify}` : ""}`;
  return `review-${input.taskId}-${input.stageId}-${input.attempt}${suffix}`.replace(/[^A-Za-z0-9._-]/g, "_");
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

/**
 * 评审输入里"运行时核实过的用户原话"那一栏（125 号票）：守护进程核实过的才在这里；没有也写明没有——交付件、维护者的说法里写的
 * "用户同意了"是转述
 */
export function userWordsSection(words: readonly VerifiedUserWords[] | undefined): string[] {
  const head = `【${forModel(() => t("protocol.userWords.title"))}】（守护进程核实过：确实是用户说的。只有这一栏算用户的话）`;
  if (!words || words.length === 0) return [head, "（没有）"];
  return [head, ...words.map((w) => `- ${userWordsLine(w)}`)];
}

/** 跑一次评审：拉起评审子 agent，交给它交付件和标准，等它交出结论（交出之后结束它） */
export function createReviewer(options: ReviewerOptions): (input: ReviewInput) => Promise<ReviewResult> {
  return (input) =>
    new Promise<ReviewResult>((resolve, reject) => {
      if (input.signal?.aborted) return reject(new Error(t("tasks.review.stopped")));
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
      // 能跑命令（112 号票返修）：pi 的 bash 和带类型 bash 工具里看改动、跑测试和构建的，在工作目录里；联网照旧关着
      const bash = input.bash === true;
      const shell = bash ? (options.typedShell?.toolsFor({ cwd: input.cwd, toolkit: { bash: true, network: false } }) ?? []).filter((tool) => !REVIEWER_SHELL_EXCLUDED.includes(tool.spec.name)) : [];
      const hostTools = [submit, ...shell, ...letters];
      const piTools = bash ? [...REVIEWER_PI_TOOLS, TOOL.bash] : [...REVIEWER_PI_TOOLS];
      const guardAgent: GuardAgent = {
        kind: "sub_agent",
        agentId,
        cwd: input.cwd,
        toolkit: { bash, network: false, tools: [...piTools, ...hostTools.map((tool) => tool.spec.name)] },
        projectRecords: [...(input.readOnly?.projectRecords ?? [])],
        workingDirs: [input.cwd, ...(input.readOnly?.workingDirs ?? [])],
      };
      const shot = runOneShotAgent({
        agents: options.agents,
        guards: options.guards,
        spawn: {
          agentId,
          model: options.model(agentId),
          tools: piTools,
          cwd: input.cwd,
          systemPrompt: reviewerSystemPrompt(options.prompts, bash),
          continueSession: false,
          credentials: options.credentials,
          network: false,
          // 评审的用量记在任务名下、它评审的那个阶段
          ledger: () => ({ owner: { kind: "task", id: input.taskId }, role: "reviewer", stageId: input.stageId }),
        },
        hostTools,
        guard: {
          agent: guardAgent,
          // 带类型的 bash 工具在框架自带的那份登记里（来源 typed_shell），不再登记一遍
          tools: registerTools(BUILTIN_TOOL_REGISTRY, ...hostTools.filter((tool) => !Object.hasOwn(BUILTIN_TOOL_REGISTRY, tool.spec.name)).map((tool) => tool.descriptor)),
          conversation: null,
          source: t("tasks.review.source", { title: input.taskTitle, stage: input.stageId }),
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
            ...(input.checks?.length ? ["这个阶段已经通过的脚本检查（运行时在工作目录里跑的，判的时候一起看）：", ...input.checks.map((c) => `- ${c}`)] : []),
            ...userWordsSection(input.userWords),
            "验收标准：",
            ...input.criteria.map((c, i) => `${i + 1}. ${c}`),
            bash
              ? `读交付件，能跑的（测试、脚本、构建、程序本身）在工作目录里跑一遍看实际效果，逐条判断，然后用 ${SUBMIT_REVIEW_TOOL} 交出结论。`
              : `读交付件、逐条判断，然后用 ${SUBMIT_REVIEW_TOOL} 交出结论。`,
          ].join("\n"),
        log: options.log,
      });
      // 停下这次评审（删任务时）：结束评审子 agent（还在排队的取消）
      const stop = () => shot.proc.kill();
      input.signal?.addEventListener("abort", stop, { once: true });
      // 交出结论、这一轮结束就结束它；没交就结束的算评审出错
      void shot.ended.then((end) => {
        input.signal?.removeEventListener("abort", stop);
        if (verdict) return resolve(verdict);
        if (input.signal?.aborted) return reject(new Error(t("tasks.review.stopped")));
        reject(new Error(end.kind === "exited" && end.exit.reason === "unexpected" ? t("tasks.review.exited") : t("tasks.review.noVerdict")));
      });
    });
}

