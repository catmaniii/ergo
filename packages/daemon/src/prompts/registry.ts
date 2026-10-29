// 系统提示的清单（71 号票）：有哪些提示文件（默认的在本包的 prompts/<编号>.md，用户改的在数据目录配置区的 prompts/<编号>.md）、
// 给人看的名字和说明、各能用哪些占位符和片段。占位符的写法和检查在共享协议包（system-prompts.ts），读文件、存文件在 library.ts。
//
// 占位符分两种来源：
// - 公用的（commonPlaceholders）：工具名（占位符的名字就是工具名本身，比如 {{view_board}}）和几个运行时的标记、命令，
//   值是代码里的常量，每份提示都能用（前缀除外）。改了工具名，旧的占位符就不认得了，启动时报清楚是哪个文件哪一行；
// - 各提示自己的（values、flags）：名字、项目的事实、阈值里的数字、条件……由装配这个 agent 的模块填（各模块的 system-prompt.ts）。
//   有的值只在某个条件成立时才有（onlyWhen，比如项目类型只在立项书确认之后才有）：写在那个条件外面的，保存和启动检查时就拦下。
// 占位符的名字用中文（拉回次数、立项书已确认……）：这些文件是给用户看、给用户改的，是"标识符用英文"的例外（docs/developer-guide.md 的"写代码的约定"）。
// 片段（partials）插进来时用插它的那份提示的值，所以片段能用的占位符必须是每个插它的提示都有的（checkPromptRegistry 查）。
// 插件贡献的（128 号票，ADR-0027）：插件在定义里声明一个条件（插件运行时成立，比如"提醒"）、公用的占位符（它的工具名）和片段
// （默认的文件跟着插件走，插进它点名的几份提示），插件宿主收齐交给系统提示的文件；这里不再 import 插件的工具名
// （提醒的三个工具名 128 号票、记忆插件的 search_materials 129 号票）。
// 内核的提示和插件的合成一份清单（promptRegistry）：插件的片段排在内核的后面，设置页上照样能看能改。
import { ASSISTANT_NAME_MARK, AUTHORIZE_FOLDERS_ACTION, isPromptPlaceholderName, type SystemPromptGroup, t, tTable } from "@ergo/protocol";
import { VIEW_BOARD_TOOL } from "../board/tool-names.ts";
import { BOARD_CHANGE_TAG } from "../board/board-watch.ts";
import { SECRETARY_RELAY_TAG, SYSTEM_NOTICE_TAG } from "../conversation/messages.ts";
import { BUILTIN_TOOL_REGISTRY, CORRECTION_PREFIX, PROJECT_HISTORY_DIR, TOOL, workflowStepTools } from "../guard/index.ts";
import { INBOX_TOOL } from "../inbox/tool-names.ts";
import { SUBMIT_PLAN_TOOL } from "../maintainers/tools.ts";
import { READ_ATTACHMENT_TOOL, SEND_ATTACHMENT_TOOL } from "../media/tool-names.ts";
// 项目系统的工具名只从它的入口拿（277 号票）
import {
  CHECK_OPS_TOOL,
  MULTI_PROJECT_TOOL,
  OPEN_SERVICE_TOOL,
  PROJECT_OPS_TOOL,
  PROPOSE_CHARTER_CHANGE_TOOL,
  PROPOSE_GO_LIVE_TOOL,
  PROPOSE_OPERATIONS_TOOL,
  PROPOSE_STANDARD_CHANGE_TOOL,
  READ_PROJECT_RECORDS_TOOL,
  SUBMIT_CHARTER_TOOL,
  SUGGEST_PROJECT_TOOL,
  SWITCH_SERVICES_TOOL,
  WORK_ORDER_TOOL,
} from "../projects/api.ts";
import { PERSONAL_FILE_ACTION, READ_PERSONAL_FILE } from "../personal-files/tool-names.ts";
import { PROPOSE_QUICK_ACTION } from "../quick-actions/tool.ts";
import { JOB_TOOL } from "../scheduled-jobs/tool-names.ts";
import { TELL_SECRETARY_TOOL } from "../secretary/letter-texts.ts";
import { AUTO_ANNOUNCE_TAG, MAINTAINER_LETTER_TAG, TASK_DONE_TAG } from "../secretary/notice-tags.ts";
import { launchCommandText } from "../tasks/launch-intent.ts";
import { TASK_CONTROL_ACTION, TASK_DELETE_ACTION, TASK_RUN_ACTION } from "../tasks/task-control.ts";
import { RELAY_ACTION } from "../secretary/relay.ts";
import { EXECUTION_TOOL, PROPOSE_PARALLEL_TOOL, SUBMIT_REVIEW_TOOL, TASK_TOOL, WORKFLOW_TOOL } from "../tasks/tool-names.ts";
import { REQUEST_MCP_CHANGE_TOOL, MCP_CALL_TOOL } from "../mcp/tool-names.ts";
import { ADJUST_SKILLS_TOOL, REQUEST_TOOLKIT_CHANGE_TOOL } from "../toolkit/tool-names.ts";

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
  /** 能插的片段（提示的编号；插件的片段另由插件写明插进哪几份） */
  readonly partials: readonly string[];
  /** 能不能用公用的占位符（工具名、标记）；前缀不能 */
  readonly common: boolean;
  /** 能不能是空的 */
  readonly allowEmpty: boolean;
}

