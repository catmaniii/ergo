// Google 插件自己的体检项（414），在 setup 里经 ctx.doctor.register 登记，passive（只读内存里记着的）。
// 二狗已经替它生成的不再重复（doctor/auto.ts）：插件本身；三个数据源各一项——Gmail 有账号的应用专用密码被撤了（needsAuth）是坏了，
// 日历每个地址都连着 3 次"一直不行"时整个数据源出错（坏了，原因写哪几个日历怎么了）；最近一次同步出错是注意。
// 这里只加"每个日历地址"一项（calendar-feeds）——数据源那一项只说"上次同步出错"，看不出哪个日历、连着几次、是不是一直不行：
// - 拉不到的日历里，最近一次是"一直不行"（地址失效、没权限：FeedProblem.lasting）的 → 坏了；
// - 一时拉不到（超时、连不上、Google 5xx）连着 FEED_FAILURES_WARN（3）次以上的 → 注意；
// - 别的正常（偶尔一两次拉不到不报：数据源那一项已经说了上次同步出错）；
// - 这次开机后还没拉过日历（没连、刚开机还没同步）→ 不适用；每个日历都连着几次一直不行时数据源那一项已经是坏了、写了每个日历的原因，
//   这里不再报一遍（不适用，指一下那一项）。
// 出错只在内存里，重启就没——照原样，重启后从下一次同步重新算（Google 日历每 30 分钟拉一次）。
import { t } from "@ergo/protocol";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import { type FeedHealth, FEED_LASTING_AFTER, type FeedTrouble, GOOGLE_CALENDAR_SOURCE } from "./calendar-feeds.ts";

/** 一时拉不到连着几次算"注意" */
export const FEED_FAILURES_WARN = 3;

/** 一个日历那一句（按当前语言）："「工作」连着 2 次没拉到：地址失效了……" */
const feedLine = (feed: FeedTrouble) => t("google.doctor.feeds.feed", { name: feed.name, count: feed.failures, reason: feed.problem });

/** 每个日历地址拉得怎么样 */
export function calendarFeedsFinding(health: FeedHealth): DoctorFinding {
  const { tried, failing } = health;
  if (tried === 0 && failing.length === 0) return { level: "na", fact: { key: "google.doctor.feeds.notTried" } };
  // 每个拉过的日历都连着几次一直不行：数据源那一项已经坏了（写了每个日历的原因），不重复
  if (failing.length >= tried && failing.every((f) => f.lasting && f.streak >= FEED_LASTING_AFTER)) return { level: "na", fact: { key: "google.doctor.feeds.allBroken" } };
  const broken = failing.filter((f) => f.lasting);
  const shaky = failing.filter((f) => !f.lasting && f.failures >= FEED_FAILURES_WARN);
  const shown = [...broken, ...shaky];
  if (shown.length === 0) return { level: "ok", fact: { key: "google.doctor.feeds.ok", params: { count: tried } } };
  const since = shown.map((f) => f.since).toSorted((a, b) => Date.parse(a) - Date.parse(b))[0]!;
  return {
    level: broken.length > 0 ? "error" : "warn",
    fact: { key: "google.doctor.feeds.failing", params: { feeds: shown.map(feedLine).join(t("google.calendar.problemSep")) } },
    fix: { key: broken.length > 0 ? "google.doctor.feeds.fixLasting" : "google.doctor.feeds.fixTransient" },
    since,
    action: { kind: "open", route: `#/more/data-sources/${GOOGLE_CALENDAR_SOURCE}` },
  };
}

/** "每个日历地址"那一项：health 现取（日历订阅的服务） */
export function googleFeedsCheck(health: () => FeedHealth): DoctorCheck {
  return { id: "calendar-feeds", title: "google.doctor.feeds.title", cost: "passive", run: () => calendarFeedsFinding(health()) };
}
