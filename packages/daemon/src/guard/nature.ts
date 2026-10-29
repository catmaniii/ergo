// 一次工具调用做了什么性质的事：只看、动手、删改（54 号票，用户 2026-10-09 定：由守护进程判定，记在每次工具调用上；
// 同一天又定删除和修改合成一类"删改"，按"动没动原来就有的东西"分）。
// 会话缩小之后，工具调用的色块按它分深浅——只看浅绿、动手绿、最重的一档绿加一圈红。
// 最重的一档是删改，不只是删除：局部改已有的文件、整个覆盖、移动或改名、强推都在里面（用户定）。
// 二狗的守卫知道得更多，按这次判定实际要判的调用（judgement.calls：通用 bash 已拆成伪工具调用）一条条看，取最重的：
// - 删改：改了或去掉了原有的东西——
//   · 时序规则里 $current.paths[].replaced 为真的路径（rule-steps.ts）：删除、移动或改名的源、带"删除或覆盖"标签的工具
//     （丢弃 git 改动：reset --hard、checkout -- 文件、restore、clean、stash drop）、整体重写一个已有的文件；
//   · 局部改（edit）一个已有的文件，只往末尾追加的（bash 的 >>、tee -a，带 append）除外；
//   · 给了工具登记的 modifiesWith 参数的（强推的 force、删远端分支的 delete、commit --amend 的 amend、增减 skill 的 remove）；
//   · 工具登记成删改的（tool-registry.ts 的 nature: "modify"：改写 git 历史或删改分支、标签——reset 到别的提交、rebase、
//     branch -D / -m、tag -d，54 号票评审补上，拆分在 shell/programs.ts；改提醒、取消提醒、自行调整计划、整份换掉进展）。
//   文件在不在看判定时现取的环境事实（guard-runtime/facts.ts，执行之前取的）；查不清的按新建算，是动手；
// - 只看：工具登记成只看的（nature: "look"：读文件、列目录、搜索、查找、git 状态和差异、查看板、读项目档案……）、
//   只读的 HTTP 请求（isReadOnlyRequest），或者通用 bash 里只看的命令拆成的"其他命令"（shell/programs.ts 的
//   READ_ONLY_COMMANDS）；并且没有写或删的路径、没带往外送的数据；
// - 其余都是动手：只新增、不碰已有的——新建文件、追加写、建目录、提交、不强推的推送、发消息、跑测试或构建、装依赖、
//   跑脚本，以及拆不开的命令、不认识的工具。
// 被拦下、没执行的调用这里照样按"要做的是什么"记；界面上按只看画（Web 的 state/tool-nature.ts）。
// 纯函数，不参与判定；守护进程在追加工具调用记录时调（guard-runtime/tool-call-record.ts），写进工具调用 part 的 nature。
import { ruleStep, type RulePath, type RuleView } from "./rule-steps.ts";
import { READ_ONLY_COMMANDS } from "./shell/programs.ts";
import { carriesPayload, findTool, isReadOnlyRequest, sendsOut, TOOL } from "./tool-registry.ts";
import type { GuardInput, GuardJudgement, JudgedCall } from "./types.ts";
import { agentShellEnv } from "./paths.ts";

/** 只看、动手、删改（和协议包的 TOOL_NATURES 一致） */
export const TOOL_NATURES = ["look", "act", "modify"] as const;
export type ToolNature = (typeof TOOL_NATURES)[number];

/** 这次调用的性质：判定里实际要判的调用里最重的（删改 > 动手 > 只看）；一条都没有时算动手 */
export function toolNature(input: GuardInput, judgement: GuardJudgement): ToolNature {
  if (judgement.calls.length === 0) return "act";
  const view: RuleView = { tools: input.tools, env: agentShellEnv(input.agent, input.places.homeDir), agent: input.agent, facts: input.facts };
  let out: ToolNature = "look";
  for (const [i, call] of judgement.calls.entries()) {
    const nature = callNature(view, call, i);
    if (nature === "modify") return "modify";
    if (nature === "act") out = "act";
  }
  return out;
}

function callNature(view: RuleView, call: JudgedCall, i: number): ToolNature {
  const tool = findTool(view.tools, call.tool);
  if (!tool) return "act";
  const step = ruleStep(view, { id: `n${i + 1}`, tool: call.tool, args: call.args });
  const paths = step.paths as RulePath[];
  if (paths.some((p) => p.replaced === true)) return "modify";
  if (call.tool === TOOL.edit && step.args.append !== true && paths.some((p) => p.exists === true)) return "modify";
  if (tool.nature === "modify" || (tool.modifiesWith ?? []).some((arg) => given(step.args[arg]))) return "modify";
  // 通用 bash 里不在程序表的命令（和只读命令没有操作数时）拆成"其他命令"：它的路径不知道读还是写，只看程序是不是只看的
  if (call.tool === TOOL.shell_command) return typeof step.args.program === "string" && READ_ONLY_COMMANDS.includes(step.args.program) ? "look" : "act";
  if (paths.some((p) => p.access !== "read") || carriesPayload(tool, step.args)) return "act";
  return tool.nature === "look" || isReadOnlyRequest(tool, step.args) ? "look" : "act";
}

/** 一次调用要动的是对外的事（外）还是本机的敏感权限（权），和协议包的 TOOL_CALL_MARKS 一致 */
export type ToolCallMark = "out" | "perm";

/**
 * 这次调用要动的是对外的事还是本机的敏感权限（93 号票：调用的策略标记里有
 * 敏感操作（op）的，按工具的权限种类分"外"（对外动作：下单、发消息、共享……）、"权"（敏感权限：删照片、写日历……））。
 * 二狗的敏感操作是命中了关注类别的调用（judgement.categories：花钱、对外发送、删除或覆盖、不可逆的提交、账户与安全、越出项目目录……）；
 * "对外"只有一个口径：这次判定实际要判的调用里有一条往外送（守卫的 sendsOut，和计划卡授权说法的 outward、重做前列出的"对外"同一个）。
 * 没命中类别的没有。被拦下、没执行的照"要做的事"记（界面只标放行执行完的）。
 * 纯函数，不参与判定；守护进程追加工具调用记录时调，写进工具调用 part 的 mark
 */
export function toolCallMark(input: GuardInput, judgement: GuardJudgement): ToolCallMark | undefined {
  if (judgement.categories.length === 0) return undefined;
  const outward = judgement.calls.some((call) => {
    const tool = findTool(input.tools, call.tool);
    return tool !== undefined && sendsOut(tool, call.args);
  });
  return outward ? "out" : "perm";
}

/** 参数给了：true，或者非空的数组（没法确定的不算） */
function given(value: unknown): boolean {
  return value === true || (Array.isArray(value) && value.length > 0);
}
