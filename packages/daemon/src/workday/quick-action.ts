// 快速动作"改工作日历"（29 号票，规格第 14、21 节）：用户对秘书说"下周一我不上班""每月最后一个周六要上班"，
// 秘书用"提议快速动作"工具提出，把"下周一"这类说法换算成具体日期、把规则换算成确定的写法；换算结果显示在快速动作卡上供核对。
// - 一律先确认（confirm: always）：日期和规则是秘书换算出来的，不是用户原样说的，"点明了"的判定因此不需要；
// - 用户确认后由运行时执行：写配置区里的个人设置，和卡片、操作记录同一事务追加 workday_settings 事件。
//   秘书自己写不了配置区（受保护区域），也没有直接改工作日历的工具。
import {
  describeExtraRule,
  describeLocalDate,
  describeWorkdayChange,
  ExtraWorkdayRule,
  LOCAL_DATE_PATTERN,
  t,
  Type,
  type WorkdayChange,
} from "@ergo/protocol";
import { defineQuickAction, type QuickActionExecutor } from "../quick-actions/index.ts";
import type { WorkdayCalendarService } from "./calendar.ts";

/** 秘书写的改动：标休息、标上班、清掉标记要给日期，加删规则要给规则 */
const CHANGES = ["mark_rest", "mark_work", "clear_mark", "add_rule", "remove_rule"] as const;

// @i18n-ignore-start model：参数说明（给秘书）
const Params = Type.Object(
  {
    change: Type.Enum(CHANGES, {
      description: "mark_rest 把某天标成休息（\"下周一我不上班\"）；mark_work 把某天标成上班；clear_mark 清掉某天的手动标记；add_rule 加一条额外上班规则；remove_rule 删掉一条额外上班规则",
    }),
    date: Type.Optional(Type.String({ pattern: LOCAL_DATE_PATTERN, description: "mark_rest、mark_work、clear_mark 时给：具体日期 YYYY-MM-DD。按用户消息前标着的当前日期把\"下周一\"这类说法换算成具体日期" })),
    rule: Type.Optional(
      Type.Union(ExtraWorkdayRule.anyOf, {
        description:
          "add_rule、remove_rule 时给，三种写法之一：{kind:\"weekly\",weekday} 每周几；{kind:\"nth_weekday\",n,weekday} 每月第 n 个周几；{kind:\"last_weekday\",weekday} 每月最后一个周几。weekday：0 是周日、1 是周一……6 是周六",
      }),
    ),
  },
  { additionalProperties: false },
);
// @i18n-ignore-end

export function workdayCalendarAction(workdayCalendar: WorkdayCalendarService): QuickActionExecutor {
  return defineQuickAction({
    type: "workday_calendar",
    get title() {
      return t("workday.quickAction.title");
    },
    // @i18n-ignore-next model：给秘书的用法
    usage: "用户说哪天不上班、哪天要上班，或者加删额外上班规则（\"每月最后一个周六要上班\"）：改个人工作日历，按我的工作日的提醒跟着变",
    params: Params,
    // 改的是二狗自己的配置，不落入任何关注类别；但日期和规则是秘书换算的，一律先确认
    watch: { categories: [] },
    confirm: "always",
    normalize({ change, date, rule }) {
      let normalized: WorkdayChange;
      if (change === "add_rule" || change === "remove_rule") {
        if (rule === undefined) throw new Error(`${change} 要给 rule`); // @i18n-ignore model：交回秘书的出错说明
        normalized = { kind: change, rule };
      } else {
        if (date === undefined) throw new Error(`${change} 要给 date（YYYY-MM-DD）`); // @i18n-ignore model：交回秘书的出错说明
        normalized = change === "clear_mark" ? { kind: "clear_mark", date } : { kind: "mark", date, mark: change === "mark_work" ? "work" : "rest" };
      }
      // 日期不存在时这里抛错（说明回给秘书）
      const title = describeWorkdayChange(normalized);
      const target = normalized.kind === "add_rule" || normalized.kind === "remove_rule" ? describeExtraRule(normalized.rule) : describeLocalDate(normalized.date);
      return { params: normalized, title, target };
    },
    execute(params) {
      const change = params as WorkdayChange;
      const prepared = workdayCalendar.prepare(change, "quick_action");
      return {
        events: prepared.event ? [prepared.event] : [],
        summary: prepared.changed ? t("workday.quickAction.done", { change: describeWorkdayChange(change) }) : t("workday.quickAction.unchanged", { change: describeWorkdayChange(change) }),
      };
    },
  });
}
