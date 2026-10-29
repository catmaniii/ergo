/**
 * 项目的"运营概况"（140 号票）：项目卡、项目头里的"现在"（项目页和维护者会话页左栏）只用这一个组件，数据是状态层的 projectOperationsSummary。
 * - 服务：首页的缩略图（守护进程截的；点了和入口一样在内置浏览器里打开；不在线的灰掉标"不在线"，停用了的标"已停用"；
 *   截不了的不显示图）后面跟"打开「X」"和在线圆点（ui/service-entry.tsx）；
 * - 定时任务：收起时一行"2 个定时任务：每天 08:00 日报、每周日 18:00 周报"，右边一个展开钮；展开后每条一行：名字、时间表、下次、
 *   上次和结果、状态，点一行进那个任务的整页。
 * - 257 号票：使用中、有在 LSM 上的服务的，服务前面一行开关——现在怎样（在线、已关闭、启动中、失败……）和"启动""关闭"两个按钮，
 *   经 LSM 把这个项目的服务全部拉起、全部关掉；关闭先弹确认框（一直关着、取消开机自启、不是停用），启动不弹。
 * size：card 项目卡（缩略图小、默认收起；项目卡整张能点开项目，展开钮、一行行的链接都不往外冒）、narrow 维护者会话页左栏（窄，默认收起）、
 * large 项目页的"现在"（缩略图大、默认展开）。
 */
import { type MouseEvent, useState } from "react";
import { createPortal } from "react-dom";
import { openInAppBrowser } from "../app/page-in-app-browser.ts";
import { toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { type OperationsSummary as Summary, type ProjectServicesAction, projectOperationsSummary, serviceEntryClick, serviceThumbnailSeen, type SummaryService, type SummaryTimedTask, t } from "../state/index.ts";
import { timeLabel } from "../util/time.ts";
import { Sheet } from "./common.tsx";
import { ServiceEntry } from "./service-entry.tsx";
import { useToast } from "./toast.tsx";

export type SummarySize = "card" | "narrow" | "large";

/** 有状态的那一层：取数据、记着展开没有、缩略图的地址、点了缩略图做什么、"关闭"的确认框（257） */
export function OperationsSummary({ projectId, size }: { projectId: string; size: SummarySize }) {
  const { ui, http, projectServicesAction } = useStore();
  const toast = useToast();
  const [open, setOpen] = useState(size === "large");
  const [confirmStop, setConfirmStop] = useState(false);
  const summary = projectOperationsSummary(ui, projectId);
  if (!summary) return null;
  const thumbnailSrc = (s: SummaryService) => {
    if (!s.thumbnail) return undefined;
    const at = s.thumbnail.kind === "shot" ? s.thumbnail.at : undefined;
    return http.serviceThumbnailUrl(s.view.projectId, s.view.name, { at, seen: serviceThumbnailSeen(at, Date.now()) });
  };
  const onOpenService = (s: SummaryService) => {
    const click = serviceEntryClick(s.view);
    if (click.kind === "open") openInAppBrowser(click.url, click.title);
    else toast(click.text);
  };
  // 257：启动不弹确认，关闭先弹确认框（挂到 body 上：项目卡上压着的那一层点不透，也不受卡片的裁切影响）
  const onPower = (action: ProjectServicesAction) => (action === "stop" ? setConfirmStop(true) : projectServicesAction(projectId, "start"));
  return (
    <>
      <OperationsSummaryBody summary={summary} size={size} open={open} onToggle={() => setOpen((o) => !o)} thumbnailSrc={thumbnailSrc} onOpenService={onOpenService} onPower={onPower} />
      {confirmStop &&
        createPortal(
          <StopServicesConfirm
            projectName={ui.projects[projectId]?.name ?? projectId}
            services={summary.services.filter((s) => s.view.rollout !== "withdrawn" && s.view.rollout !== "withdrawing").map((s) => s.view.title)}
            onCancel={() => setConfirmStop(false)}
            onConfirm={() => {
              setConfirmStop(false);
              projectServicesAction(projectId, "stop");
            }}
          />,
          document.body,
        )}
    </>
  );
}

/** "关闭"的确认框（257）：关几个服务、一直关着（取消开机自启，重启后也不起来）、不是停用 */
export function StopServicesConfirm({ projectName, services, onCancel, onConfirm }: { projectName: string; services: readonly string[]; onCancel(): void; onConfirm(): void }) {
  return (
    <Sheet title={t("ui.operationsSummary.power.confirmTitle", { name: projectName })} onClose={onCancel} center>
      <div className="modal-body">
        <p>{t("ui.operationsSummary.power.confirmBody", { count: services.length, list: services.join(t("ui.operationsSummary.power.listSep")) })}</p>
        <p className="muted">{t("ui.operationsSummary.power.confirmNote")}</p>
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("ui.operationsSummary.power.keep")}
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          {t("ui.operationsSummary.power.stop")}
        </button>
      </div>
    </Sheet>
  );
}

/** 点了不往外冒（项目卡整张能点开项目） */
const contained = (event: MouseEvent) => event.stopPropagation();

/**
 * 画出来的那一层（不用 hook，测试里直接渲染、直接点）：open 是定时任务展开没有，onToggle 点展开钮（不往外冒），
 * thumbnailSrc 给缩略图的地址（没有就不画图），onOpenService 点缩略图，onPower 点"启动""关闭"（257，不往外冒）
 */