// 174 号票：设置 · 系统提示里给人看的名字、说明跟着当前语言——写成取值函数（tTable、get），取的时候现查。
// 占位符和条件的名字（中文）是提示文件里的写法（数据），不翻；提示文件的内容是给模型看的，照旧中文。

/** 合并几张说明表，不取值（表里是取值函数，展开会在加载时就取成那时的语言） */
function joinSpecs<A extends object, B extends object>(a: A, b: B): A & B {
  return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(a), ...Object.getOwnPropertyDescriptors(b) }) as A & B;
}

/** 阈值那一段的占位符（14 号票：数字照配置 tasks.thresholds，不写死）：插了阈值片段的提示都要有 */
const THRESHOLD_VALUES = tTable({
  拉回次数: "prompts.value.pullBacks",
  停滞分钟: "prompts.value.stallMinutes",
  催促次数: "prompts.value.nudges",
  验收退回次数: "prompts.value.acceptanceReturns",
  验收退回次数加一: "prompts.value.acceptanceReturnsPlusOne",
  // 预算控制关着时也有值（照配置的倍数算）：用户改的提示写在条件外面也照常启动；默认的提示把它们放在 {{#预算控制}} 里
  停下的用量: "prompts.value.budgetAskTimes",
  说明进展的用量: "prompts.value.budgetExplainTimes",
  累计拒绝次数: "prompts.value.rejections",
});

/** 阈值那一段的条件（93 号票：预算的两个动作只在打开预算控制时说） */
const THRESHOLD_FLAGS = tTable({ 预算控制: "prompts.flag.budgetControl" });

const NONE = {} as const;

/** 对话审批开着（秘书、普通任务的 agent、迁移来的定时作业的 agent） */
const APPROVAL_FLAGS = tTable({ 对话审批开着: "prompts.flag.conversationApprovals" });

/** 定时触发的任务（76 号票）那一段的条件和值：普通任务的 agent、流程的维护者都插 triggered-runs 片段 */
const TRIGGERED_FLAGS = tTable({ 定时触发: "prompts.flag.triggered" });
const TRIGGERED_VALUES = {
  连续失败几次暂停: {
    get description() {
      return t("prompts.value.jobFailures");
    },
    onlyWhen: "定时触发", // @i18n-ignore data：条件的名字
  },
} as const;

/**
 * 全部提示，按设置页上的顺序：前缀、各角色、共用片段。编号就是文件名（<编号>.md）
 */
