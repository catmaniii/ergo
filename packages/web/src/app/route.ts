// 页面路由：用 URL 的 # 部分，直接从文件打开（file://）也能用，刷新后停在原来的页面。
import { useCallback, useEffect, useState } from "react";
import { cardWebPath } from "../state/index.ts";

export type Tab = "secretary" | "tasks" | "projects" | "inbox" | "more";

/** "更多"下面的页：消耗、设置，以及设置下面的五页 */
export const MORE_PAGES = ["usage", "settings", "watch", "workday-calendar", "skills", "devices", "materials"] as const;

export type MorePage = (typeof MORE_PAGES)[number];

function isMorePage(s: string): s is MorePage {
  return (MORE_PAGES as readonly string[]).includes(s);
}

export type Route =
  | { tab: "secretary" }
  | { tab: "tasks"; taskId?: string }
  | { tab: "projects"; projectId?: string; chat?: boolean }
  | { tab: "inbox"; itemId?: string }
  | { tab: "more"; page?: MorePage }
  /** 配对等待页：新设备上看到的，独占整页、没有 tab */
  | { tab: "pair-wait" }
  /** 配对批准页：在已信任的设备或 PC 本机上核对后批准 */
  | { tab: "pair-approve"; cardId: string }
  /** 单独显示一张卡：不认识这种卡的前端给的"去 Web 处理"链接指向这里 */
  | { tab: "card"; cardId: string };

export function parseHash(hash: string): Route {
  const [head, a, b] = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  switch (head) {
    case "tasks":
      return { tab: "tasks", taskId: a || undefined };
    case "projects":
      return { tab: "projects", projectId: a || undefined, chat: b === "chat" };
    case "inbox":
      return { tab: "inbox", itemId: a || undefined };
    case "more":
      return { tab: "more", page: a && isMorePage(a) ? a : undefined };
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
      return r.taskId ? `#/tasks/${r.taskId}` : "#/tasks";
    case "projects":
      return r.projectId ? `#/projects/${r.projectId}${r.chat ? "/chat" : ""}` : "#/projects";
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

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const navigate = useCallback((r: Route) => {
    window.location.hash = toHash(r);
  }, []);
  return [route, navigate];
}
