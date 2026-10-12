// 系统提示的清单（71 号票）：有哪些提示文件（默认的在本包的 prompts/<编号>.md，用户改的在数据目录配置区的 prompts/<编号>.md）、
// 给人看的名字和说明、各能用哪些占位符和片段。占位符的写法和检查在共享协议包（system-prompts.ts），读文件、存文件在 library.ts。
//
// 占位符分两种来源：
// - 公用的（commonPlaceholders）：工具名（占位符的名字就是工具名本身，比如 {{view_board}}）和几个运行时的标记、命令，
//   值是代码里的常量，每份提示都能用（前缀除外）。改了工具名，旧的占位符就不认得了，启动时报清楚是哪个文件哪一行；
// - 各提示自己的（values、flags）：名字、项目的事实、阈值里的数字、条件……由装配这个 agent 的模块填（各模块的 system-prompt.ts）。
//   有的值只在某个条件成立时才有（onlyWhen，比如项目类型只在立项书确认之后才有）：写在那个条件外面的，保存和启动检查时就拦下。
// 占位符的名字用中文（拉回次数、立项书已确认……）：这些文件是给用户看、给用户改的，是"标识符用英文"的例外（docs/dev.md）。
// 片段（partials）插进来时用插它的那份提示的值，所以片段能用的占位符必须是每个插它的提示都有的（checkPromptRegistry 查）。
import { ASSISTANT_NAME_MARK, isPromptPlaceholderName, type SystemPromptGroup } from "@ergou/protocol";
import { VIEW_BOARD_TOOL } from "../board/tool-names.ts";
import { BOARD_CHANGE_TAG } from "../board/board-watch.ts";
import { SYSTEM_NOTICE_TAG } from "../conversation/messages.ts";
import { BUILTIN_TOOL_REGISTRY, CORRECTION_PREFIX, PROJECT_HISTORY_DIR, TOOL, workflowStepTools } from "../guard/index.ts";
import { INBOX_TOOL } from "../inbox/tool-names.ts";
import { SUBMIT_PLAN_TOOL } from "../maintainers/tools.ts";
import { READ_ATTACHMENT_TOOL, SEND_ATTACHMENT_TOOL } from "../media/tool-names.ts";
import { SEARCH_MATERIALS } from "../memory/tool-names.ts";
import { READ_PROJECT_RECORDS_TOOL, SUBMIT_CHARTER_TOOL, SUGGEST_PROJECT_TOOL } from "../projects/tool-names.ts";
import { PROPOSE_QUICK_ACTION } from "../quick-actions/tool.ts";
import { REMINDER_TOOL } from "../reminders/tool-names.ts";
import { JOB_TOOL } from "../scheduled-jobs/tool-names.ts";
import { AUTO_ANNOUNCE_TAG, TASK_DONE_TAG } from "../secretary/notice-tags.ts";
import { LAUNCH_COMMANDS } from "../tasks/launch-intent.ts";
import { TASK_CONTROL_ACTION, TASK_RUN_ACTION } from "../tasks/task-control.ts";
import { EXECUTION_TOOL, PROPOSE_PARALLEL_TOOL, SUBMIT_REVIEW_TOOL, TASK_TOOL, WORKFLOW_TOOL } from "../tasks/tool-names.ts";
import { ADJUST_SKILLS_TOOL, REQUEST_TOOLKIT_CHANGE_TOOL } from "../toolkit/tool-names.ts";
import { SEND_VOICE_TOOL } from "../voice/texts.ts";
import { MULTI_PROJECT_TOOL, WORK_ORDER_TOOL } from "../work-orders/tool-names.ts";

/** 一个填值占位符的说明；只在某个条件成立时才有值的，另写那个条件（onlyWhen） */
export type PromptValueSpec = string | { readonly description: string; readonly onlyWhen: string };

/** 填值占位符的说明文字 */
export const valueDescription = (spec: PromptValueSpec): string => (typeof spec === "string" ? spec : spec.description);

/** 只在哪个条件成立时才有值（总有值的是 undefined） */
export const valueOnlyWhen = (spec: PromptValueSpec): string | undefined => (typeof spec === "string" ? undefined : spec.onlyWhen);

