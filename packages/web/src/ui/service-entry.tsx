/**
 * 项目的服务的入口（133 号票）："打开「X」"，旁边标着在不在线（LSM 推来的状态：在线绿、离线灰、失败红、上线中 / 启动中蓝、要你手动提醒色）。
 * 项目卡（compact：只有按钮，状态在小圆点和悬停提示里）、项目页的页头和运营方案那一节、两张运营方案的卡、秘书给的入口卡都用它。
 * 点了：上线了、有网页的用内置浏览器打开（132 号票的 openInAppBrowser；服务不在线时转发给出"现在没在运行"的说明页）；
 * 还没上线、上线失败、要你手动的不打开，提示原因。没有网页的只标状态，没有按钮。
 */
import type { MouseEvent } from "react";
import { openInAppBrowser } from "../app/page-in-app-browser.ts";
import { type ProjectServiceView, serviceEntryClick, serviceEntryView, t } from "../state/index.ts";
import { useToast } from "./toast.tsx";

export function ServiceEntry({ view, compact = false }: { view: ProjectServiceView; compact?: boolean }) {
  const toast = useToast();
  const e = serviceEntryView(view);
  const state = `${e.text}${e.detail ? t("ui.serviceEntry.detail", { detail: e.detail }) : ""}`;
  const open = (event: MouseEvent) => {
    // 项目卡整张能点开项目：入口自己处理，不往外冒
    event.stopPropagation();
    const click = serviceEntryClick(view);
    if (click.kind === "open") openInAppBrowser(click.url, click.title);
    else toast(click.text);
  };
  return (
    <span className={`svc-entry svc-${e.kind}${compact ? " svc-compact" : ""}`} title={t("ui.serviceEntry.title", { title: view.title, state })}>
      {view.url === undefined ? (
        <span className="svc-name">
          <span className="svc-dot" aria-hidden="true" />
          {t("ui.serviceEntry.serviceName", { title: view.title })}
        </span>
      ) : (
        <button type="button" className="svc-open" onClick={open} aria-label={t("ui.serviceEntry.openLabel", { label: e.label, state })}>
          <span className="svc-dot" aria-hidden="true" />
          {e.label}
        </button>
      )}
      {!compact && <span className="svc-state">{state}</span>}
    </span>
  );
}

/** 几个服务的入口排成一行（项目页页头） */
export function ServiceEntries({ views, compact = false }: { views: readonly ProjectServiceView[]; compact?: boolean }) {
  if (views.length === 0) return null;
  return (
    <span className={`svc-entries${compact ? " svc-entries-compact" : ""}`}>
      {views.map((v) => (
        <ServiceEntry key={v.app} view={v} compact={compact} />
      ))}
    </span>
  );
}
