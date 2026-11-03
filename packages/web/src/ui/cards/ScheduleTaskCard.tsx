/**
 * "定时任务"卡：助理提议建的定时触发的普通任务，负载是 ScheduleTaskCardPayload。卡上写清每次会跑什么、多久一次：
 * - 多久一次（时间表的规则文字）、第一次（首次运行时间）和之后两次——提议那一刻按时间表算的，还没确认时才列；
 * - 每次到点会启动一个 agent 照下面的任务书干活，任务书全文；
 * - 按什么跑：pi 写模型，别的运行时写它的名字、模型按它自己的设置；
 * - 每次大概花多少：同类运行的历史用量估得出才写数字，估不出照实说；
 * "确认"才建（和发起对话框里选"定时"建出来的一样，看板运营中），"取消"什么都不建。建好了给去任务的链接
 */
import { toHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { tokensText } from "../../model/labels.ts";
import { approxMoney, describeSchedule, describeTime, runtimeTitleOf, type ScheduleTaskCardPayload, t, taskLabel } from "../../state/index.ts";
import { useRuntimes } from "../runtimes.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { Btn } from "./cards.tsx";

/** 按什么跑：pi 写模型；别的运行时写名字，模型按它自己的设置 */
function runsWith(p: ScheduleTaskCardPayload, runtimeTitle: string | undefined): string | undefined {
  if (runtimeTitle !== undefined) return t("ui.cards.scheduleTask.runtime", { runtime: runtimeTitle });
  return p.model ? t("ui.cards.scheduleTask.model", { model: p.model }) : undefined;
}

/** 每次大概花多少：估不出不写数字 */
function costLine(p: ScheduleTaskCardPayload): string {
  const e = p.estimate;
  if (!e) return t("ui.cards.scheduleTask.noEstimate");
  const tokens = tokensText(e.tokens);
  return e.cost
    ? t("ui.cards.scheduleTask.estimateCost", { tokens, cost: approxMoney(e.cost), runs: e.runs, count: e.runs })
    : t("ui.cards.scheduleTask.estimate", { tokens, runs: e.runs, count: e.runs });
}

export function ScheduleTaskCard({ state, payload: p, act }: CardProps<ScheduleTaskCardPayload>) {
  const { ui } = useStore();
  const runtimes = useRuntimes();
  const pending = state.card.status === "pending";
  const [first, ...rest] = p.upcoming.map((at) => describeTime(new Date(at)));
  const using = runsWith(p, p.runtime === undefined ? undefined : runtimeTitleOf(runtimes, p.runtime));
  return (
    <CardShell
      state={state}
      title={p.title}
      actions={
        <>
          <Btn onClick={() => act("cancel")}>{t("ui.cards.scheduleTask.cancel")}</Btn>
          <Btn kind="primary" onClick={() => act("confirm")}>
            {t("ui.cards.scheduleTask.confirm")}
          </Btn>
        </>
      }
    >
      <dl className="schedule-task-when">
        <dt>{t("ui.cards.scheduleTask.howOften")}</dt>
        <dd>{describeSchedule(p.schedule)}</dd>
        {pending && first !== undefined && (
          <>
            <dt>{t("ui.cards.scheduleTask.first")}</dt>
            <dd>{first}</dd>
          </>
        )}
        {pending && rest.length > 0 && (
          <>
            <dt>{t("ui.cards.scheduleTask.then")}</dt>
            <dd>{rest.join(t("ui.common.listSep"))}</dd>
          </>
        )}
      </dl>
      <div className="muted">{t("ui.cards.scheduleTask.each")}</div>
      <div className="schedule-task-brief">{p.instructions}</div>
      {using && <div className="muted">{using}</div>}
      <div className="muted">{costLine(p)}</div>
      {pending && <div className="muted">{t("ui.cards.scheduleTask.hint")}</div>}
      {p.taskId && (
        <a className="link" href={toHash({ tab: "tasks", taskId: p.taskId })}>
          {t("ui.cards.scheduleTask.open", { task: taskLabel(ui, p.taskId) })}
        </a>
      )}
    </CardShell>
  );
}