/** 一份提示的定义 */
export interface PromptDefinition {
  /** 给人看的名字（说到秘书的写名字占位，前端换成用户起的名字） */
  readonly title: string;
  /** 一句说明：用在哪、什么时候生效 */
  readonly description: string;
  readonly group: SystemPromptGroup;
  /** 这份提示自己的填值占位符：名字 → 说明（只在某个条件成立时才有值的，写成 { description, onlyWhen: 条件 }） */
  readonly values: Readonly<Record<string, PromptValueSpec>>;
  /** 条件：名字 → 什么时候成立 */
  readonly flags: Readonly<Record<string, string>>;
  /** 能插的片段（提示的编号） */
  readonly partials: readonly PromptId[];
  /** 能不能用公用的占位符（工具名、标记）；前缀不能 */
  readonly common: boolean;
  /** 能不能是空的 */
  readonly allowEmpty: boolean;
}

/** 阈值那一段的占位符（14 号票：数字照配置 tasks.thresholds，不写死）：插了阈值片段的提示都要有 */
const THRESHOLD_VALUES = {
  拉回次数: "被拉回（按规则退回）几次后再犯就停下（配置 tasks.thresholds.pullBacks）",
  停滞分钟: "多少分钟没进展算停滞（stallMinutes）",
  催促次数: "同一次停滞里催几次（nudges）",
  验收退回次数: "阶段验收退回几次后再不过就停下（acceptanceReturns）",
  验收退回次数加一: "上一项加一：第几次还不过就停下",
  // 预算控制关着时也有值（照配置的倍数算）：用户改的提示写在条件外面也照常启动；默认的提示把它们放在 {{#预算控制}} 里
  停下的用量: "用量超过预算的几倍这一支停下（budgetAskTimes）：写成“用量超过预算”（1 倍）或“用量超过预算的 2 倍”；只在打开预算控制时真的停下",
  说明进展的用量: "用量超过预算的几倍让维护者说明进展（budgetExplainTimes），写法同上；只在打开预算控制时真的让说明",
  累计拒绝次数: "用户累计拒绝几次（审批、计划变更）暂停整个任务（rejections）",
} as const;

/** 阈值那一段的条件（93 号票：预算的两个动作只在打开预算控制时说） */
const THRESHOLD_FLAGS = { 预算控制: "配置 tasks.thresholds.budgetControl 打开时成立（93 号票：默认关着，超了预算不说明进展、不停下）" } as const;

const NONE = {} as const;

/** 定时触发的任务（76 号票）那一段的条件和值：普通任务的 agent、流程的维护者都插 triggered-runs 片段 */
const TRIGGERED_FLAGS = { 定时触发: "任务是定时触发的（76 号票：登记好了按时间表一次次运行）或者事件触发的（77 号票：每来一次等的事件运行一次）时成立" } as const;
const TRIGGERED_VALUES = {
  连续失败几次暂停: { description: "定时触发的任务连续失败几次自动暂停（配置 scheduledJobs.jobFailures）", onlyWhen: "定时触发" },
} as const;

/**
 * 全部提示，按设置页上的顺序：前缀、各角色、共用片段。编号就是文件名（<编号>.md）
 */
