/**
 * 项目头下面的"现在"（140 号票）：按项目状态先说现在怎么样，下面才是完整的历史（立项书、运营方案、内部任务……原样）。
 * 项目页和维护者会话页左栏都在项目头（ProjectHead）里画它，左栏窄、用窄版（narrow）。数据是状态层的 projectNow。
 * - 筹备中：立项书到哪一步了；要你做的给按钮（和维护者交流、去看立项书、开工）；
 * - 建设中：建设任务的进度条和状态，卡住的醒目地列出来（等你、失败、被拦、超时没动，写原因），正在做的工单，最近一句进展；
 *   "首版做完了"卡还等你确认的直接放在这里；
 * - 使用中：运营概况（ui/operations-summary.tsx，项目页上是放大的版本、缩略图大）和最近几次运行（失败的醒目）；
 * - 已停用、已归档：一句话说清停了什么、怎么重新启用，运营概况照样列（标"已停用""已归档"）。
 */
import { toHash } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { JOB_RUN_STATE_LABEL, type ProjectNow, projectNow, type ProjectView, STUCK_LABEL, t } from "../state/index.ts";
import { timeLabel } from "../util/time.ts";
import { CardPanel } from "../ui/cards/CardPanel.tsx";
import { Section, useNow } from "../ui/common.tsx";
import { OperationsSummary } from "../ui/operations-summary.tsx";
import { TaskProgress } from "../ui/TaskProgress.tsx";

/** 立项书那一节的锚点（"去看立项书"滚过去） */
export const charterAnchor = (projectId: string) => `proj-charter-${projectId}`;

export function ProjectNowSection({ view, narrow, onChat }: { view: ProjectView; narrow: boolean; onChat?: (() => void) | undefined }) {
  const { ui } = useStore();
  // 判"超时没动"用的现在：一分钟走一次
  const nowMs = useNow(60_000);
  const now = projectNow(ui, view.project.id, nowMs);
  if (!now) return null;
  return (
    <Section title={t("pages.projectNow.title")}>
      <div className={`card proj-now proj-now-${now.kind}${narrow ? " proj-now-narrow" : ""}`}>
        <NowBody now={now} view={view} narrow={narrow} onChat={onChat} />
      </div>
    </Section>
  );
}

function NowBody({ now, view, narrow, onChat }: { now: ProjectNow; view: ProjectView; narrow: boolean; onChat?: (() => void) | undefined }) {
  const { projectAction } = useStore();
  const p = view.project;
  switch (now.kind) {
    case "preparing":
      return (
        <>
          <div className="now-line">{now.text}</div>
          {now.action === "chat" &&
            (onChat ? (
              <button type="button" className="btn primary small" onClick={onChat}>
                {t("pages.projectNow.chat")}
              </button>
            ) : (
              <div className="muted">{t("pages.projectNow.chatOnRight")}</div>
            ))}
          {now.action === "charter" && (
            <button type="button" className="btn primary small" onClick={() => document.getElementById(charterAnchor(p.id))?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              {t("pages.projectNow.viewCharter")}
            </button>
          )}
          {now.action === "start_build" && view.actions.includes("start_build") && (
            <button type="button" className="btn primary small" onClick={() => projectAction(p.id, "start_build")}>
              {t("pages.projectNow.startBuild")}
            </button>
          )}
        </>
      );
    case "building":
      return (
        <>
          {now.build && (
            <div className="now-build">
              <a className="link" href={toHash({ tab: "tasks", taskId: now.build.taskId })}>
                {t("pages.projectNow.buildTask", { title: now.build.title })}
              </a>
              <span className="muted">{now.build.status}</span>
              {now.build.progress && <TaskProgress progress={now.build.progress} />}
            </div>
          )}
          {now.stuck.length > 0 && (
            <ul className="now-stuck">
              {now.stuck.map((s) => (
                <li key={s.key} className={`now-stuck-row now-stuck-${s.kind}`}>
                  <span className="now-stuck-tag">{STUCK_LABEL[s.kind]}</span>
                  <span className="now-stuck-main">
                    {s.taskId ? (
                      <a className="link" href={toHash({ tab: "tasks", taskId: s.taskId })}>
                        {s.title}
                      </a>
                    ) : (
                      <b>{s.title}</b>
                    )}
                    <span className="now-stuck-why">{s.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {now.doing.length > 0 && (
            <div className="now-doing">
              <span className="muted">{t("pages.projectNow.doing")}</span>
              {now.doing.map((w) => (
                <span key={w.id} className="now-doing-item">
                  {t("pages.projectNow.workOrder", { id: w.id, title: w.title })}
                </span>
              ))}
            </div>
          )}
          {now.latest && <div className="now-latest">{t("pages.projectNow.latest", { text: now.latest })}</div>}
          {now.stuck.length === 0 && now.doing.length === 0 && !now.latest && !now.buildDoneCardId && !now.goLiveCardId && <div className="muted">{t("pages.projectNow.nothingStuck")}</div>}
          {now.buildDoneCardId && (
            <div className="now-card">
              <div className="now-line">{t("pages.projectNow.buildDone")}</div>
              <CardPanel cardId={now.buildDoneCardId} />
            </div>
          )}
          {/* 259 号票：转入使用的确认卡（你在项目页点的、维护者提的、秘书代办的） */}
          {now.goLiveCardId && (
            <div className="now-card">
              <div className="now-line">{t("pages.projectNow.goLive")}</div>
              <CardPanel cardId={now.goLiveCardId} />
            </div>
          )}
        </>
      );
    case "in_use":
      return (
        <>
          <OperationsSummary projectId={p.id} size={narrow ? "narrow" : "large"} />
          {now.runs.length > 0 && (
            <div className="now-runs">
              <div className="now-runs-h">{t("pages.projectNow.recentRuns")}</div>
              <ul>
                {now.runs.map((r) => (
                  <li key={r.runId} className={`now-run${r.failed ? " now-run-failed" : ""}`}>
                    {r.taskId ? (
                      <a className="link" href={toHash({ tab: "tasks", taskId: r.taskId })}>
                        {r.name}
                      </a>
                    ) : (
                      <b>{r.name}</b>
                    )}
                    <span className="muted">{timeLabel(r.at)}</span>
                    <span className={`chip ${r.failed ? "chip-no" : r.text === JOB_RUN_STATE_LABEL.done ? "chip-ok" : ""}`}>{r.text}</span>
                    {r.reason && <span className="now-run-why">{r.reason}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!now.summary && now.runs.length === 0 && <div className="muted">{t("pages.projectNow.noOperations")}</div>}
        </>
      );
    case "stopped":
      return (
        <>
          <div className="now-line">{now.text}</div>
          <div className="muted">{now.how}</div>
          {now.summary && <OperationsSummary projectId={p.id} size={narrow ? "narrow" : "large"} />}
        </>
      );
  }
}
