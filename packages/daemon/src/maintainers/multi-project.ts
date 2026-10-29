// 涉及多个项目的任务的维护者（规格第 8、11 节"固定工具包"，ADR-0003，17 号票）：建卡时产生（任务自己的维护者），
// 它的工具包固定为三样——读项目档案、派工单、汇总回执（work-orders/multi-project-tools.ts）——没有文件读写、bash（70 号票起能联网：
// 每个维护者都有的联网搜索、读网页，见 PLANNING_TOOLKIT），
// 改不了任何项目，各项目的改动都靠派给项目维护者的工单。另有每个维护者都有的运行时控制：起草计划时"提交计划"，
// 执行时推进阶段的那几个（开始阶段、宣布阶段完成、报告进展、转为等我、失败、计划变更）和"转问用户"。
// 起草计划时也是这三样（规划时只读各项目档案，派工单被拒）；调用不属于任务（按对话里的处置判）。执行时调用属于任务，带重注入块。
// 工作目录是数据目录输出区里任务自己的一格，pi 的内置工具一个都不给。"没有工具包"只在这里定一次（MULTI_PROJECT_TOOLKIT）：
// 执行控制器（验收、重注入块里的工具包）、装配、守卫看到的维护者都取它。
// 127 号票起装配本身是 agent 宿主的"固定工具包"那种会话（agent-host/assembly.ts 的 fixedSetup），系统提示在 maintainers.ts 选。
// 102 号票：给秘书发消息（tell_secretary）每个 agent 默认都有，这里也有；只有这一项跟着计划里的开关（调用方算好放进 toolkit）。
// 117 号票的发附件（send_attachment、tell_secretary 带附件）这里没有：它不写文件，工作目录里没有要给用户看的东西。
import { type PlanToolkit, type Task, taskProjectScope } from "@ergo/protocol";
import { PLANNING_TOOLKIT } from "../agent-host/assembly.ts";

/** 涉及多个项目的任务的维护者的工具包：除了联网（70 号票：联网搜索、读网页）什么都不开（固定的三样是代为执行的工具，不算工具包里的能力） */
export const MULTI_PROJECT_TOOLKIT: Readonly<PlanToolkit> = Object.freeze({ skills: [], mcp: [], ...PLANNING_TOOLKIT });

/** 这个任务的维护者的工具包是不是固定的那份：建卡时定下的多项目任务是（计划里写了什么都不算）；别的任务是 undefined */
export const multiProjectToolkit = (task: Task): Readonly<PlanToolkit> | undefined => (taskProjectScope(task) === "multi" ? MULTI_PROJECT_TOOLKIT : undefined);
