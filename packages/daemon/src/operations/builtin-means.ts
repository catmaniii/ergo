// 内核登记的运营手段（登记表见 means.ts）：
// - schedule 定时触发的任务：重复的时间表（每天、每 N 天、每周几、每月几号、每年某月某日、按我的工作日），或者某个时间做一次；
// - event 事件触发的任务：事件来源、事件、过滤（二狗内部事件、本机文件夹变化、项目的服务报的事件……）；
//   这两种的做法都可以是普通任务或流程（流程带它的固定计划，确认方案时一起授权）。生效时建成这个项目的内部任务，执行者是项目的
//   负责人（规矩不变）：定时、事件触发的进运营中，触发底座登记它的触发，到点或来事件时派一张运行工单给负责人；
//   项目停用、重新启用时的暂停和恢复由触发底座按项目的状态管（不登记 pause / resume）；
// - public_entry 公网入口：二狗现在还做不了（automatic 为 false），方案的格式给它留着位置——负责人写进方案时
//   写明要用户手动做哪几步，卡上标"需要你手动"，确认时不假装生效。
// 项目自己的服务（service，登记到 LSM 上线）二狗能做了，在 project-services/means.ts；由运营层自己经登记口登记
// （project-ops/layer.ts），组装函数在事件触发和公网入口之间装运营层。
import { describeEventTrigger, describeSchedule, forModel, isRepeating, repeatScheduleError, type OperationItem, type OperationItemDraft, type ReminderSchedule, SERVICE_EVENT_NAME_FILTER, SERVICE_EVENT_SOURCE, SERVICE_REPORTED_EVENT, t, type TaskTrigger } from "@ergo/protocol";
import type { ScheduledJobs } from "../scheduled-jobs/index.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { OperationApplyContext, OperationMeans } from "./means.ts";
import { meansText } from "./texts.ts";

export interface BuiltinMeansDeps {
  tasks: Pick<TaskService, "buildInternal" | "buildAuthorizedWorkflow">;
  /** 触发底座（建在运营方案模块之后的也行：用到时现取） */
  scheduledJobs: () => Pick<ScheduledJobs, "cancelTaskEvents" | "rescheduleTaskEvents">;
}

/** 每次运行交给负责人的话（任务的说明，也是触发登记里"每次要做的事"）：每次做什么，写了失败时怎样的接在后面 */
export const runSummary = (item: Pick<OperationItem, "instructions" | "onFailure">): string => (item.onFailure ? `${item.instructions}\n${meansText.onFailure(item.onFailure)}` : item.instructions);

/** 一条除了时间表（和它的说法）以外的部分 */
const withoutSchedule = ({ schedule: _s, triggerText: _t, ...other }: OperationItem) => JSON.stringify(other);

/** 除了时间表，别的都没变（名字、做法、每次做什么、失败时怎样、流程的步骤、要的能力）：能就地改时间 */
const onlyScheduleChanged = (before: OperationItem, after: OperationItem): boolean =>
  withoutSchedule(before) === withoutSchedule(after) && JSON.stringify(before.schedule) !== JSON.stringify(after.schedule);

/** 定时、事件触发的两种共用的生效：建成项目的内部任务（普通任务，或者带着授权的流程） */
function applyTriggered(deps: BuiltinMeansDeps, item: OperationItem, trigger: TaskTrigger, ctx: OperationApplyContext) {
  const base = { projectId: ctx.project.id, title: item.name, summary: runSummary(item), origin: "operations" as const, trigger };
  if (item.approach === "workflow") {
    if (!item.workflow || !ctx.execution) throw new Error(meansText.noWorkflowPlan(item.name));
    const { task, events } = deps.tasks.buildAuthorizedWorkflow(base, { plan: item.workflow, execution: ctx.execution }, { confirmations: ctx.confirmations, note: meansText.authorizedNote(), key: `${ctx.key}#${item.key}` }, ctx.nth);
    return { taskId: task.id, events };
  }
  const { task, events } = deps.tasks.buildInternal({ ...base, kind: "plain" }, "user", undefined, ctx.nth);
  return { taskId: task.id, events };
}