export const PROMPTS = {
  prefix: {
    title: "前缀",
    description: "加在每个 agent 的系统提示最前面（同 drama_maker 设置里的前缀），默认是空的；范围审视、压缩指令和交接摘要不加。不能写占位符",
    group: "prefix",
    values: NONE,
    flags: NONE,
    partials: [],
    common: false,
    allowEmpty: true,
  },
  secretary: {
    title: ASSISTANT_NAME_MARK,
    description: "对话入口的系统提示。改了之后手头这一条处理完就按新的重新拉起，从下一轮起生效",
    group: "role",
    values: { 名字: "用户给它起的名字（设置里改，默认“二狗”）" },
    flags: { 对话审批开着: "配置 guard.conversationApprovals 是 on 时成立（默认关着）" },
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "secretary-compaction": {
    title: `${ASSISTANT_NAME_MARK}的压缩指令`,
    description: "长期主线会话压缩时写摘要按它（接在 pi 的摘要提示后面）",
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "plain-task": {
    title: "普通任务的 agent",
    description: "不涉及项目（或涉及多个项目）的普通任务：交给它的事在后台直接做，做完用一两句话说结果；定时触发的按时间表一次次运行。下一次唤起时生效",
    group: "role",
    values: TRIGGERED_VALUES,
    flags: { 对话审批开着: "配置 guard.conversationApprovals 是 on 时成立（默认关着）", ...TRIGGERED_FLAGS },
    partials: ["triggered-runs"],
    common: true,
    allowEmpty: false,
  },
  "task-maintainer": {
    title: "长程任务的维护者",
    description: "任务自己的维护者（不属于项目的长程任务）：起草计划、执行都用这一份；多项目任务的维护者开头也是它",
    group: "role",
    values: THRESHOLD_VALUES,
    flags: THRESHOLD_FLAGS,
    partials: ["plan-writing", "execution"],
    common: true,
    allowEmpty: false,
  },
  "workflow-maintainer": {
    title: "流程的维护者",
    description: "不属于项目的流程：把要做的事排成步骤、用户一次授权后按步骤执行；定时触发的授权一次、每次运行都按步骤做",
    group: "role",
    values: { ...THRESHOLD_VALUES, ...TRIGGERED_VALUES },
    flags: { ...THRESHOLD_FLAGS, ...TRIGGERED_FLAGS },
    partials: ["workflow-rules", "thresholds", "triggered-runs"],
    common: true,
    allowEmpty: false,
  },
  "multi-project-maintainer": {
    title: "多项目任务的维护者",
    description: "涉及多个项目的任务：开头插长程任务的维护者那一份，后面是派工单、等回执的说明",
    group: "role",
    values: THRESHOLD_VALUES,
    flags: THRESHOLD_FLAGS,
    partials: ["task-maintainer"],
    common: true,
    allowEmpty: false,
  },
  "project-maintainer": {
    title: "项目的维护者",
    description: "项目自己的维护者：立项问答、对话、工单（起草计划、执行）。项目的事实（名字、状态、工具包）变了时按新的重新拉起",
    group: "role",
    values: {
      项目名: "项目的名字",
      项目编号: "项目编号（p-<n>）",
      项目目标: "项目的一句话目标",
      档案目录: "项目档案所在的目录",
      工作目录: "项目的工作目录",
      项目状态: "项目现在的状态（筹备中、建设中、使用中……）",
      项目类型: { description: "立项书确认的项目类型（开发类、其他）", onlyWhen: "立项书已确认" },
      工具包带不带bash: "“工具包带 bash”或“工具包不带 bash”",
      能不能联网: "工具包开着联网是“能”，否则是“不能”",
      ...THRESHOLD_VALUES,
    },
    flags: { 立项书已确认: "立项书确认了（项目类型定下了）时成立", 外部工作目录: "工作目录绑定的是外部路径时成立", ...THRESHOLD_FLAGS },
    partials: ["plan-writing", "execution"],
    common: true,
    allowEmpty: false,
  },
  "project-workflow": {
    title: "项目的维护者 · 流程工单",
    description: "这一段的工单是流程时，接在项目的维护者那一份后面",
    group: "role",
    values: NONE,
    flags: NONE,
    partials: ["workflow-rules"],
    common: true,
    allowEmpty: true,
  },
  "project-plain": {
    title: "项目的维护者 · 普通任务工单",
    description: "这一段的工单是项目内部的普通任务时，接在项目的维护者那一份后面",
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "project-standard": {
    title: "项目的维护者 · 项目规范",
    description: "项目的维护者每段会话开头的固定上下文里的项目规范（第一阶段的简短说明）",
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "job-maintainer": {
    title: "迁移来的定时触发任务的 agent",
    description: "76 号票之前登记的、不属于项目的定时作业（已迁移成定时触发的普通任务），每次运行都由它做",
    group: "role",
    values: { 连续失败几次暂停: "定时作业连续失败几次自动暂停（配置 scheduledJobs.jobFailures）" },
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "sub-agent": {
    title: "子 agent",
    description: "维护者提议并行、用户同意后派出的子 agent",
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  reviewer: {
    title: "评审",
    description: "阶段验收里独立判交付件是否满足验收标准的评审子 agent",
    group: "role",
    values: { 只读工具: "评审能用的只读工具（read、ls、grep、find）" },
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "scope-review": {
    title: "范围审视",
    description: "在维护者的一段工作记录里找范围变更和越界的那次模型调用（只输出 JSON，便宜模型）",
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "handoff-summary": {
    title: "换模型时的交接摘要",
    description: `设置里改了模型，${ASSISTANT_NAME_MARK}、项目维护者的对话段、迁移来的定时作业的 agent 新开会话之前，原来的模型写交接摘要按它（接在 pi 的摘要提示后面）`,
    group: "role",
    values: NONE,
    flags: { 秘书: `给${ASSISTANT_NAME_MARK}的长期主线写交接摘要时成立` },
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "triggered-runs": {
    title: "定时触发的每次运行",
    description: "定时触发的普通任务、流程每次运行怎么做（各次运行接着同一段会话、做不了怎么报），只在任务是定时触发的时候出现",
    group: "fragment",
    values: TRIGGERED_VALUES,
    flags: TRIGGERED_FLAGS,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "plan-writing": {
    title: "计划的写法",
    description: "起草计划的维护者都要知道的：阶段、授权项、关注类别、用户说过的限制",
    group: "fragment",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  execution: {
    title: "执行的推进",
    description: "执行时怎么推进：宣布阶段完成、报告进展、并行、计划变更，末尾插阈值",
    group: "fragment",
    values: THRESHOLD_VALUES,
    flags: THRESHOLD_FLAGS,
    partials: ["thresholds"],
    common: true,
    allowEmpty: true,
  },
  thresholds: {
    title: "运行时的阈值",
    description: "运行时盯着偏离的那一段，数字照配置 tasks.thresholds",
    group: "fragment",
    values: THRESHOLD_VALUES,
    flags: THRESHOLD_FLAGS,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "workflow-rules": {
    title: "流程的工作方式",
    description: "照搬 AgentSense 固定计划的工作方式，连同写计划参数和条件的规矩",
    group: "fragment",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
} as const satisfies Record<string, Omit<PromptDefinition, "partials"> & { partials: readonly string[] }>;

export type PromptId = keyof typeof PROMPTS;

export const PROMPT_IDS = Object.keys(PROMPTS) as PromptId[];

export function isPromptId(id: string): id is PromptId {
  return Object.hasOwn(PROMPTS, id);
}

export function promptDefinition(id: PromptId): PromptDefinition {
  return PROMPTS[id];
}

/**
 * 一份提示要的值：自己的填值占位符和条件。只在某个条件成立时才有值的可以给 undefined（条件不成立时用不到），别的一定要给
 */
export type PromptValuesOf<Id extends PromptId> = {
  [K in keyof (typeof PROMPTS)[Id]["values"]]: (typeof PROMPTS)[Id]["values"][K] extends { readonly onlyWhen: string } ? string | undefined : string;
} & {
  [K in keyof (typeof PROMPTS)[Id]["flags"]]: boolean;
};

/** 公用的一个占位符：名字、值、说明 */
export interface CommonPlaceholder {
  readonly name: string;
  readonly value: string;
  readonly description: string;
}

let common: readonly CommonPlaceholder[] | undefined;

/**
 * 公用的占位符：工具名（名字就是工具名本身）和运行时的标记、命令。用到时才算（模块之间互相引用，加载时别碰别的模块的常量）
 */
export function commonPlaceholders(): readonly CommonPlaceholder[] {
  if (common) return common;
  const tools = [
    TOOL.read,
    TOOL.write,
    TOOL.edit,
    TOOL.ls,
    TOOL.grep,
    TOOL.find,
    TOOL.bash,
    TOOL.git_status_diff,
    TOOL.git_commit,
    TOOL.git_merge,
    TOOL.git_push,
    TOOL.create_remote_repo,
    TOOL.run_tests,
    TOOL.install_deps,
    TOOL.start_build,
    TOOL.web_search,
    TOOL.web_fetch,
    ...Object.values(REMINDER_TOOL),
    VIEW_BOARD_TOOL,
    INBOX_TOOL.list,
    INBOX_TOOL.show,
    READ_ATTACHMENT_TOOL,
    SEND_ATTACHMENT_TOOL,
    SEARCH_MATERIALS,
    PROPOSE_QUICK_ACTION,
    TASK_CONTROL_ACTION.pause,
    TASK_CONTROL_ACTION.resume,
    TASK_CONTROL_ACTION.cancel,
    TASK_RUN_ACTION.runNow,
    TASK_RUN_ACTION.announce,
    READ_PROJECT_RECORDS_TOOL,
    SUGGEST_PROJECT_TOOL,
    SUBMIT_CHARTER_TOOL,
    ...Object.values(TASK_TOOL),
    SUBMIT_PLAN_TOOL,
    ...Object.values(EXECUTION_TOOL),
    PROPOSE_PARALLEL_TOOL,
    SUBMIT_REVIEW_TOOL,
    ...Object.values(WORKFLOW_TOOL),
    ADJUST_SKILLS_TOOL,
    REQUEST_TOOLKIT_CHANGE_TOOL,
    ...Object.values(WORK_ORDER_TOOL),
    ...Object.values(MULTI_PROJECT_TOOL),
    JOB_TOOL.failRun,
    SEND_VOICE_TOOL,
  ];
  common = [
    ...[...new Set(tools)].map((name) => ({ name, value: name, description: "工具名" })),
    { name: "系统通知标记", value: SYSTEM_NOTICE_TAG, description: "运行时发给 agent 的消息开头的标记" },
    { name: "看板变化标记", value: BOARD_CHANGE_TAG, description: "看板变化那条运行时消息开头的标记" },
    { name: "任务做完标记", value: TASK_DONE_TAG, description: "任务做完（含定时、事件触发的任务每运行完一次）时运行时给秘书的通知开头的标记" },
    { name: "自动播报标记", value: AUTO_ANNOUNCE_TAG, description: "开了“跑完自动播报”的任务做完时，通知开头紧跟在任务做完标记后面的标记（这一轮能直接发语音）" },
    { name: "自动纠偏标记", value: CORRECTION_PREFIX, description: "计划检查把流程的维护者拉回来时，工具结果开头的标记" },
    { name: "发起流程命令", value: LAUNCH_COMMANDS.workflow, description: "用户输入它就是点明了发起流程" },
    { name: "发起长程任务命令", value: LAUNCH_COMMANDS.long_running, description: "用户输入它就是点明了发起长程任务" },
    { name: "项目历史区", value: PROJECT_HISTORY_DIR, description: "项目档案里留旧版本的目录名" },
    { name: "流程步骤能用的工具", value: workflowStepTools(BUILTIN_TOOL_REGISTRY).join("、"), description: "流程的步骤里能写的工具（用“、”隔开）" },
  ];
  return common;
}

/** 一份提示插了哪些片段（连同片段里再插的） */
export function partialsOf(id: PromptId): PromptId[] {
  const seen = new Set<PromptId>();
  const walk = (p: PromptId) => {
    for (const child of PROMPTS[p].partials) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child);
    }
  };
  walk(id);
  return [...seen];
}

/** 一个片段直接插在哪几份提示里 */
export function includersOf(id: PromptId): PromptId[] {
  return PROMPT_IDS.filter((p) => (PROMPTS[p].partials as readonly PromptId[]).includes(id));
}

/**
 * 清单本身对不对（编程错误，守护进程起不来）：插的片段要有、不能绕回自己，片段能用的占位符和条件每个插它的提示都要有，
 * 自己的占位符不能和公用的重名
 */
export function checkPromptRegistry(): void {
  const commonNames = new Set(commonPlaceholders().map((c) => c.name));
  for (const id of PROMPT_IDS) {
    const d: PromptDefinition = PROMPTS[id];
    for (const name of [...Object.keys(d.values), ...Object.keys(d.flags)]) {
      if (commonNames.has(name)) throw new Error(`系统提示“${id}”的占位符“${name}”和公用的重名`);
      if (!isPromptPlaceholderName(name)) throw new Error(`系统提示“${id}”的占位符“${name}”名字不合规`);
    }
    for (const [name, spec] of Object.entries(d.values)) {
      const flag = valueOnlyWhen(spec);
      if (flag !== undefined && !(flag in d.flags)) throw new Error(`系统提示“${id}”的占位符“${name}”只在条件“${flag}”成立时才有值，可它没有这个条件`);
    }
    if (partialsOf(id).includes(id)) throw new Error(`系统提示“${id}”插的片段绕回了自己`);
    for (const p of d.partials) {
      const part: PromptDefinition = PROMPTS[p];
      if (part.common && !d.common) throw new Error(`系统提示“${id}”插了用公用占位符的片段“${p}”，自己却不能用`);
      for (const [name, spec] of Object.entries(part.values)) {
        if (!(name in d.values)) throw new Error(`片段“${p}”的占位符“${name}”插它的“${id}”没有`);
        if (valueOnlyWhen(spec) !== valueOnlyWhen(d.values[name]!)) throw new Error(`片段“${p}”的占位符“${name}”什么时候有值和插它的“${id}”说的不一样`);
      }
      for (const name of Object.keys(part.flags)) if (!(name in d.flags)) throw new Error(`片段“${p}”的条件“${name}”插它的“${id}”没有`);
    }
  }
}