export function OperationsSummaryBody({
  summary,
  size,
  open,
  onToggle,
  thumbnailSrc,
  onOpenService,
  onPower,
}: {
  summary: Summary;
  size: SummarySize;
  open: boolean;
  onToggle(): void;
  thumbnailSrc(s: SummaryService): string | undefined;
  onOpenService(s: SummaryService): void;
  onPower(action: ProjectServicesAction): void;
}) {
  const power = (action: ProjectServicesAction) => (event: MouseEvent) => {
    event.stopPropagation();
    onPower(action);
  };
  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    onToggle();
  };
  return (
    <div className={`ops-sum ops-sum-${size}${summary.stopped ? " ops-sum-stopped" : ""}`}>
      {summary.stopped && <span className="ops-sum-stopped-tag">{summary.stopped}</span>}
      {summary.power && (
        <div className={`ops-power ops-power-${summary.power.state}`}>
          <span className="ops-power-state" title={summary.power.detail ? t("ui.operationsSummary.power.title", { state: summary.power.text, detail: summary.power.detail }) : summary.power.text}>
            <span className="ops-power-dot" aria-hidden="true" />
            <span className="ops-power-text">{summary.power.text}</span>
            {summary.power.detail && <span className="ops-power-detail">{summary.power.detail}</span>}
          </span>
          <span className="ops-power-btns">
            <button type="button" className="btn ghost small ops-power-start" disabled={!summary.power.canStart} onClick={power("start")}>
              {t("ui.operationsSummary.power.start")}
            </button>
            <button type="button" className="btn ghost small ops-power-stop" disabled={!summary.power.canStop} onClick={power("stop")}>
              {t("ui.operationsSummary.power.stop")}
            </button>
          </span>
          {summary.power.blocked && <span className="ops-power-blocked">{summary.power.blocked}</span>}
        </div>
      )}
      {summary.services.length > 0 && (
        <div className="ops-sum-svcs">
          {summary.services.map((s) => {
            const src = thumbnailSrc(s);
            return (
              <div key={s.view.app} className="ops-svc">
                {src !== undefined && s.thumbnail?.kind === "shot" && (
                  <button
                    type="button"
                    className={`ops-thumb${s.dim ? " ops-thumb-dim" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenService(s);
                    }}
                    aria-label={s.dim ? t("ui.operationsSummary.thumbDim", { label: s.entry.label, dim: s.dim }) : t("ui.operationsSummary.thumb", { label: s.entry.label })}
                    title={s.entry.label}
                  >
                    {/* 取不到（被删了、过期了）就藏起来，只剩入口 */}
                    <img src={src} alt="" loading="lazy" decoding="async" onError={(e) => e.currentTarget.parentElement?.setAttribute("data-broken", "")} />
                    {s.dim && <span className="ops-thumb-tag">{s.dim}</span>}
                  </button>
                )}
                {/* 上线了还没有图（还没截、截不成）：不显示，只悄悄取一次——守护进程当"有人在看"，在线的补截一张 */}
                {src !== undefined && s.thumbnail?.kind === "probe" && <img className="ops-thumb-probe" src={src} alt="" hidden />}
                <ServiceEntry view={s.view} compact={size === "card"} />
              </div>
            );
          })}
        </div>
      )}
      {summary.line && (
        <div className="ops-sum-timed">
          <div className="ops-sum-line">
            <span className="ops-sum-text">{summary.line}</span>
            <button type="button" className="ops-sum-toggle" onClick={toggle} aria-expanded={open} aria-label={open ? t("ui.operationsSummary.collapseTimed") : t("ui.operationsSummary.expandTimed")} title={open ? t("ui.operationsSummary.collapse") : t("ui.operationsSummary.expand")}>
              {open ? "▴" : "▾"}
            </button>
          </div>
          {open && (
            <ul className="ops-sum-rows">
              {summary.timed.map((task) => (
                <li key={task.jobId} className={`ops-sum-row ops-st-${task.status}`}>
                  {task.taskId ? (
                    <a className="ops-sum-row-in" href={toHash({ tab: "tasks", taskId: task.taskId })} onClick={contained}>
                      <TimedCells task={task} />
                    </a>
                  ) : (
                    <span className="ops-sum-row-in">
                      <TimedCells task={task} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** 展开后的一条：名字、时间表、下次、上次和结果、状态 */
function TimedCells({ task }: { task: SummaryTimedTask }) {
  return (
    <>
      <b className="ops-sum-name">{task.name}</b>
      <span className="ops-sum-when">{task.scheduleText}</span>
      <span className="ops-sum-next">{t("ui.operationsSummary.next", { time: task.nextAt ? timeLabel(task.nextAt) : "—" })}</span>
      <span className={`ops-sum-last${task.last?.failed ? " ops-sum-failed" : task.last?.partial ? " ops-sum-partial" : ""}`}>
        {t("ui.operationsSummary.last", { last: task.last ? `${timeLabel(task.last.at)} ${task.last.text}` : t("ui.operationsSummary.neverRun") })}
      </span>
      <span className={`st ${task.status === "active" ? "st-ops" : "st-paused"}`}>{task.statusText}</span>
    </>
  );
}