export const PROMPTS = {
  prefix: {
    get title() {
      return t("prompts.prefix.title");
    },
    get description() {
      return t("prompts.prefix.description");
    },
    group: "prefix",
    values: NONE,
    flags: NONE,
    partials: [],
    common: false,
    allowEmpty: true,
  },
  secretary: {
    title: ASSISTANT_NAME_MARK,
    get description() {
      return t("prompts.secretary.description");
    },
    group: "role",
    values: tTable({ 名字: "prompts.value.assistantName" }),
    flags: APPROVAL_FLAGS,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "secretary-compaction": {
    get title() {
      return t("prompts.secretaryCompaction.title", { assistant: ASSISTANT_NAME_MARK });
    },
    get description() {
      return t("prompts.secretaryCompaction.description");
    },
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "memory-curator": {
    get title() {
      return t("prompts.memoryCurator.title");
    },
    get description() {
      return t("prompts.memoryCurator.description");
    },
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "plain-task": {
    get title() {
      return t("prompts.plainTask.title");
    },
    get description() {
      return t("prompts.plainTask.description");
    },
    group: "role",
    values: TRIGGERED_VALUES,
    flags: joinSpecs(APPROVAL_FLAGS, TRIGGERED_FLAGS),
    partials: ["triggered-runs", "attachments", "temp-files", "tell-secretary"],
    common: true,
    allowEmpty: false,
  },
  "task-maintainer": {
    get title() {
      return t("prompts.taskMaintainer.title");
    },
    get description() {
      return t("prompts.taskMaintainer.description");
    },
    group: "role",
    values: THRESHOLD_VALUES,
    flags: THRESHOLD_FLAGS,
    partials: ["plan-writing", "execution", "attachments", "temp-files", "tell-secretary"],
    common: true,
    allowEmpty: false,
  },
  "workflow-maintainer": {
    get title() {
      return t("prompts.workflowMaintainer.title");
    },
    get description() {
      return t("prompts.workflowMaintainer.description");
    },
    group: "role",
    values: joinSpecs(THRESHOLD_VALUES, TRIGGERED_VALUES),
    flags: joinSpecs(THRESHOLD_FLAGS, TRIGGERED_FLAGS),
    partials: ["workflow-rules", "thresholds", "triggered-runs", "attachments", "temp-files", "tell-secretary"],
    common: true,
    allowEmpty: false,
  },
  "multi-project-maintainer": {
    get title() {
      return t("prompts.multiProjectMaintainer.title");
    },
    get description() {
      return t("prompts.multiProjectMaintainer.description");
    },
    group: "role",
    values: THRESHOLD_VALUES,
    flags: THRESHOLD_FLAGS,
    partials: ["task-maintainer"],
    common: true,
    allowEmpty: false,
  },
  "project-maintainer": {
    get title() {
      return t("prompts.projectMaintainer.title");
    },
    get description() {
      return t("prompts.projectMaintainer.description");
    },
    group: "role",
    values: joinSpecs(
      joinSpecs(
        tTable({
          项目名: "prompts.value.projectName",
          项目编号: "prompts.value.projectId",
          项目目标: "prompts.value.projectGoal",
          档案目录: "prompts.value.recordsDir",
          工作目录: "prompts.value.workDir",
          项目状态: "prompts.value.projectState",
          工具包带不带bash: "prompts.value.toolkitBash",
          能不能联网: "prompts.value.network",
        }),
        {
          项目类型: {
            get description() {
              return t("prompts.value.projectType");
            },
            onlyWhen: "立项书已确认", // @i18n-ignore data：条件的名字
          },
        } as const,
      ),
      THRESHOLD_VALUES,
    ),
    flags: joinSpecs(tTable({ 立项书已确认: "prompts.flag.charterConfirmed", 外部工作目录: "prompts.flag.externalWorkDir" }), THRESHOLD_FLAGS),
    partials: ["plan-writing", "execution", "attachments", "temp-files", "tell-secretary"],
    common: true,
    allowEmpty: false,
  },
  "project-workflow": {
    get title() {
      return t("prompts.projectWorkflow.title");
    },
    get description() {
      return t("prompts.projectWorkflow.description");
    },
    group: "role",
    values: NONE,
    flags: NONE,
    partials: ["workflow-rules"],
    common: true,
    allowEmpty: true,
  },
  "project-plain": {
    get title() {
      return t("prompts.projectPlain.title");
    },
    get description() {
      return t("prompts.projectPlain.description");
    },
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "project-standard": {
    get title() {
      return t("prompts.projectStandard.title");
    },
    get description() {
      return t("prompts.projectStandard.description");
    },
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "job-maintainer": {
    get title() {
      return t("prompts.jobMaintainer.title");
    },
    get description() {
      return t("prompts.jobMaintainer.description");
    },
    group: "role",
    values: tTable({ 连续失败几次暂停: "prompts.value.legacyJobFailures" }),
    flags: APPROVAL_FLAGS,
    partials: ["attachments", "temp-files", "tell-secretary"],
    common: true,
    allowEmpty: false,
  },
  "sub-agent": {
    get title() {
      return t("prompts.subAgent.title");
    },
    get description() {
      return t("prompts.subAgent.description");
    },
    group: "role",
    values: NONE,
    flags: NONE,
    partials: ["temp-files", "tell-secretary"],
    common: true,
    allowEmpty: false,
  },
  reviewer: {
    get title() {
      return t("prompts.reviewer.title");
    },
    get description() {
      return t("prompts.reviewer.description");
    },
    group: "role",
    values: tTable({ 只读工具: "prompts.value.readOnlyTools" }),
    flags: tTable({ 能跑命令: "prompts.flag.canRunCommands" }),
    partials: ["tell-secretary"],
    common: true,
    allowEmpty: false,
  },
  "scope-review": {
    get title() {
      return t("prompts.scopeReview.title");
    },
    get description() {
      return t("prompts.scopeReview.description");
    },
    group: "role",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "handoff-summary": {
    get title() {
      return t("prompts.handoffSummary.title");
    },
    get description() {
      return t("prompts.handoffSummary.description", { assistant: ASSISTANT_NAME_MARK });
    },
    group: "role",
    values: NONE,
    flags: {
      get 秘书() {
        return t("prompts.flag.secretary", { assistant: ASSISTANT_NAME_MARK });
      },
    },
    partials: [],
    common: true,
    allowEmpty: false,
  },
  "triggered-runs": {
    get title() {
      return t("prompts.triggeredRuns.title");
    },
    get description() {
      return t("prompts.triggeredRuns.description");
    },
    group: "fragment",
    values: TRIGGERED_VALUES,
    flags: TRIGGERED_FLAGS,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  attachments: {
    get title() {
      return t("prompts.attachments.title");
    },
    get description() {
      return t("prompts.attachments.description");
    },
    group: "fragment",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "temp-files": {
    get title() {
      return t("prompts.tempFiles.title");
    },
    get description() {
      return t("prompts.tempFiles.description");
    },
    group: "fragment",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "tell-secretary": {
    get title() {
      return t("prompts.tellSecretary.title");
    },
    get description() {
      return t("prompts.tellSecretary.description");
    },
    group: "fragment",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "plan-writing": {
    get title() {
      return t("prompts.planWriting.title");
    },
    get description() {
      return t("prompts.planWriting.description");
    },
    group: "fragment",
    values: NONE,
    flags: NONE,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  execution: {
    get title() {
      return t("prompts.execution.title");
    },
    get description() {
      return t("prompts.execution.description");
    },
    group: "fragment",
    values: THRESHOLD_VALUES,
    flags: THRESHOLD_FLAGS,
    partials: ["thresholds"],
    common: true,
    allowEmpty: true,
  },
  thresholds: {
    get title() {
      return t("prompts.thresholds.title");
    },
    get description() {
      return t("prompts.thresholds.description");
    },
    group: "fragment",
    values: THRESHOLD_VALUES,
    flags: THRESHOLD_FLAGS,
    partials: [],
    common: true,
    allowEmpty: true,
  },
  "workflow-rules": {
    get title() {
      return t("prompts.workflowRules.title");
    },
    get description() {
      return t("prompts.workflowRules.description");
    },
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

/** 一个公用占位符：名字是提示文件里的写法（数据），值是给模型的；说明在设置页上给人看，跟着当前语言（取值函数） */
const described = (name: string, value: string, key: string): CommonPlaceholder => ({
  name,
  value,
  get description() {
    return t(key);
  },
});

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
    VIEW_BOARD_TOOL,
    INBOX_TOOL.list,
    INBOX_TOOL.show,
    READ_ATTACHMENT_TOOL,
    SEND_ATTACHMENT_TOOL,
    PROPOSE_QUICK_ACTION,
    TASK_CONTROL_ACTION.pause,
    TASK_CONTROL_ACTION.resume,
    TASK_CONTROL_ACTION.cancel,
    TASK_RUN_ACTION.runNow,
    TASK_RUN_ACTION.announce,
    // 186 号票：删除任务的快速动作
    TASK_DELETE_ACTION,
    RELAY_ACTION.task,
    RELAY_ACTION.project,
    AUTHORIZE_FOLDERS_ACTION,
    // 281 号票：写个人档案的快速动作、读个人档案的工具
    PERSONAL_FILE_ACTION,
    READ_PERSONAL_FILE,
    READ_PROJECT_RECORDS_TOOL,
    SUGGEST_PROJECT_TOOL,
    SUBMIT_CHARTER_TOOL,
    PROPOSE_CHARTER_CHANGE_TOOL,
    // 261 号票：项目维护者提本项目的规范改写
    PROPOSE_STANDARD_CHANGE_TOOL,
    PROPOSE_OPERATIONS_TOOL,
    OPEN_SERVICE_TOOL,
    // 257 号票：秘书启动、关闭项目的服务
    SWITCH_SERVICES_TOOL,
    // 260 号票：秘书调运营中的项目的接口（list / describe / call）
    PROJECT_OPS_TOOL,
    // 268 号票：维护者验收运营接口清单（使用中的全过了登记成新的一版）
    CHECK_OPS_TOOL,
    // 259 号票：维护者、秘书提转入使用（只出确认卡，用户确认才转）
    PROPOSE_GO_LIVE_TOOL,
    // 147、164 号票的网页工具（browse_*）212 号票起是浏览插件的占位符（browsing/prompt.ts）
    ...Object.values(TASK_TOOL),
    SUBMIT_PLAN_TOOL,
    ...Object.values(EXECUTION_TOOL),
    PROPOSE_PARALLEL_TOOL,
    SUBMIT_REVIEW_TOOL,
    ...Object.values(WORKFLOW_TOOL),
    ADJUST_SKILLS_TOOL,
    REQUEST_TOOLKIT_CHANGE_TOOL,
    // 239 号票：登记 MCP（加、改、删一条，用户确认之后运行时才写配置区）
    REQUEST_MCP_CHANGE_TOOL,
    // 240 号票：秘书带参调一个登记过的 MCP 工具（参数自由传，登记过就调）
    MCP_CALL_TOOL,
    ...Object.values(WORK_ORDER_TOOL),
    ...Object.values(MULTI_PROJECT_TOOL),
    JOB_TOOL.failRun,
    // 214 号票起 send_voice 由语音插件在系统提示里贡献（voice/prompt.ts）
    TELL_SECRETARY_TOOL,
  ];
  common = [
    ...[...new Set(tools)].map((name) => described(name, name, "prompts.common.toolName")),
    // @i18n-ignore-start data：占位符的名字（提示文件里的写法）；流程步骤能用的工具用"、"隔开交给模型
    described("系统通知标记", SYSTEM_NOTICE_TAG, "prompts.common.systemNoticeTag"),
    described("看板变化标记", BOARD_CHANGE_TAG, "prompts.common.boardChangeTag"),
    described("任务做完标记", TASK_DONE_TAG, "prompts.common.taskDoneTag"),
    described("自动播报标记", AUTO_ANNOUNCE_TAG, "prompts.common.autoAnnounceTag"),
    described("秘书转达标记", SECRETARY_RELAY_TAG, "prompts.common.relayTag"),
    described("维护者来信标记", MAINTAINER_LETTER_TAG, "prompts.common.letterTag"),
    described("自动纠偏标记", CORRECTION_PREFIX, "prompts.common.correctionTag"),
    // 310 号票：英文的写法（/workflow、/task），也认的中文老写法、175 号票的别名跟一句
    described("发起流程命令", launchCommandText("workflow"), "prompts.common.launchWorkflow"),
    described("发起长程任务命令", launchCommandText("long_running"), "prompts.common.launchLongRunning"),
    described("项目历史区", PROJECT_HISTORY_DIR, "prompts.common.historyDir"),
    described("流程步骤能用的工具", workflowStepTools(BUILTIN_TOOL_REGISTRY).join("、"), "prompts.common.workflowStepTools"),
    // @i18n-ignore-end
  ];
  return common;
}

/** 插件在系统提示里贡献的（128 号票）：插件在定义里声明（PluginDefinition.prompts），插件宿主收齐交给系统提示的文件 */
export interface PluginPrompts {
  /** 哪个插件（插件名） */
  readonly plugin: string;
  /** 条件：这个插件在运行时成立。能用公用占位符的提示都能用；默认的提示里讲这个插件的段落包在它里面，插件停用时就没有 */
  readonly flag: { readonly name: string; readonly description: string };
  /** 公用的占位符（工具名）：插件停用也认得、也有值（用户改过的提示里写了不至于出错），讲它们的段落由上面的条件去掉 */
  readonly placeholders: readonly CommonPlaceholder[];
  /** 片段：默认的文件跟着插件走，用户改的照样在数据目录配置区的 prompts/<编号>.md */
  readonly fragments: readonly PluginPromptFragment[];
}

/** 插件的一个片段 */
export interface PluginPromptFragment {
  /** 编号，也是文件名；不能和内核的、别的插件的重名 */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** 默认的文件（插件目录里） */
  readonly defaultFile: string;
  /** 插进哪几份提示（它们因此能写 {{> 编号}}；要是能用公用占位符的） */
  readonly includedBy: readonly PromptId[];
}

/** 插件的一个条件：名字、说明、哪个插件 */
export interface PluginFlag {
  readonly name: string;
  readonly description: string;
  readonly plugin: string;
}

/** 一份系统提示清单（128 号票）：内核的（PROMPTS）加上插件贡献的条件、占位符、片段 */
export interface PromptRegistry {
  /** 全部提示的编号：内核的按设置页上的顺序，插件的片段排在后面 */
  readonly ids: readonly string[];
  has(id: string): boolean;
  definition(id: string): PromptDefinition;
  /** 插件的片段默认的文件；内核的是 undefined（在默认目录里） */
  pluginFile(id: string): string | undefined;
  /** 一份提示直接能插的片段（内核写明的，加上插件写明插进它的） */
  partials(id: string): string[];
  /** 一份提示插了哪些片段（连同片段里再插的） */
  partialsOf(id: string): string[];
  /** 一个片段直接插在哪几份提示里 */
  includersOf(id: string): string[];
  /** 公用的占位符：内核的（工具名、标记）加上插件的 */
  readonly common: readonly CommonPlaceholder[];
  /** 插件的条件（能用公用占位符的提示都能用） */
  readonly pluginFlags: readonly PluginFlag[];
}

/** 合成一份清单，再查一遍对不对（编程错误抛出，守护进程起不来） */
export function promptRegistry(plugins: readonly PluginPrompts[] = []): PromptRegistry {
  const fragments = new Map(plugins.flatMap((p) => p.fragments.map((f) => [f.id, f] as const)));
  const ids = [...PROMPT_IDS, ...fragments.keys()];
  const definition = (id: string): PromptDefinition => {
    if (isPromptId(id)) return PROMPTS[id];
    const f = fragments.get(id);
    if (!f) throw new Error(`没有这份系统提示：${id}`); // @i18n-ignore log：编程错误
    return {
      get title() {
        return f.title;
      },
      get description() {
        return f.description;
      },
      group: "fragment",
      values: NONE,
      flags: NONE,
      partials: [],
      common: true,
      allowEmpty: true,
    };
  };
  const partials = (id: string): string[] => [...definition(id).partials, ...[...fragments.values()].filter((f) => (f.includedBy as readonly string[]).includes(id)).map((f) => f.id)];
  const registry: PromptRegistry = {
    ids,
    has: (id) => isPromptId(id) || fragments.has(id),
    definition,
    pluginFile: (id) => fragments.get(id)?.defaultFile,
    partials,
    partialsOf(id) {
      const seen = new Set<string>();
      const walk = (p: string) => {
        for (const child of partials(p)) {
          if (seen.has(child)) continue;
          seen.add(child);
          walk(child);
        }
      };
      walk(id);
      return [...seen];
    },
    includersOf: (id) => ids.filter((p) => partials(p).includes(id)),
    common: [...commonPlaceholders(), ...plugins.flatMap((p) => p.placeholders)],
    // 说明是取值函数（跟着当前语言），不展开
    pluginFlags: plugins.map((p) => ({
      name: p.flag.name,
      get description() {
        return p.flag.description;
      },
      plugin: p.plugin,
    })),
  };
  checkPromptRegistry(registry, plugins);
  return registry;
}

/**
 * 清单本身对不对（编程错误，守护进程起不来）：插的片段要有、不能绕回自己，片段能用的占位符和条件每个插它的提示都要有，
 * 自己的占位符不能和公用的重名；插件的（128 号票）：片段、条件、占位符不能和内核的、别的插件的重名，片段插进的提示要有、要能用公用占位符
 */
// @i18n-ignore-start log：编程错误（启动时报，给开发者看）
export function checkPromptRegistry(registry: PromptRegistry = promptRegistry(), plugins: readonly PluginPrompts[] = []): void {
  const commonNames = new Set(registry.common.map((c) => c.name));
  if (commonNames.size !== registry.common.length) throw new Error(`公用的占位符有重名的：${registry.common.map((c) => c.name).filter((n, i, all) => all.indexOf(n) !== i).join("、")}`);
  const flagNames = registry.pluginFlags.map((f) => f.name);
  for (const flag of registry.pluginFlags) {
    if (!isPromptPlaceholderName(flag.name)) throw new Error(`插件 ${flag.plugin} 的条件“${flag.name}”名字不合规`);
    if (commonNames.has(flag.name) || flagNames.indexOf(flag.name) !== flagNames.lastIndexOf(flag.name)) throw new Error(`插件 ${flag.plugin} 的条件“${flag.name}”重名了`);
  }
  for (const c of registry.common) if (!isPromptPlaceholderName(c.name)) throw new Error(`公用的占位符“${c.name}”名字不合规`);
  const fragmentIds = plugins.flatMap((p) => p.fragments.map((f) => f.id));
  for (const p of plugins) {
    for (const f of p.fragments) {
      if (isPromptId(f.id) || fragmentIds.indexOf(f.id) !== fragmentIds.lastIndexOf(f.id)) throw new Error(`插件 ${p.plugin} 的片段“${f.id}”和别的提示重名`);
      for (const into of f.includedBy) if (!isPromptId(into) || !PROMPTS[into].common) throw new Error(`插件 ${p.plugin} 的片段“${f.id}”插进的“${into}”不在或不能用公用占位符`);
    }
  }
  for (const id of registry.ids) {
    const d = registry.definition(id);
    for (const name of [...Object.keys(d.values), ...Object.keys(d.flags)]) {
      if (commonNames.has(name)) throw new Error(`系统提示“${id}”的占位符“${name}”和公用的重名`);
      if (flagNames.includes(name)) throw new Error(`系统提示“${id}”的占位符“${name}”和插件的条件重名`);
      if (!isPromptPlaceholderName(name)) throw new Error(`系统提示“${id}”的占位符“${name}”名字不合规`);
    }
    for (const [name, spec] of Object.entries(d.values)) {
      const flag = valueOnlyWhen(spec);
      if (flag !== undefined && !(flag in d.flags)) throw new Error(`系统提示“${id}”的占位符“${name}”只在条件“${flag}”成立时才有值，可它没有这个条件`);
    }
    if (registry.partialsOf(id).includes(id)) throw new Error(`系统提示“${id}”插的片段绕回了自己`);
    for (const p of registry.partials(id)) {
      if (!registry.has(p)) throw new Error(`系统提示“${id}”插的片段“${p}”没有`);
      const part = registry.definition(p);
      if (part.common && !d.common) throw new Error(`系统提示“${id}”插了用公用占位符的片段“${p}”，自己却不能用`);
      for (const [name, spec] of Object.entries(part.values)) {
        if (!(name in d.values)) throw new Error(`片段“${p}”的占位符“${name}”插它的“${id}”没有`);
        if (valueOnlyWhen(spec) !== valueOnlyWhen(d.values[name]!)) throw new Error(`片段“${p}”的占位符“${name}”什么时候有值和插它的“${id}”说的不一样`);
      }
      for (const name of Object.keys(part.flags)) if (!(name in d.flags)) throw new Error(`片段“${p}”的条件“${name}”插它的“${id}”没有`);
    }
  }
}
// @i18n-ignore-end
