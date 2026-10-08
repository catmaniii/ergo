// 页面路由的地址（纯函数，不碰 window，测试在 Node 里直接用）：页面有哪些、地址怎么拆（parseHash）、怎么拼（toHash）、
// 这一页属于主导航的哪一项（navItemOf）。盯着地址变化的 React 钩子在 route.ts。
import { cardWebPath, type NavItem, parseLocalDate, parseMonthKey } from "../state/index.ts";

export type Tab = "secretary" | "tasks" | "projects" | "inbox" | "calendar" | "more";

/**
 * "更多"下面的页：消耗、记忆（第二阶段的说明）、设置，以及设置下面的六页（32 号票加了语音）。主导航放得下时消耗、记忆、设置直接显示成 tab
 * （33 号票），地址仍是 #/more/...，别处的链接（比如"去设置页修复"）不用跟着导航变。
 * 35 号票：设置里的"工作日历"升为主导航的日历（#/calendar），设置里只留"工作日规则"（额外上班规则）；旧地址 #/more/workday-calendar
 * 认作工作日规则
 */
export const MORE_PAGES = ["usage", "memory", "settings", "watch", "workday-rules", "skills", "voice", "devices", "materials"] as const;

export type MorePage = (typeof MORE_PAGES)[number];

function isMorePage(s: string): s is MorePage {
  return (MORE_PAGES as readonly string[]).includes(s);
}

/** 改了名的页的旧地址 */
const RENAMED_MORE_PAGES: Readonly<Record<string, MorePage>> = { "workday-calendar": "workday-rules" };

/** 写法对、真有这一天（这个月）才算数：#/calendar/2026-13、#/calendar/2026-02-30 当成没带，回到本月（日历页渲染时不会再拆出错） */
function valid(parse: (s: string) => unknown, s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    parse(s);
    return s;
  } catch {
    return undefined;
  }
}

export type Route =
  | { tab: "secretary" }
  /** 看板；jobId：定位到看板上这个定时作业的卡（日历里点作业过来，35 号票） */
  | { tab: "tasks"; taskId?: string; jobId?: string }
  /** 项目；jobId：定位到项目页上这个定时作业那一行（日历里点作业过来，35 号票） */
  | { tab: "projects"; projectId?: string; chat?: boolean; jobId?: string }
  | { tab: "inbox"; itemId?: string }
  /** 日历（35 号票）：month 是看哪个月（YYYY-MM，不给是这个月），date 是展开详情的那一天（YYYY-MM-DD，月份跟着它） */
  | { tab: "calendar"; month?: string; date?: string }
  | { tab: "more"; page?: MorePage }
  /** 配对等待页：新设备上看到的，独占整页、没有 tab */
  | { tab: "pair-wait" }
  /** 配对批准页：在已信任的设备或 PC 本机上核对后批准 */
  | { tab: "pair-approve"; cardId: string }
  /** 单独显示一张卡：不认识这种卡的前端给的"去 Web 处理"链接指向这里 */
  | { tab: "card"; cardId: string };

/** 设置下面的六页 */
const SETTINGS_PAGES: readonly MorePage[] = ["watch", "workday-rules", "skills", "voice", "devices", "materials"];

/** 这一页属于主导航的哪一项："更多"本身是 more；配对等待页独占整页，不属于任何一项 */
export function navItemOf(route: Route): NavItem | "more" | undefined {
  switch (route.tab) {
    case "secretary":
    case "tasks":
    case "projects":
    case "inbox":
    case "calendar":
      return route.tab;
    case "pair-approve":
    case "card":
      return "inbox";
    case "more":
      if (!route.page) return "more";
      if (route.page === "usage" || route.page === "memory") return route.page;
      return route.page === "settings" || SETTINGS_PAGES.includes(route.page) ? "settings" : "more";
    case "pair-wait":
      return undefined;
  }
}

export function parseHash(hash: string): Route {
  const [head, a, b, c] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  switch (head) {
    case "tasks":
      if (a === "jobs" && b) return { tab: "tasks", jobId: b };
      return { tab: "tasks", taskId: a || undefined };
    case "projects":
      if (a && b === "jobs" && c) return { tab: "projects", projectId: a, jobId: c };
      return { tab: "projects", projectId: a || undefined, chat: b === "chat" };
    case "inbox":
      return { tab: "inbox", itemId: a || undefined };
    case "calendar": {
      const date = valid(parseLocalDate, a);
      if (date) return { tab: "calendar", date };
      return { tab: "calendar", month: valid(parseMonthKey, a) };
    }
    case "more":
      return { tab: "more", page: a && isMorePage(a) ? a : a ? RENAMED_MORE_PAGES[a] : undefined };
    case "card":
      return a ? { tab: "card", cardId: a } : { tab: "secretary" };
    case "pair":
      if (a === "approve" && b) return { tab: "pair-approve", cardId: b };
      if (a === "wait") return { tab: "pair-wait" };
      return { tab: "secretary" };
    default:
      return { tab: "secretary" };
  }
}

export function toHash(r: Route): string {
  switch (r.tab) {
    case "secretary":
      return "#/secretary";
    case "tasks":
      if (r.jobId) return `#/tasks/jobs/${r.jobId}`;
      return r.taskId ? `#/tasks/${r.taskId}` : "#/tasks";
    case "projects":
      if (r.projectId && r.jobId) return `#/projects/${r.projectId}/jobs/${r.jobId}`;
      return r.projectId ? `#/projects/${r.projectId}${r.chat ? "/chat" : ""}` : "#/projects";
    case "calendar":
      return r.date ? `#/calendar/${r.date}` : r.month ? `#/calendar/${r.month}` : "#/calendar";
    case "inbox":
      return r.itemId ? `#/inbox/${r.itemId}` : "#/inbox";
    case "more":
      return r.page ? `#/more/${r.page}` : "#/more";
    case "pair-wait":
      return "#/pair/wait";
    case "pair-approve":
      return `#/pair/approve/${r.cardId}`;
    case "card":
      return cardWebPath(r.cardId);
  }
}

export type Navigate = (r: Route) => void;