/** 定时触发的任务 */
function scheduleMeans(deps: BuiltinMeansDeps): OperationMeans {
  return {
    id: "schedule",
    get label() {
      return t("operations.means.schedule");
    },
    hint: "按时间表反复做（schedule 写重复的时间表：每天、每 N 天（everyNDays：interval 隔几天、anchor 从哪天起）、每周几、每月几号、每年某月某日、按我的工作日），或者将来某个时间做一次（schedule 写 once 和时间）", // @i18n-ignore model：工具说明
    automatic: true,
    check(item, ctx) {
      if (!item.schedule) return [meansText.needSchedule];
      const problems = item.event ? [meansText.scheduleNotEvent] : [];
      if (item.schedule.kind === "once" && !(Date.parse(item.schedule.at) > Date.parse(ctx.now))) problems.push(meansText.oncePassed(item.schedule.at));
      // 重复的规则拼不出来的（每年 2 月 30 日、每 N 天的起算日不存在）
      const schedule = item.schedule;
      const ruleError = forModel(() => repeatScheduleError(schedule) ?? "");
      if (ruleError) problems.push(ruleError);
      return problems;
    },
    describe: (item) => (item.schedule ? describeSchedule(item.schedule) : t("operations.means.scheduleTrigger")),
    apply: (item, ctx) => applyTriggered(deps, item, { kind: "schedule", schedule: item.schedule as ReminderSchedule }, ctx),
    revoke: (binding) => (binding.taskId ? deps.scheduledJobs().cancelTaskEvents(binding.taskId, "user") : []),
    // 只改了重复的时间表：就地改时间（"改时间"，任务、会话、运行记录不变）；别的改动撤了重建
    update(before, after, binding) {
      if (!binding.taskId || !onlyScheduleChanged(before, after) || !after.schedule || !before.schedule || !isRepeating(before.schedule) || !isRepeating(after.schedule)) return undefined;
      return deps.scheduledJobs().rescheduleTaskEvents(binding.taskId, after.schedule, "user");
    },
  };
}

/** 事件触发的任务 */
function eventMeans(deps: BuiltinMeansDeps): OperationMeans {
  return {
    id: "event",
    get label() {
      return t("operations.means.event");
    },
    // @i18n-ignore-next model：工具说明
    hint: `某个事件发生时做（event 写事件来源、事件、过滤，和发起任务时的“事件发生时”同一种写法：二狗内部事件 ergo——任务做完、失败、转等我，项目状态变化，一次运行失败；本机文件夹变化 folder——新增、修改、删除文件；项目的服务 ${SERVICE_EVENT_SOURCE}——这个项目自己的服务报的事件，event 写成 {"kind":"event","source":"${SERVICE_EVENT_SOURCE}","events":["${SERVICE_REPORTED_EVENT}"],"filter":{"${SERVICE_EVENT_NAME_FILTER}":"事件名"}}，事件名你定、中文可以，要和服务里报的一字不差。服务里怎么报见系统提示的“被服务叫醒”）`,
    automatic: true,
    check(item, ctx) {
      if (!item.event) return [meansText.needEvent];
      return [...(item.schedule ? [meansText.eventNotSchedule] : []), ...ctx.checkEventTrigger(item.event)];
    },
    describe: (item, ctx) => (item.event ? describeEventTrigger(item.event, ctx.names) : t("operations.means.eventTrigger")),
    apply: (item, ctx) => applyTriggered(deps, item, item.event!, ctx),
    revoke: (binding) => (binding.taskId ? deps.scheduledJobs().cancelTaskEvents(binding.taskId, "user") : []),
  };
}

/** 二狗现在还做不了的（第二阶段）：要用户手动，方案里写明要做哪几步 */
function manualMeans(id: string, label: () => string, hint: string): OperationMeans {
  return {
    id,
    get label() {
      return label();
    },
    hint: `${hint}。二狗现在还做不了（第二阶段）：manual 里写清用户要手动做哪几步，卡上标“需要你手动”`, // @i18n-ignore model：工具说明
    automatic: false,
    check: (item: OperationItemDraft) => [...(item.manual ? [] : [meansText.needManual(label())]), ...(item.approach === "workflow" || item.workflow ? [meansText.manualNoWorkflow(label())] : [])],
    describe: () => label(),
  };
}

/**
 * 内核登记的，分两段（先后就是工具说明里列的先后）：triggered 是定时触发的任务、事件触发的任务，manual 是要用户手动的公网入口。
 * 两段中间是运营层自己经登记口登记的 service（项目自己的服务，组装函数在两段之间装运营层，不再替它插进来）
 */
export function builtinOperationMeans(deps: BuiltinMeansDeps): { triggered: OperationMeans[]; manual: OperationMeans[] } {
  // @i18n-ignore-next model：工具说明里的提示
  return { triggered: [scheduleMeans(deps), eventMeans(deps)], manual: [manualMeans("public_entry", () => t("operations.means.publicEntry"), "从外网访问项目的入口（隧道、nginx 站点）")] };
}
