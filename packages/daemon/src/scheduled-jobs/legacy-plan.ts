// 升级前交了、升级后才确认的长程任务计划（76 号票，主会话定）：76 号票之前的计划里可以写定时作业（scheduledJobs），
// 计划卡还带着它。确认这张卡时不悄悄丢掉——照以前定时作业的迁移办法建成定时触发的普通任务（jobs.ts 的 legacyPlanConfirmed）。
// 这里只认出旧计划里的作业定义（形状照 19 号票的 PlanScheduledJob）。纯函数。
import { isRepeating, type Plan, PlanGrant, PlanTemporalRule, ReminderSchedule, schemaChecker, type Static, Type } from "@ergou/protocol";

/** 76 号票之前计划里的一个定时作业定义：作业名、时间表、每次要做的事、属于哪个项目（登记时按任务判，不看它）、每次运行的策略 */
const LegacyPlanJob = Type.Object({
  title: Type.String(),
  schedule: ReminderSchedule,
  each: Type.String(),
  project: Type.Optional(Type.String()),
  policy: Type.Optional(Type.Object({ grants: Type.Array(PlanGrant), temporalRules: Type.Array(PlanTemporalRule) })),
});
export type LegacyPlanJob = Static<typeof LegacyPlanJob>;

const legacyJobs = schemaChecker(Type.Array(LegacyPlanJob));

/** 旧计划里写的定时作业（时间表重复的；没写、形状不对的是空的） */
export function legacyPlanJobs(plan: Plan): LegacyPlanJob[] {
  const raw = (plan as Plan & { scheduledJobs?: unknown }).scheduledJobs;
  return raw !== undefined && legacyJobs.check(raw) ? raw.filter((j) => isRepeating(j.schedule)) : [];
}
