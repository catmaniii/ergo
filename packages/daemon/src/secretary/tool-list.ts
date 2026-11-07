// 秘书的工具里内核的那些（守护进程代为执行）：提议快速动作，任务发起的四个和
// 交给后台（普通任务），提议定时任务（schedule_task，tasks/schedule-tool.ts：只出"定时任务"卡，排在任务发起那几个后面），
// 建议立项，只读的查看板、读项目档案、列出待我处理和把卡片放进聊天（没有任何对卡片做动作的工具），
// 给出项目的服务的入口（open_service，放一张服务入口卡；查看板时多一节"项目的服务"），启动、关闭项目的服务（
// switch_project_services，和项目卡片上的按钮同一个入口），调使用中的项目的操作（project_ops，list / describe / call，
// 各项目的操作不注册成单独的工具，用到才读登记着的那一版清单；有白送的通用操作、参数校验、能念的 say、四种实现方式、
// 清单验收和版本号，装配在 project-ops/ 的 createProjectOps），提转入使用（propose_go_live，只出确认卡，用户在卡上确认才转）。
// 读个人档案（read_personal_file）紧跟在提议快速动作后面（写档案是快速动作 personal_file）。
// 提交 skill（propose_skill，skills/change.ts）排在项目的那几样后面、待办的两个前面：只出"skill 变更"卡。
// 只读的体检（check_health，doctor/tool.ts，409）排在查看板后面：用户说"体检一下"时现查一遍，交回不正常的项和怎么修。
// 带参调 MCP（mcp_call）排在插件给的 ask_memory 后面、别的内核工具前面——用户要动一个登记过的 MCP 时
// 先看它（登记过就调，参数自由传；没登记、服务没起来时它自己会说清楚）。
// 从组合根挪到这里。建、改、取消提醒由提醒插件、素材检索由记忆插件经 agent 贡献缝给秘书
// （reminders/plugin.ts、memory/plugin.ts），排在秘书的两个附件工具之后、这里的前面（secretary.ts），插件停用时秘书就没有它们。
// 浏览侧边栏里的网页工具（读网页、找文件、看图、给选中的框填字或交文件、开网址）由浏览插件（browsing/plugin.ts）
// 经 agent 贡献缝给秘书，写着 at: "end"，排在这里的后面（原来的位置）；测试加的工具由 secretary.ts 接在它们后面。
// 先后就是秘书看到的工具顺序（测试比对它），别随手调。
// 项目系统给的几样（建议立项、查看板时"项目的服务"那一节、读项目档案到提转入使用那五个）只经入口 projects/api.ts 的
// SecretaryProjects 拿（装法在 projects/secretary-tools.ts），这里不再认项目服务、项目的服务、project_ops 和它们的造法。
import { CHANNELS } from "@ergo/protocol";
import type { HostTool } from "../agent-manager/host-tools.ts";
import type { BoardKinds } from "../board/kinds.ts";
import { viewBoardTool } from "../board/tool.ts";
import type { CardService } from "../cards/cards.ts";
import type { DoctorService } from "../doctor/doctor.ts";
import { checkHealthTool } from "../doctor/tool.ts";
import { type PersonalFilesService, readPersonalFileTool } from "../personal-files/index.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { inboxTools } from "../inbox/secretary-tools.ts";
import type { McpCallService } from "../mcp/call.ts";
import type { SecretaryProjects } from "../projects/api.ts";
import { proposeQuickActionTool, type QuickActionService, readUserTurn } from "../quick-actions/index.ts";
import type { SkillChangeService } from "../skills/change.ts";
import { type ScheduleTaskToolDeps, scheduleTaskTool } from "../tasks/schedule-tool.ts";
import { taskTools } from "../tasks/secretary-tools.ts";
import type { TaskService } from "../tasks/tasks.ts";

export interface SecretaryToolDeps {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  tasks: TaskService;
  /** 项目系统给秘书的工具和查看板时"项目的服务"那一节 */
  projects: SecretaryProjects;
  quickActions: QuickActionService;
  /** 个人档案：读档案的工具（写档案是快速动作 personal_file） */
  personalFiles: PersonalFilesService;
  /** 带参调 MCP */
  mcpCalls: Pick<McpCallService, "tool">;
  /** 提交 skill（和负责人的 request_skill_change 同一张卡、同一段校验和写入） */
  skillChanges: Pick<SkillChangeService, "secretaryTool">;
  /** 看板上有哪几种（查看板） */
  boardKinds: BoardKinds;
  /** 秘书建任务时写的运行时现在能不能用：不能用的原因；不给就不查 */
  runtimeRefusal?: (runtime: string) => string | undefined;
  /** 体检（设置 · 体检同一份）：只读的 check_health；不给就没有这个工具 */
  doctor?: Pick<DoctorService, "view">;
  /** 提议定时任务：守护进程的时钟、工作日历、任务负责人的模型、同类运行的用量 */
  scheduling: Omit<ScheduleTaskToolDeps, "cards" | "runtimeRefusal">;
  now: () => string;
  log: (line: string) => void;
}

export function secretaryToolList(deps: SecretaryToolDeps): HostTool[] {
  const { store, cards, inbox, tasks, projects, quickActions, personalFiles, mcpCalls, boardKinds } = deps;
  return [
    // 带参调一个登记过的 MCP 工具（登记过就调，参数自由传）
    mcpCalls.tool(),
    proposeQuickActionTool(quickActions, CHANNELS.secretary),
    // 按人、按字段读个人档案（填网页表单、问证件号生日住址时先读它）
    readPersonalFileTool(personalFiles),
    // 发起任务要用户这一轮点明了（看秘书正在处理的那条用户消息）
    ...taskTools(tasks, { store, cards, inbox }, (inputMessageId) => readUserTurn(store, cards, inputMessageId), deps.runtimeRefusal),
    // 提议定时任务（只出"定时任务"卡，用户点确认才建；不用点明）
    scheduleTaskTool({ cards, runtimeRefusal: deps.runtimeRefusal, ...deps.scheduling }),
    // 建议立项
    projects.suggestTool(),
    // 查看板，多一节"项目的服务"
    viewBoardTool(store, boardKinds, () => projects.boardSection()),
    // 只读的体检：现查一遍，交回不正常的项和怎么修
    ...(deps.doctor ? [checkHealthTool(deps.doctor)] : []),
    // 读项目档案、给出服务入口、启停项目的服务、调使用中的项目的操作、提转入使用（只出确认卡）
    ...projects.tools(),
    // 提交一个 skill（只出"skill 变更"卡，用户确认了运行时才写 skill 区）
    deps.skillChanges.secretaryTool(),
    // 项目内部任务的事项秘书只看到是哪个项目内部的
    ...inboxTools(inbox, cards),
  ];
}
