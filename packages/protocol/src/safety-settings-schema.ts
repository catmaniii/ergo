// 安全和预算的两个开关（315 号票，用户 2026-10-27 定："风险和任务预算的事情，做成一个设置吧。默认收紧，如果用户觉得比较难受，它可以自己关掉"）：
// - 先问我：对话里（秘书、项目维护者的对话段、起草计划）和任务里超出授权的，"先问我"出不出审批卡——配置 guard.conversationApprovals（on / off）；
// - 任务的预算：用量过了预算先让维护者说明进展、过了 2 倍这一支停下等用户——配置 tasks.thresholds.budgetControl。
// 设置接口 GET / PUT /api/safety-settings 的 schema。真相是数据目录的配置文件 config/ergo.json（守护进程写），改了马上生效、不用重启。
// 新装时两样都开着（守护进程第一次起来时写进配置文件），已有的数据目录里没写的照旧是关着（代码里的默认值没变）。
// 319 号票的设置向导复用这一对接口。
import { type Static, Type } from "typebox";

/** GET /api/safety-settings、PUT 之后回的：现在的两个开关 */
export const SafetySettingsView = Type.Object({
  /** 先问我：true 是 guard.conversationApprovals 为 on（"先问我"的一律出审批卡、任务按计划的授权核对），false 是 off */
  conversationApprovals: Type.Boolean(),
  /** 任务的预算：true 是 tasks.thresholds.budgetControl 为 true（超了先说明进展、过了 2 倍停下等你），false 是只记用量 */
  budgetControl: Type.Boolean(),
});
export type SafetySettingsView = Static<typeof SafetySettingsView>;

/** 改开关（PUT /api/safety-settings）：改哪项给哪项（至少给一项），没给的照旧 */
export const SafetySettingsBody = Type.Object(
  { conversationApprovals: Type.Optional(Type.Boolean()), budgetControl: Type.Optional(Type.Boolean()) },
  { minProperties: 1, additionalProperties: false },
);
export type SafetySettingsBody = Static<typeof SafetySettingsBody>;
